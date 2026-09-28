import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { NonGptAdapter, NonGptEvents } from '../src/non-gpt-compat.mjs';
import { normalizeOfficialHistory, normalizeGptHistory } from '../src/history-compat.mjs';
import { chatRequest, usesChat, ChatEvents } from '../src/chat-compat.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const models = ['GPT/gpt-5.6-terra','GPT/gpt-6-astra','GPT/gpt-6-luna','GPT/gpt-6-sol','vllm/qwen3.8-flash-next',
  '词元计划/deepseek-flash','词元计划/deepseek-flash-2','词元计划/glm-5.3-flash',
  '阿里云订阅/deepseek-v4-pro','阿里云订阅/deepseek-v4.1-flash','阿里云订阅/glm-5.2','阿里云订阅/glm-5.3','阿里云订阅/qwen3.8-flash','阿里云订阅/qwen3.8-max'];
const checks = [], carriers = [{ type: 'namespace', name: 'functions', tools: [
  { type: 'custom', name: 'exec', description: 'Raw source', format: { type: 'grammar', syntax: 'lark', definition: 'start: /[\\s\\S]+/' } },
  { type: 'custom', name: 'apply_patch', description: 'Raw patch', format: { type: 'text' } },
  { type: 'function', name: 'wait', parameters: { type: 'object', properties: { cell_id: { type: 'string' }, yield_time_ms: { type: 'number' }, terminate: { type: 'boolean' } }, required: ['cell_id'], additionalProperties: false } },
] }, ...['mcp_fixture','dynamic_fixture'].map(name => ({ type: 'namespace', name, tools: [{ type: 'function', name: 'lookup', strict: false,
  parameters: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'integer' }, enabled: { type: 'boolean' }, nested: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] } }, required: ['query','count','enabled','nested'] } }] }))];
const capture = path.join(root, 'data/diagnostics/native-tool-capture-result.json');
if (fs.existsSync(capture)) {
  const native = JSON.parse(fs.readFileSync(capture, 'utf8'));
  carriers.push(...native.requests[0].body.input.filter(i => i.type === 'additional_tools').flatMap(i => i.tools).filter(t => t.name !== 'functions'));
}
const flatten = (tools, namespace) => tools.flatMap(t => t.type === 'namespace' ? flatten(t.tools, [namespace,t.name].filter(Boolean).join('.')) : [{ ...t, namespace }]);
const definitions = flatten(carriers);
const image = 'data:image/png;base64,iVBORw0KGgo=';
const audio = 'data:audio/wav;base64,UklGRg==';
const multimodal = [{ type: 'input_text', text: '  中文\n<untrusted>same bytes</untrusted>  ' }, { type: 'input_image', image_url: image, detail: 'original' },
  { type: 'input_audio', audio_url: audio }, { type: 'input_file', filename: 'existing.txt', file_data: 'data:text/plain;base64,ZXhpc3Rpbmc=' }];
