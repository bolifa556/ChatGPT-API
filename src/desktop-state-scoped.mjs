import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { atomicPrivate } from './settings.mjs';

const fileName = '.codex-global-state.json';
const legacyKey = 'electron-account-renderer-state-v1';
const ownerKey = 'electron-renderer-content-owner';
const atomsKey = 'electron-persisted-atom-state';
const ownerAtoms = owner => 'electron-owner-atoms:' + owner;
const ownerValue = (key, owner) => 'electron-owner-value:' + key + ':' + owner;
const signedOut = 'signed-out';
const projectsKey = 'local-projects';
const assignmentsKey = 'thread-project-assignments';
const migrationKey = 'app-server-projects-migration-by-host';
const mappingKey = 'app-server-project-id-by-legacy-project-id-by-host';
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const hasOwner = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const hasEntries = value => Object.keys(record(value)).length > 0;

export function readDesktopJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { text, state: JSON.parse(text) };
  } catch (error) {
    if (!['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
    return null;
  }
}

function scopedFormat(state) {
  return !!state && (Object.hasOwn(state, ownerKey) ||
    Object.keys(state).some(key => key.startsWith(ownerAtoms('')) || key.startsWith('electron-owner-value:')));
}

// undefined means legacy JSON; null means an authoritative but unreadable/unknown store.
export function scopedDesktopStore(home, json) {
  const sqlite = path.join(home, '.codex-global-state.sqlite');
  if (fs.existsSync(sqlite)) {
    let db;
    try {
      db = new DatabaseSync(sqlite, { readOnly: true });
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version === 1) {
        const state = Object.create(null);
        const atoms = Object.create(null);
        for (const { scope, key, value } of db.prepare('SELECT scope, key, value FROM settings').iterate()) {
          if (scope === 'global') state[key] = JSON.parse(value);
          else if (scope === 'atom' || scope.startsWith(ownerAtoms(''))) {
            const bucket = scope === 'atom' ? atomsKey : scope;
            (atoms[bucket] ??= Object.create(null))[key] = JSON.parse(value);
          }
        }
        return { state: Object.assign(state, atoms), sqlite };
      }
      if (version !== 0) return null;
    } catch { return null; }
    finally { db?.close(); }
  }
  const file = path.join(home, fileName);
  const state = (json === undefined ? readDesktopJson(file) : json)?.state ?? readDesktopJson(file + '.bak')?.state;
  if (scopedFormat(state)) return { file, state };
}

function writeFields(store, fields) {
  const changes = Object.entries(fields).filter(([key, value]) => !equal(store.state[key], value));
  if (!changes.length) return;
  if (!store.sqlite) {
    const state = { ...store.state };
    for (const [key, value] of changes) if (value === undefined) delete state[key]; else state[key] = value;
    atomicPrivate(store.file, state, { durable: true, temporaryPath: store.file + '.chatgpt-api.tmp' });
  } else {
    const db = new DatabaseSync(store.sqlite);
    try {
      db.exec('BEGIN IMMEDIATE');
      const put = db.prepare('INSERT OR REPLACE INTO settings (scope, key, value) VALUES (?, ?, ?)');
      const remove = db.prepare('DELETE FROM settings WHERE scope = ? AND key = ?');
      const write = (scope, key, value) => value === undefined ? remove.run(scope, key) : put.run(scope, key, JSON.stringify(value));
      for (const [key, value] of changes) {
        if (!key.startsWith(ownerAtoms(''))) write('global', key, value);
        else for (const atom of new Set([...Object.keys(record(store.state[key])), ...Object.keys(record(value))])) {
          if (!equal(store.state[key]?.[atom], value?.[atom])) write(key, atom, value?.[atom]);
        }
      }
      db.exec('COMMIT');
    } finally { db.close(); }
  }
  for (const [key, value] of changes) {
    if (value === undefined) delete store.state[key];
    else store.state[key] = value;
  }
}

