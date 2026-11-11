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
