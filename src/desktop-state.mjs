// Reuse the native account-scoped desktop preferences in API-only mode without
// borrowing the account's authentication. This journal never contains messages.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { atomicPrivate } from './settings.mjs';

const scopeKey = 'electron-account-renderer-state-v1';
const atomsKey = 'electron-persisted-atom-state';
const globalKeys = ['active-workspace-roots', 'electron-saved-workspace-roots', 'local-projects',
  'app-server-project-id-by-legacy-project-id-by-host', 'app-server-projects-migration-by-host',
  'selected-project', 'project-appearances', 'pinned-thread-ids', 'app-server-migrated-pinned-thread-ids-by-host',
  'sidebar-project-thread-orders', 'thread-project-assignments', 'thread-project-membership-host-ids',
  'thread-writable-roots', 'thread-workspace-root-hints', 'thread-projectless-output-directories',
  'projectless-thread-ids', 'selected-remote-host-id', 'project-order', 'remote-project-connection-backfill-completed',
  'remote-connection-auto-connect-by-host-id', 'queued-follow-ups'];
const journalFile = root => path.join(root, 'data/state/desktop-state-compatibility.json');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function assign(target, key, value) { if (value === undefined) delete target[key]; else target[key] = value; }
function snapshot(state) {
  return { atoms: structuredClone(state[atomsKey] || {}),
    globals: Object.fromEntries(globalKeys.filter(key => Object.hasOwn(state, key)).map(key => [key, structuredClone(state[key])])) };
}
function writeState(file, value) {
  atomicPrivate(file, value, { durable: true, temporaryPath: file + '.chatgpt-api.tmp' });
}
export function recoverMissingDesktopState({ root, home }) {
  const file = path.join(home, '.codex-global-state.json');
  if (!fs.existsSync(file)) return { recovered: false };
  const current = JSON.parse(fs.readFileSync(file, 'utf8')), scope = current[scopeKey];
  if (!scope || scope.owner) return { recovered: false };
  const states = [current, ...Object.values(scope.inactive || {}).map(value => value.globals || {})];
  // Explicit empty project settings can be intentional. Recover only the
  // missing-key state left by a cleared native account scope.
  if (states.some(value => Object.hasOwn(value, 'local-projects') || Object.hasOwn(value, 'thread-project-assignments'))) return { recovered: false };
  const database = fs.readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])).at(-1);
  if (!database) return { recovered: false };
  const db = new DatabaseSync(path.join(home, database), { readOnly: true });
  let projects;
  try { projects = new Set(db.prepare('SELECT id FROM projects').all().map(row => row.id)); }
  catch { return { recovered: false }; }
  finally { db.close(); }
  if (!projects.size) return { recovered: false };
  const candidates = fs.readdirSync(home).filter(name => name === '.codex-global-state.json.bak'
    || /^\.\.codex-global-state\.json(?:\.bak)?\.tmp-\d+-[a-f0-9-]+$/.test(name))
    .map(name => ({ file: path.join(home, name), time: fs.statSync(path.join(home, name)).mtimeMs })).sort((a, b) => b.time - a.time);
  for (const candidate of candidates) {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(candidate.file, 'utf8')); } catch { continue; }
    const ids = Object.keys(saved['local-projects'] || {});
    if (!ids.length || !Object.keys(saved['thread-project-assignments'] || {}).length) continue;
    const mapping = saved['app-server-project-id-by-legacy-project-id-by-host']?.['local:' + home] || {};
    if (!ids.every(id => projects.has(mapping[id] || id))) continue;
    const sourceId = Object.keys(scope.inactive || {}).at(-1);
    if (!sourceId) continue;
    // Keep the latest preferences and fill only the settings the native reset
    // removed. Project IDs and memberships come directly from its own snapshot.
    const prior = scope.inactive[sourceId];
    const recovered = snapshot(saved);
    scope.inactive[sourceId] = { atoms: { ...recovered.atoms, ...prior.atoms }, globals: { ...recovered.globals, ...prior.globals } };
    atomicPrivate(path.join(root, 'data/state/desktop-state-repair.json'), {
      home: fs.realpathSync(home), source: candidate.file, originalText: fs.readFileSync(file, 'utf8'),
      projects: ids.length, assignments: Object.keys(saved['thread-project-assignments']).length,
    }, { durable: true });
    writeState(file, current); writeState(file + '.bak', current);
    return { recovered: true, projects: ids.length, assignments: Object.keys(saved['thread-project-assignments']).length };
  }
  return { recovered: false };
}
export function restoreDesktopState({ root, home }) {
  const journal = journalFile(root);
  if (!fs.existsSync(journal)) return;
  const saved = JSON.parse(fs.readFileSync(journal, 'utf8'));
  if (saved.home !== fs.realpathSync(home)) throw new Error('Desktop preference recovery belongs to another native home.');
  const file = path.join(home, '.codex-global-state.json');
  if (saved.version === 2) {
    let current;
    try { current = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch {
      try {
        const backup = fs.readFileSync(file + '.bak', 'utf8');
        current = backup === saved.backupText ? structuredClone(saved.applied) : JSON.parse(backup);
      }
      catch { current = structuredClone(saved.applied); }
    }
    if (equal(current, saved.applied)) {
      writeState(file, saved.originalText);
      if (saved.backupText !== undefined) writeState(file + '.bak', saved.backupText);
      else if (fs.existsSync(file + '.bak')) fs.unlinkSync(file + '.bak');
    } else {
      const updated = snapshot(current), scope = structuredClone(saved.scope);
      if (scope) {
        const native = current[scopeKey];
        if (native?.owner) {
          const inactive = { ...scope.inactive, ...native.inactive };
          if (scope.owner && scope.owner !== native.owner && !inactive[scope.owner]) inactive[scope.owner] = snapshot(saved.applied);
          current[scopeKey] = { ...native, inactive };
          writeState(file, current); writeState(file + '.bak', current);
          fs.unlinkSync(journal); return;
        }
        // API preferences belong to the same desktop workspace. Preserve edits
        // in that original account's snapshot when the account is inactive.
        if (!scope.owner && saved.sourceId) scope.inactive[saved.sourceId] = updated;
        if (!scope.owner) {
          const original = JSON.parse(saved.originalText);
          for (const key of globalKeys) assign(current, key, original[key]);
          assign(current, atomsKey, original[atomsKey]);
        }
        // An explicit sign-in during this run can create a new native scope.
        // Retain it, including its saved account state and selected owner.
        current[scopeKey] = native ? { ...scope, ...native, inactive: { ...scope.inactive, ...native.inactive } } : scope;
      }
      writeState(file, current);
      writeState(file + '.bak', current);
    }
    fs.unlinkSync(journal);
    return;
  }
  let current;
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch {
    atomicPrivate(file, saved.originalText, { durable: true, temporaryPath: file + '.chatgpt-api.tmp' });
    fs.unlinkSync(journal); return;
  }
  if (saved.version === 1 && saved.source?.globals?.['local-projects']
      && !Object.hasOwn(current, 'local-projects') && !Object.hasOwn(current, 'thread-project-assignments')
      && !current[scopeKey]?.owner) {
    // The former null-owner overlay was cleared by native startup. Missing
    // values are the reset itself, not edits to delete the saved preferences.
    const original = JSON.parse(saved.originalText);
    for (const key of [...globalKeys, atomsKey, scopeKey]) assign(current, key, original[key]);
    writeState(file, current); writeState(file + '.bak', current);
    fs.unlinkSync(journal); return;
  }
  const source = structuredClone(saved.source);
  for (const [key, applied] of Object.entries(saved.source.globals || {})) {
    if (!equal(current[key], applied)) assign(source.globals, key, current[key]);
    if (!saved.owner) assign(current, key, saved.globals[key]);
  }
  const atoms = current[atomsKey] || {};
  for (const [key, applied] of Object.entries(saved.source.atoms || {})) {
    if (!equal(atoms[key], applied)) assign(source.atoms, key, atoms[key]);
    if (!saved.owner) assign(atoms, key, saved.atoms[key]);
  }
  current[atomsKey] = atoms;
  const inactive = { ...current[scopeKey]?.inactive };
  if (saved.owner) assign(inactive, saved.sourceId, saved.previousInactive);
  else inactive[saved.sourceId] = source;
  current[scopeKey] = { ...current[scopeKey], owner: saved.owner, inactive };
  atomicPrivate(file, current, { durable: true, temporaryPath: file + '.chatgpt-api.tmp' });
  fs.unlinkSync(journal);
}
export function overlayDesktopState({ root, home }) {
  const journal = journalFile(root);
  if (fs.existsSync(journal)) {
    const saved = JSON.parse(fs.readFileSync(journal, 'utf8'));
    if (saved.home !== fs.realpathSync(home)) throw new Error('Desktop preference recovery belongs to another native home.');
    return { applied: true, reused: true };
  }
  recoverMissingDesktopState({ root, home });
  const file = path.join(home, '.codex-global-state.json');
  if (!fs.existsSync(file)) return { applied: false };
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const scope = current[scopeKey];
  if (!scope) return { applied: false };
  // The native client keeps inactive snapshots in account-switch order. Prefer
  // the current owner, otherwise its most recently saved desktop state.
  const sourceId = scope.owner || Object.keys(scope.inactive || {}).at(-1);
  const source = scope.owner ? snapshot(current) : scope.inactive?.[sourceId];
  const saved = { version: 2, home: fs.realpathSync(home), originalText: fs.readFileSync(file, 'utf8'), scope, sourceId };
  if (fs.existsSync(file + '.bak')) saved.backupText = fs.readFileSync(file + '.bak', 'utf8');
  if (source?.globals && source?.atoms) {
    for (const [key, value] of Object.entries(source.globals)) current[key] = value;
    current[atomsKey] = { ...current[atomsKey], ...source.atoms };
  }
  // A null owner is an instruction to the native constructor to clear all
  // account-scoped atoms and sidebar data. Temporarily use the native unscoped
  // storage format instead, with the complete scope saved in our own journal.
  delete current[scopeKey];
  saved.applied = current;
  atomicPrivate(journal, saved, { durable: true });
  writeState(file, current);
  return { applied: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, home, root] = process.argv.slice(2);
  if (command === 'begin') overlayDesktopState({ root, home });
  else if (command === 'restore') restoreDesktopState({ root, home });
  else throw new Error('Unknown desktop preference operation.');
}
