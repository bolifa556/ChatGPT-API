// The desktop lists threads from SQLite and checks the indexed provider when
// resuming a thread. Normal launch and exit only overlay those routing rows.
// Rollout recovery below is for sessions interrupted under the older launcher.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { atomicPrivate } from './settings.mjs';
import { createDiagnosticLog } from './diagnostics.mjs';
import { RolloutIndex, removeRolloutScratch, rolloutBytes } from './rollout-index.mjs';

const journalPath = root => path.join(root, 'data/state/thread-provider-compatibility.json');
const canonicalHome = home => fs.realpathSync(home);
const plainRollout = file => file.endsWith('.jsonl.zst') ? file.slice(0, -4) : file;
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function rewriteJobs(index, jobs) {
  const fast = jobs.filter(job => index.fast(job.file));
  let next = 0;
  const finished = await Promise.allSettled(Array.from({ length: Math.min(4, fast.length) }, async () => {
    while (next < fast.length) {
      const job = fast[next++];
      if (job.span) index.apply(job.span);
      else await index.rewrite(job.file, job.temporary, job.transform);
    }
  }));
  const failed = finished.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  // Initial decompression stays serial to bound memory for image-heavy histories.
  for (const job of jobs.filter(job => !index.fast(job.file))) await index.rewrite(job.file, job.temporary, job.transform);
}
function prepareSpans(index, jobs, state) {
  const undo = [];
  const recorded = new Set((state.undo || []).map(saved => saved.identity));
  for (const job of jobs) {
    job.span = index.plan(job.file, job.goal, replaceProvider);
    if (job.span?.changes.length) {
      const { relative, identity, mtime, original, changes } = job.span;
      if (!recorded.has(identity)) {
        undo.push({ relative, identity, mtime, original, ranges: changes.map(({ offset, length, before }) => ({ offset, length, before })) });
        recorded.add(identity);
      }
    }
  }
  if (undo.length) state.undo = [...(state.undo || []), ...undo];
}
function inside(home, file) {
  const relative = path.relative(home, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function rolloutFiles(home) {
  const files = [];
  function walk(dir) {
    if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink()) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && (entry.name.endsWith('.jsonl')
          || entry.name.endsWith('.jsonl.zst') && !fs.existsSync(plainRollout(file)))) files.push(file);
    }
  }
  for (const name of ['sessions', 'archived_sessions']) walk(path.join(home, name));
  return files;
}
function databases(home) {
  const roots = new Set([home, path.join(home, 'sqlite')]);
  if (process.env.CODEX_SQLITE_HOME) roots.add(path.resolve(process.env.CODEX_SQLITE_HOME));
  const config = path.join(home, 'config.toml');
  if (fs.existsSync(config)) {
    const head = fs.readFileSync(config, 'utf8').split(/^\s*\[/m)[0];
    const literal = head.match(/^\s*sqlite_home\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*(?:#.*)?$/m)?.[1];
    if (literal) roots.add(path.resolve(literal[0] === '"' ? JSON.parse(literal) : literal.slice(1, -1)));
  }
  return [...roots].flatMap(dir => !fs.existsSync(dir) ? [] : fs.readdirSync(dir)
    .filter(name => /^state_\d+\.sqlite$/.test(name)).map(name => path.join(dir, name)))
    .filter(file => fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink());
}
function openDatabase(file, readOnly) {
  // Native startup can leave an empty placeholder before schema creation.
  // It has no routing rows, and opening it read-only can ask SQLite to recover.
  if (fs.statSync(file).size === 0) return null;
  const db = new DatabaseSync(file, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout = 0');
    const table = db.prepare('PRAGMA table_list(threads)').get();
    if (table?.type === 'table') {
      const columns = new Set(db.prepare('PRAGMA table_xinfo(threads)').all().filter(row => row.hidden === 0).map(row => row.name));
      if (columns.has('id') && columns.has('model_provider')) return db;
    }
  } catch (error) { db.close(); throw error; }
  db.close();
  return null;
}
function skipDatabase(failed, home, file, error) {
  if (!['ERR_SQLITE_ERROR', 'ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
  failed.push({ file: path.relative(home, file), code: error.code, message: error.message });
}
async function* lines(file) {
  let pending = [], length = 0;
  for await (const bytes of rolloutBytes(file)) {
    let start = 0, end;
    while ((end = bytes.indexOf(10, start)) >= 0) {
      const part = bytes.subarray(start, end + 1);
      if (length) { pending.push(part); yield Buffer.concat(pending, length + part.length); pending = []; length = 0; }
      else yield part;
      start = end + 1;
    }
    if (start < bytes.length) { const part = bytes.subarray(start); pending.push(part); length += part.length; }
  }
  if (length) yield Buffer.concat(pending, length);
}
// Locate JSON values by their actual object path. Replacing only these tokens
// preserves whitespace, escapes and every other byte, including instructions.
function valueRange(text, wanted) {
  let at = 0, found;
  const ws = () => { while (at < text.length && /\s/.test(text[at])) at++; };
  function string() {
    const start = at++;
    while (at < text.length) { const char = text[at++]; if (char === '\\') at++; else if (char === '"') break; }
    return JSON.parse(text.slice(start, at));
  }
  function value(keys) {
    ws(); const start = at, char = text[at];
    if (char === '{') {
      at++; ws();
      while (text[at] !== '}') { const key = string(); ws(); at++; value([...keys, key]); ws(); if (text[at] !== ',') break; at++; ws(); }
      at++;
    } else if (char === '[') {
      at++; ws(); let index = 0;
      while (text[at] !== ']') { value([...keys, index++]); ws(); if (text[at] !== ',') break; at++; ws(); }
      at++;
    } else if (char === '"') string();
    else while (at < text.length && !/[\s,}\]]/.test(text[at])) at++;
    if (keys.length === wanted.length && keys.every((key, index) => key === wanted[index])) found = [start, at];
  }
  value([]); return found;
}
function metadata(bytes) {
  if (!bytes.includes('"session_meta"') && !bytes.includes('"thread_settings_applied"')) return null;
  const text = bytes.toString('utf8');
  let record; try { record = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return null; }
  const keys = record.type === 'session_meta' ? ['payload', 'model_provider']
    : record.type === 'event_msg' && record.payload?.type === 'thread_settings_applied'
      ? ['payload', 'thread_settings', 'model_provider_id'] : null;
  const id = record.type === 'session_meta' ? record.payload?.id : null;
  if (!keys) return null;
  let parent = record;
  for (const key of keys.slice(0, -1)) parent = parent?.[key];
  const name = keys.at(-1), provider = parent?.[name];
  if (typeof provider !== 'string') return { id };
  parent[name] = null;
  return { id, provider, key: fingerprint(record), text, range: valueRange(text, keys) };
}
function replaceProvider(bytes, meta, provider) {
  if (!meta?.range || provider === meta.provider) return bytes;
  return Buffer.from(meta.text.slice(0, meta.range[0]) + JSON.stringify(provider) + meta.text.slice(meta.range[1]));
}
function validateJournal(state, home) {
  if (![1, 2].includes(state.version) || state.home !== home || !Array.isArray(state.databases)
    || (state.version === 1 ? !Array.isArray(state.threads) : !Array.isArray(state.existingDatabases))) {
    throw new Error('Conversation compatibility recovery belongs to another client home.');
  }
  if (state.version === 2) return;
  for (const thread of state.threads) {
    if (typeof thread.id !== 'string' || !inside(home, path.resolve(home, thread.relative))) throw new Error('Invalid conversation compatibility path.');
  }
  for (const saved of state.undo || []) if (typeof saved.relative !== 'string' || !inside(home, path.resolve(home, saved.relative)) || !Array.isArray(saved.ranges)) throw new Error('Invalid routing metadata recovery path.');
}
function recordedProvider(state, id) {
  const indexed = new Set(state.databases.flatMap(db => db.rows || [])
    .filter(row => row.id === id && typeof row.model_provider === 'string' && row.model_provider)
    .map(row => row.model_provider));
  if (indexed.size) return indexed.size === 1 ? [...indexed][0] : undefined;
  const providers = new Set((state.threads || []).filter(thread => thread.id === id).map(thread => thread.originalProvider));
  return providers.size === 1 ? [...providers][0] : undefined;
}
function originalThread(state, file, meta) {
  const relative = path.relative(state.home, file);
  // Native resume materializes .jsonl.zst for append; its cold-history worker
  // can later compress .jsonl again. Both paths identify the same rollout.
  const exact = state.threads.find(thread => thread.id === meta.id && plainRollout(thread.relative) === plainRollout(relative));
  if (exact) return exact;
  const candidates = state.threads.filter(thread => thread.id === meta.id);
  if (candidates.length <= 1) return candidates[0];
  // Native continuations can produce another rollout with the same conversation
  // ID while keeping older rollouts. The pre-launch index owns its routing.
  const provider = recordedProvider(state, meta.id);
  if (provider !== undefined) return { id: meta.id, originalProvider: provider, records: [] };
  const matching = candidates.filter(thread => thread.records.some(record => record.key === meta.key));
  if (matching.length === 1) return matching[0];
  const first = fingerprint({ provider: candidates[0].originalProvider, records: candidates[0].records });
  if (candidates.every(thread => fingerprint({ provider: thread.originalProvider, records: thread.records }) === first)) return candidates[0];
  const moved = candidates.filter(thread => {
    const plain = plainRollout(path.resolve(state.home, thread.relative));
    return !fs.existsSync(plain) && !fs.existsSync(plain + '.zst');
  });
  if (moved.length === 1) return moved[0];
  // An unindexed extra copy with all tracked originals still present was not
  // changed by this adapter. Keep its native routing metadata as created.
  if (!moved.length) return null;
  throw new Error('An archived conversation has ambiguous duplicate records; its recovery journal was retained.');
}
function logSkipped(root, phase, failed) {
  if (!failed.length) return;
  createDiagnosticLog(path.join(root, 'data/logs/history-compat.log'))(JSON.stringify({
    phase, skipped: failed.length, files: failed.slice(0, 12),
  }));
}

function restoreDatabaseProviders(state, ids, failed) {
  const { home, provider } = state;
  const recorded = new Map(state.databases.map(item => [item.file, item.rows]));
  const discovered = databases(home).filter(file => !state.existingDatabases?.includes(file));
  for (const file of new Set([...recorded.keys(), ...discovered])) {
    if (!fs.existsSync(file)) continue;
    let db;
    try { db = openDatabase(file, false); }
    catch (error) {
      if (recorded.has(file)) throw error;
      skipDatabase(failed, home, file, error);
      continue;
    }
    if (!db) continue;
    try {
      const original = new Map((recorded.get(file) || []).map(row => [row.id, row.model_provider]));
      const changes = db.prepare('SELECT id FROM threads WHERE model_provider = ?').all(provider)
        .filter(row => ids.has(row.id)).map(({ id }) => [id, original.has(id) ? original.get(id) : recordedProvider(state, id)])
        .filter(([, value]) => value !== undefined && value !== provider);
      if (!changes.length) continue;
      db.exec('BEGIN IMMEDIATE');
      const update = db.prepare('UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider = ?');
      for (const [id, value] of changes) update.run(value, id, provider);
      db.exec('COMMIT');
    } finally { db.close(); }
  }
}

async function restoreLegacyRollouts(state, root, journal, failed) {
  const { home } = state;
  const index = new RolloutIndex(home, root, metadata, lines);
  const jobs = [];
  const files = rolloutFiles(home);
  index.undo(state.undo, files);
  // Keep the durable undo until the entire restore commits. In-place metadata
  // writes deliberately retain mtime, so a restart must not trust an older cache
  // without first replaying these bytes, including after another failed restore.
  // Paths can move when a conversation is archived. Match the native session ID.
  for (const file of files) {
    const entry = await index.get(file);
    if (entry.compressionError) { failed.push({ file: path.relative(home, file), ...entry.compressionError }); continue; }
    const thread = entry.id ? originalThread(state, file, { id: entry.id, key: entry.records[0]?.key }) : null;
    if (!thread) continue;
    const saved = new Map();
    for (const record of thread.records) { const values = saved.get(record.key) || []; values.push(record.provider); saved.set(record.key, values); }
    const counts = new Map();
    const goals = entry.records.map(record => {
      const ordinal = counts.get(record.key) || 0; counts.set(record.key, ordinal + 1);
      const previous = saved.get(record.key)?.[ordinal] ?? thread.originalProvider;
      return record.provider === state.provider ? previous : record.provider;
    });
    removeRolloutScratch(file + '.chatgpt-api-compat.tmp');
    if (entry.records.every((record, position) => record.provider === goals[position])) continue;
    // An old preparation file may still be held open. Restore through a
    // separate sibling, leaving the original archive available until rename.
    const temporary = file + '.chatgpt-api-restore.tmp';
    removeRolloutScratch(temporary);
    jobs.push({ file, temporary, goal: (_record, position) => goals[position], transform: (bytes, meta) => {
      if (!meta?.provider) return bytes;
      const previous = saved.get(meta.key)?.shift() ?? thread.originalProvider;
      return meta.provider === state.provider ? replaceProvider(bytes, meta, previous) : bytes;
    } });
  }
  prepareSpans(index, jobs, state);
  // Recovery bytes become durable before touching an existing compressed slot.
  atomicPrivate(journal, state, { durable: true });
  await rewriteJobs(index, jobs);
  for (const thread of state.threads) {
    const plain = plainRollout(path.resolve(home, thread.relative));
    for (const file of [plain, plain + '.zst']) {
      removeRolloutScratch(file + '.chatgpt-api-compat.tmp');
    }
  }
  index.save();
}

export async function restoreThreadProviders({ home, root }) {
  const journal = journalPath(root);
  if (!fs.existsSync(journal)) return { restored: 0 };
  home = canonicalHome(home);
  const state = JSON.parse(fs.readFileSync(journal, 'utf8')); validateJournal(state, home);
  const failed = [];
  if (state.version === 1) await restoreLegacyRollouts(state, root, journal, failed);
  const ids = new Set(state.version === 1 ? state.threads.map(thread => thread.id)
    : state.databases.flatMap(database => database.rows.map(row => row.id)));
  restoreDatabaseProviders(state, ids, failed);
  fs.unlinkSync(journal);
  logSkipped(root, 'restore', failed);
  return { restored: ids.size, failed };
}
export async function repairThreadProviders({ home, root, provider = 'chatgpt_api_launcher', dryRun = false }) {
  home = canonicalHome(home);
  if (!root) throw new Error('The adapter root is required for temporary conversation compatibility.');
  const journal = journalPath(root);
  if (fs.existsSync(journal)) throw new Error('Restore the previous conversation compatibility session before starting another.');
  const state = { version: 2, home, provider, existingDatabases: databases(home), databases: [] };
  const failed = [], candidates = new Map();
  for (const file of state.existingDatabases) {
    let db, journaled = false;
    try {
      db = openDatabase(file, dryRun);
      if (!db) continue;
      if (!dryRun) db.exec('BEGIN IMMEDIATE');
      const rows = db.prepare('SELECT id, model_provider FROM threads WHERE model_provider IS NOT ?').all(provider)
        .filter(row => typeof row.id === 'string' && row.id);
      if (!rows.length) continue;
      const database = { file, rows };
      if (!dryRun) {
        atomicPrivate(journal, { ...state, databases: [...state.databases, database] }, { durable: true });
        journaled = true;
        const update = db.prepare('UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider IS ?');
        for (const row of rows) update.run(provider, row.id, row.model_provider);
        db.exec('COMMIT');
        state.databases.push(database);
      }
      for (const row of rows) candidates.set(row.id, { threadId: row.id, previousProvider: row.model_provider });
    } catch (error) {
      if (journaled) {
        // Drop this snapshot only after SQLite confirms that its writes were
        // rolled back. A crash before then is recoverable from the journal.
        db.exec('ROLLBACK');
        if (state.databases.length) atomicPrivate(journal, state, { durable: true });
        else fs.unlinkSync(journal);
      }
      skipDatabase(failed, home, file, error);
    } finally {
      db?.close();
    }
  }
  if (!dryRun) logSkipped(root, 'begin', failed);
  const affected = [...candidates.values()];
  return { dryRun, provider, candidates: affected, repaired: dryRun ? [] : affected, failed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, home, root, flags] = process.argv.slice(2);
  try {
    if (command === 'begin' && flags === '--desktop') {
      const { overlayDesktopState } = await import('./desktop-state.mjs');
      overlayDesktopState({ home, root });
    }
    const result = command === 'restore' ? await restoreThreadProviders({ home, root })
      : command === 'begin' ? await repairThreadProviders({ home, root }) : (() => { throw new Error('Expected begin/restore, CODEX_HOME and adapter root.'); })();
    console.log(JSON.stringify(command === 'begin' ? { repaired: result.repaired.length, skipped: result.failed.length } : result));
  } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
