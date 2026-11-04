// Opt-in integration audit. Only synthetic data; never executes model output.
import crypto from 'node:crypto';
import { startLive, connect, turn, classify, saveReport } from './live-support.mjs';
import { imageOnlyModel } from '../src/image-compat.mjs';
const live = await startLive('protocol-319-audit');
const report = { at: new Date().toISOString(), models: [], scope: 'Real gateway protocol smoke tests; not a model-capability certification' };
const selected = process.argv.slice(2);
const models = live.models.filter(model => !imageOnlyModel({ id: model }) && (!selected.length || selected.some(value => model.includes(value))));
const tools = [{ type: 'namespace', name: 'audit', description: 'Synthetic protocol verification tools', tools: [{ type: 'custom', name: 'record', description: 'Record exactly the requested input.', format: { type: 'text' } }] }];
const schema = { type: 'json_schema', name: 'protocol_audit', strict: true, schema: { type: 'object', properties: { marker: { type: 'string' }, result: { type: 'string' } }, required: ['marker', 'result'], additionalProperties: false } };
function failure(error) {
  const message = error.message.slice(0, 450);
  return { status: /401|403|API.?key|unauthorized|forbidden|quota|额度|权限|authentication/i.test(message) || [401,403].includes(error.status) ? 'excluded_access_or_quota' : error.code === 'invalid_upstream_tool_arguments' ? 'excluded_model_output' : classify(error), code: error.code, error: message };
}
async function audit(model) {
  const row = { model }, marker = 'MARKER_' + crypto.randomBytes(4).toString('hex'), result = 'RESULT_' + crypto.randomBytes(4).toString('hex');
  report.models.push(row); let ws;
  console.log(JSON.stringify({ model, phase: 'begin' }));
  try {
    ws = await connect(live.base, { 'x-openai-internal-codex-responses-lite': 'true' });
    const first = await turn(ws, { model, instructions: 'Synthetic protocol verification. Use only the supplied tools and data.', tools, tool_choice: 'required', parallel_tool_calls: false, reasoning: { effort: 'low', context: 'all_turns' },
      input: [{ role: 'user', content: 'Remember marker ' + marker + '. Call audit.record with input exactly: ORIGINAL_TOOL_INPUT' }] }, 60000);
    const calls = first.response.output.filter(item => item.type === 'custom_tool_call');
    row.tool = { status: calls.length && calls.every(c => c.name === 'record' && c.namespace === 'audit' && typeof c.input === 'string') ? 'passed' : 'excluded_model_output', count: calls.length, exactRequestedInput: calls.every(c => c.input === 'ORIGINAL_TOOL_INPUT') };
    const updates = model.startsWith('GPT/') ? [] : [{ type: 'configuration_update', reasoning: { effort: 'low' }, text: { format: schema } }];
    const second = await turn(ws, { model, tools, tool_choice: 'none', parallel_tool_calls: false, reasoning: { effort: 'low', context: 'all_turns' }, ...(model.startsWith('GPT/') ? { text: { format: schema } } : {}), previous_response_id: first.response.id,
      input: [...calls.map(c => ({ type: 'custom_tool_call_output', call_id: c.call_id, output: result })), ...updates,
        { role: 'user', content: 'Return JSON with marker equal to the earlier marker and result equal to the tool result. No other fields.' }] }, 60000);
    let answer;try{answer=JSON.parse(second.text);}catch{}
    row.historyAndSchema = { status: answer?.marker === marker && answer?.result === result ? 'passed' : 'excluded_model_output', completed: second.response.status === 'completed' };
    if (row.historyAndSchema.status !== 'passed') row.historyAndSchema.textPreview = second.text.slice(0, 450);
    const record = live.records.filter(r => r.body?.model === model).at(-1);
    const sent = record?.body;
    if (row.historyAndSchema.status !== 'passed') {
      row.historyAndSchema.status = 'needs_review';
      row.historyAndSchema.upstreamPreview = record?.output?.slice(0, 1600);
      row.historyAndSchema.outputTypes = second.response.output.map(item => item.type);
      const packets = (record?.output || '').split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).flatMap(line => { try { return [JSON.parse(line.slice(6))]; } catch { return []; } });
      const deltas = packets.flatMap(p => (p.choices || []).map(c => c.delta || {}));
      const finalText = deltas.map(d => d.content || '').join('');
      const reasoningText = deltas.map(d => d.reasoning_content ?? d.reasoning ?? '').join('');
      if (!finalText && reasoningText && second.response.output.every(item => item.type === 'reasoning')) {
        const retained = second.response.output.flatMap(item => item.summary || []).map(part => part.text || '').join('');
        row.historyAndSchema.status = retained === reasoningText ? 'excluded_upstream_reasoning_only' : 'adapter_failure';
        row.historyAndSchema.reasoningPreservedExactly = retained === reasoningText;
      }
    }
    row.originalValuesOnWire = { user: JSON.stringify(sent).includes(marker), toolResult: JSON.stringify(sent).includes(result), schema: JSON.stringify(sent).includes('protocol_audit') };
    if (!Object.values(row.originalValuesOnWire).every(Boolean)) row.historyAndSchema.status = 'adapter_failure';
  } catch(error) { row.failure = failure(error); }
  finally { ws?.terminate(); console.log(JSON.stringify({ model, tool: row.tool, history: row.historyAndSchema?.status, failure: row.failure })); saveReport('protocol-319-live', report); }
}
try {
  let next = 0;
  await Promise.all(Array.from({length:Math.min(3,models.length)}, async () => { while(next < models.length) await audit(models[next++]); }));
} finally { report.nativeConfigAndAuthUnchanged = await live.close(); saveReport('protocol-319-live', report); }
