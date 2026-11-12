import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { repairThreadProviders, restoreThreadProviders } from '../src/repair-thread-providers.mjs';
import { rolloutBytes } from '../src/rollout-index.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-provider-compat-'));
const home = fs.realpathSync(root);
const data = path.join(root, 'data'), sessions = path.join(home, 'sessions'), archives = path.join(home, 'archived_sessions');
const ctx = { root, home }, target = 'chatgpt_api_launcher';
const journal = path.join(data, 'state/thread-provider-compatibility.json');
const current = path.join(home, 'state_5.sqlite'), duplicate = path.join(home, 'state_4.sqlite'), retired = path.join(home, 'state_3.sqlite');
const checks = [];
for (const dir of [path.dirname(journal), sessions, archives]) fs.mkdirSync(dir, { recursive: true });

function header(id, provider) {
  return JSON.stringify({ type: 'session_meta', payload: { id, model_provider: provider } }) + '\n';
}
function setting(provider) {
  return JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied',
    thread_settings: { model_provider_id: provider, model: 'unchanged-model' } } }) + '\n';
}
const message = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text',
  text: 'Preserve "model_provider": "openai", 工具 and images in message text.' }] } }) + '\n';

function useDb(file, action) {
  const db = new DatabaseSync(file);
  try { return action(db); } finally { db.close(); }
}
function initIndex(file, entries) {
  useDb(file, db => {
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, model_provider TEXT, project_id TEXT, model TEXT, updated_at INTEGER)');
    const insert = db.prepare('INSERT INTO threads VALUES (?,?,?,?,?)');
    for (const [id, provider] of entries) insert.run(id, provider, 'project', 'model', 10);
  });
}
const rows = file => useDb(file, db => db.prepare('SELECT * FROM threads ORDER BY id').all().map(row => ({ ...row })));
const providerOf = (file, id) => rows(file).find(row => row.id === id)?.model_provider;
const writeJournal = value => fs.writeFileSync(journal, JSON.stringify(value));
const pending = () => JSON.parse(fs.readFileSync(journal, 'utf8'));

initIndex(current, [['legacy', 'openai'], ['archived', 'smr'], ['no-file', 'user_custom'], ['api', target], ['null-provider', null]]);
initIndex(duplicate, [['legacy', target]]);
fs.writeFileSync(retired, 'unsupported SQLite index');
const future = path.join(home, 'state_6.sqlite');
useDb(future, db => db.exec("CREATE TABLE conversations (id TEXT PRIMARY KEY, provider TEXT); INSERT INTO conversations VALUES ('legacy','openai'); CREATE VIEW threads AS SELECT id, provider AS model_provider FROM conversations"));
const source = new Map([
  [path.join(sessions, 'legacy.jsonl'), Buffer.from(header('legacy', 'openai') + message + setting('openai'))],
  [path.join(archives, 'archived.jsonl.zst'), Buffer.concat([zstdCompressSync(Buffer.from(header('archived', 'smr') + message)), zstdCompressSync(Buffer.from(setting('smr')))])],
  [path.join(archives, 'broken.jsonl.zst'), Buffer.from('broken archive fixture')],
  [path.join(sessions, 'old.jsonl.zst.chatgpt-api-compat.tmp'), Buffer.from('orphaned temporary output')],
]);
for (const [file, bytes] of source) fs.writeFileSync(file, bytes);
const originalRows = rows(current), originalDuplicate = rows(duplicate), originalFuture = fs.readFileSync(future);