function snapshotForOwner(state, owner) {
  const scopedOwner = state?.[ownerKey], legacy = state?.[legacyKey];
  if (scopedOwner === owner) return { globals: state, atoms: state[ownerAtoms(owner)] };
  if (legacy?.owner === owner) return { globals: state, atoms: state[atomsKey] };
  if (legacy?.inactive?.[owner]) return legacy.inactive[owner];
  if (scopedOwner || legacy) return null;
  // An older, unscoped snapshot can establish ownership through its native
  // model preference key. Require a single identity; never infer it from paths.
  const identities = Object.keys(record(state?.[atomsKey])).flatMap(key => {
    const match = /^chatgpt-work-models-v1\/([^/]+)\/([^/]+)$/.exec(key);
    return match ? [createHash('sha256').update(JSON.stringify(match.slice(1))).digest('hex')] : [];
  });
  if (identities.length === 1 && identities[0] === owner) return { globals: state, atoms: state[atomsKey] };
}

function preferenceDefaults(source, target, permissions = false) {
  const keys = ['localeOverride', 'appearanceTheme', 'onboarding-completed', 'electron:onboarding-welcome-pending',
    'composer-recent-model-configurations-v1', 'composer-model-picker-selection-mode-v1', 'composer-model-picker-menu-view-v1'];
  const added = Object.fromEntries(keys.filter(key => Object.hasOwn(source, key) && !Object.hasOwn(target, key)).map(key => [key, source[key]]));
  const modeKey = 'agent-mode-by-host-id', permissionKey = 'permission-selection-by-host-id:local';
  if (permissions && !Object.hasOwn(target, permissionKey) && !Object.hasOwn(target, 'agent-mode') && !Object.hasOwn(record(target[modeKey]), 'local')) {
    if (Object.hasOwn(source, permissionKey)) added[permissionKey] = source[permissionKey];
    if (!Object.hasOwn(target, modeKey) && Object.hasOwn(record(source[modeKey]), 'local')) added[modeKey] = { local: source[modeKey].local };
  }
  return added;
}

export function overlayScopedDesktop({ home }, store, journal) {
  const { state } = store, active = state[ownerKey], targetKey = ownerAtoms(signedOut);
  const owners = Object.keys(state).filter(key => key.startsWith(ownerAtoms(''))).map(key => key.slice(ownerAtoms('').length)).filter(hasOwner);
  const owner = hasOwner(active) ? active : active === signedOut && owners.length === 1 ? owners[0] : null;
  if (!owner) return { applied: false };
  const target = record(state[targetKey]);
  const additions = preferenceDefaults(record(state[ownerAtoms(owner)]), { ...record(state[atomsKey]), ...target }, true);
  if (!hasEntries(additions)) return { applied: false };
  atomicPrivate(journal, { version: 3, home: fs.realpathSync(home), additions,
    hadTarget: Object.hasOwn(state, targetKey), json: !store.sqlite }, { durable: true });
  writeFields(store, { [targetKey]: { ...target, ...additions } });
  return { applied: true };
}

export function restoreScopedDesktop({ home }, store, saved, journal) {
  const revert = target => {
    const state = target.state, key = ownerAtoms(signedOut);
    const atoms = { ...record(state[key]) };
    let removed = false;
    for (const [name, value] of Object.entries(saved.additions)) {
      if (equal(atoms[name], value)) { delete atoms[name]; removed = true; }
    }
    if (removed) writeFields(target, { [key]: hasEntries(atoms) || saved.hadTarget ? atoms : undefined });
  };
  // Restore the seeds in the active store and any JSON copies the client kept,
  // including a JSON store that was imported into SQLite at native startup.
  if (store.sqlite) revert(store);
  const file = path.join(home, fileName);
  for (const json of store.sqlite ? (saved.json ? [file, file + '.bak'] : []) : [file, file + '.bak']) {
    const state = json === store.file ? store.state : readDesktopJson(json)?.state;
    if (scopedFormat(state)) revert({ file: json, state });
  }
  fs.unlinkSync(journal);
}

function* snapshots(home, legacyJournal) {
  if (legacyJournal?.originalText) {
    try { yield JSON.parse(legacyJournal.originalText); } catch { /* use native snapshots */ }
  }
  const files = fs.readdirSync(home).filter(name => name === fileName + '.bak' ||
    /^\.\.codex-global-state\.json(?:\.bak)?\.tmp-\d+-[a-f0-9-]+$/.test(name))
    .map(name => path.join(home, name)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of files) {
    const document = readDesktopJson(file);
    if (document) yield document.state;
  }
}

