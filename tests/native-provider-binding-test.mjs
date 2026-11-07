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
import { applyConfig, restoreConfig, getTable, setTable, setRoot } from '../macos/provider.mjs';
import { repairThreadProviders, restoreThreadProviders } from '../src/repair-thread-providers.mjs';

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
  if (/\/(?:wham\/usage|api\/codex\/usage)(?:\?|$)/.test(req.url)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ plan_type: 'plus', rate_limit: { allowed: false, limit_reached: true,
      primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_after_seconds: 3600, reset_at: 2000000000 } } }));
    return;
  }
  // Account/configuration lookups are not inference requests. Keep them on the
  // isolated server without returning a fabricated model response for them.
  if (!/\/responses(?:\/compact)?(?:\?|$)/.test(req.url)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); return; }
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
  const identity = await rpc('getAuthStatus', { includeToken: false, refreshToken: false });
  if (!identity.requiresOpenaiAuth) {
    const account = await rpc('account/read', { refreshToken: false });
    assert.equal(account.requiresOpenaiAuth, false);
    assert.equal(account.account, null);
    // The native credential store is retained. An existing subscription can
    // still have native usage metadata even though this provider has no account.
    if (fs.existsSync(path.join(home, 'auth.json'))) {
      const limits = await rpc('account/rateLimits/read');
      assert.equal(limits.rateLimits.primary.usedPercent, 100);
    } else await assert.rejects(rpc('account/rateLimits/read'), /account authentication required/);
  }
  menus.push({ provider: config.model_provider, capabilities, identity, models: menu.data.map(model => ({ model: model.model, serviceTiers: model.serviceTiers, hidden: model.hidden })) });
  console.log(JSON.stringify({ provider: config.model_provider, menu: menus.at(-1).models }));
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (child === client) { lines.close(); for (const item of pending.values()) clearTimeout(item.timer); pending.clear(); }
  child.kill(); await once(child, 'exit'); children.delete(child);
}
const ctx = { root: fixture, data: path.join(fixture, 'data'), home, cwd, config: path.join(home, 'config.toml'), node: process.execPath };
async function entry(entryMode, mode, seedProvider = null) {
  await stop(client); client = null; await stop(router); router = null;
  await restoreThreadProviders(ctx);
  const nativeAccount = entryMode !== 'apionly' && fs.existsSync(path.join(home, 'auth.json'));
  if (process.env.NATIVE_BINDING_PLATFORM === 'windows') {
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const script = path.join(fixture, 'apply-entry.ps1');
    fs.writeFileSync(script, ["$ErrorActionPreference='Stop'", ...['Common', 'Package-Paths', 'Launcher-State'].map(name => '. ' + quote(path.join(root, 'src', name + '.ps1'))),
      'Restore-LauncherConfig ' + quote(fixture) + ' ' + quote(ctx.config)].join('\n'));
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { ...process.env, CODEX_HOME: home });
  } else restoreConfig(ctx);
  fs.writeFileSync(path.join(fixture, 'data/state/route-state.json'), JSON.stringify({ mode, entryMode, officialProxy: '', nativeAccount, clientVersion: '0.167.0' }));
  const env = { ...process.env, CODEX_HOME: home, CHATGPT_API_ROOT: fixture, CHATGPT_API_ENV_PATH: path.join(fixture, 'data/.env'), CHATGPT_SHIM_PORT: new URL(routerBase).port };
  await run(process.execPath, [path.join(root, 'src/shim.mjs'), '--prepare'], env);
  router = spawn(process.execPath, [path.join(root, 'src/shim.mjs')], { env, windowsHide: true, stdio: 'ignore' }); children.add(router);
  for (let i = 0; ; i++) { try { if ((await fetch(routerBase + '/healthz')).ok) break; } catch {} assert(i < 100, 'Router not ready'); await delay(30); }
  if (process.env.NATIVE_BINDING_PLATFORM === 'windows') {
    const quote = value => "'" + value.replaceAll("'", "''") + "'", script = path.join(fixture, 'apply-entry.ps1');
    fs.appendFileSync(script, '\nApply-LauncherConfig ' + [fixture, ctx.config, mode, routerBase + '/v1', 'http://fixture.invalid/v1', entryMode].map(quote).join(' '));
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { ...process.env, CODEX_HOME: home });
  } else applyConfig(ctx, { entryMode, mode, nativeAccount });
  if (seedProvider) {
    // Build genuine pre-existing provider-bound conversations with native core,
    // rather than changing a conversation's records to fake the test fixture.
    let config = fs.readFileSync(ctx.config, 'utf8');
    if (seedProvider !== 'openai') {
      for (const suffix of ['', '.auth']) {
        const table = getTable(config, 'model_providers.chatgpt_api_launcher' + suffix);
        if (table) config = setTable(config, 'model_providers.' + seedProvider + suffix, table.replaceAll('model_providers.chatgpt_api_launcher', 'model_providers.' + seedProvider));
      }
    }
    config = setRoot(config, 'model_provider', 'model_provider = ' + JSON.stringify(seedProvider) + '\n');
    fs.writeFileSync(ctx.config, config);
  } else await repairThreadProviders(ctx);
  await startClient();
}
async function turn(threadId, model, marker, fast = false) {
  const offset = requests.length, start = notes.length;
  const { turn } = await rpc('turn/start', { threadId, model, effort: 'low', serviceTier: fast ? 'priority' : null, input: [{ type: 'text', text: marker }] });
  let result;
  for (let i = 0; i < 250; i++) { result = notes.slice(start).find(value => value.method === 'turn/completed' && value.params.turn.id === turn.id); if (result) break; await delay(50); }
  assert.equal(result?.params.turn.status, 'completed', JSON.stringify(result?.params.turn.error));
  const record = requests.slice(offset).filter(record => record.body.generate !== false && JSON.stringify(record.body).includes(marker)).at(-1);
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
  fs.writeFileSync(path.join(home, 'config.toml'), 'model="gpt-6-sol"\nchatgpt_base_url=' + JSON.stringify(base) + '\nservice_tier="default"\napproval_policy="never"\nsandbox_mode="read-only"\nweb_search="disabled"\n[features]\ncode_mode_host=true\n[analytics]\nenabled=false\n');
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [official], client_version: '0.166.0' }));
  // A chat created through pure API must remain resumable after signing in and
  // selecting an official initial model in the mixed entry.
  await entry('apionly', 'gateway');
  assert.equal(menus.at(-1).identity.requiresOpenaiAuth, false);
  assert.equal(menus.at(-1).identity.authMethod, null);
  const started = await rpc('thread/start', { model: gatewayModels[0], cwd, approvalPolicy: 'never', sandbox: 'read-only' }); threadId = started.thread.id;
  await turn(threadId, gatewayModels[0], 'ORIGINAL_API_CONTEXT', true);
  const fixtureIdToken = ['e30', Buffer.from(JSON.stringify({ email: 'fixture@example.invalid', exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account', chatgpt_user_id: 'fixture-user', chatgpt_plan_type: 'plus' } })).toString('base64url'), 'inert'].join('.');
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
    tokens: { id_token: fixtureIdToken, access_token: 'inert-native', refresh_token: '', account_id: 'fixture-account' } }));
  await entry('api', 'mixed');
  assert.equal(menus.at(-1).provider, 'chatgpt_api_launcher'); assert.equal(menus.at(-1).models.length, 3);
  const exhausted = await rpc('account/rateLimits/read');
  assert.equal(exhausted.rateLimits.primary.usedPercent, 100);
  const resumed = await rpc('thread/resume', { threadId, excludeTurns: true }); assert.equal(resumed.thread.id, threadId); assert.equal(resumed.modelProvider, 'chatgpt_api_launcher');
  const first = await turn(threadId, official.slug, 'OFFICIAL_CONTEXT', true); assert(JSON.stringify(first.body).includes('ORIGINAL_API_CONTEXT'));
  const next = await turn(threadId, gatewayModels[1], 'CUSTOM_CONTEXT'); assert(JSON.stringify(next.body).includes('ORIGINAL_API_CONTEXT')); assert(JSON.stringify(next.body).includes('OFFICIAL_CONTEXT'));
  checks.push('An exhausted subscription reported by native account/rateLimits does not prevent gateway turns in the same mixed-provider conversation');
  await turn(threadId, official.slug, 'OFFICIAL_RETURN_CONTEXT', true);
  checks.push('API-only chat resumes in signed-in mixed entry and switches official → non-GPT → official with original context');
  await entry('apionly', 'gateway');
  assert.equal(menus.at(-1).models.length, 2);
  assert.equal(menus.at(-1).identity.requiresOpenaiAuth, false);
  assert.equal(menus.at(-1).identity.authMethod, null);
  assert.equal(menus.at(-1).identity.authToken, null);
  const back = await rpc('thread/resume', { threadId, excludeTurns: true }); assert.equal(back.modelProvider, 'chatgpt_api_launcher');
  const last = await turn(threadId, gatewayModels[0], 'API_RETURN_CONTEXT', true); assert(JSON.stringify(last.body).includes('OFFICIAL_RETURN_CONTEXT')); assert.equal(last.body.service_tier, 'priority');
  checks.push('The same chat returns to API-only; model directory excludes official entries and keeps GPT Fast requests');
  checks.push('API-only ignores saved ChatGPT identity without changing the original credentials');
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
  const legacyThreads = [];
  for (const legacy of ['openai', 'chatgpt_api_mixed', 'smr', 'user_custom']) {
    await entry('official', 'mixed', legacy);
    assert.equal(menus.at(-1).provider, legacy);
    const old = await rpc('thread/start', { model: official.slug, cwd, approvalPolicy: 'never', sandbox: 'read-only' });
    await turn(old.thread.id, official.slug, 'LEGACY_' + legacy);
    legacyThreads.push({ provider: legacy, id: old.thread.id, history: await rpc('thread/turns/list', { threadId: old.thread.id, limit: 20 }) });
  }
  const beforeAuto = requests.length;
  await entry('apionly', 'gateway');
  assert.equal(menus.at(-1).provider, 'chatgpt_api_launcher');
  assert.equal(menus.at(-1).identity.authMethod, null);
  assert(menus.at(-1).models.every(model => gatewayModels.includes(model.model)));
  assert.equal(requests.length, beforeAuto, 'Automatic compatibility sent an inference request');
  for (const old of legacyThreads) {
    const same = await rpc('thread/resume', { threadId: old.id, excludeTurns: true });
    assert.equal(same.thread.id, old.id); assert.equal(same.modelProvider, 'chatgpt_api_launcher');
    assert.deepEqual(await rpc('thread/turns/list', { threadId: old.id, limit: 20 }), old.history);
  }
  // Alternate and run separate old-provider conversations concurrently in one
  // native process; no default switching, manual settings or forks are involved.
  for (const model of gatewayModels) {
    await Promise.all(legacyThreads.map(async old => {
      const record = await turn(old.id, model, 'AUTO_' + old.provider + '_' + model, model === gatewayModels[0]);
      assert(JSON.stringify(record.body).includes('LEGACY_' + old.provider));
    }));
  }
  await compact(legacyThreads[0].id, false);
  assert(requests.slice(beforeAuto).every(record => !record.url.startsWith('/backend-api')), 'API-only sent official inference');
  checks.push('One API-only launch resumes openai/mixed/smr/arbitrary-provider original IDs and histories, including concurrent GPT/non-GPT turns, Fast and native text compaction');
  await entry('api', 'mixed');
  for (const old of legacyThreads) {
    const same = await rpc('thread/resume', { threadId: old.id, excludeTurns: true }); assert.equal(same.thread.id, old.id);
    await turn(old.id, official.slug, 'AUTO_OFFICIAL_' + old.provider, true);
    await turn(old.id, gatewayModels[0], 'AUTO_GATEWAY_' + old.provider, true);
  }
  checks.push('One mixed launch alternates every original provider conversation between official and gateway models with no extra chats');
  await entry('official', 'mixed');
  for (const old of legacyThreads) { await rpc('thread/resume', { threadId: old.id, excludeTurns: true }); await turn(old.id, official.slug, 'OFFICIAL_ENTRY_' + old.provider); }
  await compact(legacyThreads[0].id, true);
  checks.push('Official entry resumes all original-provider chats and keeps official routing and native remote compaction');
  await stop(client); client = null;
  await restoreThreadProviders(ctx);
  assert(!fs.existsSync(path.join(fixture, 'data/state/thread-provider-compatibility.json')));
  const { DatabaseSync } = await import('node:sqlite');
  const dbFile = fs.readdirSync(home).find(name => /^state_\d+\.sqlite$/.test(name));
  const db = new DatabaseSync(path.join(home, dbFile), { readOnly: true });
  for (const old of legacyThreads) assert.equal(db.prepare('SELECT model_provider FROM threads WHERE id=?').get(old.id).model_provider, old.provider);
  db.close();
  assert(!fs.readdirSync(home, { recursive: true }).some(name => /chatgpt-api.*\.tmp|provider-compatibility/.test(name)));
  checks.push('Exit restores each original provider and removes compatibility scratch files; native messages and new turns remain');
  fs.writeFileSync(path.join(root, 'data/diagnostics/native-provider-binding-' + (process.env.NATIVE_BINDING_PLATFORM || 'macos') + '.json'), JSON.stringify({ passed: true, cli, fixture, threadId, checks, menus }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  for (const child of [...children]) await stop(child);
  await restoreThreadProviders(ctx);
  for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); server.close();
}
