import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { overlayDesktopState, restoreDesktopState, recoverMissingDesktopState, recoverCurrentDesktopState } from '../src/desktop-state.mjs';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(root, 'data/testing'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, 'data/testing/account-isolation-'));
process.on('exit', () => fs.rmSync(fixture, { recursive: true, force: true }));
const home = path.join(fixture, 'home'); fs.mkdirSync(home);
const ctx = { root: fixture, home }, file = path.join(home, '.codex-global-state.json');
const snapshot = { atoms: { 'saved-mode': 'work', 'onboarding-completed': true }, globals: { 'local-projects': { project: { name: 'Original' } }, 'project-order': ['project'] } };
for (const owner of [null, 'account']) {
  const baseline = { 'electron-persisted-atom-state': owner ? snapshot.atoms : { locale: 'zh-CN' },
    'electron-account-renderer-state-v1': { owner, inactive: owner ? {} : { account: snapshot } },
    ...(owner ? snapshot.globals : {}), unrelated: true };
  fs.writeFileSync(file, JSON.stringify(baseline));
  assert.equal(overlayDesktopState(ctx).applied, true);
  const applied = JSON.parse(fs.readFileSync(file));
  assert.equal(overlayDesktopState(ctx).reused, true);
  assert.equal(applied['electron-account-renderer-state-v1'], undefined, 'Native startup clears preferences when the scope exists with a null owner');
  assert.deepEqual(applied['local-projects'], snapshot.globals['local-projects']);
  assert.equal(applied['electron-persisted-atom-state']['onboarding-completed'], true);
  restoreDesktopState(ctx);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), baseline);
  assert(!fs.existsSync(path.join(fixture, 'data/state/desktop-state-compatibility.json')));
  assert(!fs.readdirSync(home).some(name => name.endsWith('.tmp')));
}
const baseline = { 'electron-persisted-atom-state': {}, 'electron-account-renderer-state-v1': { owner: null, inactive: { account: snapshot } } };
for (const owner of [null, 'account']) {
  const before = { 'electron-persisted-atom-state': owner ? snapshot.atoms : {},
    'electron-account-renderer-state-v1': { owner, inactive: owner ? {} : { account: snapshot } },
    ...(owner ? snapshot.globals : {}) };
  fs.writeFileSync(file, JSON.stringify(before));
  for (let cycle = 0; cycle < 3; cycle++) {
    overlayDesktopState(ctx);
    const during = JSON.parse(fs.readFileSync(file));
    during['electron-persisted-atom-state']['localeOverride'] = 'zh-CN';
    during['electron-persisted-atom-state']['appearanceTheme'] = 'dark';
    during['electron-account-renderer-state-v1'] = { owner: null, inactive: { account: snapshot } };
    fs.writeFileSync(file, JSON.stringify(during));
    restoreDesktopState(ctx);
    const after = JSON.parse(fs.readFileSync(file));
    assert.equal(after['electron-account-renderer-state-v1'].owner, owner);
    const atoms = owner ? after['electron-persisted-atom-state'] : after['electron-account-renderer-state-v1'].inactive.account.atoms;
    assert.equal(atoms.localeOverride, 'zh-CN');
    assert.equal(atoms.appearanceTheme, 'dark');
  }
}
fs.writeFileSync(file, JSON.stringify(baseline)); overlayDesktopState(ctx);
const edited = JSON.parse(fs.readFileSync(file)); edited['local-projects'].project.name = 'Updated'; edited.unrelated = 4;
fs.writeFileSync(file, JSON.stringify(edited)); restoreDesktopState(ctx);
const restored = JSON.parse(fs.readFileSync(file));
assert.equal(restored['local-projects'], undefined);
assert.equal(restored['electron-account-renderer-state-v1'].inactive.account.globals['local-projects'].project.name, 'Updated');
assert.equal(restored.unrelated, 4);
fs.writeFileSync(file, JSON.stringify(baseline)); overlayDesktopState(ctx);
fs.writeFileSync(file, 'interrupted native preference write'); restoreDesktopState(ctx);
assert.deepEqual(JSON.parse(fs.readFileSync(file)), baseline);

// The exact native startup rule clears state whenever this marker exists with
// a null owner. Its complete absence is required for unscoped API preferences.
for (let cycle = 0; cycle < 3; cycle++) {
  overlayDesktopState(ctx);
  const state = JSON.parse(fs.readFileSync(file));
  assert(!Object.hasOwn(state, 'electron-account-renderer-state-v1'));
  assert.equal(state['local-projects'].project.name, 'Original');
  restoreDesktopState(ctx);
}

