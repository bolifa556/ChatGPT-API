import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import { NativeWebSearch } from '../src/native-web-search.mjs';
import { chatRequest, chatResponse, ChatEvents } from '../src/chat-compat.mjs';
import { searchSources, applyChatSearch } from '../src/search-compat.mjs';
import { encodeSse } from '../src/sse.mjs';

const gateway = { model: 'relay/gpt-test', base: 'https://api.test/custom/v2',
  profile: { id: 'default', apiKey: 'fixture-key' }, metadata: {} };
const body = { model: 'public-model', id: 'fixture-session', input: [{ role: 'user', content: 'Original search context.' }],
  commands: { search_query: [{ q: 'fixture query' }], response_length: 'short' } };
const headers = { authorization: 'Bearer fixture-key', 'content-type': 'application/json',
  'x-codex-turn-state': 'private-state', 'x-bf-eh-x-codex-turn-state': 'private-state' };
const source = 'https://example.com/document';

function cache() {
  const protocols = new Map();
  return {
    searchProtocol: target => protocols.get(target.base + '/' + target.model + '/' + target.profile.apiKey),
    rememberSearch: (target, protocol) => protocols.set(target.base + '/' + target.model + '/' + target.profile.apiKey, protocol),
  };
}
function response(status, value, extra = {}) {
  return { statusCode: status, headers: { 'content-type': 'application/json', ...extra }, body: Readable.from([JSON.stringify(value)]) };
}
function complete(action = { type: 'search', sources: [{ url: source, title: 'Original title' }] }, text = 'Original evidence.') {
  return { id: 'resp_fixture', status: 'completed', output: [
    { id: 'ws_fixture', type: 'web_search_call', status: 'completed', action },
    { id: 'msg_fixture', type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] },
  ] };
}
const missing = () => response(405, { error: { code: 'method_not_allowed', message: 'Fixture endpoint not implemented.' } });
async function value(result) {
  const chunks = [];
  for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks));
}
function options(calls, reply, extra = {}) {
  return { gateway, headers, send: async (endpoint, payload, outgoing) => {
    calls.push({ endpoint, payload, headers: outgoing });
    return reply(endpoint, payload);
  }, ...extra };
}

test('native search succeeds unchanged, including commands outside the compatibility subset', async () => {
  const calls = [], store = cache(), bridge = new NativeWebSearch(store);
  const native = { encrypted_output: 'original-ciphertext', output: 'Original page body.', results: [{ type: 'future_result', original: true }] };
  const request = { ...body, commands: { click: [{ ref_id: 'native-reference', id: 3 }] } };
  const result = await bridge.run(request, options(calls, () => response(200, native)));
  assert.deepEqual(await value(result), native);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, '/alpha/search');
  assert.deepEqual(calls[0].payload, { ...request, model: gateway.model });
  assert.equal(store.searchProtocol(gateway), 'native');
});

test('endpoint rejection converts once, retains original input and caches the successful protocol', async () => {
  const calls = [], store = cache(), bridge = new NativeWebSearch(store);
  const reply = endpoint => endpoint === '/alpha/search' ? missing() : response(200, complete());
  const result = await value(await bridge.run(body, options(calls, reply)));
  assert.equal(result.results[0].url, source);
  assert.match(result.output, /Original evidence/);
  assert.deepEqual(calls.map(call => call.endpoint), ['/alpha/search', '/responses']);
  assert.deepEqual(calls[1].payload.input.slice(0, 1), body.input);
  assert.equal(calls[1].payload.model, gateway.model);
  assert.deepEqual(calls[1].payload.tool_choice, { type: 'web_search' });
  assert.equal(calls[1].headers.authorization, headers.authorization);
  assert.equal(calls[1].headers['x-codex-turn-state'], undefined);
  assert.equal(calls[1].headers['x-bf-eh-x-codex-turn-state'], undefined);
  await value(await new NativeWebSearch(store).run(body, options(calls, reply)));
  assert.equal(calls[2].endpoint, '/responses');
  assert.equal(calls.length, 3);
});

test('authentication, quota, transport, model errors and accepted failures keep their original result', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const calls = [], error = { code: 'original_error', message: 'Original upstream detail.', param: 'model' };
    const result = await new NativeWebSearch(cache()).run(body, options(calls, () => response(status, { error })));
    assert.equal(result.statusCode, status);
    assert.deepEqual(await value(result), { error });
    assert.equal(calls.length, 1);
  }
  const calls = [];
  const result = await new NativeWebSearch(cache()).run(body, options(calls,
    () => response(404, { error: { code: 'model_not_found', message: 'Unknown model.', param: 'model' } })));
  assert.equal(result.statusCode, 404);
  assert.equal(calls.length, 1);
  const failed = complete(); failed.status = 'incomplete';
  await assert.rejects(new NativeWebSearch(cache()).run(body, options([], endpoint =>
    endpoint === '/alpha/search' ? missing() : response(200, failed))), { code: 'search_upstream_incomplete' });
});

