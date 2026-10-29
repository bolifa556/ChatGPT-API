import { readRequestJson } from './http-fixture.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(root, 'data/testing/ws-reconnect');
for (const sub of ['assets', 'data/state', 'data/cache', 'home']) fs.mkdirSync(path.join(fixture, sub), { recursive: true });
for (const name of ['model-template.json', 'reasoning-levels.json']) fs.copyFileSync(path.join(root, 'assets', name), path.join(fixture, 'assets', name));
const model = { ...JSON.parse(fs.readFileSync(path.join(fixture, 'assets/model-template.json'), 'utf8')).models[0], slug: 'gpt-6-sol' };
fs.writeFileSync(path.join(fixture, 'home/models_cache.json'), JSON.stringify({ models: [model] }));
fs.writeFileSync(path.join(fixture, 'home/auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'mock-official', account_id: 'mock-account' } }));
const servers = [], sockets = new Set(), clients = new Set(), children = [], peers = [], records = [], checks = [];
let serial = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server) {
  servers.push(server);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port;
}
function completed(body) {
  const id = 'resp_mock_' + (++serial);
  return { id, object: 'response', status: 'completed', model: body.model, output: [
    { type: 'reasoning', id: 'rs_mock_' + serial, summary: [{ type: 'summary_text', text: 'Retained reasoning ' + serial }], encrypted_content: 'opaque_mock_' + serial },
    { type: 'message', id: 'msg_mock_' + serial, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Answer ' + serial, annotations: [] }] }
  ] };
}
function errorFor(body) {
  return { type: 'error', status: 400, error: { type: 'invalid_request_error', message: 'Invalid `previous_response_id`.' }, ...(body.stream_id ? { stream_id: body.stream_id } : {}) };
}
async function connect(base) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/v1/responses');
  clients.add(ws); ws.on('error', () => {}); await once(ws, 'open');
  return ws;
}
function turn(ws, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Response timed out')), 5000);
    const events = [];
    function finish(error, result) { clearTimeout(timer); ws.off('message', receive); ws.off('close', closed); error ? reject(error) : resolve(result); }
    function closed() { finish(new Error('Client connection unexpectedly closed')); }
    function receive(data) {
      const item = JSON.parse(data);
      if ((item.stream_id || 'default') !== (event.stream_id || 'default')) return;
      events.push(item);
      if (item.type === 'error') finish(new Error(item.error?.message || item.message));
      else if (item.type === 'response.completed') finish(null, { response: item.response, events });
    }
    ws.on('message', receive); ws.on('close', closed); ws.send(JSON.stringify({ type: 'response.create', ...event }));
  });
}
async function waitForHealth(base, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Router exited before becoming ready');
    try { if ((await (await fetch(base + '/healthz')).json()).service === 'chatgpt-api-router') return; } catch {}
    await delay(30);
  }
  throw new Error('Router startup timed out');
}
try {
  const gatewayPort = await listen(http.createServer(async (req, res) => {
    if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'Other/test-model' }] })); return; }
    const body = await readRequestJson(req), response = completed(body);
    records.push({ route: 'gateway', body });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }) + '\n\ndata: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n');
  }));
  const official = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ models: [model] })); });
  const wss = new WebSocketServer({ server: official });
  wss.on('connection', socket => {
    const peer = { socket, ids: new Set(), number: peers.length + 1, rejectAll: false, rejectAfterCreated: false }; peers.push(peer);
    socket.on('error', () => {});
    socket.on('message', data => {
      const body = JSON.parse(data); records.push({ route: 'official', connection: peer.number, body });
      if (peer.rejectAll || (body.previous_response_id && !peer.ids.has(body.previous_response_id))) { socket.send(JSON.stringify(errorFor(body))); return; }
      const response = completed(body), extra = body.stream_id ? { stream_id: body.stream_id } : {};
      socket.send(JSON.stringify({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] }, ...extra }));
      if (peer.disconnectAfterCreated) { socket.close(1000, 'Simulated in-flight disconnect'); return; }
      if (peer.rejectAfterCreated) { socket.send(JSON.stringify(errorFor(body))); return; }
      peer.ids.add(response.id);
      if (body.test_lite_output) {
        response.output[1].phase = 'commentary';
        response.output.push({ type: 'custom_tool_call', id: 'ctc_lite_' + serial, call_id: 'call_lite_' + serial,
          name: 'exec', namespace: 'functions', input: 'text("原始输入\\n");', status: 'completed' });
        for (const [output_index, item] of response.output.entries()) {
          socket.send(JSON.stringify({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress' }, ...extra }));
          if (!body.test_unfinished || output_index !== 2) socket.send(JSON.stringify({ type: 'response.output_item.done', output_index, item, ...extra }));
        }
      }
      socket.send(JSON.stringify({ type: 'response.completed', response: body.test_lite_output ? { ...response, output: [] } : response, ...extra }));
    });
  });
  const officialPort = await listen(official), reserved = http.createServer(), routerPort = await listen(reserved);
  await new Promise(resolve => reserved.close(resolve));
  const base = 'http://127.0.0.1:' + routerPort;
  fs.writeFileSync(path.join(fixture, 'data/.env'), `BASE_URL=http://127.0.0.1:${gatewayPort}/v1\nAPI_KEY=mock-gateway\nSHIM_PORT=${routerPort}\nOFFICIAL_BASE=http://127.0.0.1:${officialPort}/backend-api/codex\n`);
  fs.writeFileSync(path.join(fixture, 'data/state/route-state.json'), JSON.stringify({ mode: 'mixed', officialProxy: '', clientVersion: '0.159.0' }));
  const options = { env: { ...process.env, CODEX_HOME: path.join(fixture, 'home'), CHATGPT_API_ROOT: fixture }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] };
  const prepare = spawn(process.execPath, [path.join(root, 'src/shim.mjs'), '--prepare'], options); children.push(prepare);
  assert.equal((await once(prepare, 'exit'))[0], 0);
  const router = spawn(process.execPath, [path.join(root, 'src/shim.mjs')], options); children.push(router);
  await waitForHealth(base, router);

  {
    const ws = await connect(base);
    const first = await turn(ws, { model: 'gpt-6-sol', test_lite_output: true, input: [{ role: 'user', content: 'LITE_ORIGINAL_HISTORY' }],
      tools: [{ type: 'namespace', name: 'functions', description: 'Fixture', tools: [{ type: 'custom', name: 'exec', format: { type: 'text' } }] }] });
    assert.deepEqual(first.response.output, [], 'Native terminal frame is forwarded unchanged');
    const items = first.events.filter(e => e.type === 'response.output_item.done').map(e => e.item);
    const call = items.find(item => item.type === 'custom_tool_call');
    const switched = await turn(ws, { model: 'Other/test-model', test_lite_output: false, previous_response_id: first.response.id,
      input: [{ type: 'custom_tool_call_output', call_id: call.call_id, output: 'LITE_TOOL_RESULT' }, { role: 'developer', content: '<model_switch>Native client update</model_switch>' }, { role: 'user', content: 'Continue' }] });
    const wire = records.at(-1).body.input;
    assert.equal(JSON.parse(wire.find(item => item.call_id === call.call_id && item.type === 'function_call').arguments).input, call.input);
    assert.equal(wire.find(item => item.call_id === call.call_id && item.type === 'function_call_output').output, 'LITE_TOOL_RESULT');
    assert(wire.some(item => item.id === items[1].id && item.phase === 'commentary'));
    assert.equal(wire.filter(item => item.content === '<model_switch>Native client update</model_switch>').length, 1);
    await turn(ws, { model: 'gpt-6-sol', previous_response_id: switched.response.id, input: [{ role: 'user', content: 'Return to official' }] });
    const back = records.at(-1).body.input;
    for (const item of items) assert.deepEqual(back.find(value => value.id === item.id), item, 'Original native items survive a round trip');
    assert.equal(back.filter(item => item.id === items[1].id).length, 1);
    checks.push('Official Lite output is collected from completed items; bidirectional switching preserves text, phase, encrypted reasoning and tool pairs without modifying native frames');
    ws.close();
  }
  {
    const ws = await connect(base);
    const first = await turn(ws, { model: 'gpt-6-sol', test_lite_output: true, test_unfinished: true, input: [{ role: 'user', content: 'Incomplete item' }] });
    const before = records.length;
    await assert.rejects(turn(ws, { model: 'Other/test-model', previous_response_id: first.response.id, input: [{ role: 'user', content: 'Continue' }] }), /not cached/);
    assert.equal(records.length, before, 'An unfinished native item must never be dropped to manufacture complete history');
    checks.push('Missing completed items prevent partial history from being replayed as complete context');
    ws.close();
  }

  for (const startWithGateway of [false, true]) {
    const ws = await connect(base), marker = startWithGateway ? 'GATEWAY_HISTORY_719' : 'OFFICIAL_HISTORY_719';
    let result = await turn(ws, { model: startWithGateway ? 'Other/test-model' : 'gpt-6-sol', input: [{ role: 'user', content: marker }], store: false });
    if (startWithGateway) result = await turn(ws, { model: 'gpt-6-sol', previous_response_id: result.response.id, input: [{ role: 'user', content: 'Switch to official' }] });
    const firstOfficial = result.response;
    result = await turn(ws, { model: 'gpt-6-sol', previous_response_id: result.response.id, input: [{ role: 'user', content: 'One more turn before idle' }] });
    assert.equal(records.at(-1).body.previous_response_id, firstOfficial.id, 'Healthy official connection must retain incremental requests');
    const oldPeer = peers.at(-1), closed = once(oldPeer.socket, 'close'); oldPeer.socket.close(1000, 'Simulated upstream idle timeout'); await closed; await delay(50);
    const before = records.length;
    result = await turn(ws, { model: 'gpt-6-sol', previous_response_id: result.response.id, input: [{ role: 'user', content: 'Continue after idle' }] });
    const request = records.at(-1);
    assert.equal(request.route, 'official'); assert.notEqual(request.connection, oldPeer.number);
    assert(!request.body.previous_response_id, 'A new upstream connection must receive full context');
    assert(request.body.input.some(item => item.content === marker));
    assert.equal(request.body.input.filter(item => item.content === 'Continue after idle').length, 1);
    assert(request.body.input.some(item => item.encrypted_content === firstOfficial.output[0].encrypted_content), 'Usable official reasoning must survive reconnect');
    assert.equal(records.length, before + 1, 'Reconnect recovery must not duplicate generation');
    checks.push((startWithGateway ? 'Gateway → official' : 'Official only') + ': idle reconnect retains complete history and reasoning; healthy requests remain incremental');

    // An upstream may evict its response state without closing the socket.
    const peer = peers.at(-1); peer.ids.clear();
    const retryStart = records.length;
    result = await turn(ws, { model: 'gpt-6-sol', previous_response_id: result.response.id, input: [{ role: 'user', content: 'Recover evicted response' }] });
    assert.equal(records.length, retryStart + 2);
    assert(records[retryStart].body.previous_response_id); assert(!records[retryStart + 1].body.previous_response_id);
    assert.equal(records.at(-1).body.input.filter(item => item.content === 'Recover evicted response').length, 1);
    checks.push('Expired previous_response_id is retried once with complete context before any generation');

    peer.rejectAll = true;
    const failureStart = records.length;
    await assert.rejects(turn(ws, { model: 'gpt-6-sol', previous_response_id: result.response.id, input: [{ role: 'user', content: 'Bounded retry' }] }), /Invalid `previous_response_id`/);
    assert.equal(records.length, failureStart + 2, 'Persistent rejection must not loop'); peer.rejectAll = false;
    peer.rejectAfterCreated = true;
    const partialStart = records.length;
    await assert.rejects(turn(ws, { model: 'gpt-6-sol', previous_response_id: result.response.id, input: [{ role: 'user', content: 'Do not replay accepted work' }] }), /Invalid `previous_response_id`/);
    assert.equal(records.length, partialStart + 1, 'Never replay a response after generation has been accepted');
    checks.push('Permanent rejection is bounded; accepted work is never automatically replayed');
    ws.close();
  }
  {
    const ws = await connect(base);
    const [alpha, beta] = await Promise.all(['alpha', 'beta'].map(stream_id => turn(ws, { model: 'gpt-6-sol', stream_id, input: [{ role: 'user', content: 'LANE_' + stream_id }] })));
    peers.at(-1).ids.delete(alpha.response.id);
    const start = records.length;
    await Promise.all([
      turn(ws, { model: 'gpt-6-sol', stream_id: 'alpha', previous_response_id: alpha.response.id, input: [{ role: 'user', content: 'Alpha next' }] }),
      turn(ws, { model: 'gpt-6-sol', stream_id: 'beta', previous_response_id: beta.response.id, input: [{ role: 'user', content: 'Beta next' }] })
    ]);
    const recovered = records.slice(start).find(entry => entry.body.stream_id === 'alpha' && !entry.body.previous_response_id);
    assert(recovered.body.input.some(item => item.content === 'LANE_alpha'));
    assert(!recovered.body.input.some(item => item.content === 'LANE_beta'));
    assert.equal(records.slice(start).filter(entry => entry.body.stream_id === 'beta').length, 1);
    checks.push('Parallel stream recovery preserves lane isolation and does not replay healthy lanes');
    ws.close();
  }
  {
    const ws = await connect(base);
    await turn(ws, { model: 'gpt-6-sol', input: [{ role: 'user', content: 'Known local context' }] });
    const peer = peers.at(-1), missing = 'resp_present_upstream_but_not_in_local_cache';
    peer.ids.add(missing);
    const response = await turn(ws, { model: 'gpt-6-sol', previous_response_id: missing, input: [{ role: 'user', content: 'Only a delta is known locally' }] });
    const closed = once(peer.socket, 'close'); peer.socket.close(); await closed; await delay(50);
    const before = records.length;
    await assert.rejects(turn(ws, { model: 'gpt-6-sol', previous_response_id: response.response.id, input: [{ role: 'user', content: 'Need full history' }] }), /Previous response is not cached/);
    assert.equal(records.length, before, 'Incomplete local context must never be replayed as complete history');
    checks.push('Missing cached history fails explicitly instead of silently dropping conversation context');
    ws.close();
  }
  {
    const ws = await connect(base);
    const first = await turn(ws, { model: 'gpt-6-sol', input: [{ role: 'user', content: 'Before interrupted generation' }] });
    peers.at(-1).disconnectAfterCreated = true;
    const before = records.length;
    await assert.rejects(turn(ws, { model: 'gpt-6-sol', previous_response_id: first.response.id, input: [{ role: 'user', content: 'Interrupted generation' }] }), /Client connection unexpectedly closed/);
    assert.equal(records.length, before + 1);
    checks.push('In-flight upstream disconnect is exposed to the native client without silently replaying work');
  }
  const report = { passed: true, checks };
  fs.mkdirSync(path.join(root, 'data/diagnostics'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/diagnostics/ws-reconnect-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  for (const client of clients) client.terminate();
  for (const peer of peers) peer.socket.terminate();
  for (const socket of sockets) socket.destroy();
  for (const server of servers) { server.close(); server.closeAllConnections?.(); }
}
