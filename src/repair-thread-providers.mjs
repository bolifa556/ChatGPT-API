// Temporary provider compatibility, owned by the launcher lifetime. Only native
// routing metadata is overlaid; messages, tools, IDs and project data are opaque.
// The recovery journal lives in the adapter, never in the native client's home.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { atomicPrivate } from './settings.mjs';

const journalPath = root => path.join(root, 'data/state/thread-provider-compatibility.json');
const canonicalHome = home => fs.realpathSync(home);
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file);
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
  const db = new DatabaseSync(file, { readOnly });
  db.exec('PRAGMA busy_timeout = 0');
  const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
  if (!['id', 'model_provider'].every(name => columns.has(name))) { db.close(); return null; }
  return db;
}
async function* lines(file) {
  let pending = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(file)) {
    const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0, end;
    while ((end = bytes.indexOf(10, start)) >= 0) { yield bytes.subarray(start, end + 1); start = end + 1; }
    pending = bytes.subarray(start);
  }
  if (pending.length) yield pending;
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
async function rewrite(file, temporary, transform) {
  const before = fs.statSync(file), output = fs.createWriteStream(temporary, { flags: 'wx', mode: before.mode & 0o777 });
  let changed = false;
  try {
    await pipeline(lines(file), async function* (source) {
      for await (const bytes of source) { const next = transform(bytes); changed ||= next !== bytes; yield next; }
    }, output);
    const current = fs.statSync(file);
    if (current.size !== before.size || current.mtimeMs !== before.mtimeMs) throw new Error('A conversation changed while preparing compatibility; close its other client first.');
    if (changed) {
      fs.utimesSync(temporary, before.atime, before.mtime);
      const fd = fs.openSync(temporary, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
      if (process.platform !== 'win32') {
        const directory = fs.openSync(path.dirname(file), 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
    }
  } finally { output.destroy(); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function validateJournal(state, home) {
  if (state.version !== 1 || state.home !== home || !Array.isArray(state.threads) || !Array.isArray(state.databases)) throw new Error('Conversation compatibility recovery belongs to another client home.');
  for (const thread of state.threads) {
    if (typeof thread.id !== 'string' || !inside(home, path.resolve(home, thread.relative))) throw new Error('Invalid conversation compatibility path.');
  }
}
function recordedProvider(state, id) {
  const indexed = new Set(state.databases.flatMap(db => db.rows || [])
    .filter(row => row.id === id && typeof row.model_provider === 'string' && row.model_provider)
    .map(row => row.model_provider));
  if (indexed.size) return indexed.size === 1 ? [...indexed][0] : undefined;
  const providers = new Set(state.threads.filter(thread => thread.id === id).map(thread => thread.originalProvider));
  return providers.size === 1 ? [...providers][0] : undefined;
}
function originalThread(state, file, meta) {
  const relative = path.relative(state.home, file);
  const exact = state.threads.find(thread => thread.id === meta.id && thread.relative === relative);
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
  const moved = candidates.filter(thread => !fs.existsSync(path.resolve(state.home, thread.relative)));
  if (moved.length === 1) return moved[0];
  // An unindexed extra copy with all tracked originals still present was not
  // changed by this adapter. Keep its native routing metadata as created.
  if (!moved.length) return null;
  throw new Error('An archived conversation has ambiguous duplicate records; its recovery journal was retained.');
}
export async function restoreThreadProviders({ home, root }) {
  const journal = journalPath(root);
  if (!fs.existsSync(journal)) return { restored: 0 };
  home = canonicalHome(home);
  const state = JSON.parse(fs.readFileSync(journal, 'utf8')); validateJournal(state, home);
  // Paths can move when a conversation is archived. Match the native session ID.
  for (const file of rolloutFiles(home)) {
    let thread;
    for await (const bytes of lines(file)) {
      const meta = metadata(bytes);
      if (!meta?.id) continue;
      thread = originalThread(state, file, meta);
      break;
    }
    if (!thread) continue;
    const saved = new Map();
    for (const record of thread.records) { const values = saved.get(record.key) || []; values.push(record.provider); saved.set(record.key, values); }
    const temporary = file + '.chatgpt-api-compat.tmp';
    // Remove a scratch file from an interrupted preparation before retrying.
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    await rewrite(file, temporary, bytes => {
      const meta = metadata(bytes); if (!meta?.provider) return bytes;
      const previous = saved.get(meta.key)?.shift() ?? thread.originalProvider;
      return meta.provider === state.provider ? replaceProvider(bytes, meta, previous) : bytes;
    });
  }
  const files = new Set([...state.databases.map(item => item.file), ...databases(home)]);
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const db = openDatabase(file, false); if (!db) continue;
    try {
      db.exec('BEGIN IMMEDIATE');
      const original = new Map((state.databases.find(item => item.file === file)?.rows || []).map(row => [row.id, row.model_provider]));
      const update = db.prepare('UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider = ?');
      for (const id of new Set(state.threads.map(thread => thread.id))) {
        const provider = original.has(id) ? original.get(id) : recordedProvider(state, id);
        if (provider !== undefined) update.run(provider, id, state.provider);
      }
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    finally { db.close(); }
  }
  for (const thread of state.threads) {
    const scratch = path.resolve(home, thread.relative) + '.chatgpt-api-compat.tmp';
    if (fs.existsSync(scratch)) fs.unlinkSync(scratch);
  }
  fs.unlinkSync(journal);
  return { restored: state.threads.length };
}
export async function repairThreadProviders({ home, root, provider = 'chatgpt_api_launcher', dryRun = false }) {
  home = canonicalHome(home);
  if (!root) throw new Error('The adapter root is required for temporary conversation compatibility.');
  const journal = journalPath(root);
  if (fs.existsSync(journal)) throw new Error('Restore the previous conversation compatibility session before starting another.');
  let threads = [];
  for (const file of rolloutFiles(home)) {
    let id, originalProvider = 'openai'; const records = [];
    for await (const bytes of lines(file)) {
      const meta = metadata(bytes); if (!meta) continue;
      if (meta.id) id = meta.id;
      if (meta.provider) { originalProvider = meta.provider; records.push({ key: meta.key, provider: meta.provider }); }
    }
    if (id) threads.push({ id, relative: path.relative(home, file), originalProvider, records, differs: records.some(record => record.provider !== provider) });
  }
  const known = new Map(threads.map(thread => [thread.id, thread]));
  const dbs = [];
  for (const file of databases(home)) {
    const db = openDatabase(file, true); if (!db) continue;
    try {
      const rows = db.prepare('SELECT id, model_provider FROM threads').all().filter(row => known.has(row.id));
      for (const row of rows) {
        const thread = known.get(row.id);
        thread.originalProvider = row.model_provider || thread.originalProvider;
        thread.differs ||= row.model_provider !== provider;
      }
      if (rows.length) dbs.push({ file, rows });
    } finally { db.close(); }
  }
  threads = threads.filter(thread => thread.differs);
  const selected = new Set(threads.map(thread => thread.id));
  for (const db of dbs) db.rows = db.rows.filter(row => selected.has(row.id));
  const result = { dryRun, provider, candidates: threads.map(({ id, originalProvider }) => ({ threadId: id, previousProvider: originalProvider })), repaired: [], failed: [] };
  if (dryRun || !threads.length) return result;
  const state = { version: 1, home, provider, threads, databases: dbs };
  atomicPrivate(journal, state, { durable: true });
  try {
    for (const thread of threads) {
      const file = path.resolve(home, thread.relative);
      await rewrite(file, file + '.chatgpt-api-compat.tmp', bytes => { const meta = metadata(bytes); return meta?.provider ? replaceProvider(bytes, meta, provider) : bytes; });
    }
    for (const { file, rows } of dbs) {
      const db = openDatabase(file, false);
      try {
        db.exec('BEGIN IMMEDIATE');
        const update = db.prepare('UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider IS ?');
        for (const row of rows) update.run(provider, row.id, row.model_provider);
        db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
      finally { db.close(); }
    }
    result.repaired = result.candidates;
    return result;
  } catch (error) {
    await restoreThreadProviders({ home, root });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, home, root] = process.argv.slice(2);
  try {
    const result = command === 'restore' ? await restoreThreadProviders({ home, root })
      : command === 'begin' ? await repairThreadProviders({ home, root }) : (() => { throw new Error('Expected begin/restore, CODEX_HOME and adapter root.'); })();
    console.log(JSON.stringify(command === 'restore' ? result : { repaired: result.repaired.length }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