export function recoverScopedProjects({ home }, store, legacyJournal) {
  const { state } = store, owner = state[ownerKey];
  const host = 'local:' + path.resolve(home), scopedMigration = ownerValue(migrationKey, owner);
  const migration = state[scopedMigration]?.[host];
  // An existing assignment map (even empty) may reflect a user's edits.
  if (!hasOwner(owner) || !migration?.projectsMigrated || migration.threadAssignmentsMigrated !== false ||
      hasEntries(state[projectsKey]) || Object.hasOwn(state, assignmentsKey)) return { recovered: false };
  const database = fs.readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
  if (!database) return { recovered: false };
  const projectless = new Set(Array.isArray(state['projectless-thread-ids']) ? state['projectless-thread-ids'] : []);
  const pendingDeletion = record(state[ownerValue('app-server-pending-project-deletions-by-host', owner)]?.[host]);
  let db;
  try {
    db = new DatabaseSync(path.join(home, database), { readOnly: true });
    const projects = new Set(db.prepare('SELECT id FROM projects').all().map(row => row.id));
    const thread = db.prepare('SELECT project_id FROM threads WHERE id = ?');
    if (!projects.size) return { recovered: false };
    for (const candidate of snapshots(home, legacyJournal)) {
      const snapshot = snapshotForOwner(candidate, owner), globals = snapshot?.globals;
      const oldMap = record(globals?.[mappingKey]?.[host]);
      const currentMap = record(state[mappingKey]?.[host]);
      const map = Object.fromEntries(Object.entries(oldMap).filter(([id, target]) => projects.has(target) &&
        !Object.hasOwn(pendingDeletion, target) && !Object.hasOwn(pendingDeletion, id) &&
        record(globals?.[projectsKey])[id]?.id === id && (!Object.hasOwn(currentMap, id) || currentMap[id] === target)));
      const assigned = Object.fromEntries(Object.entries(record(globals?.[assignmentsKey])).filter(([id, link]) => {
        if (link?.projectKind !== 'local' || !Object.hasOwn(map, link.projectId) || projectless.has(id)) return false;
        const current = thread.get(id)?.project_id;
        return current === null || current === map[link.projectId];
      }));
      const ids = Object.keys(assigned);
      if (!ids.length) continue;
      const scope = record(state[scopedMigration]);
      const fields = {
        [assignmentsKey]: assigned,
        [projectsKey]: Object.fromEntries(Object.keys(map).map(id => [id, globals[projectsKey][id]])),
        [mappingKey]: { ...record(state[mappingKey]), [host]: { ...map, ...currentMap } },
        [scopedMigration]: { ...scope, [host]: { ...migration,
          pendingThreadAssignmentIds: [...new Set([...(migration.pendingThreadAssignmentIds || []), ...ids])] } },
      };
      if (!Object.hasOwn(state, 'project-order') && Array.isArray(globals['project-order'])) {
        fields['project-order'] = globals['project-order'].filter(id => Object.hasOwn(map, id));
      }
      if (!Object.hasOwn(state, 'sidebar-project-thread-orders') && hasEntries(globals['sidebar-project-thread-orders'])) {
        fields['sidebar-project-thread-orders'] = Object.fromEntries(Object.entries(record(globals['sidebar-project-thread-orders']))
          .filter(([id, layout]) => Object.hasOwn(map, id) && Array.isArray(layout?.threadIds))
          .map(([id, layout]) => [id, { ...layout, threadIds: layout.threadIds.filter(threadId => assigned[threadId]?.projectId === id) }]));
      }
      const currentAtoms = record(state[ownerAtoms(owner)]);
      // An old backup must never reinstate an access setting that may have
      // been changed since. Native permission choices remain authoritative.
      const additions = preferenceDefaults(record(snapshot.atoms), { ...currentAtoms, ...record(state[atomsKey]) });
      if (hasEntries(additions)) fields[ownerAtoms(owner)] = { ...currentAtoms, ...additions };
      // The native project migration consumes these settings and updates its
      // thread index. Never write that database from the launcher.
      writeFields(store, fields);
      return { recovered: true, projects: Object.keys(map).length, assignments: ids.length };
    }
  } catch (error) {
    if (error.code !== 'ERR_SQLITE_ERROR') throw error;
  } finally { db?.close(); }
  return { recovered: false };
}