test('a cached protocol can recover to native when its endpoint is removed', async () => {
  const store = cache(), calls = [];
  store.rememberSearch(gateway, 'responses');
  const native = { encrypted_output: null, output: 'Restored native protocol.', results: [] };
  const result = await new NativeWebSearch(store).run(body, options(calls, endpoint =>
    endpoint === '/responses' ? missing() : response(200, native)));
  assert.deepEqual(await value(result), native);
  assert.deepEqual(calls.map(call => call.endpoint), ['/responses', '/alpha/search']);
  assert.equal(store.searchProtocol(gateway), 'native');
});

test('a search-only result cannot satisfy opening or finding a different target', async () => {
  for (const command of [{ open: [{ ref_id: source }] }, { find: [{ ref_id: source, pattern: 'needle' }] }]) {
    await assert.rejects(new NativeWebSearch(cache()).run({ ...body, commands: command }, options([], endpoint =>
      endpoint === '/alpha/search' ? missing() : response(200, complete()))), { code: 'search_operation_not_executed' });
  }
  const bridge = new NativeWebSearch(cache()), calls = [];
  const first = await value(await bridge.run(body, options(calls, endpoint => endpoint === '/alpha/search' ? missing() : response(200, complete()))));
  const result = await value(await bridge.run({ ...body, commands: { open: [{ ref_id: first.results[0].ref_id }] } },
    options(calls, () => response(200, complete({ type: 'open_page', url: source })))));
  assert.equal(result.results[0].url, source);
  await assert.rejects(bridge.run({ ...body, id: 'other-session', commands: { open: [{ ref_id: first.results[0].ref_id }] } },
    options([], () => missing())), { code: 'invalid_search_reference' });
});

test('domain filters, original budgets and source references survive conversion', async () => {
  const calls = [], answer = complete();
  answer.output[1].content[0] = { type: 'output_text', text: 'Original claim [1].',
    annotations: [{ type: 'url_citation', url: source, title: 'Original title', start_index: 15, end_index: 18 }] };
  const result = await value(await new NativeWebSearch(cache()).run({ ...body, max_output_tokens: 800,
    settings: { filters: { allowed_domains: ['example.com'] }, external_web_access: 'cached' },
    commands: { search_query: [{ q: 'fixture', domains: ['example.com'] }] } },
  options(calls, endpoint => endpoint === '/alpha/search' ? missing() : response(200, answer))));
  assert.deepEqual(calls[1].payload.tools[0].filters, { allowed_domains: ['example.com'] });
  assert.equal(calls[1].payload.tools[0].external_web_access, false);
  assert.equal(calls[1].payload.max_output_tokens, 800);
  assert.match(result.output, /Original claim \[1\]/);
  assert(result.output.includes('cite' + result.results[0].ref_id + ''));
  assert.equal(result.results[0].title, 'Original title');
});

