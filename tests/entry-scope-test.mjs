import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { readRequestJson } from './http-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'data/testing', 'entry-scope-' + process.pid);
const template = JSON.parse(fs.readFileSync(path.join(root, 'assets/model-template.json'), 'utf8')).models[0];
const officialModel = { ...template, slug: 'gpt-6-sol' };
const gatewayModels = ['GPT/gpt-6-sol', 'Other/gateway'];
const records = [], servers = [], sockets = new Set(), children = [], checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server) {
  servers.push(server);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
function response(body) {
  return { id: 'resp_scope', object: 'response', model: body.model, status: 'completed',
    output: [{ type: 'message', id: 'msg_scope', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'scope passed', annotations: [] }] }] };
}
function peer(which) {
  const server = http.createServer(async (req, res) => {
    records.push({ which, path: req.url, headers: req.headers });
    if (req.url.includes('/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(which === 'official' ? { models: [officialModel] } : { data: gatewayModels.map(id => ({ id })) }));
      return;
    }
    const body = await readRequestJson(req), output = response(body);
    records.at(-1).body = body;
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ type: 'response.completed', response: output }) + '\n\n');
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(output));
    }
  });
  if (which === 'official') {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
      ws.on('error', () => {});
      ws.on('message', raw => {
        const body = JSON.parse(raw);
        records.push({ which, path: req.url, headers: req.headers, body });
        ws.send(JSON.stringify({ type: 'response.completed', response: response(body) }));
      });
    }));
  }
  return server;
}
async function childRun(dir, args) {
  const child = spawn(process.execPath, [path.join(root, 'src/shim.mjs'), ...args], {
    env: { ...process.env, CHATGPT_API_ROOT: dir, CODEX_HOME: path.join(dir, 'home') },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  if (args.length) {
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout);
  }
  return { child, stderr: () => stderr };
}
async function httpRequest(base, model) {
  const result = await fetch(base + '/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer mock-api-key', 'chatgpt-account-id': 'must-not-reach-gateway' },
    body: JSON.stringify({ model, input: [{ role: 'user', content: '原始对话内容' }] }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: result.status, body: await result.json() };
}
async function wsRequest(base, model) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/v1/responses', {
      headers: { authorization: 'Bearer mock-api-key', 'chatgpt-account-id': 'must-not-reach-gateway' },
    });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Scope WebSocket timed out')); }, 5000);
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'response.create', model, input: [{ role: 'user', content: '原始对话内容' }] })));
    ws.on('message', raw => {
      const event = JSON.parse(raw);
      if (event.type === 'error' || event.type === 'response.completed') { clearTimeout(timer); ws.close(); resolve(event); }
    });
  });
}

