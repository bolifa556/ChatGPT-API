import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NativeWebSearch } from '../src/native-web-search.mjs';
import { encodeSse } from '../src/sse.mjs';

const gateway = { model: 'relay/gpt-test', base: 'https://api.test/v1', profile: { id: 'default', apiKey: 'inert-api-key' } };
const body = { id: 'fixture-session', model: 'relay/gpt-test', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Original context' }] }], commands: { search_query: [{ q: 'fixture search' }], response_length: 'short' } };
const headers = { authorization: 'Bearer inert-api-key', 'x-codex-turn-state': 'native-state', 'x-bf-eh-x-codex-turn-state': 'native-state', 'x-client-request-id': 'native-id', 'content-type': 'application/json' };
function events({ urls = ['https://example.com/doc'], noCall = false, text = 'Retrieved fixture evidence.', terminal = 'response.completed', other } = {}) {
  const output = [
    ...(!noCall ? [{ type: 'web_search_call', id: 'ws_fixture', status: 'completed', action: { type: 'search', query: 'fixture', sources: urls.map(url => ({ url })) } }] : []),
    { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text, annotations: urls.map(url => ({ type: 'url_citation', title: 'Fixture source', url })) }] },
    ...(other ? [other] : []),
  ];
  return [{ type: 'response.created', response: { id: 'resp_fixture', output: [] } },
    ...output.map((item, output_index) => ({ type: 'response.output_item.done', item, output_index })),
    { type: terminal, response: { id: 'resp_fixture', status: terminal === 'response.completed' ? 'completed' : 'incomplete', output } }];
}
function response(list = events(), gzip = false) {
  const bytes = Buffer.from(list.map(encodeSse).join(''));
  return { statusCode: 200, headers: { 'content-type': 'text/event-stream', ...(gzip ? { 'content-encoding': 'gzip' } : {}) }, body: Readable.from([gzip ? gzipSync(bytes) : bytes]) };
}
function options(calls = [], makeResponse = () => response(), extra = {}) {
  return { gateway, headers, send: async (payload, outgoing) => { calls.push({ payload, headers: outgoing }); return makeResponse(); }, ...extra };
}