test('compressed SSE, named events and cancellation use the shared transport protocol', async () => {
  const final = complete(), events = final.output.map((item, output_index) => ({ type: 'response.output_item.done', item, output_index }));
  events.push({ type: 'response.completed', response: { ...final, output: [] } });
  const data = gzipSync(Buffer.from(events.map(encodeSse).join('')));
  const result = await value(await new NativeWebSearch(cache()).run(body, options([], endpoint => endpoint === '/alpha/search' ? missing()
    : { statusCode: 200, headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' }, body: Readable.from([data]) })));
  assert.equal(result.results[0].url, source);
  const controller = new AbortController(), calls = [];
  controller.abort();
  await assert.rejects(new NativeWebSearch(cache()).run(body, options(calls, missing, { signal: controller.signal })));
  assert.equal(calls.length, 0);
});

test('Chat search extension fields survive unchanged; documented source contracts select their controls', () => {
  const extensions = { enable_search: false, search_options: { enable_source: true },
    web_search_options: { search_context_size: 'low' }, search_parameters: { mode: 'auto' },
    extra_body: { google: { tools: [{ google_search: {} }] } } };
  const payload = { model: 'custom/model', input: 'Original question.', ...extensions };
  const converted = chatRequest(payload);
  for (const [key, expected] of Object.entries(extensions)) assert.deepEqual(converted[key], expected);
  const request = { model: 'custom/model', messages: [{ role: 'user', content: 'Question.' }],
    tools: [{ type: 'web_search' }], tool_choice: { type: 'web_search' } };
  const declared = applyChatSearch(request, { ...gateway, metadata: { supported_parameters: ['enable_search'] } });
  assert.equal(declared.enable_search, true);
  assert.equal(declared.tools, undefined);
  assert.equal(declared.messages, request.messages);
  const ordinaryChat = { model: 'custom/model', messages: request.messages };
  assert.equal(applyChatSearch(ordinaryChat, { ...gateway, metadata: { supported_parameters: ['enable_search'] } }), ordinaryChat);
  const zai = applyChatSearch(request, { ...gateway, base: 'https://api.z.ai/api/paas/v4' });
  assert.deepEqual(zai.tools[0].web_search, { enable: true, search_result: true });
  const ordinary = applyChatSearch(request, gateway);
  assert.deepEqual(ordinary, request);
  assert.equal(request.tools[0].web_search, undefined);
  assert.throws(() => applyChatSearch(request, { ...gateway, metadata: { supported_parameters: ['enable_search'] } },
    { external_web_access: false }), { code: 'unsupported_search_setting' });
});

test('a documented Chat search switch accepts original text when that API makes sources optional', async () => {
  const calls = [], target = { ...gateway, metadata: { supported_endpoints: ['/chat/completions'], supported_parameters: ['enable_search'] } };
  const raw = { id: 'chat_fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'Original API search response.' }, finish_reason: 'stop' }] };
  const result = await value(await new NativeWebSearch(cache()).run(body, options(calls,
    endpoint => endpoint === '/alpha/search' ? missing() : response(200, raw), { gateway: target })));
  assert.equal(calls[1].endpoint, '/chat/completions');
  assert.equal(calls[1].payload.enable_search, true);
  assert.equal(result.output, 'Original API search response.');
  assert.deepEqual(result.results, []);
});

test('Chat provider search switches honor a disabled or explicitly selected local tool', () => {
  const web = { type: 'web_search' }, local = { type: 'function', function: { name: 'lookup' } };
  for (const target of [
    { ...gateway, metadata: { supported_parameters: ['enable_search'] } },
    { ...gateway, base: 'https://api.z.ai/api/paas/v4' },
    { ...gateway, base: 'https://api.openai.com/v1' },
  ]) for (const choice of ['none', { type: 'function', function: { name: 'lookup' } }]) {
    const original = { tools: [web, local], tool_choice: choice };
    assert.deepEqual(applyChatSearch(original, target, { external_web_access: false }), { tools: [local], tool_choice: choice });
    assert.deepEqual(original.tools, [web, local]);
  }
});

test('documented search-source formats retain source metadata and only map existing numbered citations', () => {
  const raw = { id: 'chat-fixture', model: 'custom/model', choices: [{ index: 0,
    message: { content: 'Original fact [1].', role: 'assistant' }, finish_reason: 'stop' }],
    citations: [source], search_results: [{ url: source, title: 'Real source title', snippet: 'Original source snippet.' }] };
  const result = chatResponse(raw, 'custom/model');
  assert.deepEqual(result.search_results, raw.search_results);
  assert.deepEqual(result.citations, raw.citations);
  assert.equal(result.output[0].content[0].text, raw.choices[0].message.content);
  assert.equal(result.output[0].content[0].annotations[0].url, source);
  assert.equal(result.output[0].content[0].annotations[0].start_index, 14);
  const stream = new ChatEvents('custom/model');
  stream.convert({ id: 'chat-fixture', choices: [{ delta: { content: 'Original fact ' } }] });
  stream.convert({ id: 'chat-fixture', citations: [source], choices: [{ delta: { content: '[1].' }, finish_reason: 'stop' }] });
  assert.equal(stream.finish().at(-1).response.output[0].content[0].annotations[0].url, source);
  assert.equal(searchSources({ search_info: { search_results: [{ index: 2, title: 'DashScope source', url: source }] } })[0].index, 2);
  assert.equal(searchSources({ web_search: [{ link: source, title: 'Z.ai source' }] })[0].url, source);
  assert.equal(searchSources({ groundingMetadata: { groundingChunks: [{ web: { uri: source, title: 'Grounded source' } }] } })[0].url, source);
});

test('all platform build fingerprints, installers and payloads include the search modules', () => {
  for (const relative of ['src/shim.mjs', 'src/Router-Control.ps1', 'linux/provider.mjs', 'macos/provider.mjs']) {
    const source = fs.readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
    assert(source.includes("'responses-images.mjs','native-web-search.mjs','search-compat.mjs'"), relative);
  }
  for (const relative of ['scripts/Build-Release.ps1', 'scripts/build-linux-release.py', 'scripts/build-macos-release.py',
    'install/Release-Core.ps1', 'linux/install.mjs', 'macos/install.mjs']) {
    const source = fs.readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
    assert(source.includes("'src/native-web-search.mjs'"), relative);
    assert(source.includes("'src/search-compat.mjs'"), relative);
  }
});
