import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { HistoryCache } from '../src/response-state.mjs';
import { officialDispatcherFor, requestWithAbort } from '../src/transport.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(root, 'data/testing'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, 'data/testing/transport-'));
for (const sub of ['assets', 'data/state', 'home']) fs.mkdirSync(path.join(fixture, sub), { recursive: true });
for (const name of ['model-template.json', 'reasoning-levels.json']) fs.copyFileSync(path.join(root, 'assets', name), path.join(fixture, 'assets', name));
const model = { ...JSON.parse(fs.readFileSync(path.join(fixture, 'assets/model-template.json'), 'utf8')).models[0], slug: 'gpt-6-sol' };
fs.writeFileSync(path.join(fixture, 'home/models_cache.json'), JSON.stringify({ models: [model] }));
fs.writeFileSync(path.join(fixture, 'home/auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'mock-official' } }));
const sockets = new Set(), servers = [], peers = [], clients = [], children = [], records = [], checks = [];
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let sequence = 0;
const output = model => ({ id: 'resp_transport_' + (++sequence), object: 'response', status: 'completed', model,
  output: [{ type: 'message', id: 'msg_transport_' + sequence, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture', annotations: [] }] }] });
function record(body, extra = {}) {
  const input = Array.isArray(body.input) ? body.input : [];
  records.push({ ...extra, previous: body.previous_response_id, model: body.model, count: input.length,
    first: typeof input[0]?.content === 'string' ? input[0].content.slice(0, 80) : null,
    firstLength: typeof input[0]?.content === 'string' ? input[0].content.length : null,
    body: JSON.stringify(body).length < 10000 ? body : null });
}
async function listen(server) {
  servers.push(server); server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port;
}
function events(ws, count = 1) {
  return new Promise((resolve, reject) => {
    const found = [], timer = setTimeout(() => finish(new Error('Fixture response timed out')), 30000);
    function finish(error, result) { clearTimeout(timer); ws.off('message', receive); ws.off('close', close); error ? reject(error) : resolve(result); }
    function close(code, reason) { finish(null, [{ closeCode: code, reason: reason.toString() }]); }
    function receive(raw) {
      const event = JSON.parse(raw);
      if (event.type === 'error' || event.type === 'response.completed') {
        found.push(event); if (found.length === count) finish(null, found);
      }
    }
    ws.on('message', receive); ws.on('close', close);
  });
}
async function turn(ws, body) { const result = events(ws); ws.send(JSON.stringify({ type: 'response.create', ...body })); return (await result)[0]; }
try {
  const makeHttp = kind => http.createServer(async (req, res) => {
    try {
      if (req.url.includes('/models')) { res.end(JSON.stringify(kind === 'official' ? { models: [model] } : { data: [{ id: 'GPT/gpt-6-sol' }, { id: 'Other/test-model' }] })); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks), encoding = req.headers['content-encoding'];
      const decoder = { gzip: zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync, zstd: zlib.zstdDecompressSync }[encoding];
      const decoded = decoder ? decoder(raw) : raw, body = JSON.parse(decoded), response = output(body.model);
      record(body, { kind, transport: 'http', encoding, hash: digest(raw), headers: req.headers });
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ type: 'response.created', response: { ...response, output: [], status: 'in_progress' } }) + '\n\ndata: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n');
      } else if (body.compressedReply) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(JSON.stringify(response)));
      } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response)); }
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  const official = makeHttp('official'), wss = new WebSocketServer({ server: official, maxPayload: 256 * 1024 * 1024 });
  wss.on('connection', ws => {
    const peer = { ws, ids: new Set(), lanes: new Map() }; peers.push(peer); ws.on('error', () => {});
    ws.on('message', raw => {
      const body = JSON.parse(raw), lane = body.stream_id ?? null;
      record(body, { kind: 'official', transport: 'ws' });
      peer.lanes.set(lane, (peer.lanes.get(lane) || Promise.resolve()).then(async () => {
        if (body.closeCode) { body.closeCode === 1006 ? ws.terminate() : ws.close(body.closeCode, 'Original upstream close reason'); return; }
        if (body.queue) await delay(30);
        const extra = body.stream_id !== undefined ? { stream_id: body.stream_id } : {};
        if (body.reject || (body.previous_response_id && !peer.ids.has(body.previous_response_id))) {
          ws.send(JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', code: 'previous_response_not_found', message: 'Fixture previous response not found' }, ...extra })); return;
        }
        const response = output(body.model); peer.ids.add(response.id);
        ws.send(JSON.stringify({ type: 'response.created', response: { ...response, output: [], status: 'in_progress' }, ...extra }));
        ws.send(JSON.stringify({ type: 'response.completed', response, ...extra }));
      }));
    });
  });
  const officialPort = await listen(official), gatewayPort = await listen(makeHttp('gateway'));
  const reserved = http.createServer(), port = await listen(reserved); await new Promise(resolve => reserved.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  fs.writeFileSync(path.join(fixture, 'data/.env'), `BASE_URL=http://127.0.0.1:${gatewayPort}/v1\nAPI_KEY=mock-gateway\nSHIM_PORT=${port}\nOFFICIAL_BASE=http://127.0.0.1:${officialPort}/backend-api/codex\n`);
  fs.writeFileSync(path.join(fixture, 'data/state/route-state.json'), JSON.stringify({ mode: 'mixed', officialProxy: '', clientVersion: '0.163.0' }));
  const options = { env: { ...process.env, CODEX_HOME: path.join(fixture, 'home'), CHATGPT_API_ROOT: fixture }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] };
  const prepare = spawn(process.execPath, [path.join(root, 'src/shim.mjs'), '--prepare'], options); children.push(prepare);
  assert.equal((await once(prepare, 'exit'))[0], 0);
  const router = spawn(process.execPath, [path.join(root, 'src/shim.mjs')], options); children.push(router);
  let stderr = ''; router.stderr.on('data', value => stderr += value);
  let ready = false;
  for (let i = 0; i < 100; i++) { try { ready = (await fetch(base + '/healthz')).ok; if (ready) break; } catch {} await delay(30); }
  assert(ready, stderr);
  async function connect() { const ws = new WebSocket(base.replace('http:', 'ws:') + '/v1/responses'); clients.push(ws); ws.on('error', () => {}); await once(ws, 'open'); return ws; }

  const encoders = { gzip: zlib.gzipSync, deflate: zlib.deflateSync, br: zlib.brotliCompressSync, ...(zlib.zstdCompressSync ? { zstd: zlib.zstdCompressSync } : {}) };
  for (const [encoding, encode] of Object.entries(encoders)) {
    const raw = encode(Buffer.from(JSON.stringify({ model: 'gpt-6-sol', compressedReply: true, input: [{ role: 'user', content: 'Original native input' }] })));
    const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': encoding, 'accept-encoding': 'gzip' }, body: raw });
    assert.equal(response.status, 200); assert.equal((await response.json()).status, 'completed');
    assert.equal(records.at(-1).hash, digest(raw)); assert.equal(records.at(-1).encoding, encoding);
    assert.equal(records.at(-1).headers['accept-encoding'], 'gzip');
    const changed = encode(Buffer.from(JSON.stringify({ model: 'gpt-6-sol', input: [{ type: 'additional_tools', tools: [] }, { role: 'user', content: 'unchanged text' }] })));
    await (await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': encoding }, body: changed })).arrayBuffer();
    assert.equal(records.at(-1).encoding, encoding); assert.equal(records.at(-1).body.input[0].role, 'developer');
    assert.equal(records.at(-1).body.input[1].content, 'unchanged text');
  }
  checks.push('Native HTTP preserves compressed bytes and response encoding; required history conversion re-encodes without changing original text');
  const gatewayRaw = zlib.gzipSync(JSON.stringify({ model: 'GPT/gpt-6-sol', input: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'probe', parameters: { type: 'object', properties: {} } }] }] }));
  await (await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: gatewayRaw })).arrayBuffer();
  assert.equal(records.at(-1).encoding, undefined); assert.equal(records.at(-1).body.tools[0].name, 'probe');
  checks.push('Gateway format conversion does not assume compressed-request support');
  for (const stream_id of [undefined, 'queue']) {
    const ws = await connect(), extra = stream_id === undefined ? {} : { stream_id }, pending = events(ws, 2);
    for (const marker of ['FIRST_HISTORY', 'SECOND_HISTORY']) ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-6-sol', queue: true, input: [{ role: 'user', content: marker }], ...extra }));
    const results = await pending;
    for (const [index, result] of results.entries()) {
      const switched = await turn(ws, { model: 'GPT/gpt-6-sol', previous_response_id: result.response.id, input: [{ role: 'user', content: 'Continue selected response' }], ...extra });
      assert.equal(switched.type, 'response.completed'); assert.equal(records.at(-1).first, ['FIRST_HISTORY', 'SECOND_HISTORY'][index]);
    }
    ws.close();
  }
  checks.push('Queued native creates bind both original histories to their own response IDs on default and named lanes');
  {
    const ws = await connect(), pending = events(ws, 2);
    ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-6-sol', queue: true, input: [{ role: 'user', content: 'IMPLICIT_LANE' }] }));
    ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-6-sol', stream_id: 'default', queue: true, input: [{ role: 'user', content: 'NAMED_DEFAULT_LANE' }] }));
    for (const result of await pending) {
      await turn(ws, { model: 'GPT/gpt-6-sol', previous_response_id: result.response.id, input: [], ...(result.stream_id ? { stream_id: result.stream_id } : {}) });
      assert.equal(records.at(-1).first, result.stream_id ? 'NAMED_DEFAULT_LANE' : 'IMPLICIT_LANE');
    }
    ws.close();
  }
  checks.push('A named default stream remains separate from the implicit default lane');
  {
    const ws = await connect(), seed = await turn(ws, { model: 'gpt-6-sol', input: [{ role: 'user', content: 'SEED' }] });
    peers.at(-1).ids.clear();
    const pending = events(ws, 2), before = records.length;
    ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-6-sol', previous_response_id: seed.response.id, queue: true, input: [] }));
    ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-6-sol', queue: true, input: [{ role: 'user', content: 'AFTER_ERROR' }] }));
    const [error, success] = await pending;
    assert.equal(error.type, 'error'); assert.equal(success.type, 'response.completed'); assert.equal(records.length, before + 2);
    await turn(ws, { model: 'GPT/gpt-6-sol', previous_response_id: success.response.id, input: [] });
    assert.equal(records.at(-1).first, 'AFTER_ERROR'); ws.close();
  }
  checks.push('A rejected queued request cannot consume the following history or silently reorder it by replaying');
  for (const code of [1009, 1011, 1006]) {
    const ws = await connect(), result = await turn(ws, { model: 'gpt-6-sol', closeCode: code, input: [] });
    assert.equal(result.closeCode, code);
    if (code !== 1006) assert.equal(result.reason, 'Original upstream close reason');
  }
  checks.push('Native close codes and reasons survive forwarding, including abnormal closure');
  {
    const ws = await connect(), size = 65 * 1024 * 1024;
    const first = await turn(ws, { model: 'gpt-6-sol', input: [{ role: 'user', content: 'L'.repeat(size) }] });
    const next = await turn(ws, { model: 'gpt-6-sol', previous_response_id: first.response.id, input: [{ role: 'user', content: 'delta' }] });
    assert.equal(records.at(-1).previous, first.response.id); assert.equal(records.at(-1).count, 1);
    const switched = await turn(ws, { model: 'GPT/gpt-6-sol', previous_response_id: next.response.id, input: [{ role: 'user', content: 'switch' }] });
    assert.equal(switched.type, 'response.completed'); assert.equal(records.at(-1).firstLength, size);
    await turn(ws, { model: 'gpt-6-sol', previous_response_id: switched.response.id, input: [{ role: 'user', content: 'return' }] });
    assert.equal(records.at(-1).firstLength, size); ws.close();
  }
  checks.push('65 MiB native history stays incremental and survives official ↔ gateway switching without truncation');
  {
    const cache = new HistoryCache({ maxBytes: 160000, maxEntries: 3 }), shared = { role: 'user', content: 'S'.repeat(100000) };
    for (let n = 0; n < 3; n++) cache.set('r' + n, { input: [shared, { role: 'user', content: String(n) }], defaults: {}, lane: 'a', complete: true });
    for (let n = 0; n < 3; n++) assert(cache.get('r' + n), 'Shared prefixes must not be counted three times');
    cache.set('b', { input: [{ role: 'user', content: 'B'.repeat(40000) }], defaults: {}, lane: 'b', complete: true });
    assert(cache.get('r2')); assert(cache.get('b')); assert(!cache.get('r0'));
    assert.equal(cache.set('oversized', { input: [{ role: 'user', content: 'X'.repeat(200000) }], defaults: {}, lane: 'c' }), false);
    assert(cache.get('r2')); assert(cache.get('b'));
  }
  checks.push('History storage shares prefixes, retains active lanes, remains bounded and never fabricates missing history');
  {
    const proxy = http.createServer();
    proxy.on('connect', (_req, socket) => { socket.on('error', () => {}); socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); });
    const proxyPort = await listen(proxy), agent = officialDispatcherFor('http://127.0.0.1:' + proxyPort, 100);
    try {
      await assert.rejects(requestWithAbort('https://transport-test.invalid/', { dispatcher: agent }), error => error.code === 'UND_ERR_CONNECT_TIMEOUT' && error.message.includes('100ms'));
      const started = Date.now();
      await assert.rejects(requestWithAbort('https://transport-test.invalid/', { dispatcher: agent, signal: AbortSignal.timeout(30) }), error => error.name === 'TimeoutError');
      assert(Date.now() - started < 800, 'Cancellation must not wait for the TLS connector');
    } finally { await agent.destroy(); }
  }
  checks.push('Proxy TLS uses its configured deadline; cancellation returns before a pending handshake completes');
  const log = fs.readFileSync(path.join(fixture, 'data/logs/shim.log'), 'utf8');
  assert(log.includes('wireBytes')); assert(log.includes('firstByteMs')); assert(!log.includes('Original native input'));
  checks.push('Transport diagnostics record sizes and phases without prompt content');
  const report = { passed: true, checks };
  fs.mkdirSync(path.join(root, 'data/diagnostics'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/diagnostics/transport-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const ws of clients) ws.terminate();
  for (const peer of peers) peer.ws.terminate();
  for (const child of children) if (child.exitCode === null) child.kill();
  for (const socket of sockets) socket.destroy();
  for (const server of servers) { server.close(); server.closeAllConnections?.(); }
}
