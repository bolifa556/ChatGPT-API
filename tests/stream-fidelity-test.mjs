import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { ssePackets, encodeSse, isSseControl } from '../src/sse.mjs';
import { NonGptAdapter } from '../src/non-gpt-compat.mjs';
import { ChatEvents, chatEndpointUnavailable } from '../src/chat-compat.mjs';
import { HistoryCache } from '../src/response-state.mjs';
import { requestWithAbort, officialDispatcherFor, protocolError, writeWebSocket, RESPONSE_TIMEOUTS } from '../src/transport.mjs';
import { normalizeBaseUrl } from '../src/settings.mjs';
import { settingsChecked as linuxSettings } from '../linux/provider.mjs';
import { settingsChecked as macosSettings } from '../macos/provider.mjs';

const checks = [], wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const originalError = { type: 'rate_limit_error', code: 'quota_exceeded', message: 'Original error', param: 'model', details: { original: true } };
for (const newline of ['\n', '\r\n', '\r']) for (const size of [1, 7, 4096]) {
  const body = ['event: response.created', 'data: {"type":"response.created","delta":"中文"}', '',
    ': original heartbeat', '', 'event: error', 'data: ' + JSON.stringify({ error: originalError }), '', ''].join(newline);
  const bytes = Buffer.from(body), chunks = [];
  for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.subarray(at, at + size));
  const packets = []; for await (const packet of ssePackets(Readable.from(chunks))) packets.push(packet);
  assert.equal(packets[0].data.delta, '中文');
  assert(isSseControl(packets[1])); assert.equal(encodeSse(packets[1]), ': original heartbeat\n');
  assert.equal(packets[2].event, 'error'); assert.deepEqual(packets[2].data.error, originalError);
}
{
  let finish; const released = new Promise(resolve => finish = resolve);
  const stream = Readable.from((async function* () { yield Buffer.from(': idle\n'); await released; })());
  const iterator = ssePackets(stream); let timeout;
  try { const first = await Promise.race([iterator.next(), new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(Error('Heartbeat waited for stream completion')), 1000); })]); assert(isSseControl(first.value)); }
  finally { clearTimeout(timeout); finish(); await iterator.return(); stream.destroy(); }
}
checks.push('Original SSE comments arrive before completion; event names, Unicode and split LF/CRLF/CR frames survive');

try { new ChatEvents('fixture').convert({ status: 429, error: originalError }); assert.fail('Missing error'); }
catch (error) { assert.equal(protocolError(error).status, 429); assert.deepEqual(protocolError(error).error, originalError); }
assert.equal(protocolError(Object.assign(Error('Upstream abort'), { name: 'AbortError', code: 'UND_ERR_ABORTED' })).status, 502);
assert(!chatEndpointUnavailable(404, { error: { code: 'model_not_found', message: 'Unknown model' } }));
assert(!chatEndpointUnavailable(404, { error: { code: 'tool_not_found', message: 'Original tool failure' } }));
assert(!chatEndpointUnavailable(404, { error: { message: 'Original processing failure' } }));
assert(chatEndpointUnavailable(404, { detail: 'Not Found' }));
assert(chatEndpointUnavailable(404, undefined, '<html><pre>Cannot POST /v1/responses</pre></html>'));
assert(!chatEndpointUnavailable(400, { error: { message: 'Unsupported tool' } }));
assert(!chatEndpointUnavailable(502)); assert(chatEndpointUnavailable(404, { error: { code: 'unsupported_endpoint' } }));
checks.push('Stream errors retain their original object; upstream transport aborts are not user cancellations');

