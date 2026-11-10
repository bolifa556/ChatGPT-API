// Offline integration: the real router/image presentation/history adapters and
// strict loopback upstreams. No account, production gateway or paid image call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { encodeSse, ssePackets } from '../src/sse.mjs';
import { restoreHostedImageHistory } from '../src/responses-images.mjs';
import { readRequestJson } from './http-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const model = 'relay/gpt-test';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWhkAAAAASUVORK5CYII=';
const complexity = { type: 'image_generation_user_error', param: 'complexity', code: 'invalid_value', message: "Complexity 'medium' is not supported for this image model." };
const message = { type: 'message', id: 'msg_preface', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture image.' }] };
const image = { type: 'image_generation_call', id: 'ig_real_fixture', status: 'completed', result: png };

test('real HTTP/WS router relays raw tools, recovers images, restores history and isolates other routes', { timeout: 30000 }, async t => {
  fs.mkdirSync(path.join(root, 'data/testing'), { recursive: true });
  const fixture = fs.mkdtempSync(path.join(root, 'data/testing/hosted-images-'));
  const home = path.join(fixture, 'home'), records = [], sockets = new Set();
  let child, stderr = '', serial = 0;
  const official = { ...JSON.parse(fs.readFileSync(path.join(root, 'assets/model-template.json'))).models[0], slug: 'gpt-native' };
  const upstream = http.createServer(async (req, res) => {
    try {
      if (req.url.includes('/models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ models: [official], data: [model, 'other/gpt-test', 'relay/claude-test'].map(id => ({ id })) }));
        return;
      }
      const body = await readRequestJson(req);
      records.push({ url: req.url, headers: req.headers, body });
      const id = 'resp_fixture_' + ++serial;
      const base = { id, object: 'response', model: body.model, status: 'in_progress', output: [], reasoning: body.reasoning, tools: body.tools, tool_choice: body.tool_choice };
      let events;
      const draw = JSON.stringify(body.input || []).includes('draw-fixture');
      if (draw && body.reasoning && req.url.includes('openai_passthrough')) {
        events = [
          { type: 'response.created', response: base },
          { type: 'response.output_item.done', output_index: 0, item: message },
          { type: 'response.output_item.added', output_index: 1, item: { type: 'image_generation_call', id: 'ig_failed_fixture', status: 'in_progress' } },
          { type: 'error', error: complexity },
        ];
      } else {
        const output = draw ? [image] : [message];
        events = [{ type: 'response.created', response: base },
          ...output.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })),
          { type: 'response.completed', response: { ...base, status: 'completed', output } }];
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(events.map(encodeSse).join(''));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(events.at(-1).response));
      }
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  t.after(async () => {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  for (const directory of ['assets', 'data/state', 'home']) fs.mkdirSync(path.join(fixture, directory), { recursive: true });
  for (const name of ['model-template.json', 'reasoning-levels.json', 'model-contexts.json']) fs.copyFileSync(path.join(root, 'assets', name), path.join(fixture, 'assets', name));
  fs.writeFileSync(path.join(fixture, 'data/.env'), [
    'BASE_URL=http://127.0.0.1:' + upstream.address().port + '/v1', 'API_KEY=inert-fixture-key', 'SHIM_PORT=' + port,
    'OFFICIAL_BASE=http://127.0.0.1:' + upstream.address().port + '/backend-api/codex',
  ].join('\n'));
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'inert-fixture-official' } }));
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [official] }));
  fs.writeFileSync(path.join(fixture, 'data/state/route-state.json'), JSON.stringify({ mode: 'mixed', clientVersion: '0.164.0' }));
  const config = path.join(fixture, 'data/state/responses-compat.json');
  fs.writeFileSync(config, JSON.stringify({ version: 1, rules: [{ profileId: 'default', modelPrefix: 'relay/', bifrostProvider: 'relay', declareHostedImages: true, imageModel: 'fixture-image-model' }] }));
  async function start() {
    child = spawn(process.execPath, [path.join(root, 'src/shim.mjs')], {
      env: { ...process.env, CHATGPT_API_ROOT: fixture, CODEX_HOME: home }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', data => stderr += data);
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error('Fixture router exited: ' + stderr);
      try {
        const health = await (await fetch(base + '/healthz')).json();
        if (health.gateway.ready || health.service && (await fetch(base + '/readyz')).ok) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Fixture router did not become ready: ' + stderr);
  }
  await start();
  const input = [{ type: 'function_call_output', name: 'lookup', namespace: 'fixture', output: 'read-only fixture result' }, { role: 'user', content: 'draw-fixture' }];
  const request = { model, stream: true, reasoning: { effort: 'medium' }, tool_choice: 'auto',
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }], input };
  async function httpTurn(payload, suffix = '/responses') {
    const result = await fetch(base + '/v1' + suffix, { method: 'POST', headers: { 'content-type': 'application/json', 'x-codex-turn-state': 'inert-turn-state' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
    assert.equal(result.status, 200);
    if (!payload.stream) return result.json();
    const events = [];
    for await (const packet of ssePackets(result.body)) if (packet.data) events.push(packet.data);
    assert.equal(events.at(-1).type, 'response.completed', JSON.stringify(events.at(-1)));
    return events;
  }
  function assertRecovery(calls, events) {
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.url, '/openai_passthrough/v1/responses');
      assert.equal(call.body.model, 'gpt-test');
      assert.equal(call.headers['x-model-provider'], 'relay');
      assert.equal(call.headers.authorization, 'Bearer inert-fixture-key');
      assert.equal(call.body.input[0].name, 'lookup');
      assert.equal(call.body.input[0].namespace, 'fixture');
      assert.equal(call.body.input[0].call_id, undefined);
    }
    assert.deepEqual(calls[0].body.reasoning, { effort: 'medium' });
    assert(calls[0].body.tools.some(tool => tool.type === 'image_generation' && tool.model === 'fixture-image-model'));
    assert.equal(calls[0].headers['x-codex-turn-state'], 'inert-turn-state');
    assert.equal(calls[1].body.reasoning, undefined);
    assert.equal(calls[1].headers['x-codex-turn-state'], undefined);
    assert.deepEqual(calls[1].body.tools, [{ output_format: 'png', model: 'fixture-image-model', type: 'image_generation' }]);
    assert.equal(events.filter(event => event.type === 'response.created').length, 1);
    assert(!JSON.stringify(events).includes('ig_failed_fixture'));
    assert(events.every((event, index) => !index || event.sequence_number > events[index - 1].sequence_number));
    const result = events.at(-1).response;
    assert.equal(result.model, model);
    assert.equal(result.id, events[0].response.id);
    const presented = result.output.find(item => item.content?.some(part => part.type === 'input_image'));
    assert(presented, 'A real image result must reach the existing presentation adapter');
    assert.equal(presented.content.find(part => part.type === 'input_image').image_url, 'data:image/png;base64,' + png);
    assert.deepEqual(restoreHostedImageHistory({ input: [presented] }, home).payload.input[0], image);
  }
  let before = records.length;
  const httpEvents = await httpTurn(request);
  assertRecovery(records.slice(before), httpEvents);
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/v1/responses', { headers: { 'x-codex-turn-state': 'inert-turn-state' } });
  t.after(() => ws.terminate()); await once(ws, 'open');
  function wsTurn(payload) {
    return new Promise((resolve, reject) => {
      const events = [], timer = setTimeout(() => { ws.off('message', accept); reject(new Error('Fixture WS timeout')); }, 5000);
      function accept(data) {
        const event = JSON.parse(data); events.push(event);
        if (['response.completed', 'error'].includes(event.type)) { clearTimeout(timer); ws.off('message', accept); resolve(events); }
      }
      ws.on('message', accept); ws.send(JSON.stringify({ ...payload, type: 'response.create', stream_id: 'fixture-lane' }));
    });
  }
  before = records.length;
  const wsEvents = await wsTurn(request);
  assertRecovery(records.slice(before), wsEvents);
  assert(wsEvents.every(event => event.stream_id === 'fixture-lane'));
  const edited = await wsTurn({ model, previous_response_id: wsEvents.at(-1).response.id, input: [{ role: 'user', content: 'Edit draw-fixture' }] });
  assert.equal(edited.at(-1).type, 'response.completed');
  assert.deepEqual(records.at(-1).body.input.find(item => item.type === 'image_generation_call'), image);
  ws.terminate();

  // A normal GPT turn keeps reasoning and is not forced into image generation.
  before = records.length;
  await httpTurn({ ...request, input: 'Only say hello.' });
  assert.equal(records.length, before + 1);
  assert.equal(records.at(-1).body.reasoning.effort, 'medium');
  assert.equal(records.at(-1).body.tool_choice, 'auto');
  const json = await httpTurn({ ...request, stream: false, input: 'Only say hello.' });
  assert.equal(json.model, model);
  for (const [selected, suffix, expectedPath] of [
    ['gpt-native', '/responses', '/backend-api/codex/responses'],
    ['other/gpt-test', '/responses', '/v1/responses'],
    ['relay/claude-test', '/responses', '/v1/responses'],
    [model, '/responses/compact', '/v1/responses/compact'],
  ]) {
    before = records.length;
    await httpTurn({ model: selected, stream: false, input: 'Only say hello.' }, suffix);
    assert.equal(records.length, before + 1);
    assert.equal(records.at(-1).url, expectedPath);
    assert.equal(records.at(-1).headers['x-model-provider'], undefined);
    assert(!records.at(-1).body.tools?.some(tool => tool.type === 'image_generation'));
  }
  child.kill(); await once(child, 'exit'); fs.unlinkSync(config); await start();
  await httpTurn({ ...request, stream: false, input: 'Only say hello.' });
  assert.equal(records.at(-1).url, '/v1/responses');
  assert(!records.at(-1).body.tools.some(tool => tool.type === 'image_generation'));
});
