import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { repairThreadProviders, restoreThreadProviders } from '../src/repair-thread-providers.mjs';

// Native cold histories support concatenated Zstandard frames. Node's decoder
// returns one frame, so read every native frame when comparing opaque content.
function nativeDecompress(input) {
  const chunks = [];
  for (let offset = 0; offset < input.length;) {
    const result = zstdDecompressSync(input.subarray(offset), { info: true });
    assert(result.engine.bytesWritten > 0);
    chunks.push(result.buffer); offset += result.engine.bytesWritten;
  }
  return Buffer.concat(chunks);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-provider-compat-'));
const home = path.join(root, 'native'), sessions = path.join(home, 'sessions'), archive = path.join(home, 'archived_sessions');
for (const dir of [sessions, archive]) fs.mkdirSync(dir, { recursive: true });
const placeholder = path.join(home, 'state_99.sqlite'); fs.writeFileSync(placeholder, '');
const ctx = { root, home }, target = 'chatgpt_api_launcher';
const journal = path.join(root, 'data/state/thread-provider-compatibility.json');
const source = new Map(), checks = [];
const message = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep "model_provider": "openai" and 工具/图片 completely intact.' }] } }) + '\r\n';
const tool = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'old_tool', output: '{"type":"session_meta","model_provider":"openai"}' } }) + '\n';
function header(id, provider) { return '{"type":"session_meta", "payload":{"id":' + JSON.stringify(id) + ',"model_provider" : ' + JSON.stringify(provider) + ',"base_instructions":{"text":"Preserve all instructions exactly."}}}\r\n'; }
function setting(provider, stamp = 1) { return JSON.stringify({ timestamp: stamp, type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model_provider_id: provider, model: 'unchanged-model', effort: 'medium' } } }) + '\n'; }
const providers = ['openai', 'chatgpt_api_mixed', 'smr', 'custom with "quoted" name', target];
for (const [index, provider] of providers.entries()) {
  const id = 'fixture-' + index, file = path.join(sessions, id + '.jsonl');
  const prefix = index === 3 ? '\r\n' : '';
  const bytes = Buffer.from(prefix + header(id, provider) + message + setting(provider) + tool);
  fs.writeFileSync(file, bytes); fs.utimesSync(file, new Date(1700000000000), new Date(1700000000000));
  source.set(id, { file, bytes, prefix, provider, mtime: fs.statSync(file).mtimeMs });
}
const dbFiles = [path.join(home, 'state_4.sqlite'), path.join(home, 'state_5.sqlite')];
for (const file of dbFiles) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, model_provider TEXT, project_id TEXT, model TEXT, updated_at INTEGER)');
  for (const [id, row] of source) db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run(id, row.provider, 'original-project', 'original-model', 10);
  db.close();
}
function rows(file) { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare('SELECT * FROM threads ORDER BY id').all().map(row => ({ ...row })); } finally { db.close(); } }
const originalRows = dbFiles.map(rows);
const originalTree = fs.readdirSync(home, { recursive: true }).sort();
function noScratch() { assert(!fs.readdirSync(home, { recursive: true }).some(name => /chatgpt-api|backup|\.tmp$/.test(name))); }
try {
  const dry = await repairThreadProviders({ ...ctx, dryRun: true });
  assert.equal(dry.candidates.length, 4); assert(!fs.existsSync(journal));
  for (const row of source.values()) assert.deepEqual(fs.readFileSync(row.file), row.bytes);
  for (let cycle = 0; cycle < 2; cycle++) {
    const result = await repairThreadProviders(ctx); assert.equal(result.repaired.length, 4);
    for (const [id, row] of source) {
      assert.deepEqual(fs.readFileSync(row.file), Buffer.from(row.prefix + header(id, target) + message + setting(target) + tool));
      assert.equal(fs.statSync(row.file).mtimeMs, row.mtime);
    }
    assert(dbFiles.every(file => rows(file).every(row => row.model_provider === target)));
    await assert.rejects(repairThreadProviders(ctx), /Restore the previous/);
    await restoreThreadProviders(ctx);
    for (const row of source.values()) assert.deepEqual(fs.readFileSync(row.file), row.bytes);
    assert.deepEqual(dbFiles.map(rows), originalRows); assert(!fs.existsSync(journal)); noScratch();
    assert.deepEqual(fs.readdirSync(home, { recursive: true }).sort(), originalTree, 'Compatibility left additional native files');
  }
  checks.push('Every local provider is temporarily compatible; repeated exit restores exact original JSONL bytes, mtimes and provider rows with no native scratch files');
  checks.push('Instructions, message roles, tool call/result bytes, IDs and project/model/ordering metadata remain intact');

  await repairThreadProviders(ctx);
  const first = source.get('fixture-0'), moved = path.join(archive, 'moved.jsonl');
  fs.appendFileSync(first.file, message + setting(target, 2) + tool);
  fs.renameSync(first.file, moved);
  const db = new DatabaseSync(dbFiles[1]); db.prepare('UPDATE threads SET model=?, updated_at=? WHERE id=?').run('new-native-model', 20, 'fixture-0'); db.close();
  await restoreThreadProviders(ctx);
  assert.deepEqual(fs.readFileSync(moved), Buffer.concat([first.bytes, Buffer.from(message + setting('openai', 2) + tool)]));
  const resumed = rows(dbFiles[1]).find(row => row.id === 'fixture-0');
  assert.equal(resumed.model_provider, 'openai'); assert.equal(resumed.model, 'new-native-model'); assert.equal(resumed.updated_at, 20);
  assert(!fs.existsSync(journal)); noScratch();
  checks.push('Native appended turns and changed model settings survive exit; archived conversations restore by their original ID');

  // A crashed preparation is recoverable even when a native DB writer prevented
  // both the first index update and its immediate rollback.
  const locked = new DatabaseSync(dbFiles[1]); locked.exec('BEGIN IMMEDIATE');
  await assert.rejects(repairThreadProviders(ctx), /locked/);
  assert(fs.existsSync(journal)); locked.exec('ROLLBACK'); locked.close();
  await restoreThreadProviders(ctx); assert(!fs.existsSync(journal)); noScratch();
  assert.equal(rows(dbFiles[1]).find(row => row.id === 'fixture-0').model_provider, 'openai');
  assert.deepEqual(fs.readFileSync(moved), Buffer.concat([first.bytes, Buffer.from(message + setting('openai', 2) + tool)]));
  checks.push('Interrupted preparation recovers from the adapter journal without native backup files or lost messages');

  for (const indexed of [true, false]) {
    const id = indexed ? 'indexed-duplicates' : 'unindexed-duplicates';
    const left = path.join(sessions, id + '-left.jsonl'), right = path.join(sessions, id + '-right.jsonl');
    const extra = path.join(archive, id + '-new.jsonl');
    const originalLeft = header(id, 'openai') + message + setting('openai');
    const originalRight = header(id, 'smr') + message + setting('smr');
    fs.writeFileSync(left, originalLeft); fs.writeFileSync(right, originalRight);
    if (indexed) for (const file of dbFiles) {
      const db = new DatabaseSync(file); db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run(id, 'openai', 'original-project', 'original-model', 10); db.close();
    }
    await repairThreadProviders(ctx);
    fs.copyFileSync(right, extra); fs.appendFileSync(extra, setting(target, 9));
    const extraBefore = fs.readFileSync(extra);
    if (!indexed) for (const file of dbFiles) {
      const db = new DatabaseSync(file); db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run(id, target, 'new-native-project', 'new-native-model', 20); db.close();
    }
    await restoreThreadProviders(ctx);
    assert.equal(fs.readFileSync(left, 'utf8'), originalLeft);
    assert.equal(fs.readFileSync(right, 'utf8'), originalRight);
    if (indexed) assert.equal(fs.readFileSync(extra, 'utf8'), header(id, 'openai') + message + setting('openai') + setting('openai', 9));
    else {
      assert.deepEqual(fs.readFileSync(extra), extraBefore);
      assert(dbFiles.every(file => rows(file).find(row => row.id === id).model_provider === target));
    }
    assert(!fs.existsSync(journal)); noScratch();
  }
  checks.push('Duplicate rollout IDs restore each tracked file exactly; new indexed continuations use the pre-launch native provider and unowned unindexed copies remain intact');

  // Native cold-history compression keeps the logical .jsonl path in SQLite
  // while storing the actual rollout as .jsonl.zst.
  for (const materialize of [false, true]) {
    const id = 'compressed-' + materialize, plain = path.join(sessions, id + '.jsonl'), compressed = plain + '.zst';
    const bytes = Buffer.from(header(id, 'chatgpt_api_mixed') + message + setting('chatgpt_api_mixed') + tool);
    fs.writeFileSync(compressed, Buffer.concat([zstdCompressSync(bytes.subarray(0, 17)), zstdCompressSync(bytes.subarray(17))]));
    for (const file of dbFiles) {
      const db = new DatabaseSync(file); db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run(id, 'chatgpt_api_mixed', 'compressed-project', 'unchanged-model', 10); db.close();
    }
    const result = await repairThreadProviders(ctx);
    assert(result.repaired.some(row => row.threadId === id), 'Compressed history was omitted from provider compatibility');
    assert.deepEqual(nativeDecompress(fs.readFileSync(compressed)), Buffer.from(header(id, target) + message + setting(target) + tool));
    assert(dbFiles.every(file => rows(file).find(row => row.id === id).model_provider === target));
    if (materialize) {
      fs.writeFileSync(plain, nativeDecompress(fs.readFileSync(compressed)));
      fs.unlinkSync(compressed);
      fs.appendFileSync(plain, setting(target, 12) + message);
    }
    await restoreThreadProviders(ctx);
    const restored = materialize ? fs.readFileSync(plain) : nativeDecompress(fs.readFileSync(compressed));
    assert.deepEqual(restored, materialize ? Buffer.concat([bytes, Buffer.from(setting('chatgpt_api_mixed', 12) + message)]) : bytes);
    assert(dbFiles.every(file => rows(file).find(row => row.id === id).model_provider === 'chatgpt_api_mixed'));
    assert(!fs.existsSync(journal)); noScratch();
  }
  checks.push('Native .jsonl.zst history, its unchanged SQLite rollout path and materialization on append retain original providers and all message bytes');

  const shadowId = 'native-shadow', shadowPlain = path.join(sessions, shadowId + '.jsonl'), shadowCompressed = shadowPlain + '.zst';
  const shadowBytes = Buffer.from(header(shadowId, 'openai') + message + setting('openai'));
  const staleBytes = zstdCompressSync(Buffer.from(header(shadowId, 'smr') + message));
  fs.writeFileSync(shadowPlain, shadowBytes); fs.writeFileSync(shadowCompressed, staleBytes);
  await repairThreadProviders(ctx);
  assert.deepEqual(fs.readFileSync(shadowCompressed), staleBytes, 'Compatibility modified a compressed sibling hidden by the native plain rollout');
  fs.unlinkSync(shadowCompressed);
  fs.writeFileSync(shadowCompressed, zstdCompressSync(fs.readFileSync(shadowPlain)));
  fs.unlinkSync(shadowPlain);
  const coldArchive = path.join(archive, shadowId + '.jsonl.zst');
  fs.renameSync(shadowCompressed, coldArchive);
  fs.writeFileSync(coldArchive + '.chatgpt-api-compat.tmp', 'interrupted compressed rewrite');
  await restoreThreadProviders(ctx);
  assert.deepEqual(nativeDecompress(fs.readFileSync(coldArchive)), shadowBytes);
  assert(!fs.existsSync(journal)); noScratch();
  checks.push('Native plain-file precedence, compression after startup, archive moves and interrupted compressed scratch files recover without losing messages');

  const broken = path.join(sessions, 'invalid.jsonl.zst');
  const truncated = path.join(archive, 'truncated.jsonl.zst');
  const truncatedBytes = zstdCompressSync(Buffer.from(header('truncated', 'openai') + message)).subarray(0, -3);
  fs.writeFileSync(broken, 'invalid compressed data');
  fs.writeFileSync(truncated, truncatedBytes);
  const unrelated = source.get('fixture-1');
  const withBadHistory = await repairThreadProviders(ctx);
  assert.equal(withBadHistory.failed.length, 2);
  assert(withBadHistory.repaired.some(row => row.threadId === 'fixture-1'));
  assert((await restoreThreadProviders(ctx)).failed.length === 2);
  assert(!fs.existsSync(journal));
  assert.equal(fs.readFileSync(broken, 'utf8'), 'invalid compressed data');
  assert.deepEqual(fs.readFileSync(truncated), truncatedBytes);
  assert.deepEqual(fs.readFileSync(unrelated.file), unrelated.bytes);
  const fixed = Buffer.from(header('fixed', 'openai') + message);
  const padding = Buffer.alloc(17); padding.writeUInt32LE(0x184d2a5f); padding.writeUInt32LE(9, 4);
  fs.writeFileSync(broken, Buffer.concat([padding, zstdCompressSync(fixed.subarray(0, 13)), padding, zstdCompressSync(fixed.subarray(13)), padding]));
  const reindexed = await repairThreadProviders(ctx);
  assert.equal(reindexed.failed.length, 1);
  assert(reindexed.repaired.some(row => row.threadId === 'fixed'));
  await restoreThreadProviders(ctx);
  assert.deepEqual(nativeDecompress(fs.readFileSync(broken)), fixed);
  fs.unlinkSync(broken); fs.unlinkSync(truncated); noScratch();
  checks.push('Damaged and truncated archives stay byte-for-byte intact while healthy conversations can be adapted and restored; repaired archives are re-indexed across Zstandard frame boundaries');

  const retired = path.join(home, 'state_96.sqlite'), future = path.join(home, 'state_97.sqlite');
  const newRollout = path.join(sessions, 'new-format.jsonl');
  const newFormat = JSON.stringify({ type: 'session_meta', payload: { id: 'new-format', routing: { provider: 'new-native' } } }) + '\n' + message;
  fs.writeFileSync(retired, 'retired database format');
  fs.writeFileSync(newRollout, newFormat);
  const newIndex = new DatabaseSync(future);
  newIndex.exec("CREATE TABLE conversations (uuid TEXT PRIMARY KEY, provider TEXT); INSERT INTO conversations VALUES ('fixture-1', 'new-native'); CREATE VIEW threads AS SELECT uuid AS id, provider AS model_provider FROM conversations");
  newIndex.close();
  const originalFuture = fs.readFileSync(future);
  const currentIndex = new DatabaseSync(dbFiles[0]);
  currentIndex.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run('new-format', 'new-native', 'original-project', 'original-model', 10);
  currentIndex.close();
  const afterUpgrade = await repairThreadProviders(ctx);
  assert(afterUpgrade.repaired.some(row => row.threadId === 'fixture-1'));
  assert(!afterUpgrade.repaired.some(row => row.threadId === 'new-format'));
  assert(afterUpgrade.failed.some(entry => entry.file === 'state_96.sqlite'));
  assert.equal(rows(dbFiles[0]).find(row => row.id === 'new-format').model_provider, 'new-native');
  const afterUpgradeRestore = await restoreThreadProviders(ctx);
  assert(afterUpgradeRestore.failed.some(entry => entry.file === 'state_96.sqlite'));
  assert(!fs.existsSync(journal));
  assert.equal(fs.readFileSync(newRollout, 'utf8'), newFormat);
  assert.equal(fs.readFileSync(retired, 'utf8'), 'retired database format');
  assert.deepEqual(fs.readFileSync(future), originalFuture);
  for (const file of [retired, future]) fs.unlinkSync(file);
  checks.push('A retired SQLite format and unrecognized routing metadata leave compatible history usable and remain byte-for-byte intact');

  for (const compressed of [false, true]) {
    const id = 'forked-history-' + compressed, file = path.join(sessions, id + '.jsonl' + (compressed ? '.zst' : ''));
    const opaque = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Long native item ' + '图'.repeat(1024 * 1024) }] } }) + '\n';
    const bytes = Buffer.from(header(id, 'openai') + header('retained-parent-header', 'smr') + opaque + setting('openai') + tool);
    fs.writeFileSync(file, compressed ? zstdCompressSync(bytes) : bytes);
    for (const database of dbFiles) {
      const db = new DatabaseSync(database); db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run(id, 'openai', 'fork-project', 'unchanged-model', 10); db.close();
    }
    const result = await repairThreadProviders(ctx);
    assert(result.repaired.some(row => row.threadId === id), 'A retained parent header replaced the native fork ID');
    assert(!result.repaired.some(row => row.threadId === 'retained-parent-header'));
    assert(dbFiles.every(database => rows(database).find(row => row.id === id).model_provider === target));
    await restoreThreadProviders(ctx);
    assert.deepEqual(compressed ? nativeDecompress(fs.readFileSync(file)) : fs.readFileSync(file), bytes);
    assert(dbFiles.every(database => rows(database).find(row => row.id === id).model_provider === 'openai'));
    noScratch();
  }
  checks.push('Native forks retain the first session ID, restore every parent-header provider and preserve multi-megabyte Unicode history lines');

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
  const undoFile = path.join(sessions, 'interrupted-slot.jsonl.zst');
  const undoBytes = Buffer.from(header('interrupted-slot', 'openai') + message + setting('openai') + tool);
  fs.writeFileSync(undoFile, zstdCompressSync(undoBytes));
  await repairThreadProviders(ctx); await restoreThreadProviders(ctx);
  const originalCompressed = fs.readFileSync(undoFile), originalInode = fs.statSync(undoFile, { bigint: true }).ino;
  const repeatedLock = new DatabaseSync(dbFiles[1]); repeatedLock.exec('BEGIN IMMEDIATE');
  await assert.rejects(repairThreadProviders(ctx), /locked/);
  for (let interruption = 0; interruption < 2; interruption++) await assert.rejects(restoreThreadProviders(ctx), /locked/);
  repeatedLock.exec('ROLLBACK'); repeatedLock.close();
  await restoreThreadProviders(ctx);
  assert.deepEqual(fs.readFileSync(undoFile), originalCompressed, 'Repeated interrupted recovery trusted a stale metadata cache');
  assert(!fs.existsSync(journal));
  checks.push('Repeated recovery interruptions retain durable original metadata and restore correctly despite unchanged file stamps');
  await repairThreadProviders(ctx);
  assert.equal(fs.statSync(undoFile, { bigint: true }).ino, originalInode, 'A cached compressed history was needlessly copied');
  const pending = JSON.parse(fs.readFileSync(journal));
  const snapshot = pending.undo.find(row => row.relative === path.relative(home, undoFile));
  assert(snapshot?.ranges.length, 'Compressed metadata was changed without durable recovery bytes');
  const fd = fs.openSync(undoFile, 'r+');
  fs.writeSync(fd, Buffer.alloc(20, 255), 0, 20, snapshot.ranges[0].offset); fs.closeSync(fd);
  fs.unlinkSync(path.join(root, 'data/cache/rollout-index.json'));
  await restoreThreadProviders(ctx);
  assert.deepEqual(fs.readFileSync(undoFile), originalCompressed, 'Interrupted metadata writes did not restore exact compressed bytes');
  assert.deepEqual(nativeDecompress(fs.readFileSync(undoFile)), undoBytes);
  checks.push('Cached compressed histories update only routing slots; interrupted writes recover exact original bytes even without the optional cache');
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await restoreThreadProviders(ctx);
  fs.rmSync(root, { recursive: true, force: true });
}