fs.writeFileSync(file, JSON.stringify(baseline)); overlayDesktopState(ctx);
const nativeBackup = JSON.parse(fs.readFileSync(file));
nativeBackup['local-projects'].project.name = 'Latest native backup';
fs.writeFileSync(file + '.bak', JSON.stringify(nativeBackup));
fs.writeFileSync(file, 'interrupted native preference write'); restoreDesktopState(ctx);
assert.equal(JSON.parse(fs.readFileSync(file))['electron-account-renderer-state-v1'].inactive.account.globals['local-projects'].project.name, 'Latest native backup');

fs.writeFileSync(file, JSON.stringify(baseline)); overlayDesktopState(ctx);
const switched = JSON.parse(fs.readFileSync(file));
switched['electron-account-renderer-state-v1'] = { owner: 'new-account', inactive: {} };
switched['local-projects'] = { different: { name: 'New account workspace' } };
fs.writeFileSync(file, JSON.stringify(switched)); restoreDesktopState(ctx);
assert.equal(JSON.parse(fs.readFileSync(file))['local-projects'].different.name, 'New account workspace');
assert.equal(JSON.parse(fs.readFileSync(file))['electron-account-renderer-state-v1'].owner, 'new-account');

// Recover only native-recorded settings whose mapped project IDs still exist.
// An explicit empty project map is respected and no memberships are inferred.
const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY)'); db.prepare('INSERT INTO projects VALUES(?)').run('native-project'); db.close();
const saved = { 'local-projects': { legacy: { id: 'legacy', name: 'Recovered project' } },
  'thread-project-assignments': { thread: { projectKind: 'local', projectId: 'legacy' } },
  'app-server-project-id-by-legacy-project-id-by-host': { ['local:' + home]: { legacy: 'native-project' } },
  'electron-persisted-atom-state': { 'onboarding-completed': true } };
fs.writeFileSync(path.join(home, '..codex-global-state.json.tmp-123456789-fixture'), JSON.stringify(saved));
const nativeSnapshot = path.join(home, '..codex-global-state.json.tmp-123456789-abcdef00');
fs.renameSync(path.join(home, '..codex-global-state.json.tmp-123456789-fixture'), nativeSnapshot);
fs.writeFileSync(file, JSON.stringify(baseline));
assert.equal(recoverMissingDesktopState(ctx).recovered, false);
fs.writeFileSync(file, JSON.stringify({ 'electron-account-renderer-state-v1': { owner: null, inactive: { account: { atoms: {}, globals: {} } } }, unrelated: 'keep' }));
const recovery = recoverMissingDesktopState(ctx); assert.equal(recovery.recovered, true);
assert.equal(recovery.projects, 1); assert.equal(recovery.assignments, 1);
overlayDesktopState(ctx);
assert.deepEqual(JSON.parse(fs.readFileSync(file))['thread-project-assignments'], saved['thread-project-assignments']);
assert.equal(JSON.parse(fs.readFileSync(file)).unrelated, 'keep');
restoreDesktopState(ctx); assert.equal(recoverMissingDesktopState(ctx).recovered, false);

const legacyOriginal = { 'electron-account-renderer-state-v1': { owner: 'old-account', inactive: {} },
  'local-projects': saved['local-projects'], 'thread-project-assignments': saved['thread-project-assignments'],
  'electron-persisted-atom-state': saved['electron-persisted-atom-state'] };
fs.writeFileSync(path.join(fixture, 'data/state/desktop-state-compatibility.json'), JSON.stringify({
  version: 1, home: fs.realpathSync(home), originalText: JSON.stringify(legacyOriginal),
  source: { atoms: saved['electron-persisted-atom-state'], globals: { 'local-projects': saved['local-projects'] } },
}));
fs.writeFileSync(file, JSON.stringify({ 'electron-account-renderer-state-v1': { owner: null, inactive: {} }, unrelated: 'new-value' }));
restoreDesktopState(ctx);
const legacyRestored = JSON.parse(fs.readFileSync(file));
assert.deepEqual(legacyRestored['thread-project-assignments'], legacyOriginal['thread-project-assignments']);
assert.equal(legacyRestored['electron-account-renderer-state-v1'].owner, 'old-account');
assert.equal(legacyRestored.unrelated, 'new-value');

