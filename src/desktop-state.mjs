// Reuse the native account-scoped desktop preferences in API-only mode without
// borrowing the account's authentication. This journal never contains messages.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
export function restoreDesktopState({ root, home }) {
  const journal = journalFile(root);
  if (!fs.existsSync(journal)) return;
  const saved = JSON.parse(fs.readFileSync(journal, 'utf8'));
  if (saved.home !== fs.realpathSync(home)) throw new Error('Desktop preference recovery belongs to another native home.');
  const file = path.join(home, '.codex-global-state.json');
  let current;
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch {
    atomicPrivate(file, saved.originalText, { durable: true, temporaryPath: file + '.chatgpt-api.tmp' });
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
  const file = path.join(home, '.codex-global-state.json');
  if (!fs.existsSync(file)) return { applied: false };
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const scope = current[scopeKey];
  if (!scope) return { applied: false };
  // The native client keeps inactive snapshots in account-switch order. Prefer
  // the current owner, otherwise its most recently saved desktop state.
  const sourceId = scope.owner || Object.keys(scope.inactive || {}).at(-1);
  if (!sourceId) return { applied: false };
  const source = scope.owner ? { atoms: current[atomsKey] || {}, globals: {} } : scope.inactive[sourceId];
  if (scope.owner) {
    // Use the native snapshot's own key inventory for the globals it owns.
    for (const key of globalKeys) if (Object.hasOwn(current, key)) source.globals[key] = current[key];
  }
  if (!source?.globals || !source?.atoms) return { applied: false };
  const saved = { version: 1, home: fs.realpathSync(home), originalText: fs.readFileSync(file, 'utf8'), owner: scope.owner, sourceId, source, previousInactive: scope.inactive?.[sourceId],
    globals: Object.fromEntries(Object.keys(source.globals).filter(key => Object.hasOwn(current, key)).map(key => [key, current[key]])),
    atoms: Object.fromEntries(Object.keys(source.atoms).filter(key => Object.hasOwn(current[atomsKey] || {}, key)).map(key => [key, current[atomsKey][key]])) };
  atomicPrivate(journal, saved, { durable: true });
  for (const [key, value] of Object.entries(source.globals)) current[key] = value;
  current[atomsKey] = { ...current[atomsKey], ...source.atoms };
  current[scopeKey] = { ...scope, owner: null, inactive: { ...scope.inactive, [sourceId]: source } };
  atomicPrivate(file, current, { durable: true, temporaryPath: file + '.chatgpt-api.tmp' });
  return { applied: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, home, root] = process.argv.slice(2);
  if (command === 'begin') overlayDesktopState({ root, home });
  else if (command === 'restore') restoreDesktopState({ root, home });
  else throw new Error('Unknown desktop preference operation.');
}
