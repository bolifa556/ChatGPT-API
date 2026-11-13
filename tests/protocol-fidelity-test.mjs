import assert from 'node:assert/strict';
import { chatRequest, chatResponse, ChatEvents, usesChat } from '../src/chat-compat.mjs';
import { NonGptAdapter } from '../src/non-gpt-compat.mjs';
import { normalizeGptHistory } from '../src/history-compat.mjs';
import { normalizeBaseUrl } from '../src/settings.mjs';
import { gatewayResponseHeaders } from '../src/transport.mjs';

const checks = [];
for (const model of ['custom/model', 'GPT/gpt-fixture', 'vllm/fixture', '词元计划/fixture']) {
  assert(usesChat({ model }, { supported_endpoints: ['/chat/completions'] }));
  assert(!usesChat({ model }, { supported_endpoints: ['/responses'] }));
}
assert(usesChat({ model: '词元计划/fixture' }));
assert(!usesChat({ model: 'custom/model' }));
checks.push('Declared endpoints choose the protocol independently of names; absent declarations retain compatibility');

const source = { model: 'custom/model', instructions: 'Original native instructions', service_tier: 'priority',
  tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'lookup', description: 'Original description', parameters: { type: 'object' } }] }],
  input: [{ type: 'function_call_output', namespace: 'functions', name: 'lookup', output: 'Original named result' }] };
const snapshot = JSON.stringify(source), adapter = new NonGptAdapter(source), converted = adapter.request();
const chat = chatRequest(converted), alias = converted.tools[0].name;
assert.deepEqual(chat.messages, [{ role: 'system', content: source.instructions }, { role: 'function', name: alias, content: 'Original named result' }]);
assert.equal(chat.service_tier, 'priority'); assert.equal(JSON.stringify(source), snapshot);
assert.deepEqual(normalizeGptHistory(source).payload.input, source.input);
const bound = chatRequest({ input: [{ type: 'function_call', name: 'lookup', call_id: 'original-call', arguments: '{}' }, { type: 'function_call_output', name: 'lookup', output: 'Result' }] });
assert.equal(bound.messages.at(-1).tool_call_id, 'original-call');
assert.equal(bound.messages.filter(message => message.role === 'assistant').length, 1);
assert.throws(() => chatRequest({ input: [{ type: 'function_call_output', output: 'Unbound' }] }), /original call_id or function name/);
assert.throws(() => chatRequest({ input: [{ type: 'function_call_output', name: 'lookup', output: [{ type: 'input_image', image_url: 'data:image/png;base64,fixture' }] }] }), /non-text/);
checks.push('Named results retain identity without fabricated calls/IDs; unambiguous existing calls are reused');

for (const releaseOriginal of [false, true]) {
  for (const call of [
    { namespace: 'functions', name: 'lookup' },
    { name: 'functions.lookup' },
    { namespace: 'functions', name: 'functions.lookup' },
  ]) {
    const original = { ...source, tool_choice: { type: 'function', ...call }, input: [
      { type: 'function_call', ...call, call_id: 'original-qualified-call', arguments: '{}' },
      { type: 'function_call_output', name: 'functions.lookup', output: 'Original qualified result' },
    ] };
    const before = JSON.stringify(original);
    const result = new NonGptAdapter(original).request({ releaseOriginal });
    assert.equal(result.input[0].name, result.tools[0].name);
    assert.equal(result.input[1].name, result.tools[0].name);
    assert.deepEqual(result.tool_choice, { type: 'function', name: result.tools[0].name });
    assert.equal(chatRequest(result).messages.at(-1).tool_call_id, 'original-qualified-call');
    assert.equal(JSON.stringify(original), before);
  }
  const standalone = new NonGptAdapter({ ...source, input: [
    { type: 'function_call_output', name: 'functions.lookup', output: 'Original standalone result' },
  ] }).request({ releaseOriginal });
  assert.equal(chatRequest(standalone).messages.at(-1).name, standalone.tools[0].name);
}
checks.push('Qualified tool names resolve to the same alias in definitions, calls and named results for both request-copy paths');

const duplicateLeaf = new NonGptAdapter({ model: 'custom/model', tools: [
  { type: 'function', name: 'lookup', parameters: { type: 'object' } }, ...source.tools,
], input: [
  { type: 'function_call', name: 'lookup', call_id: 'root-call', arguments: '{}' },
  { type: 'function_call', name: 'functions.lookup', call_id: 'namespace-call', arguments: '{}' },
  { type: 'function_call_output', name: 'lookup', output: 'Root result' },
  { type: 'function_call_output', name: 'functions.lookup', output: 'Namespace result' },
] }).request();
assert.equal(duplicateLeaf.input[0].name, 'lookup');
assert.equal(duplicateLeaf.input[1].name, duplicateLeaf.tools[1].name);
assert.deepEqual(chatRequest(duplicateLeaf).messages.slice(-2).map(item => item.tool_call_id), ['root-call', 'namespace-call']);
checks.push('A root function and a namespaced function with the same leaf name keep their original call/result associations');

