import assert from 'node:assert/strict';
import { ResponseOutput } from '../src/history-compat.mjs';
import { NonGptAdapter, NonGptEvents } from '../src/non-gpt-compat.mjs';
import { usesChat, chatRequest, chatResponse, ChatEvents } from '../src/chat-compat.mjs';

const checks = [];
const raw = 'const x = {n: 17, ok: true, text: "中文\\n\\\""};\ntext(x);';
const tools = [{ type: 'namespace', name: 'functions', description: 'Tools', tools: [
  { type: 'custom', name: 'exec', format: { type: 'text' } },
  { type: 'function', name: 'lookup', parameters: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false } }
] }];
const model = '词元计划/glm-5.3-flash';
const adapter = new NonGptAdapter({ model, tools }, { preserveReasoning: true });
const wire = adapter.request(), name = wire.tools[0].name;
const thought = adapter.item({ type: 'reasoning', id: 'rs_source', summary: [{ type: 'summary_text', text: '  Existing reasoning.\nExisting reasoning.  ' }] });
const contentThought = adapter.item({ type: 'reasoning', id: 'rs_content', content: [{ type: 'reasoning_text', text: 'Original thought' }] });
assert.deepEqual(contentThought.summary, []);
assert.deepEqual(contentThought.content, [{ type: 'reasoning_text', text: 'Original thought' }]);
const original = { model, instructions: 'Existing instructions', tools, text: { format: { type: 'json_schema', name: 'schema', strict: false, schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } } },
  input: [{ role: 'user', content: 'Existing task' }, thought,
    { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Existing commentary' }] },
    { type: 'custom_tool_call', call_id: 'call_1', namespace: 'functions', name: 'exec', input: raw },
    { type: 'custom_tool_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'Existing result' }] },
    { role: 'developer', content: '<model_switch>Client update</model_switch>' }, { role: 'user', content: 'Continue' }] };
const snapshot = JSON.stringify(original);
const converted = new NonGptAdapter(original, { preserveReasoning: true }).request();
const chat = chatRequest(converted);
assert.equal(JSON.stringify(original), snapshot);
assert.equal(chat.messages[2].reasoning_content, thought.summary[0].text);
assert.equal(chat.messages[2].content[0].text, 'Existing commentary');
assert.equal(JSON.parse(chat.messages[2].tool_calls[0].function.arguments).input, raw);
assert.equal(chat.messages[3].tool_call_id, 'call_1');
assert.equal(chat.messages[4].role, 'developer');
assert.deepEqual(chat.response_format.json_schema, { name: 'schema', strict: false, schema: original.text.format.schema });
assert.deepEqual(chat.tools[1].function.parameters, tools[0].tools[1].parameters);
assert(usesChat(original)); assert(!usesChat({ model: 'GPT/gpt-6-sol', text: original.text }));
const hosted = { type: 'web_search', search_context_size: 'medium' };
const hostedRequest = { model, input: [], tools: [hosted], tool_choice: { type: 'web_search' } };
assert.deepEqual(chatRequest(hostedRequest).tools, [hosted]);
assert.deepEqual(chatRequest(hostedRequest).tool_choice, hostedRequest.tool_choice);
assert.deepEqual(chatRequest({ ...hostedRequest, tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'web_search' }] } }).tools, [hosted]);
const aliyun = chatRequest({ ...converted, model: '阿里云订阅/qwen3.8-max' });
assert.equal(aliyun.messages[0].content, 'Existing instructions\n\n<model_switch>Client update</model_switch>');
assert.equal(aliyun.messages.filter(message => message.role === 'system').length, 1);
assert.equal(chatRequest({ model, input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,fixture', detail: 'high' }] }] }).messages[0].content[0].image_url.url, 'data:image/png;base64,fixture');
const switched = new NonGptAdapter({ ...original, model: '阿里云订阅/glm-5.3' }, { preserveReasoning: true }).request();
assert(!switched.input.some(item => item.type === 'reasoning'));
assert(new NonGptAdapter({ ...original, model }, { preserveReasoning: true }).request().input.some(item => item.type === 'reasoning'));
checks.push('Same-model reasoning is preserved exactly; cross-model compatibility remains distinct; immutable roles, native updates, tool schema, content and structured output map to Chat');

for (const value of ['', raw]) {
  const data = new NonGptAdapter({ tools, input: [{ type: 'custom_tool_call', namespace: 'functions', name: 'exec', call_id: 'c', input: value }] }).request();
  assert.equal(JSON.parse(data.input[0].arguments).input, value);
}
assert.throws(() => new NonGptAdapter({ tools, input: [{ type: 'custom_tool_call', name: 'exec', call_id: 'c' }] }).request(), /must be a string/);
assert.throws(() => adapter.raw('{"input":123}'), error => error.code === 'invalid_upstream_tool_arguments');
assert.throws(() => adapter.raw('broken JSON'), error => error.code === 'invalid_upstream_tool_arguments');
assert.equal(adapter.raw(JSON.stringify({ input: '{"data":"not repaired"}' })), '{"data":"not repaired"}');
checks.push('Empty inputs remain empty; missing inputs fail; only the protocol wrapper is validated, never model source code');

for (const mode of ['late-name','terminal-only','parallel']) {
  const events = new NonGptEvents(adapter), output = [], args = JSON.stringify({ input: raw });
  const items = [0, 1].map(index => ({ type: 'function_call', id: 'fc_tool_' + index, name, call_id: 'call_' + index, arguments: args, status: 'completed' }));
  if (mode !== 'terminal-only') {
    for (const [index, item] of items.entries()) output.push(...events.convert({ type: 'response.output_item.added', output_index: index, item: { ...item, name: mode === 'late-name' ? '' : name, arguments: '' } }));
    for (const index of [1, 0]) {
      for (const delta of [args.slice(0, 7), args.slice(7)]) output.push(...events.convert({ type: 'response.function_call_arguments.delta', output_index: index, item_id: items[index].id, delta }));
      output.push(...events.convert({ type: 'response.output_item.done', output_index: index, item: items[index] }));
    }
  }
  output.push(...events.convert({ type: 'response.completed', response: { output: items } }));
  events.finish();
  assert.equal(output.filter(event => event.type === 'response.custom_tool_call_input.done').length, 2);
  assert.equal(output.filter(event => event.type === 'response.output_item.done').length, 2);
  assert(output.filter(event => event.type === 'response.custom_tool_call_input.done').every(event => event.input === raw));
  assert(output.at(-1).response.output.every(item => item.input === raw && item.namespace === 'functions'));
}
assert.throws(() => new NonGptEvents(adapter).finish(), error => error.code === 'incomplete_upstream_response');
checks.push('Late names, interleaved parallel arguments and final-only tool items yield exactly one complete native call each; truncated streams never succeed');
const lateFunction = new NonGptEvents(new NonGptAdapter({})), lateEvents = [];
lateEvents.push(...lateFunction.convert({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_late', delta: '{"n":' }));
lateEvents.push(...lateFunction.convert({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_late', call_id: 'call_late', name: 'lookup', arguments: '' } }));
lateEvents.push(...lateFunction.convert({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_late', delta: '1}' }));
assert.equal(lateEvents.filter(event => event.type === 'response.function_call_arguments.delta').map(event => event.delta).join(''), '{"n":1}');
const ids = new NonGptEvents(new NonGptAdapter({ model }));
const added = ids.convert({ type: 'response.output_item.added', output_index: 0, item: { id: 'one', type: 'message', role: 'assistant', content: [] } })[0];
const done = ids.convert({ type: 'response.output_item.done', output_index: 0, item: { id: 'two', type: 'message', role: 'assistant', summary: [], content: [{ type: 'output_text', text: 'Original' }] } })[0];
const terminal = ids.convert({ type: 'response.completed', response: { output: [{ ...done.item, id: 'three' }] } }).at(-1);
assert.equal(added.item.id, done.item.id); assert.equal(done.item.id, terminal.response.output[0].id);
assert(!('summary' in done.item));
checks.push('Buffered function prefixes are retained; gateway item IDs remain stable throughout a stream; empty reasoning-only fields do not leak into messages');

const chatStream = new ChatEvents(model), nativeStream = new NonGptEvents(adapter), translated = [];
const args = JSON.stringify({ input: raw });
const chunks = [
  { choices: [{ index: 0, delta: { reasoning_content: '  Thinking\n' } }] },
  { choices: [{ index: 0, delta: { reasoning_content: 'unchanged.  ', content: 'Commentary 中文' } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_stream', function: { arguments: args.slice(0, 6) } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: '', function: { name, arguments: args.slice(6) } }] }, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 19, completion_tokens: 11, total_tokens: 30, prompt_tokens_details: { cached_tokens: 7 }, completion_tokens_details: { reasoning_tokens: 5 } } }
];
for (const chunk of chunks) for (const event of chatStream.convert({ id: 'chat_fixture', created: 10, ...chunk })) translated.push(...nativeStream.convert(event));
for (const event of chatStream.finish()) translated.push(...nativeStream.convert(event));
const completed = translated.at(-1).response;
assert.equal(completed.output[0].summary[0].text, '  Thinking\nunchanged.  ');
assert.equal(completed.output[2].input, raw);
assert.equal(completed.output[2].call_id, 'call_stream');
assert.equal(completed.usage.input_tokens_details.cached_tokens, 7);
assert.equal(completed.usage.output_tokens_details.reasoning_tokens, 5);
const single = adapter.response(chatResponse({ id: 'chat_fixture', created: 10, usage: chunks.at(-1).usage,
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: 'Commentary 中文', reasoning_content: '  Thinking\nunchanged.  ', tool_calls: [{ id: 'call_stream', type: 'function', function: { name, arguments: args } }] } }] }, model));
assert.deepEqual(single, completed);
const sparseUsage = chatResponse({ id: 'sparse_usage', usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, completion_tokens_details: { text_tokens: 3 } }, choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] }, model).usage;
assert.deepEqual(sparseUsage, { input_tokens: 2, output_tokens: 3, total_tokens: 5 });
const limited = new ChatEvents(model);
limited.convert({ id: 'limited', choices: [{ delta: { content: 'Partial' }, finish_reason: 'length' }] });
assert.equal(limited.finish().at(-1).type, 'response.incomplete');
assert.throws(() => new ChatEvents(model).finish(), error => error.code === 'incomplete_upstream_response');
checks.push('Chat JSON and SSE produce identical native output, reasoning, calls and usage; length limits remain incomplete');

assert.equal(chatRequest({ model, service_tier: 'priority', input: [] }).service_tier, 'priority');
for (const tier of ['priority', 'default', null, undefined]) {
  const value = { id: 'chat_tier', created: 10,
    ...(tier !== undefined ? { service_tier: tier } : {}),
    choices: [{ index: 0, finish_reason: 'stop', message: { content: 'OK' } }] };
  const json = adapter.response(chatResponse(value, model));
  const stream = new ChatEvents(model), native = new NonGptEvents(adapter);
  const created = stream.convert({ ...value, choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] });
  assert.equal(Object.hasOwn(created[0].response, 'service_tier'), tier !== undefined);
  for (const event of created) native.convert(event);
  const result = stream.finish().flatMap(event => native.convert(event)).at(-1).response;
  assert.deepEqual(result, json);
  assert.equal(Object.hasOwn(result, 'service_tier'), tier !== undefined);
  assert.equal(result.service_tier, tier);
}
const lateTier = new ChatEvents(model);
const initialTier = lateTier.convert({ id: 'late_tier', service_tier: 'priority', choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] });
lateTier.convert({ id: 'late_tier', service_tier: 'default', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
assert.equal(lateTier.finish().at(-1).response.service_tier, 'default');
assert.equal(initialTier[0].response.service_tier, 'priority');
checks.push('Fast requests and actual upstream service tiers survive JSON, SSE and native restoration, including late fallback metadata; absent tiers are never invented');

const output = new ResponseOutput();
const first = { type: 'reasoning', id: 'rs_native', summary: [], encrypted_content: 'opaque' };
const second = { type: 'message', id: 'msg_native', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Native output' }] };
for (const [index, item] of [first, second].entries()) output.observe({ type: 'response.output_item.added', output_index: index, item });
output.observe({ type: 'response.output_item.done', output_index: 1, item: second });
assert.equal(output.finish([]).complete, false);
output.observe({ type: 'response.output_item.done', output_index: 0, item: first });
assert.deepEqual(output.finish([]), { complete: true, output: [first, second] });
assert.deepEqual(output.finish([first, second]).output, [first, second]);
const finalOnly = new ResponseOutput();
finalOnly.observe({ type: 'response.output_item.done', output_index: 0, item: first });
assert.deepEqual(finalOnly.finish([second]).output, [second]);
checks.push('Lite output collection preserves native item ordering, phase and encryption, deduplicates terminal output and detects unfinished items');
console.log(JSON.stringify({ passed: true, checks }, null, 2));