test('native search returns the exact native response shape backed by actual search output', async () => {
  const calls = [], original = JSON.stringify(body);
  const result = await new NativeWebSearch().run(body, options(calls));
  assert.equal(result.encrypted_output, null);
  assert.match(result.output, /Retrieved fixture evidence/);
  assert.match(result.results[0].ref_id, /^turn\d+search0$/);
  assert.equal(result.results[0].url, 'https://example.com/doc');
  assert.equal(JSON.stringify(body), original);
  assert.equal(calls[0].payload.model, gateway.model);
  assert.deepEqual(calls[0].payload.tool_choice, { type: 'web_search' });
  assert.equal(calls[0].payload.tools.length, 1);
  assert.equal(calls[0].payload.tools[0].type, 'web_search');
  assert.equal(calls[0].payload.store, false);
  assert.equal(calls[0].payload.input.length, 1);
  assert(!JSON.stringify(calls[0].payload.input).includes('Original context'));
  assert.match(calls[0].payload.input[0].content, /fixture search/);
});
test('native session metadata is isolated while source authentication remains', async () => {
  const calls = []; await new NativeWebSearch().run(body, options(calls));
  assert.equal(calls[0].headers.authorization, 'Bearer inert-api-key');
  for (const key of ['x-codex-turn-state', 'x-bf-eh-x-codex-turn-state', 'x-client-request-id']) assert.equal(calls[0].headers[key], undefined);
  assert.equal(headers['x-codex-turn-state'], 'native-state');
});
test('no real search call, incomplete streams and external calls cannot become successes', async () => {
  for (const [list, code] of [[events({ noCall: true }), 'search_not_executed'], [[], 'search_upstream_incomplete'],
    [events({ terminal: 'response.incomplete' }), 'search_upstream_incomplete'],
    [events({ other: { type: 'function_call', name: 'exec', id: 'fc_unexpected' } }), 'unexpected_search_tool']]) {
    await assert.rejects(new NativeWebSearch().run(body, options([], () => response(list))), { code });
  }
});
test('SSE business errors and HTTP auth errors retain their real details without retries', async () => {
  const error = { type: 'rate_limit_error', code: 'rate_limited', message: 'Fixture limit' };
  const calls = [];
  await assert.rejects(new NativeWebSearch().run(body, options(calls, () => response([{ type: 'error', error }]))), e => e.upstreamError.code === error.code);
  assert.equal(calls.length, 1);
  await assert.rejects(new NativeWebSearch().run(body, options([], () => ({ statusCode: 401, headers: {}, body: Readable.from([JSON.stringify({ error: { type: 'authentication_error', message: 'Fixture unauthorized' } })]) }))), e => e.status === 401 && e.upstreamError.type === 'authentication_error');
});
test('compressed and Lite terminal output still provide real source references', async () => {
  const list = events(); list.at(-1).response.output = [];
  const result = await new NativeWebSearch().run(body, options([], () => response(list, true)));
  assert.equal(result.results.length, 1);
});
test('open and find resolve saved references only in the same API source and session', async () => {
  const bridge = new NativeWebSearch(), calls = [];
  const first = await bridge.run(body, options());
  await bridge.run({ ...body, commands: { open: [{ ref_id: first.results[0].ref_id, lineno: 5 }] } }, options(calls));
  assert.match(calls[0].payload.input.at(-1).content, /https:\/\/example.com\/doc/);
  assert.match(calls[0].payload.input.at(-1).content, /"lineno":5/);
  await bridge.run({ ...body, commands: { find: [{ ref_id: first.results[0].ref_id, pattern: 'fixture' }] } }, options(calls));
  assert.match(calls[1].payload.input.at(-1).content, /"pattern":"fixture"/);
  for (const extra of [{ gateway: { ...gateway, profile: { ...gateway.profile, apiKey: 'another-inert-key' } } }, {}]) {
    await assert.rejects(bridge.run({ ...body, ...(Object.keys(extra).length ? {} : { id: 'other-session' }), commands: { open: [{ ref_id: first.results[0].ref_id }] } }, options([], undefined, extra)), { code: 'invalid_search_reference' });
  }
});
test('reference storage expires and stays bounded', async () => {
  let now = 0;
  const bridge = new NativeWebSearch({ now: () => now });
  await bridge.run(body, options()); now += 31 * 60 * 1000;
  await assert.rejects(bridge.run({ ...body, commands: { open: [{ ref_id: 'turn0search0' }] } }, options()), { code: 'invalid_search_reference' });
  for (let index = 0; index < 70; index++) await bridge.run({ ...body, id: 'session-' + index }, options());
  assert.equal(bridge.sessions.size, 64);
});
test('domain restrictions are intersected rather than widened and verified on returned sources', async () => {
  const calls = [];
  await new NativeWebSearch().run({ ...body, settings: { filters: { allowed_domains: ['example.com'] } }, commands: { search_query: [{ q: 'fixture', domains: ['docs.example.com'] }] } }, options(calls, () => response(events({ urls: ['https://docs.example.com/doc'] }))));
  assert.deepEqual(calls[0].payload.tools[0].filters.allowed_domains, ['docs.example.com']);
  await assert.rejects(new NativeWebSearch().run({ ...body, commands: { search_query: [{ q: 'fixture', domains: ['unrelated.test'] }] } }, options()), { code: 'search_filter_not_honored' });
  await assert.rejects(new NativeWebSearch().run({ ...body, settings: { filters: { allowed_domains: ['allowed.test'] } }, commands: { search_query: [{ q: 'fixture', domains: ['unrelated.test'] }] } }, options()), { code: 'empty_search_filter' });
});
test('cache-only remains cache-only and indexed policy is never silently widened to live', async () => {
  for (const [value, expected] of [['cached', false], ['live', true], ['indexed', 'indexed'], [false, false]]) {
    const calls = [];
    await new NativeWebSearch().run({ ...body, settings: { external_web_access: value } }, options(calls));
    assert.equal(calls[0].payload.tools[0].external_web_access, expected);
  }
});
test('caller output budget is preserved and conversational instructions never enter search subrequests', async () => {
  const calls = [];
  await new NativeWebSearch().run({ ...body, input: [{ role: 'user', content: 'Discuss my launcher and claim repairs were not performed.' }], max_output_tokens: 2000 }, options(calls));
  assert.equal(calls[0].payload.max_output_tokens, 2000);
  assert(!JSON.stringify(calls[0].payload.input).includes('launcher'));
  await assert.rejects(new NativeWebSearch().run({ ...body, max_output_tokens: -1 }, options()), { code: 'invalid_search_budget' });
});
test('unsupported tools, invalid inputs, blocked references and cancellations fail before dispatch', async () => {
  const calls = [], bridge = new NativeWebSearch();
  for (const request of [{ ...body, commands: { screenshot: [{ ref_id: 'https://example.com', pageno: 0 }] } },
    { ...body, commands: {} }, { ...body, commands: { search_query: [{ q: '' }] } },
    { ...body, commands: { open: [{ ref_id: 'file:///private' }] } },
    { ...body, settings: { filters: { blocked_domains: ['example.com'] } }, commands: { open: [{ ref_id: 'https://example.com/doc' }] } }]) {
    await assert.rejects(bridge.run(request, options(calls)));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(bridge.run(body, options(calls, undefined, { signal: controller.signal })));
  assert.equal(calls.length, 0);
});
test('native endpoint is narrowly integrated and all production build fingerprints agree', () => {
  const base = fileURLToPath(new URL('../src/', import.meta.url));
  const shim = fs.readFileSync(base + 'shim.mjs', 'utf8'), control = fs.readFileSync(base + 'Router-Control.ps1', 'utf8');
  assert.match(shim, /import \{ NativeWebSearch \}/);
  assert.match(shim, /alpha\\\/search/);
  assert.match(shim, /if \(route\(body.model\) === 'gateway'\)/);
  for (const source of [shim, control]) assert(source.includes("'responses-images.mjs','native-web-search.mjs'"));
  for (const relative of ['linux/provider.mjs', 'macos/provider.mjs']) assert(fs.readFileSync(new URL('../' + relative, import.meta.url), 'utf8').includes("'responses-images.mjs','native-web-search.mjs'"));
  for (const relative of ['scripts/Build-Release.ps1', 'scripts/build-linux-release.py', 'scripts/build-macos-release.py']) assert(fs.readFileSync(new URL('../' + relative, import.meta.url), 'utf8').includes("'src/native-web-search.mjs'"));
});

test('non-stream JSON search responses are decoded without losing citations', async () => {
  const complete = events().at(-1).response;
  const result = await new NativeWebSearch().run(body, options([], () => ({
    statusCode: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    body: Readable.from([gzipSync(Buffer.from(JSON.stringify(complete)))]),
  })));
  assert.equal(result.results[0].url, 'https://example.com/doc');
});
test('named SSE events without a type field and harmless controls are supported', async () => {
  const bytes = events().map(event => {
    const { type, ...data } = event;
    return 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
  }).join('');
  const result = await new NativeWebSearch().run(body, options([], () => ({
    statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: Readable.from([Buffer.from(': keepalive\n\n'), Buffer.from(bytes)]),
  })));
  assert.equal(result.results.length, 1);
});
test('invalid settings and oversized UTF-8 requests fail before network dispatch', async () => {
  const calls = [];
  for (const changes of [
    { settings: { filters: 'invalid' } },
    { settings: { external_web_access: 'invalid' } },
    { settings: { search_context_size: 'invalid' } },
    { commands: { search_query: [{ q: 'fixture', domains: ['example.com:443'] }] } },
    { commands: { response_length: 'invalid', search_query: [{ q: 'fixture' }] } },
    { commands: { open: [{ ref_id: 'https://example.com', lineno: -1 }] } },
    { input: '中'.repeat(180000) },
  ]) await assert.rejects(new NativeWebSearch().run({ ...body, ...changes }, options(calls)));
  assert.equal(calls.length, 0);
});
test('blocked navigation in an operation batch fails before any search dispatch', async () => {
  const calls = [];
  await assert.rejects(new NativeWebSearch().run({
    ...body, settings: { filters: { blocked_domains: ['blocked.test'] } },
    commands: { search_query: [{ q: 'fixture' }], open: [{ ref_id: 'https://blocked.test/private' }] },
  }, options(calls)), { code: 'search_domain_blocked' });
  assert.equal(calls.length, 0);
});
test('aggregate streaming payloads stay bounded even when individual events are small enough', async () => {
  const payload = 'x'.repeat(2 * 1024 * 1024);
  const chunks = Array.from({ length: 9 }, (_, index) => Buffer.from(encodeSse({
    type: 'response.output_item.done', output_index: index,
    item: { id: 'msg_' + index, type: 'message', content: [{ type: 'output_text', text: payload }] },
  })));
  await assert.rejects(new NativeWebSearch().run(body, options([], () => ({
    statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: Readable.from(chunks),
  }))), { code: 'search_response_too_large' });
});
