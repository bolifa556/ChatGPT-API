import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { readRequestJson } from './http-fixture.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(root, 'data/testing'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, 'data/testing/ws-interrupt-'));
const routerFile = process.env.WS_INTERRUPT_ROUTER_FILE || path.join(root, 'src/shim.mjs');
const models = ['GPT/gpt-6.1-sol', '阿里云订阅/glm-5.3', '词元计划/glm-5.3-flash'];
const native = { ...JSON.parse(fs.readFileSync(path.join(root, 'assets/model-template.json'))).models[0], slug: 'gpt-6-sol' };
const clients = [], children = [], sockets = new Set(), records = [], officialFrames = [], checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = content => typeof content === 'string' ? content : (content || []).map(part => part.text || '').join('');
const latestUser = body => [...(body.input || body.messages || [])].reverse().find(item => item.role === 'user');
const sendSse = (res, event) => res.write('data: ' + JSON.stringify(event) + '\n\n');
let serial = 0;

async function until(read, description, attempts = 250) {
  for (let n = 0; n < attempts; n++) { const result = await read(); if (result) return result; await delay(20); }
  throw new Error('Timed out: ' + description);
}
function responseEvents(body, emit) {
  const id = 'resp_interrupt_' + (++serial), response = { id, object: 'response', model: body.model, status: 'in_progress', output: [] };
  let sequence = 0;
  const send = event => emit({ ...event, sequence_number: sequence++ });
  send({ type: 'response.created', response });
  const item = { id: 'msg_committed_' + serial, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'COMMITTED_ORIGINAL', annotations: [] }] };
  send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } });
  send({ type: 'response.output_item.done', output_index: 0, item });
  if (text(latestUser(body)?.content).includes('HOLD_')) {
    if (text(latestUser(body)?.content).includes('NATIVE_')) {
      const partial = { id: 'msg_partial_' + serial, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
      send({ type: 'response.output_item.added', output_index: 1, item: partial });
      send({ type: 'response.content_part.added', output_index: 1, item_id: partial.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      send({ type: 'response.output_text.delta', output_index: 1, item_id: partial.id, content_index: 0, delta: 'UNCOMMITTED_ONLY' });
      return { response, output: [item], sequence };
    }
    const partial = { id: 'fc_partial_' + serial, type: 'function_call', call_id: 'call_partial_' + serial, name: 'partial_tool', arguments: '', status: 'in_progress' };
    send({ type: 'response.output_item.added', output_index: 1, item: partial });
    send({ type: 'response.function_call_arguments.delta', output_index: 1, item_id: partial.id, delta: '{"UNCOMMITTED_ONLY":' });
    return { response, output: [item], sequence };
  }
  send({ type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 } } });
  return { response, output: [item], sequence };
}

