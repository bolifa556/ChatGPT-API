// Current native app-server + real router, isolated configuration and loopback
// upstreams. No production chats, account credentials, or model calls are used.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { readRequestJson } from './http-fixture.mjs';
import { applyConfig, restoreConfig } from '../macos/provider.mjs';
import { repairThreadProviders } from '../src/repair-thread-providers.mjs';
import { readSettings, saveSettings } from '../src/settings.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = process.env.CODEX_CLI_PATH;
assert(cli && fs.existsSync(cli), 'Set CODEX_CLI_PATH to the current native client.');
const fixture = fs.mkdtempSync(path.join(root, 'data/testing/native-provider-binding-'));
const home = path.join(fixture, 'home'), cwd = path.join(fixture, 'workspace');
for (const dir of [home, cwd, path.join(fixture, 'assets'), path.join(fixture, 'macos'), path.join(fixture, 'data/cache'), path.join(fixture, 'data/state')]) fs.mkdirSync(dir, { recursive: true });
for (const file of ['model-template.json', 'reasoning-levels.json', 'model-contexts.json']) fs.copyFileSync(path.join(root, 'assets', file), path.join(fixture, 'assets', file));
fs.writeFileSync(path.join(fixture, 'macos/provider.mjs'), "process.stdout.write('inert-gateway\\n');\n");
const official = { ...JSON.parse(fs.readFileSync(path.join(root, 'assets/model-template.json'))).models[0],
  slug: 'gpt-6-sol', visibility: 'list', service_tiers: [{ id: 'priority', name: 'Fast', description: 'Fixture native tier' }], additional_speed_tiers: ['fast'] };
