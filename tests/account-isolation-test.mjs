import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { overlayDesktopState, restoreDesktopState } from '../src/desktop-state.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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
  assert.equal(applied['electron-account-renderer-state-v1'].owner, null);
  assert.deepEqual(applied['local-projects'], snapshot.globals['local-projects']);
  assert.equal(applied['electron-persisted-atom-state']['onboarding-completed'], true);
  restoreDesktopState(ctx);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), baseline);
  assert(!fs.existsSync(path.join(fixture, 'data/state/desktop-state-compatibility.json')));
  assert(!fs.readdirSync(home).some(name => name.endsWith('.tmp')));
}
const baseline = { 'electron-persisted-atom-state': {}, 'electron-account-renderer-state-v1': { owner: null, inactive: { account: snapshot } } };
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

console.log(JSON.stringify({ passed: true, checks: ['API-only project and onboarding state without account credentials', 'normal and interrupted restore without native scratch files', 'native preference edits retained in their original account scope'] }));
