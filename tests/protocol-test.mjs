import assert from 'node:assert/strict';
import { ResponseOutput, portableReasoning, ResponsePhases, responseMessagePhases } from '../src/history-compat.mjs';
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
assert.deepEqual(switched.input.find(item => item.type === 'reasoning'), { type: 'reasoning', summary: thought.summary });
assert(new NonGptAdapter({ ...original, model }, { preserveReasoning: true }).request().input.some(item => item.type === 'reasoning'));
checks.push('Same-model reasoning is preserved exactly; cross-model compatibility remains distinct; immutable roles, native updates, tool schema, content and structured output map to Chat');

const oldTitles = { type: 'reasoning', id: 'rs_official', encrypted_content: 'source-private', summary: [
  { type: 'summary_text', text: '**Checking the latest skill root**' },
  { type: 'summary_text', text: '**Checking finalization signature**' }
] };
const history = { model: 'Qoder/qwen4-max', input: [
  { role: 'user', content: 'Earlier request' },
  { type: 'message', role: 'assistant', phase: 'final_answer', content: 'Earlier answer' },
  oldTitles, { type: 'message', role: 'assistant', phase: 'commentary', content: 'Reading the requested file' },
  { type: 'message', role: 'assistant', phase: 'final_answer', content: 'Finished' }
] };
const historyBefore = structuredClone(history);
for (const releaseOriginal of [false, true]) {
  const wire = new NonGptAdapter(history, { preserveReasoning: true }).request({ releaseOriginal });
  assert.deepEqual(wire.input[2], portableReasoning(oldTitles));
  const messages = chatRequest(wire).messages;
  assert.equal(messages[1].content, 'Earlier answer');
  assert.equal(messages[1].reasoning_content, undefined);
  assert.equal(messages[2].reasoning_content, oldTitles.summary.map(part => part.text).join('\n\n'));
  assert.equal(messages[2].content, 'Reading the requested file');
  assert.equal(messages[3].content, 'Finished');
  assert(!messages.some(message => String(message.content).includes('**Checking')));
  assert.deepEqual(history, historyBefore);
}
checks.push('Foreign reasoning retains its channel and separate summary blocks; Chat reasoning attaches to the following assistant message and consecutive replies retain their boundaries');

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
{
  const stream = new ChatEvents(model);
  const id = 'chat_tool_before_usage';
  stream.convert({ id, usage: { prompt_tokens: 12, prompt_tokens_details: { cached_tokens: 4 } }, choices: [
    { delta: { tool_calls: [{ index: 0, id: 'fixture-call', function: { name: 'fixture', arguments: '{' } }] } },
  ] });
  const confirmed = stream.convert({ id, end_turn: false, choices: [
    { delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] }, finish_reason: 'tool_calls' },
  ] });
  const done = confirmed.find(event => event.type === 'response.output_item.done');
  assert.equal(done.item.arguments, '{}');
  assert(!confirmed.some(event => event.type === 'response.completed'));
  assert.deepEqual(stream.convert({ id, usage: { completion_tokens: 3 }, choices: [] }), []);
  const finished = stream.finish();
  assert.deepEqual(finished.map(event => event.type), ['response.completed']);
  assert.deepEqual(finished[0].response.usage, { input_tokens: 12, output_tokens: 3, total_tokens: 15, input_tokens_details: { cached_tokens: 4 } });
  assert.equal(finished[0].response.end_turn, false);
  assert.deepEqual(finished[0].response.output, [done.item]);
}
checks.push('A confirmed tool-only Chat response sends the completed call before the usage trailer and merges split token counts once');

for (const reason of ['length', 'content_filter']) for (const partial of ['{"input":"unfinished', '{"input":', '']) {
  const incompleteChat = new ChatEvents(model), incompleteNative = new NonGptEvents(adapter), events = [];
  const value = { id: 'partial_' + reason, created: 10, model, choices: [{ index: 0, finish_reason: reason,
    message: { role: 'assistant', tool_calls: [{ id: 'call_partial', type: 'function', function: { name, arguments: partial } }] } }] };
  const json = adapter.response(chatResponse(value, model));
  for (const event of incompleteChat.convert({ ...value, choices: [{ index: 0, finish_reason: reason,
    delta: { tool_calls: [{ index: 0, ...value.choices[0].message.tool_calls[0] }] } }] })) events.push(...incompleteNative.convert(event));
  for (const event of incompleteChat.finish()) events.push(...incompleteNative.convert(event));
  incompleteNative.finish();
  assert.equal(events.at(-1).type, 'response.incomplete');
  assert.deepEqual(events.at(-1).response, json);
  assert.equal(json.output[0].type, 'function_call');
  assert.equal(json.output[0].arguments, partial);
  assert.equal(json.output[0].call_id, 'call_partial');
  assert.equal(json.output[0].status, 'incomplete');
  assert(!events.some(event => event.type === 'response.output_item.done'));
  assert.equal(new ResponseOutput().finish(json.output).complete, false);
}
checks.push('Truncated custom wrappers retain the exact unfinished function call and incomplete status in JSON/SSE without completing tool calls or reusable history');

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

