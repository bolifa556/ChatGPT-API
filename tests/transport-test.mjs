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
import { officialDispatcherFor, requestWithAbort, WS_LITE_FIELD, TURN_STATE_HEADER } from '../src/transport.mjs';

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
let sequence = 0, socketId = 0;
const socketIds = new WeakMap(), httpDowngrades = new Set();
let temporaryUpgradeAttempts = 0;
const output = model => ({ id: 'resp_transport_' + (++sequence), object: 'response', status: 'completed', model,
  output: [{ type: 'message', id: 'msg_transport_' + sequence, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture', annotations: [] }] }] });
const originalToolCall = { type: 'custom_tool_call', id: 'ctc_fixture', call_id: 'call_fixture', name: 'fixture', input: 'original input', status: 'completed' };
const toolContinuationError = { type: 'error', status: 400, error: { code: 'invalid_request_error',
  message: 'No tool call found for custom tool call output with call_id call_fixture.' } };
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
      if (kind === 'gateway') res.setHeader('x-bifrost-request-id', 'fixture-request');
      if (req.url.includes('/models')) { res.end(JSON.stringify(kind === 'official' ? { models: [model] } : { data: [{ id: 'GPT/gpt-6-sol' }, { id: 'GPT/gpt-6.1-sol' }, { id: 'Other/test-model' }, { id: '阿里云订阅/config-fixture' }] })); return; }
      if (!socketIds.has(req.socket)) socketIds.set(req.socket, ++socketId);
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks), encoding = req.headers['content-encoding'];
      const decoder = { gzip: zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync, zstd: zlib.zstdDecompressSync }[encoding];
      const decoded = decoder ? decoder(raw) : raw, body = JSON.parse(decoded), response = output(body.model);
      record(body, { kind, transport: 'http', path: req.url, encoding, hash: digest(raw), headers: req.headers, socketId: socketIds.get(req.socket) });
      if (kind === 'gateway' && body.rejectLite && req.headers['x-openai-internal-codex-responses-lite']) {
        httpDowngrades.add(body.model);
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'unsupported_value', message: 'Responses Lite additional_tools is unsupported.' } })); return;
      }
      if (kind === 'gateway' && body.rejectConfiguration && body.input?.some(item => item.type === 'configuration_update')) {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'unsupported_value', message: 'Unsupported input type configuration_update', param: 'input[1].type' } })); return;
      }
      if (req.url.endsWith('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'chat_config_fixture', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: '{"answer":"fixture"}' }, finish_reason: 'stop' }] })); return;
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const result = 'data: ' + JSON.stringify({ type: 'response.created', response: { ...response, output: [], status: 'in_progress' } }) + '\n\ndata: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n';
        if (body.tail) {
          const pendingTail = records.at(-1);
          pendingTail.end = () => res.end('data: [DONE]\n\n');
          pendingTail.closed = new Promise(resolve => res.once('close', resolve));
          res.write(result);
        } else res.end(result);
      } else if (body.compressedReply) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(JSON.stringify(response)));
      } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response)); }
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  const official = makeHttp('official'), wss = new WebSocketServer({ server: official, maxPayload: 256 * 1024 * 1024 });
  wss.on('headers', (headers, req) => {
    if (req.headers['x-test-turn-state'] === '1') headers.push(TURN_STATE_HEADER + ': official-turn-fixture');
  });
  wss.on('connection', (ws, req) => {
    const peer = { ws, ids: new Set(), lanes: new Map() }; peers.push(peer); ws.on('error', () => {});
    ws.on('message', raw => {
      const body = JSON.parse(raw), lane = body.stream_id ?? null;
      record(body, { kind: 'official', transport: 'ws', headers: req.headers });
      peer.lanes.set(lane, (peer.lanes.get(lane) || Promise.resolve()).then(async () => {
        if (body.closeCode) { body.closeCode === 1006 ? ws.terminate() : ws.close(body.closeCode, 'Original upstream close reason'); return; }
        if (body.queue) await delay(30);
        const extra = body.stream_id !== undefined ? { stream_id: body.stream_id } : {};
        if (body.reject || (body.previous_response_id && !peer.ids.has(body.previous_response_id))) {
          ws.send(JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', code: 'previous_response_not_found', message: 'Fixture previous response not found' }, ...extra })); return;
        }
        if (body.rejectToolResult) { ws.send(JSON.stringify(toolContinuationError)); return; }
        const response = output(body.model); peer.ids.add(response.id);
        if (body.toolCallFixture) response.output = [originalToolCall];
        ws.send(JSON.stringify({ type: 'response.created', response: { ...response, output: [], status: 'in_progress' }, ...extra }));
        if (body.nativeTurnState) ws.send(JSON.stringify({ type: 'response.metadata', response_id: response.id,
          headers: { 'X-Codex-Turn-State': 'official-stream-state' }, ...extra }));
        ws.send(JSON.stringify({ type: 'response.completed', response, ...extra }));
      }));
    });
  });
  const gateway = makeHttp('gateway'), gatewayWss = new WebSocketServer({ noServer: true });
  gateway.on('upgrade', (req, socket, head) => {
    if (req.headers['x-test-native-ws'] !== '1') { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    if (req.headers['x-test-temporary-ws'] && ++temporaryUpgradeAttempts === 1) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return;
    }
    gatewayWss.handleUpgrade(req, socket, head, ws => {
      const socketId = ++sequence;
      let current;
      ws.on('error', () => {});
      ws.on('message', (raw, binary) => {
        const body = JSON.parse(raw), send = event => ws.send(JSON.stringify(event));
        record(body, { kind: 'gateway', transport: 'ws', headers: req.headers, socketId, binary, hash: digest(raw) });
        if (body.type === 'response.interrupt') {
          send({ type: 'response.interrupt.accepted', response_id: body.response_id });
          send({ type: 'response.completed', response: { ...current, status: 'cancelled' } });
          return;
        }
        if (body.expirePrevious && body.previous_response_id) {
          send({ type: 'error', status: 409, error: { code: 'previous_response_not_found' } });
          return;
        }
        if (body.rejectToolResult) { send(toolContinuationError); return; }
        if (body.rejectNative || body.failAfterStart) {
          if (body.failAfterStart) send({ type: 'response.created', response: { ...output(body.model), output: [], status: 'in_progress' } });
          send({ type: 'error', status: 400, error: { code: 'unsupported_value', message: 'Responses Lite additional_tools is unsupported.' } });
          return;
        }
        current = output(body.model);
        if (body.toolCallFixture) current.output = [originalToolCall];
        send({ type: 'response.created', response: { ...current, output: [], status: 'in_progress' } });
        if (!body.waitForInterrupt) send({ type: 'response.completed', response: current });
      });
    });
  });
  const officialPort = await listen(official), gatewayPort = await listen(gateway);
  const reserved = http.createServer(), port = await listen(reserved); await new Promise(resolve => reserved.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  fs.writeFileSync(path.join(fixture, 'data/.env'), `BASE_URL=http://127.0.0.1:${gatewayPort}/v1\nAPI_KEY=mock-gateway\nSHIM_PORT=${port}\nOFFICIAL_BASE=http://127.0.0.1:${officialPort}/backend-api/codex\n`);
  fs.writeFileSync(path.join(fixture, 'data/state/route-state.json'), JSON.stringify({ mode: 'mixed', officialProxy: '', clientVersion: '0.163.0' }));
  const options = { env: { ...process.env, CODEX_HOME: path.join(fixture, 'home'), CHATGPT_API_DEBUG: '1', CHATGPT_API_ROOT: fixture }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] };
  const prepare = spawn(process.execPath, [path.join(root, 'src/shim.mjs'), '--prepare'], options); children.push(prepare);
  assert.equal((await once(prepare, 'exit'))[0], 0);
  const router = spawn(process.execPath, [path.join(root, 'src/shim.mjs')], options); children.push(router);
  let stderr = ''; router.stderr.on('data', value => stderr += value);
  let ready = false;
  for (let i = 0; i < 100; i++) { try { ready = (await fetch(base + '/healthz')).ok; if (ready) break; } catch {} await delay(30); }
  assert(ready, stderr);
  async function connect(headers) { const ws = new WebSocket(base.replace('http:', 'ws:') + '/v1/responses', { headers }); clients.push(ws); ws.on('error', () => {}); await once(ws, 'open'); return ws; }

  const nativeProtocol = 'x-openai-internal-codex-responses-lite';
  const forwardedProtocol = 'x-bf-eh-' + nativeProtocol;
  const nativeMetadata = { 'user-agent': 'Native client fixture', originator: 'Codex Desktop', version: '0.166.0',
    'x-codex-turn-metadata': '{"turn_id":"native-turn"}', 'x-codex-turn-state': 'native-state',
    'x-codex-beta-features': 'native-feature', 'x-client-request-id': 'native-request', 'session-id': 'native-session' };
  for (const selected of ['gpt-6-sol', 'GPT/gpt-6-sol', 'Other/test-model']) {
    const native = selected !== 'Other/test-model', gateway = selected.startsWith('GPT/');
    for (const stream of [false, true]) {
      const original = { model: selected, stream, input: [{ role: 'user', content: 'Use only the client tools.' }] };
      const reply = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', [nativeProtocol]: 'true', ...nativeMetadata, authorization: 'Bearer mock-official', 'chatgpt-account-id': 'native-account' }, body: JSON.stringify(original) });
      assert.equal(reply.status, 200); await reply.arrayBuffer();
      const sent = records.at(-1);
      assert.equal(sent.headers[nativeProtocol], native ? 'true' : undefined);
      assert.equal(sent.headers[forwardedProtocol], gateway ? 'true' : undefined);
      for (const [name, value] of Object.entries(nativeMetadata)) assert.equal(sent.headers['x-bf-eh-' + name], gateway ? value : undefined);
      assert.equal(sent.headers['x-bf-eh-authorization'], undefined);
      assert.equal(sent.headers['x-bf-eh-chatgpt-account-id'], undefined);
      assert.equal(sent.body.input[0].content, original.input[0].content);
      assert.equal(sent.body.tools, undefined);
    }
    const ws = await connect({ [nativeProtocol]: 'true', ...nativeMetadata });
    assert.equal((await turn(ws, { model: selected, input: [] })).type, 'response.completed');
    assert.equal(records.at(-1).headers[nativeProtocol], native ? 'true' : undefined);
    assert.equal(records.at(-1).headers[forwardedProtocol], gateway ? 'true' : undefined);
    for (const [name, value] of Object.entries(nativeMetadata)) assert.equal(records.at(-1).headers['x-bf-eh-' + name], gateway ? value : undefined);
    ws.close();
  }
  await (await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', [forwardedProtocol]: 'true' }, body: JSON.stringify({ model: 'GPT/gpt-6-sol', input: [] }) })).arrayBuffer();
  assert.equal(records.at(-1).headers[nativeProtocol], undefined);
  assert.equal(records.at(-1).headers[forwardedProtocol], undefined);
  checks.push('Native Responses protocol identity survives a Bifrost header boundary over HTTP/SSE/WS without changing tools or messages; ordinary, official and non-GPT requests do not acquire that identity');
  await (await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer chatgpt-api-local' },
    body: JSON.stringify({ model: 'gpt-6-sol', input: [] }) })).arrayBuffer();
  assert.equal(records.at(-1).headers.authorization, 'Bearer mock-official');
  checks.push('A local bridge credential never becomes official OAuth; legacy requests use the saved native identity');
  {
    const updated = { model: '阿里云订阅/config-fixture', reasoning: { effort: 'low' }, text: { format: { type: 'text' } }, input: [
      { role: 'user', content: 'Original task' },
      { type: 'configuration_update', reasoning: { effort: 'medium' }, text: { format: { type: 'json_schema', name: 'fixture', schema: { type: 'object' } } } },
    ] };
    const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(updated) });
    assert.equal(response.status, 200); await response.arrayBuffer();
    assert.equal(records.at(-1).path, '/v1/chat/completions');
    assert.equal(records.at(-1).body.reasoning_effort, 'medium');
    assert.deepEqual(records.at(-1).body.messages, [{ role: 'user', content: 'Original task' }]);
    assert.deepEqual(records.at(-1).body.response_format.json_schema.schema, { type: 'object' });
    checks.push('A native format update selects the correct Chat route after conversion, with exact original messages and current reasoning settings');
  }

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
    const ws = await connect({ 'x-test-turn-state': '1' });
    const forwarded = [];
    ws.on('message', raw => forwarded.push(JSON.parse(raw)));
    const first = await turn(ws, { model: 'gpt-6-sol', input: [] });
    const metadata = forwarded.filter(event => event.type === 'response.metadata');
    assert.deepEqual(metadata, [{ type: 'response.metadata', response_id: first.response.id, headers: { [TURN_STATE_HEADER]: 'official-turn-fixture' } }]);
    await turn(ws, { model: 'gpt-6-sol', previous_response_id: first.response.id, input: [] });
    assert.equal(forwarded.filter(event => event.type === 'response.metadata').length, 1);
    ws.close();
  }
  {
    const ws = await connect({ 'x-test-turn-state': '1' });
    const forwarded = [];
    ws.on('message', raw => forwarded.push(JSON.parse(raw)));
    const warm = await turn(ws, { model: 'gpt-6-sol', generate: false, input: [] });
    await turn(ws, { model: 'gpt-6-sol', previous_response_id: warm.response.id, input: [] });
    assert(!forwarded.some(event => event.type === 'response.metadata'), 'A startup handshake token escaped its original turn');
    ws.close();
  }
  checks.push('Official handshake state reaches the original live response exactly once and never leaks from startup prewarm');
  {
    const ws = await connect({ 'x-test-turn-state': '1', 'x-test-native-ws': '1', [TURN_STATE_HEADER]: 'official-incoming-state' });
    const received = [];
    ws.on('message', raw => received.push(JSON.parse(raw)));
    const first = await turn(ws, { model: 'gpt-6-sol', nativeTurnState: true, input: [] });
    assert.deepEqual(received.filter(event => event.type === 'response.metadata'), [{ type: 'response.metadata',
      response_id: first.response.id, headers: { 'X-Codex-Turn-State': 'official-stream-state' } }]);
    const gateway = await turn(ws, { model: 'GPT/gpt-6-sol', client_metadata: { [WS_LITE_FIELD]: 'true', [TURN_STATE_HEADER]: 'official-stream-state' }, input: [] });
    assert.equal(gateway.type, 'response.completed');
    assert.equal(records.at(-1).headers[TURN_STATE_HEADER], undefined);
    assert.equal(records.at(-1).body.client_metadata[TURN_STATE_HEADER], undefined);
    await turn(ws, { model: 'gpt-6-sol', client_metadata: { [TURN_STATE_HEADER]: 'gateway-stream-state' }, input: [] });
    assert.equal(records.at(-1).body.client_metadata[TURN_STATE_HEADER], undefined);
    ws.close();
  }
  checks.push('Real upstream turn metadata takes precedence over handshake state, and switches without a previous ID do not forward foreign state');
  {
    const ws = await connect({ 'x-test-native-ws': '1', authorization: 'Bearer mock-official', 'chatgpt-account-id': 'official-account' });
    const model = 'GPT/gpt-6-sol', metadata = { [WS_LITE_FIELD]: 'true' };
    const prefix = [{ type: 'additional_tools', role: 'developer', id: 'at_fixture', tools: [] }, { role: 'user', content: 'original context' }];
    const before = records.length;
    const warm = await turn(ws, { model, client_metadata: metadata, generate: false, input: [] });
    assert.equal(records.length, before, 'Gateway preconnect must not generate upstream');
    const first = await turn(ws, { model, client_metadata: metadata, previous_response_id: warm.response.id, input: prefix });
    const one = records.at(-1);
    assert.equal(one.transport, 'ws');
    assert.equal(one.previous, undefined);
    assert.equal(one.headers.authorization, 'Bearer mock-gateway');
    assert.equal(one.headers['chatgpt-account-id'], undefined);
    assert.deepEqual(one.body.input, prefix);
    const delta = [{ role: 'user', content: 'incremental input' }];
    const second = await turn(ws, { model, client_metadata: metadata, previous_response_id: first.response.id, input: delta });
    const two = records.at(-1);
    assert.equal(two.socketId, one.socketId);
    assert.equal(two.previous, first.response.id);
    assert.deepEqual(two.body.input, delta);
    assert.equal(two.body.tools, undefined);
    const branch = await turn(ws, { model, client_metadata: metadata, previous_response_id: first.response.id, input: [] });
    assert.equal(records.at(-1).previous, undefined, 'A stale branch attempted to reuse the current response slot');
    assert(records.at(-1).body.input.some(item => item.content === 'original context'));
    const beforeRecovery = records.length;
    const recovered = await turn(ws, { model, client_metadata: metadata, previous_response_id: branch.response.id, expirePrevious: true, input: [] });
    const [rejection, recovery] = records.slice(beforeRecovery);
    assert.equal(records.length, beforeRecovery + 2);
    assert.equal(rejection.previous, branch.response.id);
    assert.equal(recovery.previous, undefined);
    assert.equal(recovery.socketId, one.socketId);
    assert(recovery.body.input.some(item => item.content === 'original context'));
    const done = events(ws);
    ws.send(JSON.stringify({ type: 'response.create', model, client_metadata: metadata, previous_response_id: recovered.response.id, waitForInterrupt: true, input: [] }));
    const [created] = await once(ws, 'message');
    ws.send(JSON.stringify({ type: 'response.interrupt', mode: 'discard_partial_items', response_id: JSON.parse(created).response.id }));
    const interrupted = (await done)[0];
    assert.equal(interrupted.response.status, 'cancelled');
    assert.equal(records.at(-1).body.type, 'response.interrupt');
    const next = events(ws);
    ws.send(JSON.stringify({ type: 'response.create', model, client_metadata: metadata, failAfterStart: true, input: [] }));
    assert.equal((await next)[0].type, 'error');
    assert.equal(records.at(-1).transport, 'ws', 'An accepted request was retried over HTTP');
    ws.close();
  }
  checks.push('A native GPT source keeps incremental input, tool carriers and interrupts on the same gateway socket without reusing synthetic IDs or replaying accepted work');
  for (const model of ['gpt-6-sol', 'GPT/gpt-6-sol']) {
    const ws = await connect({ 'x-test-native-ws': '1' }), client_metadata = { [WS_LITE_FIELD]: 'true' };
    const first = await turn(ws, { model, client_metadata, toolCallFixture: true, input: [] });
    assert.deepEqual(first.response.output, [originalToolCall]);
    const before = records.length;
    const input = [{ type: 'custom_tool_call_output', call_id: originalToolCall.call_id, output: 'original result' }];
    const reply = await turn(ws, { model, client_metadata, rejectToolResult: true, previous_response_id: first.response.id, input });
    assert.deepEqual(reply, toolContinuationError);
    assert.equal(records.length, before + 1);
    assert.equal(records.at(-1).transport, 'ws');
    assert.equal(records.at(-1).previous, first.response.id);
    assert.deepEqual(records.at(-1).body.input, input);
    ws.close();
  }
  checks.push('Both WebSocket routes forward the original tool result and preserve a tool-pairing rejection, without retrying a different request');
  {
    const ws = await connect({ 'x-test-native-ws': '1', 'x-test-temporary-ws': '1' });
    const model = 'GPT/gpt-6-sol', metadata = { [WS_LITE_FIELD]: 'true' };
    const first = await turn(ws, { model, client_metadata: metadata, input: [] });
    assert.equal(first.type, 'response.completed');
    assert.equal(records.at(-1).transport, 'http');
    assert.equal((await turn(ws, { model, client_metadata: metadata, previous_response_id: first.response.id, input: [] })).type, 'response.completed');
    assert.equal(records.at(-1).transport, 'http');
    assert.equal(temporaryUpgradeAttempts, 1);
    const raw = JSON.stringify({ type: 'response.create', model, client_metadata: metadata, input: [{ role: 'user', content: '原样' }] }, null, 2);
    const result = events(ws);
    ws.send(raw);
    assert.equal((await result)[0].type, 'response.completed');
    assert.equal(temporaryUpgradeAttempts, 2);
    assert.equal(records.at(-1).transport, 'ws');
    assert.equal(records.at(-1).hash, digest(raw));
    assert.equal(records.at(-1).binary, false);
    ws.close();
  }
  checks.push('A transient upgrade error keeps HTTP for the current chain and permits WebSocket on a later turn; unchanged requests keep the original text frame');
  {
    const ws = await connect({ 'x-test-native-ws': '1' });
    const model = 'GPT/gpt-6-sol', metadata = { [WS_LITE_FIELD]: 'true', [TURN_STATE_HEADER]: 'state-fixture' };
    const input = [{ type: 'additional_tools', role: 'developer', id: 'at_fixture', tools: [{ type: 'function', name: 'fixture', parameters: { type: 'object' } }] }];
    const before = records.length;
    const first = await turn(ws, { model, client_metadata: metadata, rejectNative: true, input });
    assert.equal(first.type, 'response.completed');
    const [wsRequest, httpRequest] = records.slice(before);
    assert.equal(wsRequest.transport, 'ws');
    assert.equal(httpRequest.transport, 'http');
    assert.equal(httpRequest.headers[nativeProtocol], 'true');
    assert.equal(httpRequest.headers[forwardedProtocol], 'true');
    assert.equal(httpRequest.headers[TURN_STATE_HEADER], 'state-fixture');
    assert.deepEqual(httpRequest.body.input, input);
    const second = await turn(ws, { model, client_metadata: metadata, previous_response_id: first.response.id, rejectLite: true, input: [] });
    assert.equal(second.type, 'response.completed');
    assert(httpDowngrades.has(model));
    assert.equal(records.at(-1).headers[nativeProtocol], undefined);
    assert.equal(records.at(-1).body.tools[0].name, 'fixture');
    assert(!records.at(-1).body.input.some(item => item.type === 'additional_tools'));
    const next = records.length;
    await turn(ws, { model, client_metadata: metadata, previous_response_id: second.response.id, input: [] });
    assert.equal(records.length, next + 1, 'An unsupported transport was tried again during the next tool round');
    ws.close();
  }
  checks.push('A provider that rejects native WebSocket validation falls back to native HTTP and then standard HTTP only on explicit validation errors');
  {
    const request = { model: 'GPT/gpt-6.1-sol', rejectConfiguration: true, reasoning: { effort: 'low', summary: 'auto' },
      input: [{ role: 'user', content: 'Original message' }, { type: 'configuration_update', id: 'cfg_test', reasoning: { effort: 'high' }, text: { verbosity: 'low' } },
        { type: 'item_reference', id: 'cfg_test' }, { role: 'user', content: 'Original follow-up' }] };
    const post = () => fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    const before = records.length;
    const reply = await post(); assert.equal(reply.status, 200); await reply.arrayBuffer();
    const [original, compatible] = records.slice(before);
    assert.equal(records.length, before + 2);
    assert.deepEqual(original.body.input, request.input);
    assert.deepEqual(compatible.body.input, [request.input[0], request.input[3]]);
    assert.deepEqual(compatible.body.reasoning, { effort: 'high', summary: 'auto' });
    assert.deepEqual(compatible.body.text, { verbosity: 'low' });
    const next = await post(); assert.equal(next.status, 200); await next.arrayBuffer();
    assert.equal(records.length, before + 3);
  }
  checks.push('A GPT source that explicitly rejects the configuration item receives its original effective settings at request level once and on later turns');
  {
    const ws = await connect();
    const model = 'GPT/gpt-6-sol';
    const first = await turn(ws, { model, input: [], tail: true });
    const tail = records.at(-1);
    assert.equal(first.type, 'response.completed');
    tail.end();
    await tail.closed;
    await delay(25);
    await turn(ws, { model, previous_response_id: first.response.id, input: [] });
    assert.equal(records.at(-1).socketId, tail.socketId);
    ws.close();
  }
  checks.push('The gateway sends completion before the SSE tail ends, then reuses the HTTP connection');
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
    const cache = new HistoryCache();
    const original = { type: 'message', role: 'user', content: [{ type: 'input_text', text: '代码、工具和对话。'.repeat(48000) }], optional: undefined };
    assert(cache.set('large', { input: [original], defaults: {}, lane: 'main', complete: true }));
    const stored = cache.entries.get('large').input[0];
    assert.equal(stored.packed, null, 'Packing blocked insertion on the main thread');
    assert.equal(cache.get('large').input[0], original);
    for (let n = 0; n < 200 && !stored.packed; n++) await delay(10);
    assert(stored.packed?.length < 10000, 'Compressible history retained a full-size resident item');
    stored.current = null;
    const restored = cache.get('large').input[0];
    assert.deepEqual(restored, original);
    assert(cache.set('continued', { input: [restored, { role: 'user', content: '继续' }], defaults: {}, lane: 'main', complete: true }));
    assert.equal(cache.entries.get('continued').input[0], stored, 'Continuing a large dialogue created another copy of its prefix');
  }
  checks.push('Large history items are compressed in memory and materialize without losing text, shape or shared prefixes');
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
