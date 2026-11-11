import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { overlayDesktopState, restoreDesktopState, recoverMissingDesktopState } from '../src/desktop-state.mjs';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(root, 'data/testing'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, 'data/testing/account-isolation-'));
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

console.log(JSON.stringify({ passed: true, checks: ['API-only project and onboarding state without account credentials', 'normal and interrupted restore without native scratch files', 'native preference edits retained in their original account scope', 'three repeated launches retain native preferences', 'explicit native account switches retain their own workspace', 'missing settings recover exact native snapshot memberships only when project IDs still exist'] }));