const identifiedResult = new NonGptAdapter({ ...source, input: [
  { type: 'function_call', namespace: 'functions', name: 'lookup', call_id: 'identified-call', arguments: '{}' },
  { type: 'function_call_output', namespace: 'functions', name: 'functions.lookup', call_id: 'identified-call', output: 'Identified result' },
] }).request();
assert.equal(identifiedResult.input[1].name, identifiedResult.tools[0].name);
assert.equal(identifiedResult.input[1].call_id, 'identified-call');
assert.equal(chatRequest(identifiedResult).messages.at(-1).tool_call_id, 'identified-call');

const parameterSource = { model: 'custom/model', input: 'Original input', max_output_tokens: 1234,
  text: { verbosity: 'high' }, service_tier: 'priority', safety_identifier: 'original-user',
  prompt_cache_retention: '24h', prompt_cache_options: { mode: 'explicit', ttl: '30m' } };
const parameterSnapshot = JSON.stringify(parameterSource);
const parameterResult = chatRequest(parameterSource, { supported_parameters: ['max_completion_tokens'] });
assert.equal(parameterResult.max_completion_tokens, 1234);
assert(!Object.hasOwn(parameterResult, 'max_tokens'));
assert.equal(parameterResult.verbosity, 'high');
for (const key of ['service_tier', 'safety_identifier', 'prompt_cache_retention', 'prompt_cache_options'])
  assert.deepEqual(parameterResult[key], parameterSource[key]);
assert.equal(JSON.stringify(parameterSource), parameterSnapshot);
assert.equal(chatRequest(parameterSource).max_tokens, 1234);
for (const model of ['o1', 'openai/o3-mini', 'GPT/gpt-5.1', 'GPT/gpt-6-sol']) {
  const request = { ...parameterSource, model };
  assert.equal(chatRequest(request).max_completion_tokens, 1234);
  assert.equal(chatRequest(request, { supported_parameters: ['max_tokens'] }).max_tokens, 1234);
}
checks.push('Chat verbosity, cache controls and caller identity survive; declared token-limit parameters override documented model defaults');

const annotation = { type: 'url_citation', url_citation: { start_index: 0, end_index: 6, title: 'Original source', url: 'https://example.com/source' } };
const expected = { type: 'url_citation', ...annotation.url_citation };
const response = chatResponse({ id: 'citation', model: 'actual-upstream-model', service_tier: 'priority', choices: [{ finish_reason: 'stop', message: { content: 'Answer', annotations: [annotation] } }] }, 'requested-model');
assert.deepEqual(response.output[0].content[0].annotations, [expected]);
assert.equal(response.model, 'actual-upstream-model'); assert.equal(response.service_tier, 'priority');
for (const early of [false, true]) {
  const stream = new ChatEvents('fixture');
  if (early) stream.convert({ id: 'citation-stream', choices: [{ delta: { annotations: [annotation] } }] });
  const events = stream.convert({ id: 'citation-stream', choices: [{ delta: { content: 'Answer', annotations: [annotation] }, finish_reason: 'stop' }] });
  events.push(...stream.finish());
  assert.deepEqual(events.at(-1).response.output[0].content[0].annotations, [expected]);
}
checks.push('JSON and streamed source annotations retain URLs, offsets and titles; actual model and Fast metadata survive');

for (const [base, expectedBase] of [['https://example.com', 'https://example.com/v1'], ['https://example.com/custom/v2/', 'https://example.com/custom/v2'], ['https://example.com/proxy/v1/responses', 'https://example.com/proxy/v1'], ['https://example.com/custom/v2/chat/completions', 'https://example.com/custom/v2']]) assert.equal(normalizeBaseUrl(base), expectedBase);
checks.push('Explicit API prefixes survive normalization; a bare origin retains the conventional default');
const headers = { 'x-openai-internal-codex-responses-lite': 'true', 'x-codex-turn-state': 'original-state' };
assert.deepEqual(gatewayResponseHeaders(headers, true, ''), headers);
assert.equal(gatewayResponseHeaders(headers, true, 'x-bf-eh-')['x-bf-eh-x-codex-turn-state'], 'original-state');
checks.push('Ordinary endpoints retain native headers without proprietary additions; declared forwarding preserves protocol metadata');
console.log(JSON.stringify({ passed: true, checks }));