{
  const source = { model: 'vendor-model', tools: [{ type: 'custom', name: 'exec', format: { type: 'text' } }], input: [
    { type: 'message', id: 'foreign_item', role: 'assistant', content: [{ type: 'output_text', text: 'Original message' }] },
    { type: 'custom_tool_call', id: 'ctc_original', name: 'exec', call_id: 'call_original', input: 'Original input' },
    { type: 'custom_tool_call_output', id: 'ctco_original', call_id: 'call_original', output: 'Original result' },
    ...['foreign_item', 'ctc_original', 'ctco_original'].map(id => ({ type: 'item_reference', id })),
  ] }, before = JSON.stringify(source), out = new NonGptAdapter(source).request();
  for (let at = 0; at < 3; at++) assert.equal(out.input[at].id, out.input[at + 3].id);
  assert.equal(JSON.parse(out.input[1].arguments).input, 'Original input'); assert.equal(out.input[2].output, 'Original result');
  assert.equal(JSON.stringify(source), before);
  const routes = new Map(), cache = new HistoryCache({ maxEntries: 2, onDelete: id => routes.delete(id) });
  for (const id of ['one', 'two', 'three']) { cache.set(id, { input: [], defaults: {}, lane: 'same' }); routes.set(id, 'gateway'); }
  assert.deepEqual([...routes.keys()], ['two', 'three']); assert.equal(cache.entries.size, 2);
  let callback, completed = false;
  const pending = writeWebSocket({ readyState: 1, send(_value, done) { callback = done; } }, 'Original frame').then(() => completed = true);
  await Promise.resolve(); assert(!completed); callback(); await pending; assert(completed);
}
for (const base of ['https://example.com', 'https://example.com/custom/v2', 'https://example.com/prefix/v1/responses']) {
  for (const checked of [linuxSettings, macosSettings]) assert.equal(checked({ BASE_URL: base, API_KEY: 'inert' }).BASE_URL, normalizeBaseUrl(base));
}
for (const checked of [linuxSettings, macosSettings]) assert.throws(() => checked({ BASE_URL: 'not-a-url', API_KEY: 'inert' }), error => error.code === 'gateway_unavailable');
checks.push('Only adapted item identities update references; old routes leave with history; WS output waits for writes; platform URL rules agree');

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testing = path.join(root, 'data/testing');
fs.mkdirSync(testing, { recursive: true });
const fixture = fs.mkdtempSync(path.join(testing, 'stream-fidelity-'));
const children = [], sockets = new Set(), servers = [], records = [], timers = new Set();
let proxyCount = 0, downloads = 0, allowResponses = false, held, finishHeartbeat;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const models = [{ id: 'GPT/gpt-fixture' }, { id: 'chat-only' }, { id: 'ws-chat-only' },
  { id: 'deepseek-reasoner', supported_endpoints: ['chat/completions'] },
  { id: 'chat-modern-limit', supported_endpoints: ['chat/completions'], supported_parameters: ['max_completion_tokens'] },
  { id: 'chat-truncated', supported_endpoints: ['chat/completions'] },
  { id: 'chat-error', supported_endpoints: ['chat/completions'] }, { id: 'flux-dev', type: 'image' }];