const peer = http.createServer(async (req, res) => {
  try {
    if (req.url.includes('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url.startsWith('/official') ? { models: [native] } : { data: models.map(id => ({ id })) })); return; }
    const body = await readRequestJson(req), record = { body, closed: false }; records.push(record);
    res.on('close', () => { record.closed = true; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url.endsWith('/chat/completions')) {
      const base = { id: 'chat_interrupt_' + (++serial), model: body.model, created: 1 };
      sendSse(res, { ...base, choices: [{ index: 0, delta: { content: 'UNCOMMITTED_ONLY' } }] });
      if (text(latestUser(body)?.content).includes('HOLD_')) return;
      sendSse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      sendSse(res, { ...base, choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } });
      res.end('data: [DONE]\n\n'); return;
    }
    const result = responseEvents(body, event => sendSse(res, event));
    if (!text(latestUser(body)?.content).includes('HOLD_')) res.end();
    record.responseId = result.response.id;
  } catch (error) { res.end('data: ' + JSON.stringify({ type: 'error', error: { message: error.message } }) + '\n\n'); }
});
peer.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
const official = new WebSocketServer({ server: peer });
official.on('connection', socket => {
  socket.on('error', () => {});
  const responses = new Map();
  socket.on('message', raw => {
    const frame = JSON.parse(raw); officialFrames.push(frame);
    if (frame.type === 'response.interrupt') {
      const result = responses.get(frame.response_id); assert(result);
      const extra = result.streamId !== undefined ? { stream_id: result.streamId } : {};
      socket.send(JSON.stringify({ type: 'response.interrupt.accepted', response_id: frame.response_id, sequence_number: result.sequence++, ...extra }));
      socket.send(JSON.stringify({ type: 'response.completed', response: { ...result.response, status: 'cancelled', output: result.output }, sequence_number: result.sequence++, ...extra }));
    } else {
      const extra = frame.stream_id !== undefined ? { stream_id: frame.stream_id } : {};
      const result = responseEvents(frame, event => socket.send(JSON.stringify({ ...event, ...extra })));
      responses.set(result.response.id, { ...result, streamId: frame.stream_id });
    }
  });
});
await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve));
const upstream = 'http://127.0.0.1:' + peer.address().port;
const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const base = 'http://127.0.0.1:' + port;
for (const dir of ['assets', 'data/state', 'home']) fs.mkdirSync(path.join(fixture, dir), { recursive: true });
for (const name of ['model-template.json', 'reasoning-levels.json']) fs.copyFileSync(path.join(root, 'assets', name), path.join(fixture, 'assets', name));
fs.writeFileSync(path.join(fixture, 'data/.env'), 'BASE_URL=' + upstream + '/v1\nAPI_KEY=inert-test-key\nSHIM_PORT=' + port + '\nOFFICIAL_BASE=' + upstream + '/official\n');
fs.writeFileSync(path.join(fixture, 'data/state/route-state.json'), JSON.stringify({ mode: 'mixed', entryMode: 'api', officialProxy: '', clientVersion: '0.164.0' }));
fs.writeFileSync(path.join(fixture, 'home/auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'inert-test-account' } }));
const env = { ...process.env, CHATGPT_API_ROOT: fixture, CODEX_HOME: path.join(fixture, 'home') };
function runRouter(args) {
  const child = spawn(process.execPath, [routerFile, ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); let errors = ''; child.stderr.on('data', value => { errors += value; });
  child.stdout.resume(); return { child, errors: () => errors };
}
async function connect() {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/v1/responses'), events = [];
  clients.push(socket); socket.on('error', () => {}); socket.on('message', raw => events.push(JSON.parse(raw))); await once(socket, 'open');
  return { socket, events, send: value => socket.send(JSON.stringify(value)),
    wait: (type, offset = 0, id) => until(() => {
      const found = events.slice(offset); const error = found.find(event => event.type === 'error');
      if (error) throw new Error('Unexpected gateway error: ' + JSON.stringify(error));
      return found.find(event => event.type === type && (!id || event.response_id === id || event.response?.id === id));
    }, type) };
}
function create(client, model, marker, extra = {}) {
  const offset = client.events.length;
  client.send({ type: 'response.create', model, input: [{ role: 'user', content: marker }], ...extra });
  return client.wait('response.created', offset);
}
async function interrupt(client, id, extra = {}) {
  const offset = client.events.length;
  client.send({ type: 'response.interrupt', response_id: id, mode: 'discard_partial_items', ...extra });
  await client.wait('response.interrupt.accepted', offset, id);
  return client.wait('response.completed', offset, id);
}
async function checkNativeClient(cli) {
  const home = path.join(fixture, 'native-home'), cwd = path.join(fixture, 'native-workspace');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  const config = [
    'model_provider = "interrupt_fixture"', 'model = ' + JSON.stringify(models[0]), 'model_reasoning_effort = "low"',
    'model_catalog_json = ' + JSON.stringify(path.join(fixture, 'data/cache/models-smr.json')),
    '[features]', 'responses_websockets_v2 = true',
    '[model_providers.interrupt_fixture]', 'name = "Isolated interrupt fixture"', 'base_url = ' + JSON.stringify(base + '/v1'),
    'wire_api = "responses"', 'env_key = "WS_INTERRUPT_FIXTURE_KEY"', 'supports_websockets = true',
  ].join('\n');
  fs.writeFileSync(path.join(home, 'config.toml'), config);
  const child = spawn(cli, ['app-server', '--stdio'], { cwd, env: { ...process.env, CODEX_HOME: home, WS_INTERRUPT_FIXTURE_KEY: 'inert-test-key' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let id = 0, stderr = '';
  const pending = new Map(), notices = [], lines = readline.createInterface({ input: child.stdout });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  lines.on('line', line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    if (value.id !== undefined && !value.method) {
      const wait = pending.get(value.id); if (!wait) return;
      pending.delete(value.id); clearTimeout(wait.timer);
      value.error ? wait.reject(new Error(JSON.stringify(value.error))) : wait.resolve(value.result);
    } else if (value.id !== undefined) child.stdin.write(JSON.stringify({ id: value.id, error: { code: -32601, message: 'No external test tools are implemented.' } }) + '\n');
    else notices.push(value);
  });
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Native RPC timeout: ' + method + '\n' + stderr)); }, 20000);
      pending.set(requestId, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n');
    });
  }
  async function startTurn(threadId, model, message) {
    const offset = notices.length;
    const started = await rpc('turn/start', { threadId, model, effort: 'low', input: [{ type: 'text', text: message }] });
    return { offset, turnId: started.turn.id };
  }
  async function waitTurn(turn) {
    return until(() => notices.slice(turn.offset).find(value => value.method === 'turn/completed' && value.params?.turn?.id === turn.turnId), 'native turn/completed', 1000);
  }
  try {
    await rpc('initialize', { clientInfo: { name: 'isolated-ws-interrupt-test', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    for (const model of models) {
      const thread = await rpc('thread/start', { model, modelProvider: 'interrupt_fixture', cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'danger-full-access', runtimeWorkspaceRoots: [cwd] });
      const threadId = thread.thread.id;
      const cancelled = await startTurn(threadId, model, 'HOLD_NATIVE_CANCEL_' + model);
      await until(() => notices.slice(cancelled.offset).find(value => value.method === 'item/agentMessage/delta'), 'native streaming text', 1000);
      const waiting = records.at(-1);
      await rpc('turn/interrupt', { threadId, turnId: cancelled.turnId });
      assert.equal((await waitTurn(cancelled)).params.turn.status, 'interrupted');
      await until(() => waiting.closed, 'native cancellation HTTP release');
      const continued = await startTurn(threadId, model, 'Continue after native cancellation');
      const completed = (await waitTurn(continued)).params.turn;
      assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
      if (model === models[0]) {
        // The native Lite path sends response.interrupt for immediate steering.
        // Non-Lite models queue steering until the current sampling boundary.
        const steered = await startTurn(threadId, model, 'HOLD_NATIVE_STEER_' + model);
        await until(() => notices.slice(steered.offset).find(value => value.method === 'item/agentMessage/delta'), 'native text before steering', 1000);
        const logBefore = fs.readFileSync(path.join(fixture, 'data/logs/shim.log'), 'utf8');
        await rpc('turn/steer', { threadId, expectedTurnId: steered.turnId, input: [{ type: 'text', text: 'Continue using this native steering message' }] });
        const afterSteer = (await waitTurn(steered)).params.turn;
        assert.equal(afterSteer.status, 'completed', JSON.stringify(afterSteer.error));
        assert(fs.readFileSync(path.join(fixture, 'data/logs/shim.log'), 'utf8').slice(logBefore.length).includes('gateway WS interrupted response='));
      }
      const errors = notices.slice(cancelled.offset).filter(value => value.method === 'error');
      assert.deepEqual(errors, []);
      checks.push('Installed native client ' + model + ': cancellation and same-chat continuation' + (model === models[0] ? ', including mid-turn steering' : ''));
    }
  } finally {
    for (const wait of pending.values()) clearTimeout(wait.timer);
    pending.clear(); lines.close(); child.kill();
  }
}
try {
  const prepare = runRouter(['--prepare']); assert.equal((await once(prepare.child, 'exit'))[0], 0, prepare.errors());
  const router = runRouter([]);
  await until(() => fetch(base + '/healthz').then(r => r.ok).catch(() => false), 'router health');
  for (const model of models) {
    const client = await connect(), before = records.length;
    const created = await create(client, model, 'HOLD_ORIGINAL_' + model);
    await client.wait(model.startsWith('词元计划/') ? 'response.output_text.delta' : 'response.function_call_arguments.delta');
    const record = records[before], stopped = await interrupt(client, created.response.id);
    assert.equal(stopped.response.status, 'cancelled');
    assert.equal(stopped.response.output.length, model.startsWith('词元计划/') ? 0 : 1);
    assert(!JSON.stringify(stopped.response).includes('UNCOMMITTED_ONLY'));
    assert(!Object.hasOwn(stopped.response, 'usage'), 'Unknown cancelled usage must not be fabricated');
    await until(() => record.closed, 'cancelled upstream HTTP close');
    const offset = client.events.length;
    client.send({ type: 'response.create', model, previous_response_id: created.response.id, input: [{ role: 'user', content: 'Resume with original context' }] });
    const resumed = await client.wait('response.completed', offset);
    assert.equal(resumed.response.status, 'completed');
    const request = JSON.stringify(records.at(-1).body);
    assert(request.includes('HOLD_ORIGINAL_' + model));
    assert(!request.includes('UNCOMMITTED_ONLY')); assert(!request.includes('fc_partial_'));
    if (!model.startsWith('词元计划/')) assert(request.includes('COMMITTED_ORIGINAL'));
    // A completed response can race with its interrupt. Never duplicate completion.
    const race = client.events.length;
    client.send({ type: 'response.interrupt', response_id: resumed.response.id, mode: 'discard_partial_items' });
    await client.wait('response.interrupt.accepted', race, resumed.response.id); await delay(30);
    assert(!client.events.slice(race).some(event => event.type === 'response.completed'));
    assert(!client.events.some(event => event.type === 'error'));
    client.socket.close(); checks.push(model + ': interrupt handshake, HTTP release, original context and completion race');
  }
  {
    const client = await connect();
    const a = await create(client, models[0], 'HOLD_LANE_A', { stream_id: 'a' });
    const b = await create(client, models[0], 'HOLD_LANE_B', { stream_id: 'b' });
    await client.wait('response.function_call_arguments.delta', 0, undefined);
    const before = records.length, recordA = records[before - 2], recordB = records[before - 1];
    const offset = client.events.length;
    client.send({ type: 'response.interrupt', response_id: a.response.id, mode: 'discard_partial_items', stream_id: 'b' });
    await client.wait('response.interrupt.failed', offset, a.response.id);
    assert(!recordA.closed && !recordB.closed);
    const stopped = await interrupt(client, a.response.id); assert.equal(stopped.stream_id, 'a');
    await until(() => recordA.closed, 'lane A HTTP close'); assert(!recordB.closed);
    const failed = client.events.length;
    client.send({ type: 'response.interrupt', response_id: 'resp_unknown', mode: 'discard_partial_items', stream_id: 'b' });
    await client.wait('response.interrupt.failed', failed, 'resp_unknown'); assert(!recordB.closed);
    const unsupported = client.events.length;
    client.send({ type: 'response.interrupt', response_id: b.response.id, mode: 'unknown_mode' });
    await client.wait('response.interrupt.failed', unsupported, b.response.id); assert(!recordB.closed);
    await interrupt(client, b.response.id); await until(() => recordB.closed, 'lane B HTTP close');
    client.socket.close(); checks.push('Response IDs isolate multiplexed streams; invalid IDs, lanes and modes cannot cancel unrelated work');
  }
  {
    const client = await connect();
    const first = await create(client, models[0], 'HOLD_IMMEDIATE_REUSE');
    await client.wait('response.function_call_arguments.delta');
    const offset = client.events.length;
    client.send({ type: 'response.interrupt', response_id: first.response.id, mode: 'discard_partial_items' });
    client.send({ type: 'response.create', model: models[0], previous_response_id: first.response.id, input: [{ role: 'user', content: 'Immediate continuation' }] });
    await client.wait('response.interrupt.accepted', offset, first.response.id);
    await until(() => {
      const events = client.events.slice(offset); assert(!events.some(event => event.type === 'error'));
      return events.filter(event => event.type === 'response.completed').length === 2;
    }, 'immediate continuation without stale abort errors');
    const completed = client.events.slice(offset).filter(event => event.type === 'response.completed');
    assert.equal(completed[0].response.status, 'cancelled'); assert.equal(completed[1].response.status, 'completed');
    client.socket.close(); checks.push('Immediate continuation can reuse the interrupted stream before the old HTTP cleanup finishes');
  }
  {
    const client = await connect();
    const first = await create(client, models[0], 'Finished response'); await client.wait('response.completed', 0, first.response.id);
    const second = await create(client, models[0], 'HOLD_NEW_RESPONSE');
    const record = records.at(-1), offset = client.events.length;
    client.send({ type: 'response.interrupt', response_id: first.response.id, mode: 'discard_partial_items' });
    await client.wait('response.interrupt.accepted', offset, first.response.id); assert(!record.closed);
    await interrupt(client, second.response.id); client.socket.close();
    checks.push('Late interrupts cannot cancel a newer generation on the same stream');
  }
  {
    const client = await connect();
    const original = await create(client, native.slug, 'HOLD_OFFICIAL_ORIGINAL', { stream_id: 'official' });
    await client.wait('response.function_call_arguments.delta');
    const otherOffset = client.events.length;
    await create(client, models[0], 'Gateway on the same connection'); await client.wait('response.completed', otherOffset);
    const frame = { type: 'response.interrupt', response_id: original.response.id, mode: 'discard_partial_items' };
    const stopped = await interrupt(client, original.response.id); assert.equal(stopped.response.status, 'cancelled');
    assert.deepEqual(officialFrames.at(-1), frame, 'Official interruption must pass through unchanged');
    const offset = client.events.length;
    client.send({ type: 'response.create', model: models[0], previous_response_id: original.response.id, input: [{ role: 'user', content: 'Continue on gateway' }] });
    await client.wait('response.completed', offset);
    assert(JSON.stringify(records.at(-1).body).includes('HOLD_OFFICIAL_ORIGINAL'));
    assert(!JSON.stringify(records.at(-1).body).includes('UNCOMMITTED_ONLY'));
    client.socket.close(); checks.push('Official interrupts remain unchanged after route switches; retained context can continue on a gateway');
  }
  if (process.env.WS_INTERRUPT_NATIVE_CLI) await checkNativeClient(process.env.WS_INTERRUPT_NATIVE_CLI);
  const report = { passed: true, checks };
  fs.mkdirSync(path.join(root, 'data/diagnostics'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/diagnostics/ws-interrupt-results' + (process.env.WS_INTERRUPT_NATIVE_CLI ? '-native' : '') + '.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const client of clients) client.terminate();
  for (const child of children) if (child.exitCode === null) child.kill();
  for (const client of official.clients) client.terminate();
  for (const socket of sockets) socket.destroy();
  official.close(); peer.close();
}
