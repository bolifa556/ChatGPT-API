import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { request as realRequest } from 'undici';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { gatewayResponseRequest, imageComplexityError, imageSubrequest, readGatewayResponseRules } from '../src/gateway-responses-compat.mjs';
import { ssePackets, encodeSse } from '../src/sse.mjs';

const rule = { profileId: 'default', modelPrefix: 'relay/', bifrostProvider: 'relay', imageModel: 'gpt-image-2.5-flare' };
const gateway = { profile: { id: 'default' } };
const error = { type: 'error', error: { type: 'image_generation_user_error', param: 'complexity', code: 'invalid_value', message: "Complexity 'medium' is not supported for this image model." } };
const created = id => ({ type: 'response.created', response: { id, model: 'gpt-test', status: 'in_progress', output: [], reasoning: { effort: 'medium' } } });
const item = (type, index, data) => ({ type: 'response.output_item.' + type, output_index: index, item: data });
const text = { type: 'message', id: 'msg_preface', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Generating the image.' }] };
const image = { type: 'image_generation_call', id: 'ig_real_retry', status: 'completed', result: 'aW1hZ2U=' };
const done = (id, output) => ({ type: 'response.completed', response: { id, model: 'gpt-test', status: 'completed', output } });
const failureEvents = [created('resp_original'), item('added', 0, { ...text, status: 'in_progress', content: [] }), item('done', 0, text), item('added', 1, { type: 'image_generation_call', id: 'ig_failed', status: 'in_progress' }), error];
const successEvents = [created('resp_retry'), item('added', 0, { ...image, status: 'in_progress', result: undefined }), item('done', 0, image), done('resp_retry', [image])];
function response(events, gzip = false) {
  const bytes = Buffer.from(events.map(encodeSse).join(''));
  return { statusCode: 200, headers: { 'content-type': 'text/event-stream', ...(gzip ? { 'content-encoding': 'gzip' } : {}) }, body: Readable.from([gzip ? gzipSync(bytes) : bytes]) };
}
async function run(events, nextEvents = successEvents, overrides = {}) {
  const calls = [], payload = { model: 'relay/gpt-test', input: [{ type: 'function_call_output', name: 'create_thread', namespace: 'codex_app', output: 'result' }], reasoning: { effort: 'medium' }, tools: [{ type: 'function', name: 'exec' }], stream: true };
  const request = async (url, options) => { calls.push({ url, options, payload: JSON.parse(options.body) }); return response(calls.length === 1 ? events : nextEvents, overrides.gzip); };
  const upstream = await gatewayResponseRequest('http://gateway.test/v1/responses', { method: 'POST', headers: { authorization: 'Bearer test', 'content-encoding': 'gzip' }, body: 'original', signal: overrides.signal },
    { payload: { ...payload, ...overrides.payload }, gateway, rules: [rule], request });
  const received = [];
  for await (const packet of ssePackets(upstream.body, { maxEventBytes: 64 * 1024 * 1024 })) if (packet.data) received.push(packet.data);
  return { calls, received, payload, upstream };
}

test('raw Bifrost relay preserves name and namespace, and only strips the routing model prefix', async () => {
  const { calls } = await run([created('resp_normal'), item('done', 0, text), done('resp_normal', [text])]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://gateway.test/openai_passthrough/v1/responses');
  assert.equal(calls[0].options.headers['x-model-provider'], 'relay');
  assert.equal(calls[0].options.headers['content-encoding'], undefined);
  assert.equal(calls[0].payload.input[0].name, 'create_thread');
  assert.equal(calls[0].payload.input[0].namespace, 'codex_app');
  assert.equal(calls[0].payload.model, 'gpt-test');
  assert.equal(calls[0].payload.reasoning.effort, 'medium');
});

test('known image error runs one isolated image-only retry, merging streamed preface and real image identity', async () => {
  const { calls, received, payload } = await run(failureEvents);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].payload.reasoning, { effort: 'medium' });
  assert.equal(calls[1].payload.reasoning, undefined);
  assert.deepEqual(calls[1].payload.tools, [{ type: 'image_generation', model: 'gpt-image-2.5-flare', output_format: 'png' }]);
  assert.deepEqual(calls[1].payload.tool_choice, { type: 'image_generation' });
  assert.deepEqual(payload.reasoning, { effort: 'medium' });
  assert.equal(received.filter(event => event.type === 'response.created').length, 1);
  assert.equal(received.some(event => event.type === 'error'), false);
  assert.equal(received.some(event => event.item?.id === 'ig_failed'), false);
  const completed = received.at(-1);
  assert.equal(completed.response.id, 'resp_original');
  assert.equal(completed.response.model, 'relay/gpt-test');
  assert.deepEqual(completed.response.output.map(value => value.id), ['msg_preface', 'ig_real_retry']);
  assert.deepEqual(received.map(value => value.sequence_number), received.map((_, index) => index));
  assert.equal(received.find(event => event.item?.id === 'ig_real_retry').output_index, 1);
});