const gatewayModels = ['GPT/gpt-6-sol', 'Vendor/model'];
const requests = [], checks = [], menus = [];
let serial = 0, router, client, lines, pending, notes, rpcId, routerBase, compacting = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = new Set();
function events(body, url, send, headers) {
  requests.push({ model: body.model, url, headers, body });
  const id = 'resp_binding_' + ++serial, base = { id, object: 'response', created_at: 1, model: body.model, output: [], status: 'in_progress' };
  let sequence = 0;
  const emit = value => send({ ...value, sequence_number: sequence++, ...(body.stream_id ? { stream_id: body.stream_id } : {}) });
  emit({ type: 'response.created', response: base });
  if (body.generate === false) { emit({ type: 'response.completed', response: { ...base, status: 'completed' } }); return; }
  const item = compacting && body.input?.some(part => part.type === 'compaction_trigger')
    ? { type: 'compaction', id: 'cmp_' + serial, encrypted_content: 'inert-native-compaction' }
    : { type: 'message', role: 'assistant', phase: 'final_answer', id: 'msg_' + serial, status: 'completed', content: [{ type: 'output_text', text: compacting ? 'Native fixture context summary.' : 'NATIVE_BINDING_OK', annotations: [] }] };
  emit({ type: 'response.output_item.added', output_index: 0, item });
  emit({ type: 'response.output_item.done', output_index: 0, item });
  emit({ type: 'response.completed', response: { ...base, output: [item], status: 'completed', usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } });
}
const server = http.createServer(async (req, res) => {
  if (req.url.includes('/models')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.startsWith('/backend-api') ? { models: [official] } : { data: gatewayModels.map(id => ({ id })) })); return;
  }
  try { const body = await readRequestJson(req); res.writeHead(200, { 'content-type': 'text/event-stream' }); events(body, req.url, event => res.write('data: ' + JSON.stringify(event) + '\n\n'), req.headers); res.end(); }
  catch (error) { res.end(String(error)); }
});
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => { ws.on('error', () => {}); ws.on('message', data => events(JSON.parse(data), req.url, event => ws.send(JSON.stringify(event)), req.headers)); });
async function run(file, args, env) {
  const child = spawn(file, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', value => output += value); child.stderr.on('data', value => output += value);
  const [code] = await once(child, 'exit'); assert.equal(code, 0, output); return output;
}
function send(value) { client.stdin.write(JSON.stringify(value) + '\n'); }
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId, timer = setTimeout(() => { pending.delete(id); reject(Error('Timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer }); send({ id, method, params });
  });
}
async function startClient() {
  pending = new Map(); notes = []; rpcId = 0;
  client = spawn(cli, ['app-server', '--stdio'], { cwd, env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: 'inert-gateway' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); children.add(client);
  client.stderr.resume(); lines = readline.createInterface({ input: client.stdout });
  lines.on('line', text => {
    let value; try { value = JSON.parse(text); } catch { return; }
    const call = pending.get(value.id);
    if (call && !value.method) { pending.delete(value.id); clearTimeout(call.timer); value.error ? call.reject(Object.assign(Error(value.error.message), { data: value.error.data })) : call.resolve(value.result); }
    else if (value.id !== undefined) send({ id: value.id, error: { code: -32601, message: 'No test tools are authorized' } });
    else notes.push(value);
  });
  await rpc('initialize', { clientInfo: { name: 'native-provider-binding-test', version: '1' }, capabilities: { experimentalApi: true } }); send({ method: 'initialized', params: {} });
  const config = (await rpc('config/read', { includeLayers: false })).config;
  const menu = await rpc('model/list', { includeHidden: true });
  const capabilities = await rpc('modelProvider/capabilities/read');
  menus.push({ provider: config.model_provider, capabilities, models: menu.data.map(model => ({ model: model.model, serviceTiers: model.serviceTiers, hidden: model.hidden })) });
  console.log(JSON.stringify({ provider: config.model_provider, menu: menus.at(-1).models }));
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (child === client) { lines.close(); for (const item of pending.values()) clearTimeout(item.timer); pending.clear(); }
  child.kill(); await once(child, 'exit'); children.delete(child);
}
const ctx = { root: fixture, data: path.join(fixture, 'data'), home, cwd, config: path.join(home, 'config.toml'), node: process.execPath };
async function entry(entryMode, mode) {
  await stop(client); client = null; await stop(router); router = null;
  if (process.env.NATIVE_BINDING_PLATFORM === 'windows') {
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const script = path.join(fixture, 'apply-entry.ps1');
    fs.writeFileSync(script, ["$ErrorActionPreference='Stop'", ...['Common', 'Package-Paths', 'Launcher-State'].map(name => '. ' + quote(path.join(root, 'src', name + '.ps1'))),
      'Restore-LauncherConfig ' + quote(fixture) + ' ' + quote(ctx.config)].join('\n'));
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { ...process.env, CODEX_HOME: home });
  } else restoreConfig(ctx);
  fs.writeFileSync(path.join(fixture, 'data/state/route-state.json'), JSON.stringify({ mode, entryMode, officialProxy: '', nativeAccount: mode === 'mixed', clientVersion: '0.166.0' }));
  const env = { ...process.env, CODEX_HOME: home, CHATGPT_API_ROOT: fixture, CHATGPT_API_ENV_PATH: path.join(fixture, 'data/.env'), CHATGPT_SHIM_PORT: new URL(routerBase).port };
  await run(process.execPath, [path.join(root, 'src/shim.mjs'), '--prepare'], env);
  router = spawn(process.execPath, [path.join(root, 'src/shim.mjs')], { env, windowsHide: true, stdio: 'ignore' }); children.add(router);
  for (let i = 0; ; i++) { try { if ((await fetch(routerBase + '/healthz')).ok) break; } catch {} assert(i < 100, 'Router not ready'); await delay(30); }
  if (process.env.NATIVE_BINDING_PLATFORM === 'windows') {
    const quote = value => "'" + value.replaceAll("'", "''") + "'", script = path.join(fixture, 'apply-entry.ps1');
    fs.appendFileSync(script, '\nApply-LauncherConfig ' + [fixture, ctx.config, mode, routerBase + '/v1', 'http://fixture.invalid/v1', entryMode].map(quote).join(' '));
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { ...process.env, CODEX_HOME: home });
  } else applyConfig(ctx, { entryMode, mode });
  await startClient();
}
async function turn(threadId, model, marker, fast = false) {
  const offset = requests.length, start = notes.length;
  const { turn } = await rpc('turn/start', { threadId, model, effort: 'low', serviceTier: fast ? 'priority' : null, input: [{ type: 'text', text: marker }] });
  let result;
  for (let i = 0; i < 250; i++) { result = notes.slice(start).find(value => value.method === 'turn/completed' && value.params.turn.id === turn.id); if (result) break; await delay(50); }
  assert.equal(result?.params.turn.status, 'completed', JSON.stringify(result?.params.turn.error));
  const record = requests.slice(offset).filter(record => record.body.generate !== false).at(-1);
  assert(record, 'No inference request'); assert.equal(record.model, model);
  assert.equal(record.url.startsWith('/backend-api'), model === official.slug);
  assert.equal(record.headers.authorization, model === official.slug ? 'Bearer inert-native' : 'Bearer inert-gateway');
  if (model !== official.slug) assert.equal(record.headers['chatgpt-account-id'], undefined);
  if (fast) assert.equal(record.body.service_tier, 'priority');
  return record;
}
async function compact(threadId, remote) {
  const offset = requests.length, start = notes.length; compacting = true;
  try {
    await rpc('thread/compact/start', { threadId }); let result;
    for (let i = 0; i < 250; i++) { result = notes.slice(start).find(value => value.method === 'turn/completed'); if (result) break; await delay(50); }
    assert.equal(result?.params.turn.status, 'completed', JSON.stringify(result?.params.turn.error));
    const records = requests.slice(offset).filter(record => record.body.generate !== false);
    assert(records.length);
    assert.equal(records.some(record => record.body.input?.some(item => item.type === 'compaction_trigger')), remote);
    if (!remote) assert(records.some(record => JSON.stringify(record.body).includes('CONTEXT CHECKPOINT')));
  } finally { compacting = false; }
}
let threadId, finalHistory;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = 'http://127.0.0.1:' + server.address().port;
  const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); routerBase = 'http://127.0.0.1:' + reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  fs.writeFileSync(path.join(fixture, 'data/.env'), ['BASE_URL=' + base + '/v1', 'API_KEY=inert-gateway', 'OFFICIAL_BASE=' + base + '/backend-api/codex', 'SHIM_PORT=' + new URL(routerBase).port].join('\n'));
  fs.writeFileSync(path.join(home, 'config.toml'), 'model="gpt-6-sol"\nservice_tier="default"\napproval_policy="never"\nsandbox_mode="read-only"\nweb_search="disabled"\n[features]\ncode_mode_host=true\n[analytics]\nenabled=false\n');
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [official], client_version: '0.166.0' }));
  // A chat created through pure API must remain resumable after signing in and
  // selecting an official initial model in the mixed entry.
  await entry('apionly', 'gateway');
  const started = await rpc('thread/start', { model: gatewayModels[0], cwd, approvalPolicy: 'never', sandbox: 'read-only' }); threadId = started.thread.id;
  await turn(threadId, gatewayModels[0], 'ORIGINAL_API_CONTEXT', true);
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'inert-native', account_id: 'fixture-account' } }));
  await entry('api', 'mixed');
  assert.equal(menus.at(-1).provider, 'chatgpt_api_launcher'); assert.equal(menus.at(-1).models.length, 3);
  const resumed = await rpc('thread/resume', { threadId, excludeTurns: true }); assert.equal(resumed.thread.id, threadId); assert.equal(resumed.modelProvider, 'chatgpt_api_launcher');
  const first = await turn(threadId, official.slug, 'OFFICIAL_CONTEXT', true); assert(JSON.stringify(first.body).includes('ORIGINAL_API_CONTEXT'));
  const next = await turn(threadId, gatewayModels[1], 'CUSTOM_CONTEXT'); assert(JSON.stringify(next.body).includes('ORIGINAL_API_CONTEXT')); assert(JSON.stringify(next.body).includes('OFFICIAL_CONTEXT'));
  await turn(threadId, official.slug, 'OFFICIAL_RETURN_CONTEXT', true);
  checks.push('API-only chat resumes in signed-in mixed entry and switches official → non-GPT → official with original context');
  await entry('apionly', 'gateway');
  assert.equal(menus.at(-1).models.length, 2);
  const back = await rpc('thread/resume', { threadId, excludeTurns: true }); assert.equal(back.modelProvider, 'chatgpt_api_launcher');
  const last = await turn(threadId, gatewayModels[0], 'API_RETURN_CONTEXT', true); assert(JSON.stringify(last.body).includes('OFFICIAL_RETURN_CONTEXT')); assert.equal(last.body.service_tier, 'priority');
  checks.push('The same chat returns to API-only; model directory excludes official entries and keeps GPT Fast requests');
  await compact(threadId, false); checks.push('API provider uses native text compaction; no adapter-written prompt');
  finalHistory = await rpc('thread/turns/list', { threadId, limit: 20 });
  await entry('official', 'mixed');
  const before = requests.length;
  assert.equal(menus.at(-1).provider, 'chatgpt_api_launcher');
  assert(!menus.at(-1).models.some(model => gatewayModels.includes(model.model)), 'Official entry exposes API models');
  const officialCapabilities = menus.at(-1).capabilities;
  const officialResume = await rpc('thread/resume', { threadId, excludeTurns: true });
  assert.equal(officialResume.thread.id, threadId); assert.equal(officialResume.modelProvider, 'chatgpt_api_launcher');
  assert.equal(requests.length, before, 'Resume sent inference');
  assert.deepEqual(await rpc('thread/turns/list', { threadId, limit: 20 }), finalHistory);
  await turn(threadId, official.slug, 'OFFICIAL_COMPATIBLE_CONTEXT', true);
  await compact(threadId, true);
  assert(requests.slice(before).every(record => record.url.startsWith('/backend-api')), 'Official compatibility sent a gateway request');
  checks.push('Official entry resumes the same API chat with unchanged history, an official-only menu, native remote compaction and no gateway inference');
  const native = await rpc('thread/start', { model: official.slug, cwd, approvalPolicy: 'never', sandbox: 'read-only' });
  await turn(native.thread.id, official.slug, 'NATIVE_OFFICIAL_CONTEXT', true);
  await compact(native.thread.id, true); checks.push('Official entry retains OpenAI authentication, Fast requests and native remote compaction');
  await entry('api', 'mixed');
  await rpc('thread/resume', { threadId, excludeTurns: true });
  const officialReturn = await turn(threadId, gatewayModels[0], 'BACK_FROM_OFFICIAL');
  assert(officialReturn.body.input.some(item => item.type === 'compaction'), 'Official compaction disappeared when returning to gateway GPT');
  checks.push('The same conversation returns from the official entry to mixed mode without a fork; opaque compaction is preserved for GPT');
  for (const legacy of ['openai', 'chatgpt_api_mixed', 'smr']) {
    saveSettings(fixture, { ...readSettings(fixture), officialProvider: legacy });
    await entry('official', 'mixed'); assert.equal(menus.at(-1).provider, legacy); assert.deepEqual(menus.at(-1).capabilities, officialCapabilities);
    const old = await rpc('thread/start', { model: official.slug, cwd, approvalPolicy: 'never', sandbox: 'read-only' });
    await turn(old.thread.id, official.slug, 'LEGACY_' + legacy);
    await entry('official', 'mixed'); const restored = await rpc('thread/resume', { threadId: old.thread.id, excludeTurns: true });
    assert.equal(restored.thread.id, old.thread.id); assert.equal(restored.modelProvider, legacy);
    await compact(old.thread.id, true);
    const count = requests.length;
    await assert.rejects(rpc('thread/resume', { threadId }), error => error.data?.type === 'modelProviderMismatch');
    assert.equal(requests.length, count);
  }
  checks.push('Legacy openai/mixed/smr selections resume their own unchanged IDs, retain native OpenAI capabilities, and respect mismatched-provider admission');
  await stop(client); client = null;
  const repair = await repairThreadProviders({ cli, home, gatewayIds: gatewayModels, officialIds: [official.slug], provider: 'chatgpt_api_launcher' });
  assert.equal(repair.skipped, 'native_provider_binding'); assert.deepEqual(repair.repaired, []);
  checks.push('Modern native clients skip obsolete provider migration without rewriting or forking conversations');
  fs.writeFileSync(path.join(root, 'data/diagnostics/native-provider-binding-' + (process.env.NATIVE_BINDING_PLATFORM || 'macos') + '.json'), JSON.stringify({ passed: true, cli, fixture, threadId, checks, menus }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  for (const child of [...children]) await stop(child);
  for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); server.close();
}