const tools = [{ type: 'additional_tools', id: 'at_fixture', role: 'developer', tools: carriers }];
for (const model of models) {
  for (const structured of model.startsWith('阿里云订阅/') ? [false,true] : [false]) {
    const original = { model, input: [...tools, { role: 'user', content: multimodal }], parallel_tool_calls: true,
      ...(structured ? { text: { format: { type: 'json_schema', name: 'fixture', strict: true, description: 'Existing schema', schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'], additionalProperties: false } } } } : {}) };
    const before = JSON.stringify(original);
    const adapter = new NonGptAdapter(original);
    const converted = model.startsWith('GPT/') ? normalizeGptHistory(original).payload : adapter.request();
    const wire = usesChat(original) ? chatRequest(converted) : converted;
    assert.equal(JSON.stringify(original), before);
    assert.equal(wire.parallel_tool_calls, true);
    const parts = wire.messages?.[0].content || wire.input.find(i => i.role === 'user').content;
    assert.equal(parts[0].text, multimodal[0].text);
    if (wire.messages) {
      assert.deepEqual(parts[1], { type: 'image_url', image_url: { url: image, detail: 'original' } });
      assert.deepEqual(parts[2], { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } });
      assert.equal(parts[3].file.file_data, multimodal[3].file_data);
    } else assert.deepEqual(parts, multimodal);
    if (!model.startsWith('GPT/')) {
      for (const definition of definitions) {
        const mapped = [...adapter.mapping].find(([, v]) => v.name === definition.name && v.namespace === definition.namespace);
        assert(mapped, 'Missing declaration for ' + definition.namespace + '.' + definition.name);
        const raw = definition.type === 'custom' ? '*** Begin Patch\n中文 `literal` $literal\n*** End Patch' : JSON.stringify({ query: '中文\\n', count: 3, enabled: false, nested: null });
        const args = definition.type === 'custom' ? JSON.stringify({ input: raw }) : raw;
        const item = adapter.item({ type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: mapped[0], arguments: args });
        assert.equal(item.name, definition.name); assert.equal(item.namespace, definition.namespace);
        assert.equal(definition.type === 'custom' ? item.input : item.arguments, raw);
        const history = new NonGptAdapter({ ...original, input: [...original.input, item, { type: definition.type === 'custom' ? 'custom_tool_call_output' : 'function_call_output', call_id: item.call_id, output: multimodal }] }).request();
        const roundTrip = usesChat(original) ? chatRequest(history) : history;
        const serialized = JSON.stringify(roundTrip);
        assert(serialized.includes('call_fixture')); assert(serialized.includes('UklGRg==')); assert(serialized.includes('ZXhpc3Rpbmc='));
      }
      for (const choice of ['auto','none','required', { type: 'custom', namespace: 'functions', name: 'exec' }, { type: 'allowed_tools', mode: 'required', tools: [{ type: 'custom', namespace: 'functions', name: 'exec' }] }]) {
        const r = new NonGptAdapter({ ...original, tool_choice: choice }).request();
        const actual = usesChat(original) ? chatRequest(r) : r;
        if (typeof choice === 'string') assert.equal(actual.tool_choice, choice);
        else if (choice.type === 'custom') assert(JSON.stringify(actual.tool_choice).includes('cx_functions_exec_'));
        else assert.equal(actual.tools.length, usesChat(original) ? 1 : r.tools.length);
      }
    }
    checks.push({ model, path: wire.messages ? 'chat' : 'responses', passed: true, toolDefinitions: definitions.length,
      features: ['text_unicode_and_whitespace','image_url_and_detail','audio_data','file_data_and_name','multimodal_tool_results','custom_grammar_and_raw_patch','MCP_and_dynamic_namespaces','function_arguments_and_schema','parallel_tool_setting','auto_none_required_named_allowed_tool_choice', ...(structured ? ['structured_output_schema'] : [])] });
  }
}
const nativeTypes = ['agent_message','local_shell_call','tool_search_call','tool_search_output','web_search_call','image_generation_call','compaction','configuration_update','compaction_trigger','context_compaction'];
for (const type of nativeTypes) {
  const body = { model: 'gpt-6-astra', input: [{ type, id: type === 'web_search_call' ? 'ws_native' : 'opaque_native', payload: { untouched: true } }, ...tools], tools: [{ type: 'web_search' }] };
  assert.equal(normalizeOfficialHistory(body).payload, body);
}
for (const type of ['response.created','response.in_progress','response.failed','error','response.incomplete','response.refusal.delta','response.web_search_call.completed','response.image_generation_call.partial_image','response.output_text.annotation.added']) {
  const event = { type, marker: 'UPSTREAM_UNCHANGED' };
  const adapter = new NonGptEvents(new NonGptAdapter({}));
  const actual = adapter.convert(event)[0]; assert.equal(actual.type, type); assert.equal(actual.marker, event.marker);
}
const refusals = new ChatEvents('fixture'); const converted = refusals.convert({ id: 'refusal', choices: [{ delta: { refusal: 'Original refusal' }, finish_reason: 'stop' }] });
converted.push(...refusals.finish()); assert.equal(converted.at(-1).response.output[0].content[0].refusal, 'Original refusal');
assert.throws(() => chatRequest({ input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'private_official_id' }] }] }), /original image data/);
assert.throws(() => chatRequest({ input: [{ role: 'user', content: [{ type: 'input_audio', audio_url: 'opaque_private_audio' }] }] }), /cannot be silently discarded/);
let switchPairs = 0;
for (const source of ['gpt-6-astra', ...models]) {
  const base = { model: source, input: [...tools], tools: [] };
  const sourceAdapter = new NonGptAdapter(base, { preserveReasoning: true }); sourceAdapter.request();
  const thought = source.startsWith('GPT/') || source === 'gpt-6-astra' ?
    { type: 'reasoning', id: 'rs_official', summary: [{ type: 'summary_text', text: 'SOURCE_ORIGINAL\n' }], encrypted_content: 'ORIGINAL_OPAQUE' } :
    sourceAdapter.item({ type: 'reasoning', id: 'vendor_thought', summary: [{ type: 'summary_text', text: 'SOURCE_ORIGINAL\n' }] });
  const input = [...tools, { role: 'user', content: 'FIRST_USER_ORIGINAL' }, thought,
    { type: 'custom_tool_call', id: 'ctc_original', name: 'exec', namespace: 'functions', call_id: 'call_original', input: 'text("EXACT_SOURCE\\n");' },
    { type: 'custom_tool_call_output', call_id: 'call_original', output: [{ type: 'input_text', text: 'EXACT_TOOL_RESULT' }] },
    { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'EXACT_ASSISTANT_TEXT' }] },
    { role: 'developer', content: '<model_switch>Existing native update</model_switch>' }];
  const snapshot = JSON.stringify(input);
  for (const target of ['gpt-6-astra', ...models]) {
    const request = { model: target, input };
    const normalized = target === 'gpt-6-astra' ? normalizeOfficialHistory(request).payload : target.startsWith('GPT/') ? normalizeGptHistory(request).payload : new NonGptAdapter(request,{preserveReasoning:true}).request();
    const wire = usesChat(request) ? chatRequest(normalized) : normalized;
    const actual = JSON.stringify(wire);
    for (const original of ['FIRST_USER_ORIGINAL','SOURCE_ORIGINAL','EXACT_TOOL_RESULT','EXACT_ASSISTANT_TEXT','call_original','<model_switch>Existing native update</model_switch>']) assert(actual.includes(original),source+' → '+target+' lost '+original);
    assert(!actual.includes('Earlier assistant reasoning'));
    assert.equal(JSON.stringify(input),snapshot);
    if(target===source&&!source.startsWith('GPT/')&&source!=='gpt-6-astra')assert(normalized.input.some(i=>i.id===thought.id&&i.type==='reasoning'));
    switchPairs++;
  }
}
const report = { at: new Date().toISOString(), passed: true, scope: 'Protocol conversion, no model capability claims', cases: checks,
  switchPairs, officialNativeTypesPreserved: nativeTypes, commonEventsAndRefusalPreserved: true, privateMediaReferencesFailExplicitly: true };
fs.mkdirSync(path.join(root,'data/diagnostics'),{recursive:true}); fs.writeFileSync(path.join(root,'data/diagnostics/feature-matrix-result.json'), JSON.stringify(report,null,2));
console.log(JSON.stringify({ passed: true, paths: checks.length, switchPairs, toolDefinitions: definitions.length, officialNativeTypesPreserved: nativeTypes, report: 'data/diagnostics/feature-matrix-result.json' }));