try {
  const readdir = fs.readdirSync;
  fs.readdirSync = (dir, ...options) => {
    assert(![sessions, archives].includes(dir), 'Normal launch or exit enumerated conversation archives');
    return readdir(dir, ...options);
  };
  try {
    const dry = await repairThreadProviders({ ...ctx, dryRun: true });
    assert.equal(dry.candidates.length, 4);
    assert(!fs.existsSync(journal));
    assert.deepEqual(rows(current), originalRows);
    for (let cycle = 0; cycle < 2; cycle++) {
      const applied = await repairThreadProviders(ctx);
      assert.equal(applied.repaired.length, 4);
      assert(applied.failed.some(entry => entry.file === 'state_3.sqlite'));
      assert(rows(current).every(row => row.model_provider === target));
      assert.equal(pending().version, 2);
      assert(!Object.hasOwn(pending(), 'threads'));
      await assert.rejects(repairThreadProviders(ctx), /Restore the previous/);
      await restoreThreadProviders(ctx);
      assert.deepEqual(rows(current), originalRows);
      assert.deepEqual(rows(duplicate), originalDuplicate);
      assert(!fs.existsSync(journal));
    }
  } finally { fs.readdirSync = readdir; }
  assert(!fs.existsSync(path.join(data, 'cache/rollout-index.json')));
  for (const [file, bytes] of source) assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readFileSync(future), originalFuture);
  assert.equal(fs.readFileSync(retired, 'utf8'), 'unsupported SQLite index');
  checks.push('Cold and repeated launch and exit use only indexed provider rows; plain, compressed, damaged and orphaned archive files remain byte-for-byte intact');

  const lock = new DatabaseSync(current);
  lock.exec('BEGIN IMMEDIATE');
  try {
    const skipped = await repairThreadProviders(ctx);
    assert(skipped.failed.some(entry => entry.file === 'state_5.sqlite'));
    assert.equal(skipped.repaired.length, 0);
    assert(!fs.existsSync(journal));
  } finally { lock.exec('ROLLBACK'); lock.close(); }
  await repairThreadProviders(ctx);
  const movedIndex = path.join(home, 'state_7.sqlite');
  initIndex(movedIndex, [['legacy', target], ['api', target]]);
  useDb(current, db => db.prepare('UPDATE threads SET model=?, updated_at=? WHERE id=?').run('edited', 20, 'legacy'));
  const exitLock = new DatabaseSync(current);
  exitLock.exec('BEGIN IMMEDIATE');
  try {
    await assert.rejects(restoreThreadProviders(ctx), /locked/);
    assert(fs.existsSync(journal), 'Interrupted restore lost the durable index snapshot');
  } finally { exitLock.exec('ROLLBACK'); exitLock.close(); }
  await restoreThreadProviders(ctx);
  assert.equal(providerOf(current, 'legacy'), 'openai');
  assert.equal(providerOf(movedIndex, 'legacy'), 'openai');
  assert.equal(providerOf(movedIndex, 'api'), target);
  assert.equal(rows(current).find(row => row.id === 'legacy').model, 'edited');
  assert.deepEqual(rows(duplicate), originalDuplicate);
  assert(!fs.existsSync(journal));
  checks.push('A busy optional index is skipped at launch, and a busy changed index retains its journal for exit recovery; new native preferences and new index migrations survive');

  const legacyFile = path.join(archives, 'moved.jsonl.zst');
  const lockedScratch = legacyFile + '.chatgpt-api-compat.tmp';
  const legacyId = 'legacy-recovery';
  fs.writeFileSync(legacyFile, zstdCompressSync(Buffer.from(header(legacyId, target) + message + setting(target))));
  fs.writeFileSync(lockedScratch, 'held by another process');
  writeJournal({ version: 1, home, provider: target,
    threads: [{ id: legacyId, relative: path.join('sessions', 'moved.jsonl.zst'), originalProvider: 'openai', records: [] }], databases: [] });
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (file, ...options) => {
    if (file === lockedScratch) throw Object.assign(new Error('fixture scratch is in use'), { code: 'EBUSY' });
    return unlink(file, ...options);
  };
  try { await restoreThreadProviders(ctx); }
  finally { fs.unlinkSync = unlink; }
  const decoded = [];
  for await (const bytes of rolloutBytes(legacyFile)) decoded.push(bytes);
  assert.equal(Buffer.concat(decoded).toString(), header(legacyId, 'openai') + message + setting('openai'));
  assert(!fs.existsSync(journal));
  assert(!fs.existsSync(legacyFile + '.chatgpt-api-restore.tmp'));
  assert.equal(fs.readFileSync(lockedScratch, 'utf8'), 'held by another process');

  const undoFile = path.join(sessions, 'interrupted-slot.jsonl.zst'), id = 'interrupted-slot';
  const raw = Buffer.from(header(id, 'openai')), frame = zstdCompressSync(raw), slot = Buffer.alloc(frame.length + 64);
  frame.copy(slot);
  slot.writeUInt32LE(0x184d2a50, frame.length);
  slot.writeUInt32LE(56, frame.length + 4);
  const original = Buffer.concat([slot, zstdCompressSync(Buffer.from(message))]);
  fs.writeFileSync(undoFile, original);
  const undoFd = fs.openSync(undoFile, 'r+');
  fs.writeSync(undoFd, Buffer.alloc(12, 255), 0, 12, 0); fs.closeSync(undoFd);
  const stat = fs.statSync(undoFile, { bigint: true }), relative = path.relative(home, undoFile);
  const meta = JSON.parse(raw);
  meta.payload.model_provider = null;
  const record = { offset: 0, length: slot.length, provider: 'openai',
    key: crypto.createHash('sha256').update(JSON.stringify(meta)).digest('hex') };
  writeJournal({ version: 1, home, provider: target, databases: [], threads: [{ id, relative, originalProvider: 'openai', records: [record] }],
    undo: [{ relative, identity: [stat.dev, stat.ino, stat.size].join(':'), mtime: Number(stat.mtimeMs),
      original: { id, originalProvider: 'openai', records: [record], framed: true, reserved: true },
      ranges: [{ offset: 0, length: slot.length, before: slot.toString('base64') }] }] });
  await restoreThreadProviders(ctx);
  assert.deepEqual(fs.readFileSync(undoFile), original);
  assert(!fs.existsSync(journal));
  checks.push('Version-one recovery restores moved compressed histories despite a locked old scratch file and replays durable compressed-slot undo bytes');

  for (const platform of ['macos', 'linux']) {
    const { applyConfig, restoreConfig } = await import('../' + platform + '/provider.mjs');
    const area = path.join(root, platform), data = path.join(area, 'data'), native = path.join(area, 'home');
    fs.mkdirSync(path.join(data, 'cache'), { recursive: true }); fs.mkdirSync(native);
    fs.writeFileSync(path.join(data, '.env'), 'BASE_URL=http://fixture.invalid/v1\nAPI_KEY=inert\nSHIM_PORT=8102\n');
    for (const name of ['models-gateway.json', 'models-smr.json']) fs.writeFileSync(path.join(data, 'cache', name), JSON.stringify({ models: [{ slug: 'Fixture/model' }] }));
    const projected = { root: area, home: native, data, config: path.join(native, 'config.toml'), node: process.execPath };
    applyConfig(projected); restoreConfig(projected);
    assert(!fs.existsSync(projected.config), platform + ' left a config file that did not originally exist');
    const original = '# Original formatting\r\nmodel = "keep"\r\n[app]\r\nlocaleOverride = "zh-CN"\r\n\r\n';
    fs.writeFileSync(projected.config, original); applyConfig(projected); restoreConfig(projected);
    assert.equal(fs.readFileSync(projected.config, 'utf8'), original, platform + ' did not restore exact configuration bytes');
    applyConfig(projected);
    const legacyJournal = path.join(data, 'state/config.json'), legacy = JSON.parse(fs.readFileSync(legacyJournal));
    delete legacy.original; fs.writeFileSync(legacyJournal, JSON.stringify(legacy));
    applyConfig(projected); restoreConfig(projected);
    const legacyRestored = fs.readFileSync(projected.config, 'utf8');
    assert(!legacyRestored.includes('model_catalog_json'), platform + ' restored an already-overlaid legacy backup');
    assert(!legacyRestored.includes('[model_providers.chatgpt_api_launcher]'));
    assert(legacyRestored.includes('localeOverride = "zh-CN"'));
    fs.writeFileSync(projected.config, original); applyConfig(projected);
    fs.writeFileSync(projected.config, fs.readFileSync(projected.config, 'utf8').replace('zh-CN', 'en-US'));
    applyConfig(projected); restoreConfig(projected);
    assert(fs.readFileSync(projected.config, 'utf8').includes('localeOverride = "en-US"'), platform + ' discarded a preference edited before reconfiguration');
  }
  checks.push('macOS/Linux runtime configuration restores exact bytes or original absence, with no leftover provider definitions');
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