test('successful image generation never retries and drops no image result', async () => {
  const { calls, received } = await run(successEvents);
  assert.equal(calls.length, 1);
  assert.equal(received.at(-1).response.output[0].id, 'ig_real_retry');
});

test('auth/rate/transport errors are not treated as image parameter failures', async () => {
  const other = { type: 'error', error: { type: 'authentication_error', param: 'complexity', message: 'Unauthorized' } };
  const { calls, received } = await run([created('resp_original'), other]);
  assert.equal(calls.length, 1);
  assert.deepEqual(received.at(-1).error, other.error);
});

test('a turn with an external tool invocation is never replayed', async () => {
  const call = { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'exec', input: 'change something' };
  const { calls, received } = await run([created('resp_original'), item('added', 0, call), item('done', 0, call), error]);
  assert.equal(calls.length, 1);
  assert.equal(received.at(-1).type, 'error');
});

test('unfinished non-image items prevent a retry with inconsistent output history', async () => {
  const { calls } = await run([created('resp_original'), item('added', 0, { type: 'message', id: 'msg_open' }), error]);
  assert.equal(calls.length, 1);
});

test('without outer reasoning, a failure is not retried', async () => {
  const { calls } = await run([created('resp_original'), error], successEvents, { payload: { reasoning: undefined } });
  assert.equal(calls.length, 1);
});

test('the image-only retry is bounded to one attempt', async () => {
  const { calls, received } = await run(failureEvents, [created('resp_retry'), error]);
  assert.equal(calls.length, 2);
  assert.equal(received.at(-1).type, 'error');
});

test('compressed upstream event streams remain readable', async () => {
  const { received, upstream } = await run(failureEvents, successEvents, { gzip: true });
  assert.equal(upstream.headers['content-encoding'], undefined);
  assert.equal(received.at(-1).response.output.at(-1).id, 'ig_real_retry');
});

test('unselected profiles, model prefixes, compact and official URLs are untouched', async () => {
  for (const [url, model, profile] of [
    ['http://gateway.test/v1/responses', 'other/model', 'default'],
    ['http://gateway.test/v1/responses', 'relay/gpt-test', 'other'],
    ['http://gateway.test/v1/responses/compact', 'relay/gpt-test', 'default'],
  ]) {
    const options = { headers: {}, body: 'original' }, expected = { body: 'untouched' };
    const actual = await gatewayResponseRequest(url, options, { payload: { model }, gateway: { profile: { id: profile } }, rules: [rule], request: async (target, sent) => { assert.equal(target, url); assert.equal(sent, options); return expected; } });
    assert.equal(actual, expected);
  }
});

test('cancellation prevents the image-only subrequest', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(run(failureEvents, successEvents, { signal: controller.signal }), /abort/i);
});

test('subrequest creation does not mutate the original tool array', () => {
  const original = { reasoning: { effort: 'high' }, tools: [{ type: 'function', name: 'do_work' }] };
  const retry = imageSubrequest(original, 'gpt-image-2.5-flare');
  assert.equal(original.tools[0].name, 'do_work');
  assert.equal(original.reasoning.effort, 'high');
  assert.equal(retry.reasoning, undefined);
  assert.equal(imageComplexityError(error), true);
});

test('hosted image declaration reflects a real wire tool and does not force image generation', async () => {
  const original = { model: 'relay/gpt-test', tools: [{ type: 'function', name: 'exec' }], instructions: 'Original instructions', tool_choice: 'auto', reasoning: { effort: 'medium' } };
  let sent;
  const expected = { statusCode: 400, headers: {}, body: 'unused' };
  await gatewayResponseRequest('http://gateway.test/v1/responses', { headers: {}, body: '' }, { payload: original, gateway,
    rules: [{ ...rule, declareHostedImages: true }], request: async (_, options) => { sent = JSON.parse(options.body); return expected; } });
  assert.equal(sent.tools.filter(tool => tool.type === 'image_generation').length, 1);
  assert.equal(sent.tool_choice, 'auto');
  assert.equal(sent.reasoning.effort, 'medium');
  assert.match(sent.instructions, /^Original instructions/);
  assert.equal(original.tools.length, 1);
});

