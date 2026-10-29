import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareWithRecovery, updateEnv, restoreRootLine } from '../src/gateway-recovery.mjs';
import { requestSettings } from './settings.mjs';
import { syncLegacySettings, userApiSettings } from '../src/settings.mjs';

const run = promisify(execFile), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const providerId = 'chatgpt_api_launcher';
export const rootKeys = ['model_provider', 'model_catalog_json', 'model', 'model_context_window', 'model_auto_compact_token_limit'];
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
export function settingsChecked(settings) {
  const base = (settings.BASE_URL || '').trim().replace(/\/+$/, '').replace(/\/(models|responses)$/, '');
  let url; try { url = new URL(base); } catch { throw new Error('Enter a valid http:// or https:// API base URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[\r\n]/.test(base)) throw new Error('API URL must not contain credentials, a query, or a fragment.');
  const key = (settings.API_KEY || '').trim();
  if (!key || /[\r\n]/.test(key)) throw new Error('API Key is missing or invalid. Run chatgpt-api configure.');
  const port = Number(settings.SHIM_PORT || 8102);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Local port must be between 1024 and 65535.');
  return { BASE_URL: base.endsWith('/v1') ? base : base + '/v1', API_KEY: key, SHIM_PORT: port };
}
function statePath(ctx, name) { return path.join(ctx.data, 'state', name + '.json'); }
function processIdentity(pid) {
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] === 'Z' ? null : { pid: Number(pid), start: fields[19] };
  } catch { return null; }
}
function alive(record) { return !!record && processIdentity(record.pid)?.start === record.start; }
export function runningClients() {
  if (process.platform !== 'linux') return [];
  return fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      if (fs.statSync('/proc/' + name).uid !== process.getuid()) return [];
      const exe = fs.readlinkSync('/proc/' + name + '/exe'), args = fs.readFileSync('/proc/' + name + '/cmdline', 'utf8').split('\0');
      return /^chatgpt$/i.test(path.basename(exe)) && !args.some(arg => arg.startsWith('--type=')) ? [Number(name)] : [];
    } catch { return []; }
  });
}
export function requireClosedClient() { if (runningClients().length) throw new Error('Fully quit ChatGPT before installing, configuring, restoring, or stopping the provider.'); }
async function locked(ctx, action) {
  const file = statePath(ctx, 'provider-lock'), owner = processIdentity(process.pid);
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
export async function health(ctx, settings = settingsChecked(readSettings(ctx))) {
  try { return await (await fetch('http://127.0.0.1:' + settings.SHIM_PORT + '/healthz', { signal: AbortSignal.timeout(1200) })).json(); } catch { return null; }
}
export async function stopRouter(ctx) {
  const record = readJson(statePath(ctx, 'router'));
  if (!alive(record)) return;
  const args = fs.readFileSync('/proc/' + record.pid + '/cmdline', 'utf8').split('\0');
  if (!args.includes(path.join(ctx.root, 'src/shim.mjs'))) throw new Error('Recorded PID is not this provider router.');
  process.kill(record.pid, 'SIGTERM');
  for (let i = 0; i < 50 && alive(record); i++) await delay(100);
  if (alive(record)) throw new Error('Router has not finished stopping.');
  atomic(statePath(ctx, 'router'), null);
}
async function prepare(ctx, settings) {
  atomic(statePath(ctx, 'route-state'), { version: 2, mode: 'gateway', gatewayTransport: 'direct', officialProxy: '' });
  // The router never reads the desktop's official login or official model cache.
  const env = { ...process.env, CHATGPT_API_ROOT: ctx.root, CODEX_HOME: path.join(ctx.data, 'provider-only'), CHATGPT_API_ENV_PATH: path.join(ctx.data, '.env'), CHATGPT_SHIM_PORT: String(settings.SHIM_PORT) };
  delete env.CHATGPT_GATEWAY_BASE;
  const result = await run(ctx.node, [path.join(ctx.root, 'src/shim.mjs'), '--prepare'], { env, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  return { env, prepared: JSON.parse(result.stdout) };
}
export async function ensureRouter(ctx, refresh = false) {
  return locked(ctx, async () => {
    const settings = settingsChecked(readSettings(ctx));
    const expectedSource = crypto.createHash('sha256').update(settings.BASE_URL + '\n' + settings.API_KEY).digest('hex');
    const existing = await health(ctx, settings);
    if (existing) {
      if (existing.service !== 'chatgpt-api-router' || existing.mode !== 'gateway' || existing.sourceId !== expectedSource || existing.buildId !== buildId(ctx)) throw new Error('Local port is occupied by another router or version. Quit ChatGPT and run chatgpt-api stop before updating.');
      if (refresh) {
        const refreshed = await (await fetch('http://127.0.0.1:' + settings.SHIM_PORT + '/readyz', { signal: AbortSignal.timeout(30000) })).json();
        const cached = readJson(path.join(ctx.data, 'cache/catalog-state.json'));
        if (!refreshed.gateway?.ready && !(cached?.sourceId === expectedSource && cached?.gatewayIds?.length && Date.now() - Date.parse(cached.gatewayAt) < 86400000)) throw Object.assign(new Error('Gateway is unavailable and no recent model catalog is cached.'), { code: 'gateway_unavailable' });
        return refreshed;
      }
      return existing;
    }
    const { env, prepared } = await prepare(ctx, settings);
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
      if (ready?.buildId === buildId(ctx) && ready.sourceId === expectedSource && ready.mode === 'gateway') return prepared;
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
export function applyConfig(ctx) {
  const settings = settingsChecked(readSettings(ctx));
  const models = readJson(path.join(ctx.data, 'cache/models-gateway.json'))?.models || [];
  const ids = models.map(model => model.slug); if (!ids.length) throw new Error('No gateway models are available.');
  let original = ''; try { original = fs.readFileSync(ctx.config, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let text = original, selected = rootString(text, 'model'); if (!ids.includes(selected)) selected = ids[0];
  const table = 'model_providers.' + providerId;
  const body = `[${table}]\nname = "ChatGPT API Provider"\nbase_url = "http://127.0.0.1:${settings.SHIM_PORT}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n\n`;
  const auth = `[${table}.auth]\ncommand = ${JSON.stringify(ctx.node)}\nargs = ${JSON.stringify([path.join(ctx.root, 'linux/provider.mjs'), 'auth'])}\ntimeout_ms = 45000\nrefresh_interval_ms = 0\n\n`;
  text = setTable(setTable(text, table + '.auth', auth), table, body);
  const values = { model_provider: providerId, model_catalog_json: path.join(ctx.data, 'cache/models-gateway.json'), model: selected, model_context_window: null, model_auto_compact_token_limit: null };
  for (const key of rootKeys) text = setRoot(text, key, values[key] === null ? '' : key + ' = ' + JSON.stringify(values[key]) + '\n');
  const file = statePath(ctx, 'config'), prior = readJson(file);
  if (prior && prior.configPath !== ctx.config) throw new Error('This installation is bound to another CODEX_HOME.');
  const saved = { configPath: ctx.config, original: prior?.original ?? original,
    roots: { ...Object.fromEntries(rootKeys.map(key => [key, getRoot(original, key)])), ...prior?.roots },
    tables: { ...Object.fromEntries([table, table + '.auth'].map(name => [name, getTable(original, name)])), ...prior?.tables } };
  atomic(file, { ...saved, applied: text }); atomic(ctx.config, text);
  return { models: ids.length, model: selected };
}
export function restoreConfig(ctx) {
  const file = statePath(ctx, 'config'), saved = readJson(file); if (!saved) return;
  if (saved.configPath !== ctx.config) throw new Error('Saved configuration belongs to another CODEX_HOME.');
  let text = fs.readFileSync(ctx.config, 'utf8');
  const ownsProvider = rootString(text, 'model_provider') === providerId;
  for (const key of rootKeys) if (Object.hasOwn(saved.roots, key) && (getRoot(text, key) === getRoot(saved.applied, key) || key === 'model' && ownsProvider)) text = restoreRootLine(text, key, saved.roots[key], saved.original) ?? setRoot(text, key, saved.roots[key]);
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
  const current = userApiSettings(ctx.root, readSettings(ctx));
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
function clientExecutable() {
  const candidates = process.env.CHATGPT_API_CLIENT ? [process.env.CHATGPT_API_CLIENT] : (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'chatgpt'));
  for (const file of candidates) { try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {} }
  throw new Error('Official Linux desktop app was not found. Install ChatGPT first, or set CHATGPT_API_CLIENT to its executable path.');
}
export async function main(args = process.argv.slice(2)) {
  if (process.platform !== 'linux') throw new Error('This provider launcher requires Linux.');
  const ctx = context(), command = args[0] || 'launch';
  if (command === 'console') { const { startConsole } = await import('../src/console.mjs'); await startConsole({ root: ctx.root }); return; }
  if (command === 'auth') { await ensureRouter(ctx); process.stdout.write(settingsChecked(readSettings(ctx)).API_KEY + '\n'); return; }
  if (command === 'configure') { const result = await configure(ctx, true); console.log('Provider configured; gateway models: ' + result.models); return; }
  if (command === 'stop' || command === 'restore') { requireClosedClient(); await locked(ctx, () => stopRouter(ctx)); if (command === 'restore') restoreConfig(ctx); console.log('Provider ' + (command === 'restore' ? 'configuration restored.' : 'router stopped.')); return; }
  if (command === 'status') { console.log(JSON.stringify(await health(ctx), null, 2)); return; }
  if (command !== 'launch') throw new Error('Usage: chatgpt-api [launch | configure | status | stop | restore]');
  const client = clientExecutable(), running = runningClients().length > 0;
  if (running && rootString(fs.readFileSync(ctx.config, 'utf8'), 'model_provider') !== providerId) throw new Error('Fully quit the current ChatGPT instance before opening the API provider.');
  await prepareWithRecovery(() => ensureRouter(ctx, !running), running ? null : async () => {
    const values = await requestSettings(userApiSettings(ctx.root, readSettings(ctx)));
    if (!values) return false;
    const names = ['CHATGPT_API_BASE_URL','CHATGPT_API_KEY'];
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    try {
      process.env.CHATGPT_API_BASE_URL = values.base; process.env.CHATGPT_API_KEY = values.key;
      await configure(ctx, false, false);
    } finally { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
    return true;
  });
  if (!running) applyConfig(ctx);
  const child = spawn(client, args.slice(1), { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { const key = readSettings(context()).API_KEY; process.stderr.write((key ? error.message.replaceAll(key, '[redacted]') : error.message) + '\n'); process.exitCode = 1; });
}