const journal = path.join(fixture, 'data/state/desktop-state-compatibility.json');
for (const future of ['unsupported JSON', '[]', '{"electron-account-renderer-state-v1":{"owner":{"type":"account"}}}']) {
  fs.writeFileSync(file, future);
  assert.equal(overlayDesktopState(ctx).applied, false);
  assert(!fs.existsSync(journal));
  assert.equal(fs.readFileSync(file, 'utf8'), future);
}
fs.writeFileSync(file, JSON.stringify(baseline));
overlayDesktopState(ctx);
const overlay = fs.readFileSync(file, 'utf8'), savedJournal = fs.readFileSync(journal);
const futureScope = '{"electron-account-renderer-state-v1":{"owner":{"type":"account"}}}';
fs.writeFileSync(file, futureScope);
assert.equal(restoreDesktopState(ctx).pending, true);
assert.equal(overlayDesktopState(ctx).applied, false);
assert.equal(fs.readFileSync(file, 'utf8'), futureScope);
assert.deepEqual(fs.readFileSync(journal), savedJournal);
fs.writeFileSync(file, overlay);
restoreDesktopState(ctx);
assert.deepEqual(JSON.parse(fs.readFileSync(file)), baseline);

const ownerKey = 'electron-renderer-content-owner';
const owner = createHash('sha256').update(JSON.stringify(['fixture-user', 'fixture-account'])).digest('hex');
const ownerAtoms = 'electron-owner-atoms:' + owner;
const guestAtoms = 'electron-owner-atoms:signed-out';
const checkpoint = 'electron-owner-value:app-server-projects-migration-by-host:' + owner;
const host = 'local:' + home;
const permission = 'permission-selection-by-host-id:local', recent = 'composer-recent-model-configurations-v1';
const scoped = { [ownerKey]: owner, [ownerAtoms]: { [permission]: { mode: 'ask' }, [recent]: [{ model: 'current' }],
  'agent-mode-by-host-id': { local: 'default', remote: 'full-access' }, 'composer-drafts-v1': { secret: 'never copy' } },
  [checkpoint]: { [host]: { projectsMigrated: true, threadAssignmentsMigrated: false, threadAssignmentsReadMigrated: true } },
  'local-projects': {}, 'projectless-thread-ids': ['detached'], unrelated: 'keep' };
const historical = { ...saved,
  'electron-persisted-atom-state': { 'chatgpt-work-models-v1/fixture-user/fixture-account': {}, [permission]: { mode: 'full-access' },
    [recent]: [{ model: 'older' }], 'onboarding-completed': true },
  'local-projects': { ...saved['local-projects'], removed: { id: 'removed', name: 'Deleted project' } },
  'app-server-project-id-by-legacy-project-id-by-host': { [host]: { legacy: 'native-project', removed: 'nonexistent' } },
  'project-order': ['legacy', 'removed'],
  'sidebar-project-thread-orders': { legacy: { threadIds: ['present', 'deleted', 'reassigned'] } },
  'thread-project-assignments': Object.fromEntries(['present', 'detached', 'deleted', 'reassigned'].map(id => [id, { projectId: 'legacy', projectKind: 'local' }])) };
const threads = new DatabaseSync(path.join(home, 'state_5.sqlite'));
threads.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, project_id TEXT); INSERT INTO threads VALUES ('present', NULL), ('detached', NULL), ('reassigned', 'new-project')");
threads.close();

// Upgrade while a legacy overlay is active. Its journal supplies the native
// migration input without ever replacing the newer account or preference data.
fs.writeFileSync(file, JSON.stringify(scoped));
fs.writeFileSync(journal, JSON.stringify({ version: 2, home: fs.realpathSync(home), originalText: JSON.stringify(historical) }));
restoreDesktopState(ctx);
const repaired = JSON.parse(fs.readFileSync(file));
assert.equal(repaired[ownerKey], owner);
assert.equal(repaired['electron-account-renderer-state-v1'], undefined);
assert.deepEqual(repaired['thread-project-assignments'], { present: historical['thread-project-assignments'].present });
assert.deepEqual(repaired[checkpoint][host].pendingThreadAssignmentIds, ['present']);
assert.deepEqual(repaired['project-order'], ['legacy']);
assert.deepEqual(repaired['sidebar-project-thread-orders'], { legacy: { threadIds: ['present'] } });
assert.deepEqual(repaired[ownerAtoms], { ...scoped[ownerAtoms], 'onboarding-completed': true });
assert.equal(repaired.unrelated, 'keep');
assert(!fs.existsSync(journal));
const unchangedThreads = new DatabaseSync(path.join(home, 'state_5.sqlite'), { readOnly: true });
assert.equal(unchangedThreads.prepare('SELECT project_id FROM threads WHERE id = ?').get('present').project_id, null,
  'Only the native migration may write thread project IDs');
unchangedThreads.close();

