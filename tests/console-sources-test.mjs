import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startConsole } from '../src/console.mjs';
import { readSettings, saveSettings, publicSettings, overrideKey } from '../src/settings.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(root, 'data/testing'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, 'data/testing/console-sources-'));
for (const dir of ['assets', 'data/state', 'home']) fs.mkdirSync(path.join(fixture, dir), { recursive: true });
fs.cpSync(path.join(root, 'assets/console'), path.join(fixture, 'assets/console'), { recursive: true });
for (const name of ['model-template.json', 'reasoning-levels.json', 'model-contexts.json']) fs.copyFileSync(path.join(root, 'assets', name), path.join(fixture, 'assets', name));
fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ version: '3.1.5' }));
const sockets = new Set(), children = [], clients = [], records = [], checks = [];
let modelRequests = 0, serial = 0, sourceBDown = false;
const keys = { a: 'private-fixture-A-never-render', b: 'private-fixture-B-never-render' };
const models = ['GPT/gpt-6.1-sol', '词元计划/glm-5.3-flash', 'qwen-image'];
const peer = http.createServer(async (req, res) => {
  const source = req.url.split('/')[1], base = '/' + source + '/v1';
  if (req.headers.authorization !== 'Bearer ' + keys[source]) { res.writeHead(401); res.end('wrong source key'); return; }
  if (req.url === base + '/models') {
    modelRequests++; if (source === 'b' && sourceBDown) { res.writeHead(503); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: models.map(id => ({ id, context_window: source === 'a' ? 128000 : 512000 })) })); return;
  }
  const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks));
  records.push({ source, url: req.url, body });
  if (req.url.includes('/images/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ created: 1, data: [{ b64_json: 'aW5lcnQ=' }] })); return; }
  const model = body.model; assert(models.includes(model), 'The public source alias leaked to the upstream');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (req.url.endsWith('/chat/completions')) {
    const event = { id: 'chat_source_' + (++serial), model, created: 1 };
    res.write('data: ' + JSON.stringify({ ...event, choices: [{ index: 0, delta: { content: 'SOURCE_' + source } }] }) + '\n\n');
    res.end('data: ' + JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); return;
  }
  const response = { id: 'resp_source_' + (++serial), object: 'response', model, status: 'completed', output: [] };
  res.end('data: ' + JSON.stringify({ type: 'response.created', response: { ...response, status: 'in_progress' } }) + '\n\ndata: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n');
});
peer.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve));
const upstream = 'http://127.0.0.1:' + peer.address().port;
const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
fs.writeFileSync(path.join(fixture, 'data/.env'), 'BASE_URL=' + upstream + '/a/v1\nAPI_KEY=' + keys.a + '\nSHIM_PORT=' + port + '\nIMAGE_MODEL=legacy-image-alias\n');
fs.writeFileSync(path.join(fixture, 'data/state/route-state.json'), JSON.stringify({ entryMode: 'apionly', mode: 'gateway' }));
const initial = readSettings(fixture), key = overrideKey('p_bbbbbbbb', models[0]);
saveSettings(fixture, { ...publicSettings(initial), contextLimit: 100000, contextOverrides: { [key]: 64000 }, providers: [
  { ...initial.providers[0], apiKey: '', imageModel: '' }, { id: 'p_bbbbbbbb', name: 'Source B', baseUrl: upstream + '/b', apiKey: keys.b, enabled: true },
] });
assert.equal(readSettings(fixture).providers[0].apiKey, keys.a);
const env = { ...process.env, CHATGPT_API_ROOT: fixture, CODEX_HOME: path.join(fixture, 'home') };
function run(args) {
  const child = spawn(process.execPath, [path.join(root, 'src/shim.mjs'), ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
  return { child, output: () => output };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read) { for (let n = 0; n < 100; n++) { const value = await read(); if (value) return value; await delay(25); } throw new Error('Fixture did not become ready'); }
async function wsTurn(model) {
  const socket = new WebSocket('ws://127.0.0.1:' + port + '/v1/responses'); clients.push(socket); socket.on('error', () => {});
  await once(socket, 'open');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture WS timed out')), 5000);
    socket.on('message', raw => { const event = JSON.parse(raw); if (event.type === 'error' || event.type === 'response.completed') { clearTimeout(timer); socket.close(); event.type === 'error' ? reject(new Error(JSON.stringify(event))) : resolve(event); } });
    socket.send(JSON.stringify({ type: 'response.create', model, input: [{ role: 'user', content: 'Original input' }] }));
  });
}
let consoleServer;
try {
  const prepare = run(['--prepare']); assert.equal((await once(prepare.child, 'exit'))[0], 0, prepare.output());
  const catalog = JSON.parse(fs.readFileSync(path.join(fixture, 'data/cache/models-gateway.json'))).models;
  assert.equal(catalog.length, 4); assert(catalog.some(model => model.slug === models[0]));
  const alias = '@p_bbbbbbbb/' + models[0], chatAlias = '@p_bbbbbbbb/' + models[1];
  const entry = catalog.find(model => model.slug === alias); assert(entry.display_name.includes('Source B')); assert.equal(entry.context_window, 64000);
  assert.equal(catalog.find(model => model.slug === models[0]).context_window, 100000);
  checks.push('Sources with duplicate model names keep independent stable identities and actual capacity limits');
  const router = run([]); await until(() => fetch('http://127.0.0.1:' + port + '/healthz').then(response => response.ok).catch(() => false));
  assert.equal((await wsTurn(alias)).response.model, alias); assert.equal(records.at(-1).source, 'b'); assert.equal(records.at(-1).body.model, models[0]);
  await wsTurn(models[0]); assert.equal(records.at(-1).source, 'a');
  assert.equal((await wsTurn(chatAlias)).response.model, chatAlias); assert(records.at(-1).url.endsWith('/b/v1/chat/completions'));
  const response = await fetch('http://127.0.0.1:' + port + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: alias, input: [], stream: true }) });
  assert((await response.text()).includes(alias)); assert.equal(records.at(-1).source, 'b');
  const image = await fetch('http://127.0.0.1:' + port + '/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: '@p_bbbbbbbb/qwen-image', prompt: 'Fixture image' }) });
  assert.equal(image.status, 200); assert.equal(records.at(-1).source, 'b'); assert.equal(records.at(-1).body.model, 'qwen-image');
  const automaticImage = await fetch('http://127.0.0.1:' + port + '/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Fixture automatic image' }) });
  assert.equal(automaticImage.status, 200, 'Clearing the image selection must not reuse a legacy .env model');
  assert.equal(records.at(-1).source, 'a'); assert.equal(records.at(-1).body.model, 'qwen-image');
  checks.push('HTTP, WS, Chat conversion and images route to the selected URL/key and restore the upstream model name');
  const shared = new WebSocket('ws://127.0.0.1:' + port + '/v1/responses'); clients.push(shared); shared.on('error', () => {});
  await once(shared, 'open');
  const sharedTurn = payload => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { shared.off('message', receive); reject(new Error('Cross-source continuation timed out')); }, 5000);
    function receive(raw) {
      const event = JSON.parse(raw);
      if (event.type !== 'error' && event.type !== 'response.completed') return;
      clearTimeout(timer); shared.off('message', receive);
      event.type === 'error' ? reject(new Error(JSON.stringify(event))) : resolve(event.response);
    }
    shared.on('message', receive); shared.send(JSON.stringify({ type: 'response.create', ...payload }));
  });
  const first = await sharedTurn({ model: models[0], input: [{ role: 'user', content: 'Original source history' }] });
  const second = await sharedTurn({ model: alias, previous_response_id: first.id, input: [{ role: 'user', content: 'Second source continuation' }] });
  assert.equal(second.model, alias); assert.equal(records.at(-1).source, 'b'); assert.equal(records.at(-1).body.previous_response_id, undefined);
  assert(JSON.stringify(records.at(-1).body.input).includes('Original source history'));
  const third = await sharedTurn({ model: chatAlias, previous_response_id: second.id, input: [{ role: 'user', content: 'Chat route continuation' }] });
  assert.equal(third.model, chatAlias); assert.equal(records.at(-1).source, 'b'); assert(records.at(-1).url.endsWith('/chat/completions'));
  for (const content of ['Original source history', 'Second source continuation', 'Chat route continuation']) assert(JSON.stringify(records.at(-1).body.messages).includes(content));
  shared.close();
  checks.push('A single WebSocket preserves original history across same-name API sources and Responses-to-Chat switching without foreign response IDs');
  const before = modelRequests; await delay(100); await fetch('http://127.0.0.1:' + port + '/healthz'); assert.equal(modelRequests, before);
  checks.push('Health reads and runtime idle time never trigger periodic model discovery');
  consoleServer = await startConsole({ root: fixture, open: false });
  const consoleUrl = new URL(consoleServer.url), token = consoleUrl.hash.slice(1); consoleUrl.hash = '';
  const request = (route, body, extra = {}) => fetch(new URL('/api/' + route, consoleUrl), { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await fetch(new URL('/api/state', consoleUrl))).status, 401);
  assert.equal((await request('state', undefined, { origin: 'https://untrusted.invalid' })).status, 403);
  let state = await (await request('state')).json();
  assert(!JSON.stringify(state).includes(keys.a)); assert(!JSON.stringify(state).includes(keys.b));
  assert.equal(state.models.length, 6); assert(state.models.find(model => model.id === alias).effective === 60800);
  const reuse = await startConsole({ root: fixture, open: false }); assert(reuse.reused);
  const settings = { ...state.settings, contextLimit: 90000 }; settings.providers[1].name = 'Renamed source';
  const saved = await request('settings', settings); assert.equal(saved.status, 200); assert.equal(readSettings(fixture).providers[1].apiKey, keys.b);
  assert.equal((await request('settings', settings)).status, 409);
  state = await (await request('refresh', {})).json(); assert.equal(state.models.length, 6);
  assert.equal(state.settings.providers[1].name, 'Renamed source');
  checks.push('Console authentication, origin checks, key redaction, blank-key preservation and concurrent edit protection');
  const page = await (await fetch(consoleUrl)).text(); assert(page.includes('API 来源')); assert(!page.includes(keys.a));
  const script = await fetch(new URL('/console.js', consoleUrl)); assert(script.ok); assert(script.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  sourceBDown = true; await request('refresh', {});
  state = await (await request('state')).json(); assert(state.sources.find(source => source.id === 'p_bbbbbbbb').cached); assert.equal(state.models.length, 6);
  checks.push('One unavailable source retains its own matching fresh cache without blocking other APIs');
  const settingsFile = path.join(fixture, 'data/providers.json');
  const configuredSources = fs.readFileSync(settingsFile);
  fs.unlinkSync(settingsFile);
  const legacyState = await (await request('state')).json();
  fs.writeFileSync(path.join(fixture, 'data/.env'), 'BASE_URL=' + upstream + '/b/v1\nAPI_KEY=' + keys.b + '\nSHIM_PORT=' + port + '\n');
  const changedLegacy = await (await request('state')).json();
  assert.equal(changedLegacy.settings.providers[0].baseUrl, upstream + '/b/v1');
  assert.equal((await request('settings', legacyState.settings)).status, 409, 'A legacy settings update must invalidate an older console draft');
  fs.writeFileSync(settingsFile, configuredSources);
  checks.push('A reused console rereads changed legacy settings and rejects drafts from before that change');
  const report = { passed: true, checks }; console.log(JSON.stringify(report, null, 2));
  fs.mkdirSync(path.join(root, 'data/diagnostics/console315'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/diagnostics/console315/console-sources-results.json'), JSON.stringify(report, null, 2));
} finally {
  if (consoleServer) await consoleServer.close();
  for (const client of clients) client.terminate(); for (const child of children) if (child.exitCode === null) child.kill();
  for (const socket of sockets) socket.destroy(); peer.close();
}