test('source keeps both HTTP and WebSocket integration and build fingerprints', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const shim = fs.readFileSync(root + 'shim.mjs', 'utf8');
  const control = fs.readFileSync(root + 'Router-Control.ps1', 'utf8');
  assert.equal([...shim.matchAll(/await gatewayResponseRequest\(/g)].length, 2);
  assert.match(shim, /import \{ gatewayResponseRequest, readGatewayResponseRules \} from '\.\/gateway-responses-compat\.mjs(?:\?[^']+)?'/);
  assert.match(shim, /'responses-images\.mjs','gateway-responses-compat\.mjs'/);
  assert.match(control, /'responses-images\.mjs','gateway-responses-compat\.mjs'/);
});

test('image retry proceeds when the failing HTTP SSE connection stays open', async () => {
  let requests = 0;
  const server = http.createServer((incoming, outgoing) => {
    incoming.resume();
    requests++;
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests === 1) outgoing.write(failureEvents.map(encodeSse).join(''));
    else outgoing.end(successEvents.map(encodeSse).join(''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const upstream = await gatewayResponseRequest(`http://127.0.0.1:${server.address().port}/v1/responses`,
      { method: 'POST', headers: {}, body: '', signal: AbortSignal.timeout(3000) },
      { payload: { model: 'relay/gpt-test', stream: true, reasoning: { effort: 'medium' }, input: 'Generate one mouse image.' },
        gateway, rules: [rule], request: realRequest });
    const received = [];
    for await (const packet of ssePackets(upstream.body)) if (packet.data) received.push(packet.data);
    assert.equal(requests, 2);
    assert.equal(received.at(-1).type, 'response.completed');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('image-only retry does not reuse native turn state, Lite negotiation or request identity', async () => {
  const calls = [];
  const headers = { authorization: 'Bearer test', 'x-codex-turn-state': 'opaque-native-state',
    'x-bf-eh-x-codex-turn-state': 'opaque-native-state', 'x-client-request-id': 'original-request',
    'x-bf-eh-x-openai-internal-codex-responses-lite': 'true', 'thread-id': 'original-thread' };
  const upstream = await gatewayResponseRequest('http://gateway.test/v1/responses', { headers, body: '' },
    { payload: { model: 'relay/gpt-test', reasoning: { effort: 'medium' }, input: 'Generate a mouse.', stream: true }, gateway, rules: [rule],
      request: async (_, options) => { calls.push(options); return response(calls.length === 1 ? failureEvents : successEvents); } });
  for await (const packet of ssePackets(upstream.body)) {}
  assert.equal(calls[0].headers['x-codex-turn-state'], 'opaque-native-state');
  assert.equal(calls[1].headers['x-codex-turn-state'], undefined);
  assert.equal(calls[1].headers['x-bf-eh-x-codex-turn-state'], undefined);
  assert.equal(calls[1].headers['x-client-request-id'], undefined);
  assert.equal(calls[1].headers['x-bf-eh-x-openai-internal-codex-responses-lite'], undefined);
  assert.equal(calls[1].headers.authorization, 'Bearer test');
  assert.equal(calls[1].headers['x-model-provider'], 'relay');
});

test('configuration is absent by default and invalid rules fail closed without logging their contents', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'responses-compat-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const logs = [], log = value => logs.push(value);
  assert.deepEqual(readGatewayResponseRules(fixture, log), []);
  assert.equal(logs.length, 0);
  fs.mkdirSync(path.join(fixture, 'data/state'), { recursive: true });
  const file = path.join(fixture, 'data/state/responses-compat.json');
  for (const invalid of [null, {}, { version: 2, rules: [rule] }, { version: 1, rules: {} },
    { version: 1, rules: [null] }, { version: 1, rules: Array(33).fill(rule) },
    ...[{ modelPrefix: '' }, { modelPrefix: 'relay' }, { profileId: null }, { bifrostProvider: 'bad\r\nheader' },
      { declareHostedImages: 'true' }, { imageModel: 12 }].map(override => ({ version: 1, rules: [{ ...rule, ...override }] }))]) {
    fs.writeFileSync(file, JSON.stringify(invalid));
    assert.deepEqual(readGatewayResponseRules(fixture, log), []);
  }
  fs.writeFileSync(file, 'not-json-inert-private-marker');
  assert.deepEqual(readGatewayResponseRules(fixture, log), []);
  assert(logs.length > 0);
  assert(!logs.join('').includes('inert-private-marker'));
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ version: 1, rules: [rule] }));
  assert.deepEqual(readGatewayResponseRules(fixture, log), [rule]);
});

test('existing hosted image options are neither duplicated nor replaced during retry', async () => {
  const tool = { type: 'image_generation', model: 'custom-image-model', action: 'edit', size: '1024x1024', output_format: 'webp', quality: 'high' };
  const { calls } = await run(failureEvents, successEvents, { payload: { tools: [tool] } });
  assert.deepEqual(calls[1].payload.tools, [tool]);
  assert.deepEqual(imageSubrequest({ tools: [tool] }, 'fallback-model').tools, [tool]);
  let sent;
  await gatewayResponseRequest('http://gateway.test/v1/responses', { headers: {}, body: '' }, {
    payload: { model: 'relay/gpt-test', tools: [tool] }, gateway, rules: [{ ...rule, declareHostedImages: true }],
    request: async (_, options) => { sent = JSON.parse(options.body); return { statusCode: 400, headers: {} }; },
  });
  assert.deepEqual(sent.tools, [tool]);
});

test('raw relay retains reverse-proxy URL prefixes and queries', async () => {
  let target;
  await gatewayResponseRequest('http://gateway.test/proxy/v1/responses?fixture=1', { headers: {}, body: '' }, {
    payload: { model: 'relay/gpt-test' }, gateway, rules: [rule],
    request: async url => { target = url; return { statusCode: 400, headers: {} }; },
  });
  assert.equal(target, 'http://gateway.test/proxy/openai_passthrough/v1/responses?fixture=1');
});

test('errors with a successful image or an external call in terminal output never retry', async () => {
  for (const output of [[image], [{ type: 'local_shell_call', id: 'call_terminal', status: 'completed' }]]) {
    const { calls } = await run([created('resp_original'), { type: 'response.failed', response: { id: 'resp_original', error: error.error, output } }]);
    assert.equal(calls.length, 1);
  }
  const { calls } = await run([created('resp_original'), item('done', 0, image), error]);
  assert.equal(calls.length, 1);
});

test('multiple failed image slots or unfinished terminal output prevent ambiguous replay', async () => {
  for (const events of [
    [created('resp_original'), item('added', 0, { type: 'image_generation_call', id: 'ig_a' }), item('added', 1, { type: 'image_generation_call', id: 'ig_b' }), error],
    [created('resp_original'), { type: 'response.failed', response: { id: 'resp_original', error: error.error, output: [{ ...text, status: 'in_progress' }] } }],
  ]) assert.equal((await run(events)).calls.length, 1);
});

test('terminal-only completed text is retained when recovering a failed image', async () => {
  const failed = { type: 'response.failed', response: { id: 'resp_original', error: error.error, output: [text, { type: 'image_generation_call', id: 'ig_failed', status: 'failed' }] } };
  const { received } = await run([created('resp_original'), failed]);
  assert.deepEqual(received.at(-1).response.output.map(value => value.id), [text.id, image.id]);
});

test('truncated streams and a retry without an image fail instead of claiming success', async () => {
  await assert.rejects(run([created('resp_original')]), { code: 'incomplete_upstream_response' });
  await assert.rejects(run(failureEvents, [created('resp_retry')]), { code: 'incomplete_upstream_response' });
  await assert.rejects(run(failureEvents, [created('resp_retry'), done('resp_retry', [text])]), { code: 'image_compatibility_retry_failed' });
});

test('unexpected external calls from the image-only retry are never exposed', async () => {
  await assert.rejects(run(failureEvents, [created('resp_retry'), item('added', 0, { type: 'function_call', name: 'do_work', id: 'fc_unexpected' })]), { code: 'image_compatibility_retry_failed' });
});

test('all platform fingerprints and release allowlists contain the compatibility module', () => {
  const root = new URL('../', import.meta.url);
  for (const relative of ['src/shim.mjs', 'src/Router-Control.ps1', 'macos/provider.mjs', 'linux/provider.mjs']) {
    assert.match(fs.readFileSync(new URL(relative, root), 'utf8'), /'responses-images\.mjs','gateway-responses-compat\.mjs'/, relative);
  }
  for (const relative of ['scripts/Build-Release.ps1', 'scripts/build-macos-release.py', 'scripts/build-linux-release.py']) {
    assert.match(fs.readFileSync(new URL(relative, root), 'utf8'), /'src\/gateway-responses-compat\.mjs'/, relative);
  }
});