async function listen(server) {
  servers.push(server); server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port;
}
const terminal = model => ({ type: 'response.completed', response: { id: 'resp_' + crypto.randomUUID(), object: 'response', model, status: 'completed', output: [] } });
const peer = http.createServer(async (req, res) => {
  try {
    if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: models })); return; }
    if (req.url === '/held') { held?.(); return; }
    if (req.url === '/image') { downloads++; assert.equal(req.headers.authorization, undefined); res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from(png, 'base64')); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: cdn + '/image' }); res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); records.push({ path: req.url, body, host: req.headers.host });
    if (req.url.endsWith('/images/generations')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ created: 1, data: [{ url: 'http://' + req.headers.host + (body.prompt === 'redirect' ? '/redirect' : '/image') }] })); return; }
    if (req.url.endsWith('/responses') && (body.model === 'ws-chat-only' || body.model === 'chat-only' && !allowResponses)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'unsupported_endpoint', message: 'Responses endpoint not implemented' } })); return; }
    if (body.auditStatus) { res.writeHead(body.auditStatus, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end(zlib.gzipSync(JSON.stringify({ error: body.auditError || originalError }))); return; }
    if (body.model === 'chat-truncated') {
      const call = { id: 'call_partial', type: 'function', function: { name: body.tools[0].function.name, arguments: '{"input":"unfinished' } };
      const completion = { id: 'chat_partial', created: 1, model: body.model, choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', tool_calls: [call] } }] };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ ...completion, choices: [{ index: 0, finish_reason: 'length', delta: { tool_calls: [{ index: 0, ...call }] } }] }) + '\n\ndata: [DONE]\n\n');
      } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(completion)); }
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
    if (req.url.endsWith('/chat/completions')) {
      if (body.model === 'chat-error') { res.end('event: error\ndata: ' + JSON.stringify({ error: originalError }) + '\n\n'); return; }
      res.end('data: ' + JSON.stringify({ id: 'chat_fixture', model: body.model, choices: [{ index: 0, delta: { content: 'Original answer' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); return;
    }
    if (body.auditCase === 'event-error') { res.end('event: error\ndata: ' + JSON.stringify({ error: originalError }) + '\n\n'); return; }
    if (body.auditCase === 'heartbeat') {
      res.write(': original heartbeat\n');
      finishHeartbeat = () => { if (!res.destroyed) res.end(encodeSse(terminal(body.model))); };
      return;
    }
    res.end(encodeSse(terminal(body.model)));
  } catch (error) { res.writeHead(500); res.end(error.message); }
});
const proxy = http.createServer();
proxy.on('connect', (_req, socket) => { proxyCount++; socket.end('HTTP/1.1 502 Fixture rejection\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); });
let cdn;
async function start({ ssh = false } = {}) {
  const dir = path.join(fixture, 'router-' + children.length);
  for (const folder of ['assets', 'data/state', 'data/cache', 'home']) fs.mkdirSync(path.join(dir, folder), { recursive: true });
  for (const name of ['model-template.json', 'reasoning-levels.json']) fs.copyFileSync(path.join(root, 'assets', name), path.join(dir, 'assets', name));
  const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const upstream = 'http://' + (ssh ? 'api.fixture.invalid' : '127.0.0.1') + ':' + peer.address().port + '/v1';
  fs.writeFileSync(path.join(dir, 'data/.env'), `BASE_URL=${upstream}\nAPI_KEY=inert-key\nSHIM_PORT=${port}\nGATEWAY_TUNNEL_PORT=${peer.address().port}\n`);
  fs.writeFileSync(path.join(dir, 'data/state/route-state.json'), JSON.stringify({ mode: 'gateway', entryMode: 'apionly', officialProxy: 'http://127.0.0.1:' + proxy.address().port, gatewayTransport: ssh ? 'ssh' : 'direct' }));
  fs.writeFileSync(path.join(dir, 'data/cache/catalog-state.json'), JSON.stringify({ sourceId: crypto.createHash('sha256').update(upstream + '\ninert-key').digest('hex'), gatewayAt: new Date().toISOString(), gatewayIds: models.map(model => model.id), gatewayModels: models }));
  const child = spawn(process.execPath, [path.join(root, 'src/shim.mjs')], { env: { ...process.env, CHATGPT_API_ROOT: dir, CODEX_HOME: path.join(dir, 'home') }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); children.push(child);
  let errors = ''; child.stderr.on('data', data => errors += data);
  const base = 'http://127.0.0.1:' + port;
  let ready = false; for (let n = 0; n < 100; n++) { try { ready = (await fetch(base + '/healthz')).ok; if (ready) break; } catch {} await wait(20); } assert(ready, errors);
  return base;
}
const post = (base, body, suffix = '/v1/responses') => fetch(base + suffix, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
try {
  const cdnPort = await listen(http.createServer((req, res) => { downloads++; assert.equal(req.headers.authorization, undefined); res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from(png, 'base64')); })); cdn = 'http://127.0.0.1:' + cdnPort;
  await listen(peer); await listen(proxy);
  const base = await start();
  {
    const response = await post(base, { model: 'GPT/gpt-fixture', input: [], stream: true, auditCase: 'heartbeat' });
    const reader = response.body.getReader(), first = new TextDecoder().decode((await reader.read()).value);
    assert(first.includes(': original heartbeat')); assert(!first.includes('response.completed'));
    finishHeartbeat();
    let tail = ''; while (true) { const chunk = await reader.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value); } assert(tail.includes('response.completed'));
  }
  for (const model of ['GPT/gpt-fixture', 'chat-error']) {
    const response = await post(base, { model, input: [], stream: true, auditCase: 'event-error' });
    const output = await response.text(); assert(output.includes('event: error\n')); assert(!output.includes('event: undefined'));
    const events = []; for await (const packet of ssePackets(Readable.from([Buffer.from(output)]))) if (packet.data) events.push(packet.data);
    assert.deepEqual(events.at(-1).error, originalError);
  }
  checks.push('HTTP sends upstream heartbeats before the result; native and Chat stream errors retain their original fields');
  const original = { model: 'chat-only', instructions: 'Exact native instructions', input: [{ role: 'user', content: 'Exact user content' }], stream: true, service_tier: 'priority' };
  let response = await post(base, original); assert.equal(response.status, 200); await response.text();
  assert.deepEqual(records.at(-1).body.messages, [{ role: 'system', content: original.instructions }, { role: 'user', content: original.input[0].content }]);
  assert.equal(records.at(-1).body.service_tier, 'priority');
  const rejectedCount = records.filter(record => record.path.endsWith('/responses') && record.body.model === 'chat-only').length;
  response = await post(base, original); await response.text(); assert.equal(records.filter(record => record.path.endsWith('/responses') && record.body.model === 'chat-only').length, rejectedCount);
  for (const status of [400, 401, 403, 404, 429, 502]) {
    const before = records.length;
    response = await post(base, { model: 'GPT/gpt-fixture', input: [], auditStatus: status, auditError: originalError });
    assert.equal(response.status, status); assert.deepEqual((await response.json()).error, originalError); assert.equal(records.length, before + 1);
  }
  {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/v1/responses'); socket.on('error', () => {}); await once(socket, 'open');
    try {
      const completed = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('WS fallback timed out')), 5000); socket.on('message', raw => { const event = JSON.parse(raw); if (['response.completed', 'error'].includes(event.type)) { clearTimeout(timer); resolve(event); } }); });
      socket.send(JSON.stringify({ type: 'response.create', model: 'ws-chat-only', input: [{ role: 'user', content: 'Original WS input' }] }));
      assert.equal((await completed).type, 'response.completed'); assert.equal(records.at(-1).path, '/v1/chat/completions');
    } finally { const closed = once(socket, 'close'); socket.close(); await closed; }
  }
  allowResponses = true; await (await fetch(base + '/readyz')).arrayBuffer(); response = await post(base, original); await response.text(); assert.equal(records.at(-1).path, '/v1/responses');
  checks.push('Only rejected unsupported endpoints convert once to Chat over HTTP/WS; instructions and Fast survive; hints reset on catalog refresh');
  {
    const request = { model: 'chat-modern-limit', input: [{ role: 'user', content: 'Original input' }], max_output_tokens: 1234,
      text: { verbosity: 'high' }, prompt_cache_retention: '24h', service_tier: 'priority' };
    response = await post(base, request); await response.text();
    assert.equal(records.at(-1).body.max_completion_tokens, 1234);
    assert(!Object.hasOwn(records.at(-1).body, 'max_tokens'));
    assert.equal(records.at(-1).body.verbosity, 'high');
    assert.equal(records.at(-1).body.prompt_cache_retention, '24h');
    assert.equal(records.at(-1).body.service_tier, 'priority');
  }
  {
    const tools = [{ type: 'custom', name: 'exec', format: { type: 'text' } }];
    for (const stream of [false, true]) {
      response = await post(base, { model: 'chat-truncated', input: [], tools, stream });
      assert.equal(response.status, 200);
      let result;
      if (stream) {
        const events = []; for await (const packet of ssePackets(response.body)) if (packet.data) events.push(packet.data);
        assert.equal(events.at(-1).type, 'response.incomplete');
        assert(!events.some(event => event.type === 'error' || event.type === 'response.output_item.done'));
        result = events.at(-1).response;
      } else result = await response.json();
      assert.equal(result.status, 'incomplete');
      assert.equal(result.output[0].arguments, '{"input":"unfinished');
    }
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/v1/responses'); socket.on('error', () => {}); await once(socket, 'open');
    try {
      const turn = value => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off('message', accept); reject(Error('Incomplete Chat fixture timed out')); }, 5000);
        function accept(raw) {
          const event = JSON.parse(raw);
          if (['response.completed', 'response.incomplete', 'error'].includes(event.type)) { clearTimeout(timer); socket.off('message', accept); resolve(event); }
        }
        socket.on('message', accept); socket.send(JSON.stringify({ type: 'response.create', ...value }));
      });
      const incomplete = await turn({ model: 'chat-truncated', input: [], tools });
      assert.equal(incomplete.type, 'response.incomplete');
      const retry = await turn({ model: 'chat-truncated', previous_response_id: incomplete.response.id, input: [] });
      assert.equal(retry.error.code, 'previous_response_not_found');
      const continued = await turn({ model: 'chat-modern-limit', input: [{ role: 'user', content: 'Original complete history' }], max_output_tokens: 1234 });
      assert.equal(continued.type, 'response.completed');
      assert.equal(records.at(-1).body.max_completion_tokens, 1234);
    } finally { const closed = once(socket, 'close'); socket.close(); await closed; }
  }
  checks.push('Model token-limit declarations and Chat controls survive HTTP/WS; truncated JSON/SSE tools remain incomplete and the same connection accepts a full-history continuation');
  {
    const adapter = new NonGptAdapter({ model: 'deepseek-reasoner' });
    const thought = adapter.item({ type: 'reasoning', id: 'upstream_thought', summary: [{ type: 'summary_text', text: 'Original thinking' }] });
    response = await post(base, { model: 'deepseek-reasoner', input: [thought, { type: 'function_call', name: 'calc', call_id: 'call_prior', arguments: '{}' }, { type: 'function_call_output', call_id: 'call_prior', output: 'Original tool result' }], stream: true });
    assert.equal(response.status, 200); await response.text(); assert.equal(records.at(-1).body.messages[0].reasoning_content, 'Original thinking');
    assert.equal(records.at(-1).body.messages[0].content, null);
  }
  for (const gateway of [base, await start({ ssh: true })]) for (const prompt of ['same-origin', 'redirect']) {
    response = await post(gateway, { model: 'flux-dev', prompt }, '/v1/images/generations');
    assert.equal(response.status, 200); assert.equal((await response.json()).data[0].b64_json, png);
  }
  assert.equal(proxyCount, 0); assert.equal(downloads, 4);
  checks.push('Generic same-model thinking stays in reasoning_content; custom image URLs and redirects use the correct direct/SSH path without official proxy or credentials');
  {
    const agent = officialDispatcherFor('http://127.0.0.1:' + proxy.address().port);
    try { await assert.rejects(requestWithAbort('http://127.0.0.1:' + peer.address().port + '/held', { dispatcher: agent, signal: new AbortController().signal, ...RESPONSE_TIMEOUTS }), error => protocolError(error).status === 502); }
    finally { await agent.destroy(); }
    let accepted; const started = new Promise(resolve => accepted = resolve); held = accepted;
    const controller = new AbortController(), pending = requestWithAbort('http://127.0.0.1:' + peer.address().port + '/held', { signal: controller.signal, ...RESPONSE_TIMEOUTS });
    await started; controller.abort(); await assert.rejects(pending, error => protocolError(error).status === 499);
  }
  checks.push('Real proxy CONNECT failures remain failures, while explicit local cancellation is reported as cancelled');
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  for (const timer of timers) clearTimeout(timer);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  for (const socket of sockets) socket.destroy();
  for (const server of servers) if (server.listening) await new Promise(resolve => server.close(resolve));
  if (path.dirname(fixture) === testing && path.basename(fixture).startsWith('stream-fidelity-')) fs.rmSync(fixture, { recursive: true, force: true });
}
