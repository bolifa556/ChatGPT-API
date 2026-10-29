import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { processIdentity, alive, runningClients, requireClosedClient, clientExecutable, nativeCli, officialProxy, startNativeClient } from './platform.mjs';
import { hasChatGPTLogin, nativeVersion } from './native.mjs';
import { repairThreadProviders } from '../src/repair-thread-providers.mjs';
import { prepareWithRecovery, updateEnv, restoreRootLine } from '../src/gateway-recovery.mjs';
import { syncLegacySettings, userApiSettings } from '../src/settings.mjs';
export { requireClosedClient } from './platform.mjs';

const run = promisify(execFile), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const providerId = 'chatgpt_api_launcher';
export const rootKeys = ['openai_base_url', 'model_provider', 'model_catalog_json', 'model', 'model_reasoning_effort', 'model_context_window', 'model_auto_compact_token_limit'];
export const entryModes = ['official', 'api', 'apionly'];
export function context(root = process.env.CHATGPT_API_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return { root, home, data: path.join(root, 'data'), config: path.join(home, 'config.toml'), node: path.join(root, 'runtime/node') };
}
export function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
export function atomic(file, value, mode = 0o600) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Refusing to replace a symbolic link: ' + file);
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, text, { mode }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
export function readSettings(ctx) {
  let text = ''; try { text = fs.readFileSync(path.join(ctx.data, '.env'), 'utf8'); } catch {}
  return Object.fromEntries(text.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#') && line.includes('='))
    .map(line => { const at = line.indexOf('='); return [line.slice(0, at).trim(), line.slice(at + 1).trim()]; }));
}
export function userSettings(ctx) { return userApiSettings(ctx.root, readSettings(ctx)); }
export function settingsChecked(settings) {
  const base = (settings.BASE_URL || '').trim().replace(/\/+$/, '').replace(/\/(models|responses)$/, '');
  let url; try { url = new URL(base); } catch { throw new Error('Enter a valid http:// or https:// API base URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[\r\n]/.test(base)) throw new Error('API URL must not contain credentials, a query, or a fragment.');
  const key = (settings.API_KEY || '').trim();
  if (!key || /[\r\n]/.test(key)) throw new Error('API Key is missing or invalid. Run chatgpt-apionly configure.');
  const port = Number(settings.SHIM_PORT || 8102);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Local port must be between 1024 and 65535.');
  return { BASE_URL: base.endsWith('/v1') ? base : base + '/v1', API_KEY: key, SHIM_PORT: port };
}
function statePath(ctx, name) { return path.join(ctx.data, 'state', name + '.json'); }
async function locked(ctx, action, name = 'provider-lock') {
  const file = statePath(ctx, name), owner = processIdentity(process.pid);
  if (!owner) throw new Error('Cannot identify this provider process.');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const until = Date.now() + 20000;
  while (true) {
    try { const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, JSON.stringify(owner)); } finally { fs.closeSync(fd); } break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = readJson(file);
      let oldEmptyFile = false;
      if (!previous) {
        try { oldEmptyFile = Date.now() - fs.statSync(file).mtimeMs > 15000; }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      }
      if ((previous && !alive(previous)) || oldEmptyFile) { try { fs.unlinkSync(file); } catch {} continue; }
      if (Date.now() > until) throw new Error('Another provider operation is still running.');
      await delay(100);
    }
  }
  try { return await action(); }
  finally { const current = readJson(file); if (current?.pid === owner.pid && current.start === owner.start) fs.unlinkSync(file); }
}
function buildId(ctx) {
  const hash = crypto.createHash('sha256');
  for (const file of ['shim.mjs','history-compat.mjs','non-gpt-compat.mjs','sse.mjs','chat-compat.mjs','image-compat.mjs','model-context.mjs','transport.mjs','response-state.mjs','settings.mjs','gateway-sources.mjs']) hash.update(fs.readFileSync(path.join(ctx.root, 'src', file)));
  for (const name of ['model-contexts.json', 'model-template.json']) {
    if (fs.existsSync(path.join(ctx.root, 'assets', name))) hash.update(fs.readFileSync(path.join(ctx.root, 'assets', name)));
  }
  return hash.digest('hex');
}
export async function health(ctx, settings = readSettings(ctx)) {
  try { return await (await fetch('http://127.0.0.1:' + (settings.SHIM_PORT || 8102) + '/healthz', { signal: AbortSignal.timeout(1200) })).json(); } catch { return null; }
}
export async function stopRouter(ctx) {
  const record = readJson(statePath(ctx, 'router'));
  if (!alive(record)) return;
  const command = processIdentity(record.pid)?.command || '';
  if (!command.includes(path.join(ctx.root, 'src/shim.mjs'))) throw new Error('Recorded PID is not this provider router.');
  process.kill(record.pid, 'SIGTERM');
  for (let i = 0; i < 50 && alive(record); i++) await delay(100);
  if (alive(record)) throw new Error('Router has not finished stopping.');
  atomic(statePath(ctx, 'router'), null);
}
export async function entrySelection(ctx, entryMode = 'apionly', options = {}) {
  if (!entryModes.includes(entryMode)) throw new Error('Unknown launcher entry.');
  const signedIn = entryMode === 'api' && await hasChatGPTLogin(ctx.home, options.cli);
  const mode = entryMode === 'official' || signedIn ? 'mixed' : 'gateway';
  return { entryMode, mode, nativeAccount: signedIn, gatewayTransport: 'direct',
    clientVersion: mode === 'mixed' ? nativeVersion(options.cli) : '',
    officialProxy: mode === 'mixed' ? options.officialProxy ?? officialProxy(readSettings(ctx)) : '' };
}
function routerSettings(ctx, selection) {
  const raw = readSettings(ctx);
  if (selection.entryMode !== 'official') return settingsChecked(raw);
  const port = Number(raw.SHIM_PORT || 8102);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local router port.');
  return { BASE_URL: '', API_KEY: '', SHIM_PORT: port };
}
async function prepare(ctx, settings, selection) {
  atomic(statePath(ctx, 'route-state'), { version: 2, ...selection });
  let envPath = path.join(ctx.data, '.env');
  if (selection.entryMode === 'official') {
    envPath = path.join(ctx.data, 'state/official.env');
    const extra = readSettings(ctx).OFFICIAL_BASE;
    atomic(envPath, 'SHIM_HOST=127.0.0.1\nSHIM_PORT=' + settings.SHIM_PORT + '\n' + (extra ? 'OFFICIAL_BASE=' + extra + '\n' : ''));
  }
  const env = { ...process.env, CHATGPT_API_ROOT: ctx.root, CODEX_HOME: selection.mode === 'mixed' ? ctx.home : path.join(ctx.data, 'provider-only'), CHATGPT_API_ENV_PATH: envPath, CHATGPT_SHIM_PORT: String(settings.SHIM_PORT) };
  delete env.CHATGPT_GATEWAY_BASE;
  const result = await run(ctx.node, [path.join(ctx.root, 'src/shim.mjs'), '--prepare'], { env, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  return { env, prepared: JSON.parse(result.stdout) };
}
export async function ensureRouter(ctx, refresh = false, selection = { entryMode: 'apionly', mode: 'gateway', gatewayTransport: 'direct', officialProxy: '' }) {
  return locked(ctx, async () => {
    const settings = routerSettings(ctx, selection);
    const expectedSource = crypto.createHash('sha256').update(settings.BASE_URL + '\n' + settings.API_KEY).digest('hex');
    let existing = await health(ctx, settings);
    if (existing && (existing.mode !== selection.mode || existing.entryMode !== selection.entryMode || existing.sourceId !== expectedSource || existing.buildId !== buildId(ctx))) {
      requireClosedClient();
      const owner = readJson(statePath(ctx, 'router'));
      if (!alive(owner)) throw new Error('Local port is occupied by another router.');
      await stopRouter(ctx); existing = null;
    }
    if (existing) {
      if (existing.service !== 'chatgpt-api-router') throw new Error('Local port is occupied by another service.');
      if (refresh) {
        const refreshed = await (await fetch('http://127.0.0.1:' + settings.SHIM_PORT + '/readyz', { signal: AbortSignal.timeout(30000) })).json();
        const cached = readJson(path.join(ctx.data, 'cache/catalog-state.json'));
        if (selection.entryMode !== 'official' && !refreshed.gateway?.ready && !(cached?.sourceId === expectedSource && cached?.gatewayIds?.length && Date.now() - Date.parse(cached.gatewayAt) < 86400000) && !(selection.mode === 'mixed' && cached?.official?.length)) throw Object.assign(new Error('Gateway is unavailable and no recent model catalog is cached.'), { code: 'gateway_unavailable' });
        return refreshed;
      }
      return existing;
    }
    const { env, prepared } = await prepare(ctx, settings, selection);
    const logPath = path.join(ctx.data, 'logs', 'provider-start.log'); fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    const log = fs.openSync(logPath, 'a', 0o600);
    const child = spawn(ctx.node, [path.join(ctx.root, 'src/shim.mjs')], { env, cwd: ctx.root, detached: true, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const identity = processIdentity(child.pid); child.unref();
    if (!identity) throw new Error('Router exited during startup. See data/logs/provider-start.log.');
    atomic(statePath(ctx, 'router'), identity);
    for (let i = 0; i < 60; i++) {
      const ready = await health(ctx, settings);
      if (ready?.buildId === buildId(ctx) && ready.sourceId === expectedSource && ready.mode === selection.mode && ready.entryMode === selection.entryMode) return prepared;
      if (!alive(identity)) break;
      await delay(100);
    }
    await stopRouter(ctx); throw new Error('Router did not become ready. See data/logs/provider-start.log.');
  });
}
const rootHead = text => text.slice(0, text.search(/^[ \t]*\[/m) < 0 ? text.length : text.search(/^[ \t]*\[/m));
const keyPattern = key => new RegExp('^[ \\t]*' + key + '[ \\t]*=[^\\r\\n]*(?:\\r?\\n|$)', 'm');
const tablePattern = name => new RegExp('^[ \\t]*\\[' + name.replaceAll('.', '\\.') + '\\][^\\r\\n]*(?:\\r?\\n|$).*?(?=^[ \\t]*\\[|(?![\\s\\S]))', 'ms');
export function getRoot(text, key) { return rootHead(text).match(keyPattern(key))?.[0] || ''; }
function rootString(text, key) {
  const value = getRoot(text, key).split('=').slice(1).join('=').trim().match(/^("(?:[^"\\]|\\.)*"|'[^']*')/)?.[0];
  if (!value) return '';
  try { return value.startsWith('"') ? JSON.parse(value) : value.slice(1, -1); } catch { return ''; }
}
export function setRoot(text, key, line) {
  const head = rootHead(text), tail = text.slice(head.length), pattern = keyPattern(key);
  return (pattern.test(head) ? head.replace(pattern, () => line) : line + head) + tail;
}
export function getTable(text, name) { return text.match(tablePattern(name))?.[0] || ''; }
export function setTable(text, name, value) { const pattern = tablePattern(name); return pattern.test(text) ? text.replace(pattern, () => value) : value ? text.trimEnd() + '\n\n' + value : text; }
export function applyConfig(ctx, selection = { entryMode: 'apionly', mode: 'gateway' }) {
  const settings = routerSettings(ctx, selection), signedIn = selection.mode === 'mixed';
  const catalog = readJson(path.join(ctx.data, 'cache/catalog-state.json'), {});
  const officialIds = signedIn ? (catalog.official || []).map(model => model.slug) : [];
  const models = readJson(path.join(ctx.data, 'cache/models-smr.json'))?.models
    || readJson(path.join(ctx.data, 'cache/models-gateway.json'))?.models || [];
  const ids = selection.entryMode === 'official' ? officialIds : models.map(model => model.slug);
  if (!ids.length && selection.entryMode !== 'official') throw new Error('No models are available.');
  let original = ''; try { original = fs.readFileSync(ctx.config, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const remembered = readJson(statePath(ctx, 'entry-models'), {})[selection.entryMode];
  let text = original, selected = ids.includes(remembered?.model) ? remembered.model : rootString(text, 'model');
  if (!ids.includes(selected)) selected = ids[0];
  const base = 'http://127.0.0.1:' + settings.SHIM_PORT + '/v1';
  const tables = ['chatgpt_api_launcher', 'chatgpt_api_mixed', ...(getTable(original, 'model_providers.smr') ? ['smr'] : [])];
  const tableNames = tables.flatMap(id => ['model_providers.' + id, 'model_providers.' + id + '.auth']);
  for (const id of tables) {
    const table = 'model_providers.' + id;
    const body = `[${table}]\nname = "ChatGPT API compatibility"\nbase_url = ${JSON.stringify(base)}\nwire_api = "responses"\nrequires_openai_auth = ${signedIn}\nsupports_websockets = ${signedIn}\n\n`;
    const auth = signedIn ? '' : `[${table}.auth]\ncommand = ${JSON.stringify(ctx.node)}\nargs = ${JSON.stringify([path.join(ctx.root, 'macos/provider.mjs'), 'auth'])}\ntimeout_ms = 45000\nrefresh_interval_ms = 0\n\n`;
    text = setTable(setTable(text, table + '.auth', auth), table, body);
  }
  const values = { openai_base_url: base, model_provider: selection.entryMode === 'official' || officialIds.includes(selected) ? 'openai' : signedIn ? 'chatgpt_api_mixed' : providerId,
    model_catalog_json: selection.entryMode === 'official' ? null : path.join(ctx.data, 'cache/models-smr.json'), model: selected || null };
  if (values.model_provider !== 'openai') Object.assign(values, { model_context_window: null, model_auto_compact_token_limit: null });
  for (const [key, value] of Object.entries(values)) text = setRoot(text, key, value === null ? '' : key + ' = ' + JSON.stringify(value) + '\n');
  if (remembered?.effort) text = setRoot(text, 'model_reasoning_effort', 'model_reasoning_effort = ' + JSON.stringify(remembered.effort) + '\n');
  const file = statePath(ctx, 'config'), prior = readJson(file);
  if (prior && prior.configPath !== ctx.config) throw new Error('This installation is bound to another CODEX_HOME.');
  const saved = { configPath: ctx.config, original: prior?.original ?? original, roots: { ...Object.fromEntries(rootKeys.map(key => [key, getRoot(original, key)])), ...prior?.roots },
    tables: { ...Object.fromEntries(tableNames.map(name => [name, getTable(original, name)])), ...prior?.tables } };
  atomic(file, { ...saved, active: true, entryMode: selection.entryMode, mode: selection.mode, owner: processIdentity(process.pid), sessionId: crypto.randomUUID(), applied: text }); atomic(ctx.config, text);
  return { models: ids.length, model: selected, provider: values.model_provider };
}
export function restoreConfig(ctx) {
  const file = statePath(ctx, 'config'), saved = readJson(file); if (!saved) return;
  if (saved.configPath !== ctx.config) throw new Error('Saved configuration belongs to another CODEX_HOME.');
  let text = fs.readFileSync(ctx.config, 'utf8');
  const ownsProvider = ['openai', providerId, 'chatgpt_api_mixed', 'smr'].includes(rootString(text, 'model_provider'));
  if (saved.entryMode) {
    const memories = readJson(statePath(ctx, 'entry-models'), {});
    atomic(statePath(ctx, 'entry-models'), { ...memories, [saved.entryMode]: { model: rootString(text, 'model'), effort: rootString(text, 'model_reasoning_effort') } });
  }
  for (const [key, value] of Object.entries(saved.roots)) if (getRoot(text, key) === getRoot(saved.applied, key) || ['model', 'model_reasoning_effort'].includes(key) && ownsProvider) text = restoreRootLine(text, key, value, saved.original) ?? setRoot(text, key, value);
  for (const [name, value] of Object.entries(saved.tables)) if (getTable(text, name) === getTable(saved.applied, name)) text = setTable(text, name, value);
  atomic(ctx.config, text); fs.unlinkSync(file);
}
async function prompt(label, hidden = false) {
  if (!process.stdin.isTTY) throw new Error('Set CHATGPT_API_BASE_URL and CHATGPT_API_KEY for unattended installation, or run in a terminal.');
  const output = new Writable({ write(chunk, encoding, done) { if (!hidden) process.stderr.write(chunk); done(); } });
  output.isTTY = true; output.columns = process.stderr.columns || 80;
  const reader = readline.createInterface({ input: process.stdin, output, terminal: true });
  if (hidden) process.stderr.write(label);
  try { return await new Promise((resolve, reject) => { reader.once('SIGINT', () => reject(new Error('Configuration cancelled.'))); reader.question(hidden ? '' : label, resolve); }); }
  finally { reader.close(); if (hidden) process.stderr.write('\n'); }
}
export async function configure(ctx, askExisting = false, apply = true) {
  requireClosedClient();
  const current = userSettings(ctx);
  let base = process.env.CHATGPT_API_BASE_URL || current.BASE_URL, key = process.env.CHATGPT_API_KEY || current.API_KEY;
  if (!base || askExisting && !process.env.CHATGPT_API_BASE_URL && process.stdin.isTTY) base = (await prompt('API base URL' + (base ? ' [' + base + ']' : '') + ': ')).trim() || base;
  if (!key || askExisting && !process.env.CHATGPT_API_KEY && process.stdin.isTTY) key = (await prompt('API Key' + (key ? ' [Enter to keep existing]' : '') + ': ', true)).trim() || key;
  const settings = settingsChecked({ BASE_URL: base, API_KEY: key, SHIM_PORT: process.env.CHATGPT_API_PORT || current.SHIM_PORT });
  await locked(ctx, () => stopRouter(ctx));
  const envFile = path.join(ctx.data, '.env');
  let original = ''; try { original = fs.readFileSync(envFile, 'utf8'); } catch {}
  atomic(envFile, updateEnv(original, { ...settings, SHIM_HOST: current.SHIM_HOST || '127.0.0.1', GATEWAY_TRANSPORT: current.GATEWAY_TRANSPORT || 'direct' }));
  if (base !== current.BASE_URL || key !== current.API_KEY) syncLegacySettings(ctx.root, settings.BASE_URL, settings.API_KEY);
  if (!apply) return { configured: true };
  await ensureRouter(ctx, true); return applyConfig(ctx);
}

export async function launchEntry(ctx, entryMode, args = [], options = {}) {
  const client = options.client || clientExecutable(), cli = options.cli === undefined ? nativeCli(client) : options.cli;
  const clients = options.runningClients || runningClients;
  const launchClient = options.launchClient || startNativeClient;
  let child, sessionId, reused = false, selection;
  await locked(ctx, async () => {
    const active = readJson(statePath(ctx, 'config'));
    if (clients().length || active?.active && alive(active.owner)) {
      if (!active?.active || active.configPath !== ctx.config || active.entryMode !== entryMode) throw new Error('Fully quit ChatGPT before switching launcher entries.');
      reused = true; return;
    }
    restoreConfig(ctx);
    selection = await entrySelection(ctx, entryMode, { cli, ...options });
    await prepareWithRecovery(() => ensureRouter(ctx, true, selection), entryMode === 'official' ? null : options.recoverGateway);
    try {
      applyConfig(ctx, selection);
      sessionId = readJson(statePath(ctx, 'config')).sessionId;
      if (cli) {
        const catalog = readJson(path.join(ctx.data, 'cache/catalog-state.json'), {});
        const repair = await repairThreadProviders({ cli, home: ctx.home,
          gatewayIds: entryMode === 'official' ? [] : catalog.gatewayIds || [],
          officialIds: selection.mode === 'mixed' ? (catalog.official || []).map(model => model.slug) : [],
          provider: selection.mode === 'mixed' ? 'chatgpt_api_mixed' : providerId });
        atomic(statePath(ctx, 'provider-repair-result'), repair);
        if (repair.failed.length) throw new Error('Some conversations could not switch their native provider. See data/state/provider-repair-result.json.');
      }
      child = await launchClient(client, args, ctx.home, { wait: true });
    } catch (error) {
      restoreConfig(ctx); await stopRouter(ctx); throw error;
    }
  }, 'launch-lock');
  if (reused) {
    child = await launchClient(client, args, ctx.home, { wait: false }); child.unref();
    return { reused: true };
  }
  try {
    if (options.waitForClient) await options.waitForClient(child);
    else {
      if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
      // The native updater can replace its main process while the app is open.
      await delay(1200);
      while (clients().length && readJson(statePath(ctx, 'config'))?.sessionId === sessionId) await delay(1200);
      if (child.exitCode) throw new Error('The native client exited with status ' + child.exitCode + '.');
    }
  } finally {
    await locked(ctx, async () => {
      const current = readJson(statePath(ctx, 'config'));
      if (current?.sessionId === sessionId && !clients().length) {
        restoreConfig(ctx); await locked(ctx, () => stopRouter(ctx));
      }
    }, 'launch-lock');
  }
  return { entryMode, mode: selection.mode };
}

export async function main(args = process.argv.slice(2), options = {}) {
  if (process.platform !== 'darwin') throw new Error('This provider launcher requires macOS.');
  const index = args.indexOf('--entry');
  const entryMode = index < 0 ? 'apionly' : args[index + 1];
  if (!entryModes.includes(entryMode)) throw new Error('Unknown launcher entry.');
  if (index >= 0) args = [...args.slice(0, index), ...args.slice(index + 2)];
  const ctx = context(), command = args[0] || 'launch';
  if (command === 'auth') {
    const selection = readJson(statePath(ctx, 'route-state'), { entryMode: 'apionly', mode: 'gateway' });
    if (selection.entryMode === 'official') throw new Error('The official entry uses native ChatGPT authentication.');
    await ensureRouter(ctx, false, selection); process.stdout.write(settingsChecked(readSettings(ctx)).API_KEY + '\n'); return;
  }
  if (command === 'configure') { const result = await configure(ctx, true); console.log('Provider configured; gateway models: ' + result.models); return; }
  if (command === 'stop' || command === 'restore') { requireClosedClient(); await locked(ctx, () => stopRouter(ctx)); if (command === 'restore') restoreConfig(ctx); console.log('Provider ' + (command === 'restore' ? 'configuration restored.' : 'router stopped.')); return; }
  if (command === 'status') { console.log(JSON.stringify(await health(ctx), null, 2)); return; }
  if (command !== 'launch') throw new Error('Usage: chatgpt-apionly [launch | configure | status | stop | restore]');
  return launchEntry(ctx, entryMode, args.slice(1), options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { const key = readSettings(context()).API_KEY; process.stderr.write((key ? error.message.replaceAll(key, '[redacted]') : error.message) + '\n'); process.exitCode = 1; });
}