try {
  const gatewayPort = await listen(peer('gateway')), officialPort = await listen(peer('official'));
  for (const scenario of [
    { entryMode: 'official', login: true, mode: 'mixed', visible: ['gpt-6-sol'] },
    { entryMode: 'api', login: true, mode: 'mixed', visible: ['gpt-6-sol', ...gatewayModels] },
    { entryMode: 'api', login: false, mode: 'gateway', visible: gatewayModels },
    // Stale mixed metadata and saved OAuth must never enable the official route here.
    { entryMode: 'apionly', login: true, mode: 'mixed', visible: gatewayModels },
    { entryMode: 'apionly', login: false, mode: 'gateway', visible: gatewayModels },
  ]) {
    const dir = path.join(fixture, scenario.entryMode + '-' + scenario.login);
    for (const sub of ['assets', 'data/state', 'data/cache', 'home']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    for (const name of ['model-template.json', 'reasoning-levels.json']) fs.copyFileSync(path.join(root, 'assets', name), path.join(dir, 'assets', name));
    const authPath = path.join(dir, 'home/auth.json');
    if (scenario.login) fs.writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'mock-official', account_id: 'mock-account' } }));
    const authBefore = scenario.login ? fs.readFileSync(authPath) : null;
    fs.writeFileSync(path.join(dir, 'home/models_cache.json'), JSON.stringify({ models: [officialModel] }));
    const reserve = http.createServer(), port = await listen(reserve);
    await new Promise(resolve => reserve.close(resolve));
    const base = 'http://127.0.0.1:' + port, gatewayBase = 'http://127.0.0.1:' + gatewayPort + '/v1';
    fs.writeFileSync(path.join(dir, 'data/.env'), [
      'BASE_URL=' + (scenario.entryMode === 'official' ? '' : gatewayBase), 'API_KEY=' + (scenario.entryMode === 'official' ? '' : 'mock-api-key'), 'SHIM_PORT=' + port,
      'OFFICIAL_BASE=http://127.0.0.1:' + officialPort + '/backend-api/codex',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'data/state/route-state.json'), JSON.stringify({
      mode: scenario.mode, entryMode: scenario.entryMode, officialProxy: '', gatewayTransport: 'direct', clientVersion: '0.162.0',
    }));
    // Retain a real gateway cache so the official-entry denial tests routing, not a missing model.
    fs.writeFileSync(path.join(dir, 'data/cache/catalog-state.json'), JSON.stringify({
      gatewayIds: gatewayModels, gatewayModels: gatewayModels.map(id => ({ id })), gatewayAt: new Date().toISOString(),
      sourceId: crypto.createHash('sha256').update(gatewayBase + '\nmock-api-key').digest('hex'),
    }));
    const offset = records.length;
    const prepared = await childRun(dir, ['--prepare']);
    assert.equal(prepared.entryMode, scenario.entryMode);
    const server = await childRun(dir, []);
    let ready = false;
    for (let n = 0; n < 100; n++) {
      if (server.child.exitCode !== null) throw new Error(server.stderr());
      try { if ((await fetch(base + '/healthz')).ok) { ready = true; break; } } catch {}
      await delay(30);
    }
    assert(ready, server.stderr());
    const menu = await (await fetch(base + '/v1/models')).json();
    assert.deepEqual(menu.data.map(model => model.id), scenario.visible);
    const diskMenu = JSON.parse(fs.readFileSync(path.join(dir, 'data/cache/models-smr.json'), 'utf8'));
    assert.deepEqual(diskMenu.models.map(model => model.slug), scenario.visible);
    for (const [model, which] of [['gpt-6-sol', 'official'], ['GPT/gpt-6-sol', 'gateway']]) {
      const allowed = scenario.visible.includes(model);
      const httpResult = await httpRequest(base, model);
      assert.equal(httpResult.status, allowed ? 200 : 400);
      const wsResult = await wsRequest(base, model);
      assert.equal(wsResult.type, allowed ? 'response.completed' : 'error');
      if (allowed) assert(records.slice(offset).some(record => record.which === which && record.body?.model === model));
    }
    const own = records.slice(offset);
    if (scenario.entryMode === 'official') assert(!own.some(record => record.which === 'gateway'), 'Official entry contacted the gateway');
    if (!scenario.login || scenario.entryMode === 'apionly') assert(!own.some(record => record.which === 'official'), 'Gateway-only entry contacted the official upstream');
    for (const record of own.filter(record => record.which === 'gateway')) {
      assert.equal(record.headers.authorization, 'Bearer mock-api-key');
      assert.equal(record.headers['chatgpt-account-id'], undefined);
    }
    if (authBefore) assert.deepEqual(fs.readFileSync(authPath), authBefore);
    else assert(!fs.existsSync(authPath));
    server.child.kill();
    checks.push({ ...scenario, passed: true, upstreamRequests: own.length });
  }
  const report = { passed: true, scope: 'Isolated upstreams; actual HTTP/WebSocket forwarding, catalog visibility and credential preservation', checks };
  fs.mkdirSync(path.join(root, 'data/diagnostics'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/diagnostics/entry-scope-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  for (const socket of sockets) socket.destroy();
  for (const server of servers) server.close();
}