// The mixed entry recovers the same data from a verified native snapshot.
const rejectedSnapshot = { ...historical, 'electron-persisted-atom-state': {
  'chatgpt-work-models-v1/different-user/fixture-account': {} } };
fs.writeFileSync(file, JSON.stringify(scoped));
fs.writeFileSync(nativeSnapshot, JSON.stringify(rejectedSnapshot));
assert.deepEqual(recoverCurrentDesktopState(ctx), { recovered: false });
fs.writeFileSync(nativeSnapshot, JSON.stringify(historical));
assert.deepEqual(recoverCurrentDesktopState(ctx), { recovered: true, projects: 1, assignments: 1 });
assert.deepEqual(recoverCurrentDesktopState(ctx), { recovered: false });
fs.writeFileSync(file, JSON.stringify({ ...scoped, 'thread-project-assignments': {} }));
assert.deepEqual(recoverCurrentDesktopState(ctx), { recovered: false }, 'An explicit empty assignment map remains empty');

// The client selects the signed-out view on API-only startup. Only known UI
// defaults are seeded, and the client's own preference edits survive recovery.
const presets = { ...repaired, [guestAtoms]: { [permission]: { mode: 'locked' } } };
fs.writeFileSync(file, JSON.stringify(presets));
assert.equal(overlayDesktopState(ctx).applied, true);
const launched = JSON.parse(fs.readFileSync(file));
assert.equal(launched[ownerKey], owner);
assert.deepEqual(launched[guestAtoms], { [permission]: { mode: 'locked' }, [recent]: repaired[ownerAtoms][recent], 'onboarding-completed': true });
launched[ownerKey] = 'signed-out';
launched[guestAtoms][recent] = [{ model: 'user selected' }];
launched.unrelated = 'client wrote this';
fs.writeFileSync(file + '.bak', JSON.stringify(launched));
fs.writeFileSync(file, 'interrupted native state write');
restoreDesktopState(ctx);
const recoveredGuest = JSON.parse(fs.readFileSync(file));
assert.equal(recoveredGuest[ownerKey], 'signed-out', 'The native client is responsible for choosing the active account');
assert.equal(recoveredGuest.unrelated, launched.unrelated);
assert.deepEqual(recoveredGuest[guestAtoms], { [permission]: { mode: 'locked' }, [recent]: [{ model: 'user selected' }] });
assert.deepEqual(recoveredGuest[ownerAtoms], repaired[ownerAtoms]);
assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak')), recoveredGuest);
assert(!fs.existsSync(journal));

const globalDb = path.join(home, '.codex-global-state.sqlite');
const store = new DatabaseSync(globalDb);
store.exec('PRAGMA user_version=1; CREATE TABLE settings (scope TEXT, key TEXT, value TEXT, PRIMARY KEY(scope,key)) WITHOUT ROWID');
const put = store.prepare('INSERT INTO settings VALUES (?, ?, ?)');
for (const [key, value] of Object.entries(scoped)) put.run('global', key, JSON.stringify(key === ownerAtoms ? {} : value));
for (const [key, value] of Object.entries(repaired[ownerAtoms])) put.run(ownerAtoms, key, JSON.stringify(value));
store.close();
const jsonBefore = fs.readFileSync(file);
assert.equal(recoverCurrentDesktopState(ctx).assignments, 1);
assert.equal(overlayDesktopState(ctx).applied, true);
const openDb = new DatabaseSync(globalDb);
const read = openDb.prepare('SELECT value FROM settings WHERE scope = ? AND key = ?');
assert.deepEqual(JSON.parse(read.get('global', 'thread-project-assignments').value), repaired['thread-project-assignments']);
assert.deepEqual(JSON.parse(read.get(guestAtoms, recent).value), repaired[ownerAtoms][recent]);
assert.deepEqual(JSON.parse(read.get(guestAtoms, 'agent-mode-by-host-id').value), { local: 'default' });
openDb.close();
restoreDesktopState(ctx);
const afterDb = new DatabaseSync(globalDb, { readOnly: true });
assert.equal(afterDb.prepare('SELECT count(*) AS n FROM settings WHERE scope = ?').get(guestAtoms).n, 0);
assert(afterDb.prepare('SELECT value FROM settings WHERE scope = ? AND key = ?').get(ownerAtoms, permission));
afterDb.close();
assert.deepEqual(fs.readFileSync(file), jsonBefore, 'An active native SQLite store must not write stale JSON');

console.log(JSON.stringify({ passed: true, checks: ['legacy desktop preferences and interrupted recovery', 'owner-scoped JSON and SQLite',
  'native project migration input and account verification', 'signed-out preference isolation and retained user edits'] }));
