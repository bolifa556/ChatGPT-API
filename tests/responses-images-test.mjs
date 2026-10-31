import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { ResponseImages, restoreHostedImageHistory } from '../src/responses-images.mjs';
import { ssePackets, encodeSse } from '../src/sse.mjs';
import { readRequestJson } from './http-fixture.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(root, 'data/testing'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, 'data/testing/responses-images-'));
const home = path.join(fixture, 'client home 图片');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const image = (id = 'ig_fixture', result = png) => ({ type: 'image_generation_call', id, status: 'completed', result, output_format: 'png' });
const message = { type: 'message', id: 'msg_text', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Original text', annotations: [] }] };
const response = output => ({ id: 'resp_fixture', object: 'response', model: 'GPT/gpt-test', status: 'completed', output });
const savedPath = item => item.content[0].text.slice(5, -2);
const checks = [];

const converter = new ResponseImages(home);
const plain = response([message]);
assert.equal(converter.response(plain), plain);
const output = converter.response(response([message, image(), image('ig_second')])).output;
assert.equal(output[0], message);
assert.equal(output[1].content[1].image_url, 'data:image/png;base64,' + png);
assert(fs.readFileSync(savedPath(output[1])).equals(Buffer.from(png, 'base64')));
assert.equal(savedPath(output[1]), savedPath(output[2]));
assert.notEqual(output[1].id, output[2].id);
assert.equal(new ResponseImages(home).response(response([image()])).output[0].id, output[1].id);
assert.equal(fs.readdirSync(converter.directory).filter(name => name.endsWith('.png')).length, 1);
const noStatus = image('ig_no_status'); delete noStatus.status;
assert.equal(new ResponseImages(home).response({ output: [noStatus] }).output[0].status, 'completed');
const terminalWithoutStatus = new ResponseImages(home).convert({ type: 'response.completed', response: { output: [noStatus] } });
assert.equal(terminalWithoutStatus.at(-1).response.output[0].status, 'completed');
checks.push('Exact image bytes survive conversion and restart in a persistent Unicode/space path; multiple items share storage without merging their identities');

const originalResult = { ...image('ig_original_metadata'), revised_prompt: 'Original upstream description', quality: 'high', size: '1024x1024', background: 'opaque' };
const presented = converter.response(response([originalResult])).output[0];
const history = { input: [presented, { type: 'item_reference', id: presented.id }, message], tools: [{ type: 'function', name: 'unchanged' }] };
const canonical = JSON.stringify(history), restored = restoreHostedImageHistory(history, home);
assert.equal(JSON.stringify(history), canonical);
assert.deepEqual(restored.payload.input[0], originalResult);
assert.deepEqual(restored.payload.input[1], { type: 'item_reference', id: originalResult.id });
assert.equal(restored.payload.input[2], message); assert.equal(restored.payload.tools, history.tools);
assert.equal(restoreHostedImageHistory(restored.payload, home).payload, restored.payload);
new ResponseImages(home).response(response([Object.fromEntries(Object.entries(originalResult).reverse())]));
assert.deepEqual(restoreHostedImageHistory(history, home).payload.input[0], originalResult);
const legacy = restoreHostedImageHistory({ input: [presented] }, path.join(fixture, 'older-home'));
assert.deepEqual(legacy.payload.input[0], { type: 'image_generation_call', id: 'ig_' + presented.id.slice(4), status: 'completed', result: png });
assert.equal(legacy.payload.input.length, 1);
for (const unchanged of [
  { ...presented, role: 'user' },
  { ...presented, content: [{ type: 'output_text', text: 'Original assistant image', annotations: [] }, presented.content[1]] },
  { type: 'custom_tool_call_output', call_id: 'real_tool', output: [presented.content[1]] },
  { type: 'function_call_output', call_id: 'real_tool', output: [presented.content[1]] },
  { ...presented, content: [presented.content[0], { ...presented.content[1], image_url: 'data:image/png;base64,AAAA' }] },
]) {
  const value = { input: [unchanged] }; assert.equal(restoreHostedImageHistory(value, home).payload, value);
}
const metadata = fs.readFileSync(path.join(converter.directory, presented.id + '.response.json'), 'utf8');
assert(!metadata.includes(png));
checks.push('Only adapter image presentations restore to the original hosted result, with metadata and reference IDs; legacy 3.1.8 histories work without a new role, tool invocation, image request or conversation copy');

// Signature selection follows the bytes, not an incorrect upstream MIME hint.
for (const [format, hex] of [['jpeg', 'ffd8ffe000104a46494600010100000100010000ffd9'], ['webp', '524946461000000057454250565038200400000000000000']]) {
  const data = Buffer.from(hex, 'hex').toString('base64');
  const item = new ResponseImages(home).response(response([image('ig_' + format, data)])).output[0];
  assert.match(item.content[1].image_url, new RegExp('^data:image/' + format));
  assert(fs.readFileSync(savedPath(item)).equals(Buffer.from(data, 'base64')));
}
for (const result of [undefined, null, '', '!bad', 'abcd=', Buffer.from('<svg/>').toString('base64')]) {
  assert.throws(() => new ResponseImages(home).response(response([image('ig_bad', result === undefined ? '' : result)])), error => error.code === 'invalid_upstream_image_response');
}
const blocked = path.join(fixture, 'blocked'); fs.writeFileSync(blocked, 'not a directory');
assert.throws(() => new ResponseImages(blocked).response(response([image()])), error => error.code === 'image_storage_unavailable');
checks.push('PNG/JPEG/WebP bytes are kept; invalid, missing and unsupported image data or unwritable storage produce explicit errors');

function eventsFor(output, variant = 'full') {
  const events = [{ type: 'response.created', response: { ...response([]), status: 'in_progress' } }];
  if (variant !== 'terminal') for (const [output_index, item] of output.entries()) {
    events.push({ type: 'response.output_item.added', output_index, item: item.type === 'image_generation_call' ? { ...item, status: 'in_progress', result: null } : item });
    if (item.type === 'image_generation_call') for (const state of ['in_progress', 'generating', 'partial_image', 'completed']) events.push({ type: 'response.image_generation_call.' + state, output_index, item_id: item.id, partial_image_b64: png });
    if (variant !== 'missing') {
      events.push({ type: 'response.output_item.done', output_index, item });
      if (variant === 'duplicate') events.push({ type: 'response.output_item.done', output_index, item });
    }
  }
  events.push({ type: 'response.completed', response: response(variant === 'lite' || variant === 'missing' ? [] : output) });
  return events.map((event, sequence_number) => ({ ...event, sequence_number }));
}
for (const variant of ['full', 'terminal', 'duplicate', 'lite']) {
  const images = new ResponseImages(home);
  const events = eventsFor([message, image(), image('ig_second')], variant).flatMap(event => images.convert(event));
  assert.equal(events.filter(event => event.type === 'response.output_item.done' && event.item.id !== message.id).length, 2);
  assert.equal(events.filter(event => event.type === 'response.output_item.added' && event.item.id !== message.id).length, 2);
  assert(!events.some(event => event.item?.type === 'image_generation_call' || event.type.startsWith('response.image_generation_call.')));
  assert(events.every((event, index) => !index || event.sequence_number > events[index - 1].sequence_number));
  for (const event of events.filter(event => event.type === 'response.output_item.done' && event.item.id !== message.id)) {
    assert.equal(event.item.content[1].image_url, 'data:image/png;base64,' + png);
    assert.equal(events.filter(part => part.type === 'response.output_text.delta' && part.item_id === event.item.id).map(part => part.delta).join(''), event.item.content[0].text);
  }
}
assert.throws(() => { const images = new ResponseImages(home); eventsFor([image()], 'missing').forEach(event => images.convert(event)); }, error => error.code === 'invalid_upstream_image_response');
const interrupted = new ResponseImages(home);
assert.equal(interrupted.convert({ type: 'response.output_item.added', output_index: 0, item: { ...image(), status: 'in_progress', result: null } })[0].item.status, 'in_progress');
const failure = { type: 'response.failed', response: { ...response([]), status: 'failed', error: { code: 'upstream_failure' } } };
assert.deepEqual(interrupted.convert(failure)[0].response.error, failure.response.error);
const cancellation = { type: 'response.completed', response: { ...response([]), status: 'cancelled' } };
assert.equal(interrupted.convert(cancellation)[0].response.status, 'cancelled');
checks.push('Full, terminal-only, repeated and Responses Lite events deliver each image once; incomplete images never become successful output');

const servers = [], sockets = new Set(), children = [], records = [];
function invalidAssistantImage(body) {
  const index = (Array.isArray(body.input) ? body.input : []).findIndex(item => item.role === 'assistant' && item.content?.some?.(part => part.type === 'input_image'));
  return index < 0 ? null : { type: 'invalid_request_error', code: 'invalid_value',
    message: "Invalid value: 'input_image'. Supported values are: 'output_text' and 'refusal'.", param: 'input[' + index + '].content' };
}
let variant = 'full', imageOutput = [message, image()], running;
const officialModel = { ...JSON.parse(fs.readFileSync(path.join(root, 'assets/model-template.json'))).models[0], slug: 'gpt-native' };
async function listen(server) {
  servers.push(server); server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port;
}
const upstream = http.createServer(async (req, res) => {
  if (req.url.includes('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ models: [officialModel], data: [{ id: 'GPT/gpt-test' }, { id: 'Other/test' }, { id: '词元计划/glm-5.3' }] })); return; }
  const body = await readRequestJson(req); records.push({ url: req.url, body });
  const invalid = invalidAssistantImage(body);
  if (invalid) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: invalid })); return; }
  if (req.url.endsWith('/chat/completions')) {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'chat_test', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })); return;
  }
  const bytes = body.stream ? eventsFor(imageOutput, variant).map(encodeSse).join('') : JSON.stringify(response(imageOutput));
  res.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json', 'content-encoding': 'gzip' }); res.end(zlib.gzipSync(bytes));
});
const wss = new WebSocketServer({ noServer: true });
upstream.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
  ws.on('error', () => {}); ws.on('message', data => {
    const body = JSON.parse(data); records.push({ url: req.url, body, transport: 'ws' });
    const invalid = invalidAssistantImage(body);
    if (invalid) { ws.send(JSON.stringify({ type: 'error', error: invalid })); return; }
    for (const event of eventsFor(imageOutput, variant)) ws.send(JSON.stringify(event));
  });
}));
async function start() {
  running = spawn(process.execPath, [path.join(root, 'src/shim.mjs')], { env: { ...process.env, CHATGPT_API_ROOT: fixture, CODEX_HOME: home }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(running); let stderr = ''; running.stderr.on('data', data => stderr += data);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (running.exitCode !== null) throw new Error(stderr);
    try { const status = await (await fetch(base + '/healthz')).json(); if (status.gateway.ready || status.service && (await fetch(base + '/readyz')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Fixture router did not start: ' + stderr);
}
let base;
async function send(model, stream = false, suffix = '/responses', input = 'Draw fixture') {
  return fetch(base + '/v1' + suffix, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream, input }), signal: AbortSignal.timeout(10000) });
}
async function wsTurn(ws, model, previous, input = 'Continue') {
  const events = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', accept); reject(new Error('Fixture WebSocket timeout')); }, 10000);
    function accept(data) {
      const event = JSON.parse(data); events.push(event);
      if (event.type === 'response.completed' || event.type === 'error') { clearTimeout(timer); ws.off('message', accept); resolve(events); }
    }
    ws.on('message', accept);
    ws.send(JSON.stringify({ type: 'response.create', model, input, ...(previous ? { previous_response_id: previous } : {}) }));
  });
}
try {
  const port = await listen(upstream), reserve = http.createServer(), routerPort = await listen(reserve);
  await new Promise(resolve => reserve.close(resolve)); base = 'http://127.0.0.1:' + routerPort;
  for (const part of ['assets', 'data/state', 'client home 图片']) fs.mkdirSync(path.join(fixture, part), { recursive: true });
  for (const file of ['model-template.json', 'reasoning-levels.json']) fs.copyFileSync(path.join(root, 'assets', file), path.join(fixture, 'assets', file));
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'mock-official' } }));
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [officialModel] }));
  fs.writeFileSync(path.join(fixture, 'data/.env'), ['BASE_URL=http://127.0.0.1:' + port + '/v1', 'API_KEY=mock-api', 'SHIM_PORT=' + routerPort, 'OFFICIAL_BASE=http://127.0.0.1:' + port + '/backend-api/codex'].join('\n'));
  fs.writeFileSync(path.join(fixture, 'data/state/route-state.json'), JSON.stringify({ mode: 'mixed', clientVersion: '0.164.0' }));
  await start();
  let delivered;
  for (const model of ['GPT/gpt-test', 'Other/test']) {
    const before = records.length;
    const result = await send(model); assert.equal(result.status, 200);
    delivered = (await result.json()).output;
    assert.equal(delivered[1].content[1].image_url, 'data:image/png;base64,' + png);
    assert.equal(records.length, before + 1);
    for (const style of ['full', 'terminal', 'duplicate', 'lite']) {
      variant = style; const stream = await send(model, true), events = [];
      for await (const packet of ssePackets(stream.body)) if (packet.data) events.push(packet.data);
      assert.equal(events.at(-1).type, 'response.completed');
      const images = events.filter(event => event.type === 'response.output_item.done' && event.item.id !== message.id);
      assert.equal(images.length, 1); assert.deepEqual(images[0].item, delivered[1]);
    }
  }
  checks.push('The real router converts compressed JSON/SSE for GPT and non-GPT gateway routes without an extra upstream request');
  variant = 'full';
  const official = await send('gpt-native', true);
  assert.equal(await official.text(), eventsFor(imageOutput).map(encodeSse).join(''));
  assert.deepEqual((await (await send('gpt-native')).json()).output, imageOutput);
  assert.deepEqual((await (await send('GPT/gpt-test', false, '/responses/compact')).json()).output, imageOutput);
  const officialWs = new WebSocket(base.replace('http:', 'ws:') + '/v1/responses'); await once(officialWs, 'open');
  assert.deepEqual(await wsTurn(officialWs, 'gpt-native'), eventsFor(imageOutput)); officialWs.close();
  checks.push('Official JSON/SSE/WebSocket image results and remote compact responses are passed through unchanged');

  const rejected = await fetch('http://127.0.0.1:' + port + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'GPT/gpt-test', input: delivered }) });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error.message, /Supported values are: 'output_text' and 'refusal'/);

  const ws = new WebSocket(base.replace('http:', 'ws:') + '/v1/responses'); await once(ws, 'open');
  const first = await wsTurn(ws, 'GPT/gpt-test');
  assert.equal(first.at(-1).type, 'response.completed');
  const next = await wsTurn(ws, 'Other/test', first.at(-1).response.id);
  assert.equal(next.at(-1).type, 'response.completed');
  assert.deepEqual(records.at(-1).body.input.find(item => item.type === 'image_generation_call'), image());
  const switched = await wsTurn(ws, 'gpt-native', next.at(-1).response.id);
  assert.equal(switched.at(-1).type, 'response.completed');
  assert(records.at(-1).body.input.some(item => item.type === 'image_generation_call' && item.result === png));
  ws.close();
  for (const model of ['gpt-native', 'GPT/gpt-test', 'Other/test', '词元计划/glm-5.3']) {
    const reply = await send(model, false, '/responses', [...delivered, { role: 'user', content: 'Edit this image' }]); assert.equal(reply.status, 200); await reply.arrayBuffer();
    const body = records.at(-1).body;
    const parts = (body.messages || body.input).flatMap(item => Array.isArray(item.content) ? item.content : []);
    if (body.messages) {
      assert(parts.some(part => part.image_url?.url === 'data:image/png;base64,' + png));
      assert(parts.some(part => part.text === delivered[1].content[0].text));
    } else {
      assert.deepEqual(body.input.find(item => item.type === 'image_generation_call'), image());
      assert.equal(body.input[0].content[0].text, message.content[0].text);
      assert.equal(invalidAssistantImage(body), null);
    }
  }
  checks.push('The strict upstream reproduces the reported 400 before conversion; HTTP/WS continuation, gateway-to-official switching and full-history Responses requests now carry valid original image results while Chat keeps its existing image mapping');
  for (const model of ['gpt-native', 'GPT/gpt-test']) {
    const compact = await send(model, false, '/responses/compact', delivered);
    assert.equal(compact.status, 200); await compact.arrayBuffer();
    assert.deepEqual(records.at(-1).body.input[1], image());
  }
  checks.push('Remote compaction receives the same valid image result history; its response remains untouched');

  running.kill(); await once(running, 'exit'); await start();
  assert(fs.readFileSync(savedPath(delivered[1])).equals(Buffer.from(png, 'base64')));
  fs.unlinkSync(path.join(converter.directory, delivered[1].id + '.response.json'));
  const legacyRequest = await send('GPT/gpt-test', false, '/responses', delivered); assert.equal(legacyRequest.status, 200); await legacyRequest.arrayBuffer();
  assert.equal(records.at(-1).body.input[1].result, png);
  const resumed = new WebSocket(base.replace('http:', 'ws:') + '/v1/responses'); await once(resumed, 'open');
  assert.equal((await wsTurn(resumed, 'gpt-native', null, delivered)).at(-1).type, 'response.completed'); resumed.close();
  checks.push('Already-saved 3.1.8 history continues over HTTP and a reconnected official WebSocket without editing or replacing the on-disk conversation');
  // A valid uncompressed PNG can exceed the 16 MiB text-event limit after
  // base64 encoding. Exercise the actual compressed SSE router, not just the converter.
  const chunk = (name, bytes) => {
    const type = Buffer.from(name), prefix = Buffer.alloc(4), crc = Buffer.alloc(4);
    prefix.writeUInt32BE(bytes.length); crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([prefix, type, bytes, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(2048); header.writeUInt32BE(1600, 4); header[8] = 8; header[9] = 6;
  const largePng = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(1600 * (1 + 2048 * 4)), { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
  const largeResult = largePng.toString('base64'); assert(largeResult.length > 16 * 1024 * 1024);
  imageOutput = [image('ig_large_fixture', largeResult)];
  const largeStream = await send('GPT/gpt-test', true); let largeDelivered, largeTerminal;
  for await (const packet of ssePackets(largeStream.body, { maxEventBytes: 64 * 1024 * 1024 })) {
    if (packet.data?.type === 'response.output_item.done') largeDelivered = packet.data.item;
    if (packet.data) largeTerminal = packet.data.type;
  }
  assert.equal(largeTerminal, 'response.completed');
  assert(fs.readFileSync(savedPath(largeDelivered)).equals(largePng));
  assert.equal(restoreHostedImageHistory({ input: [largeDelivered] }, home).payload.input[0].result, largeResult);
  checks.push('A valid PNG larger than a 16 MiB base64 event survives compressed Responses streaming, storage and history replay without truncation');
  imageOutput = [image('ig_bad', '')];
  const bad = await send('GPT/gpt-test'); assert.equal(bad.status, 502); assert.equal((await bad.json()).error.code, 'invalid_upstream_image_response');
  const badStream = await send('GPT/gpt-test', true), errors = [];
  for await (const packet of ssePackets(badStream.body)) if (packet.data) errors.push(packet.data);
  assert.equal(errors.at(-1).type, 'error'); assert(!errors.some(event => event.type === 'response.completed'));
  const badWs = new WebSocket(base.replace('http:', 'ws:') + '/v1/responses'); await once(badWs, 'open');
  assert.equal((await wsTurn(badWs, 'GPT/gpt-test')).at(-1).type, 'error'); badWs.close();
  checks.push('Images survive router restart; malformed hosted output fails explicitly over JSON, SSE and WebSocket');
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  for (const socket of sockets) socket.destroy();
  wss.close(); for (const server of servers) { server.close(); server.closeAllConnections?.(); }
}