const plainMessage = { id: 'msg_phase', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Original text', annotations: [] }] };
const appCall = { id: 'fc_phase', type: 'function_call', call_id: 'call_phase', name: 'sum', arguments: '{"a":1,"b":2}', status: 'completed' };
for (const tool of [false, true]) for (const lite of [false, true]) {
  const phases = new ResponsePhases(), results = [];
  results.push(...phases.convert({ type: 'response.output_item.added', sequence_number: 0, output_index: 0, item: { ...plainMessage, status: 'in_progress' } }));
  const delta = { type: 'response.output_text.delta', sequence_number: 1, output_index: 0, item_id: plainMessage.id, content_index: 0, delta: 'Original text' };
  assert.deepEqual(phases.convert(delta), [delta], 'Text waited for the final phase');
  assert.deepEqual(phases.convert({ type: 'response.output_item.done', sequence_number: 2, output_index: 0, item: plainMessage }), []);
  results.push(...phases.convert({ type: 'response.output_item.added', sequence_number: 3, output_index: 1, item: tool ? appCall : { type: 'reasoning', id: 'rs_late', summary: [] } }));
  const terminal = { id: 'resp_phase', status: 'completed', output: lite ? [] : tool ? [plainMessage, appCall] : [plainMessage] };
  results.push(...phases.convert({ type: 'response.completed', sequence_number: 4, response: terminal }));
  const done = results.find(event => event.type === 'response.output_item.done');
  assert.equal(done.item.phase, tool ? 'commentary' : 'final_answer');
  assert.deepEqual(done.item.content, plainMessage.content);
  const sequences = results.map(event => event.sequence_number);
  assert(sequences.every((value, index) => index === 0 || value > sequences[index - 1]));
  if (!lite) assert.equal(results.at(-1).response.output[0].phase, done.item.phase);
  assert.equal(Object.hasOwn(results.at(-1).response, 'usage'), false);
}
const nativePhases = { status: 'completed', output: [{ ...plainMessage, phase: 'commentary' }, appCall] };
assert.equal(responseMessagePhases(nativePhases), nativePhases);
assert.equal(new ResponsePhases().convert({ type: 'response.output_item.done', output_index: 0, item: nativePhases.output[0] })[0].item, nativePhases.output[0]);
const phaseFailure = new ResponsePhases();
phaseFailure.convert({ type: 'response.output_item.done', output_index: 0, item: plainMessage });
const failed = phaseFailure.convert({ type: 'error', error: { code: 'source_error', message: 'Original error' } });
assert.equal(failed[0].item.phase, 'commentary');
assert.equal(failed.at(-1).error.code, 'source_error');
const latePhase = new ResponsePhases();
latePhase.convert({ type: 'response.output_item.done', output_index: 0, item: plainMessage });
const declared = latePhase.convert({ type: 'response.completed', response: { status: 'completed', output: [{ ...plainMessage, phase: 'commentary' }] } });
assert.equal(declared[0].item.phase, 'commentary');
assert.equal(declared.at(-1).response.output[0].phase, 'commentary');
const ordered = new ResponsePhases();
ordered.convert({type:'response.output_item.done',output_index:0,item:plainMessage});
const nextMessage = ordered.convert({type:'response.output_item.added',output_index:1,item:{...plainMessage,id:'msg_next',phase:'final_answer'}});
assert.deepEqual(nextMessage.map(e=>[e.type,e.item.phase]),[['response.output_item.done','commentary'],['response.output_item.added','final_answer']]);
assert.equal(plainMessage.phase, undefined);
assert.equal(responseMessagePhases({ status: 'completed', output: [{ type: 'web_search_call' }, plainMessage] }).output[1].phase, 'final_answer');
assert.equal(chatResponse({ id: 'explicit_phase', choices: [{ finish_reason: 'stop', message: { phase: 'commentary', content: 'Original commentary' } }] }, model).output[0].phase, 'commentary');
checks.push('Missing gateway phases resolve from tool and stop events across JSON, SSE and Lite; text streams immediately, explicit phases and usage remain intact, and delayed done events retain monotonic sequence numbers');
{
  const phases = new ResponsePhases();
  const original = { ...plainMessage, phase: 'partial_answer' };
  phases.convert({ type: 'response.output_item.done', output_index: 0, item: original });
  const thought = { type: 'reasoning', id: 'rs_terminal', summary: [{ type: 'summary_text', text: 'Original thought' }] };
  const call = { type: 'function_call', id: 'fc_terminal', name: 'fixture', arguments: '{}', call_id: 'original-call', status: 'completed' };
  const raw = { type: 'response.completed', response: { status: 'completed', output: [original, thought, call], usage: { input_tokens: 5, output_tokens: 3 } } };
  const events = phases.convert(raw);
  assert.deepEqual(events.filter(event => event.type === 'response.output_item.done').map(event => event.item), [thought, call]);
  assert.deepEqual(events.at(-1).response.usage, { input_tokens: 5, output_tokens: 3, total_tokens: 8 });
  assert.equal(raw.response.usage.total_tokens, undefined);
  const incomplete = new ResponsePhases().convert({ type: 'response.incomplete', response: { status: 'incomplete', output: [plainMessage, call], usage: { input_tokens: 5 } } });
  assert.deepEqual(incomplete.filter(event => event.type === 'response.output_item.done').map(event => event.item.type), ['message']);
  assert.equal(Object.hasOwn(incomplete.at(-1).response, 'usage'), false);
}
checks.push('Terminal-only GPT output restores original messages, reasoning and completed tools without duplication; incomplete usage cannot invalidate the native response');
// Desktop consumers complete items from item events, including when a gateway
// sends text only in response.output. Never repeat a previously finished item.
for (const already of ['none','added','done']) {
  const format = new NonGptEvents(new NonGptAdapter({ model })), emitted = [];
  if (already !== 'none') emitted.push(...format.convert({ type: 'response.output_item.added', output_index: 0, item: { ...plainMessage, status: 'in_progress', content: [] } }));
  if (already === 'done') emitted.push(...format.convert({ type: 'response.output_item.done', output_index: 0, item: plainMessage }));
  emitted.push(...format.convert({ type: 'response.completed', response: { status: 'completed', output: [plainMessage] } }));
  assert.equal(emitted.filter(e => e.type === 'response.output_item.added').length, 1);
  const done = emitted.filter(e => e.type === 'response.output_item.done');
  assert.equal(done.length, 1); assert.deepEqual(done[0].item, plainMessage);
  assert.deepEqual(emitted.at(-1).response.output, [plainMessage]);
}
for (const partial of ['{"input":"unfinished', JSON.stringify({ input: 'complete-looking but truncated' })]) {
  const wire = new NonGptEvents(adapter), emitted = [];
  const tool = { type: 'function_call', id: 'fc_unfinished', call_id: 'c', name, status: 'incomplete', arguments: partial };
  for (const e of [
    { type:'response.output_item.added', output_index:0, item:{ ...tool, arguments:'', status:'in_progress' } },
    { type:'response.function_call_arguments.delta', output_index:0, item_id:tool.id, delta:partial },
    { type:'response.function_call_arguments.done', output_index:0, item_id:tool.id, arguments:partial },
    { type:'response.output_item.done', output_index:0, item:tool },
    { type:'response.incomplete', response:{ status:'incomplete', incomplete_details:{reason:'max_output_tokens'}, output:[tool] } },
  ]) emitted.push(...wire.convert(e));
  assert(!emitted.some(e=>['response.custom_tool_call_input.done','response.output_item.done'].includes(e.type)));
  assert.deepEqual(emitted.at(-1).response.output, [tool]);
  assert.equal(emitted.at(-1).response.incomplete_details.reason, 'max_output_tokens');
}
const blocks = new ChatEvents(model), visible = [];
for (const delta of [{ reasoning_content:'First thought' }, { content:'Progress' }, { reasoning_content:'Second thought' },
  { content:[{type:'text',text:'Answer '},{type:'text',text:'two'},{type:'refusal',refusal:'Unavailable'}] }]) {
  visible.push(...blocks.convert({id:'chat_blocks',choices:[{delta}]}));
}
blocks.convert({id:'chat_blocks',choices:[{delta:{},finish_reason:'stop'}]}); visible.push(...blocks.finish());
assert.deepEqual(visible.filter(e=>e.type==='response.output_item.done').map(e=>[e.item.type,e.item.phase]),
  [['reasoning',undefined],['message','commentary'],['reasoning',undefined],['message','final_answer']]);
const finalBlock = visible.at(-1).response.output.at(-1);
assert.deepEqual(finalBlock.content.map(p=>[p.type,p.text??p.refusal]),[['output_text','Answer '],['output_text','two'],['refusal','Unavailable']]);
assert.deepEqual(visible.filter(e=>e.type==='response.content_part.done'&&e.output_index===3).map(e=>e.content_index),[0,1,2]);
assert(visible.findIndex(e=>e.type==='response.output_item.done') < visible.findIndex(e=>e.item?.type==='message'));
checks.push('Terminal-only Responses text displays once; unfinished Responses tools never run; Chat text blocks, reasoning transitions and refusal events keep their original order');
console.log(JSON.stringify({ passed: true, checks }, null, 2));
