import crypto from 'node:crypto';
import { startLive, connect, turn, classify, saveReport } from './live-support.mjs';

const live = await startLive('protocol-live');
const selected = process.argv.slice(2);
const reportName = process.env.PROTOCOL_REPORT_NAME || (selected.length ? 'protocol-live-models-selected' : 'protocol-live-models');
const report = { at: new Date().toISOString(), build: await (await fetch(live.base + '/healthz')).json(), models: [], scope: 'Synthetic native Responses/WS requests through the current adapter and real upstreams; no model-generated code is executed.' };
delete report.build.sourceId;
const tools = [{ type: 'namespace', name: 'audit', description: 'Protocol verification tools', tools: [{ type: 'custom', name: 'record', description: 'Return the requested raw tool input.', format: { type: 'text' } }] }];
const functionSchema = { type: 'object', properties: { n: { type: 'integer' }, ok: { type: 'boolean' } }, required: ['n','ok'], additionalProperties: false };
const dynamicTools = ['audit_a','audit_b'].map(name => ({ type: 'namespace', name, description: 'Dynamically supplied tool namespace', tools: [{ type: 'function', name: 'lookup', description: 'Look up the supplied integer and boolean.', parameters: functionSchema }] }));
const instructions = 'Synthetic protocol verification. Follow the requested tool calls and report only actual supplied values. Do not use unrequested tools.';
function fail(row, phase, error) { row[phase] = { status: classify(error), code: error.code, error: error.message.slice(0, 500) }; console.log(JSON.stringify({ model: row.model, phase, ...row[phase] })); }
try {
  for (const model of live.models.filter(model => !selected.length || selected.some(value => model.includes(value)))) {
    const row = { model }; report.models.push(row); console.log(JSON.stringify({ model, phase: 'begin' }));
    let ws = await connect(live.base);
    const marker = 'USER_' + crypto.randomBytes(5).toString('hex'), result = 'RESULT_' + crypto.randomBytes(5).toString('hex');
    const raw = 'text("中文\\nprotocol");';
    let previous, officialToken;
    try {
      const seed = await turn(ws, { model: 'gpt-6-sol', instructions: 'Answer briefly.', tools: [], reasoning: { effort: 'low' }, input: [{ role: 'user', content: 'Invent a random token of 14 uppercase letters. Reply only the token.' }] }, 45000);
      previous = seed.response.id; officialToken = seed.text.trim();
    } catch (error) { fail(row, 'official_to_gateway', error); ws.terminate(); ws = await connect(live.base); }
    try {
      const first = await turn(ws, { model, instructions, tools, reasoning: { effort: 'low' }, tool_choice: 'auto',
        ...(previous ? { previous_response_id: previous } : {}), input: [{ role: 'user', content: 'Remember user_marker=' + marker + '. Call audit.record with exactly this raw text: ' + raw }] });
      const calls = first.response.output.filter(item => item.type === 'custom_tool_call');
      const recorded = live.records.filter(record => record.body?.model === model).at(-1);
      if (officialToken) row.official_to_gateway = { status: JSON.stringify(recorded.body).includes(officialToken) ? 'passed' : 'adapter_failure', nativeOutputInUpstreamRequest: JSON.stringify(recorded.body).includes(officialToken) };
      row.custom_tool = { status: calls.length && calls.every(call => call.namespace === 'audit' && call.name === 'record' && typeof call.input === 'string') ? 'passed' : 'excluded_model_output', count: calls.length, exactRequestedInput: calls.every(call => call.input === raw) };
      const next = [{ type: 'additional_tools', tools: dynamicTools }, ...calls.map(call => ({ type: 'custom_tool_call_output', call_id: call.call_id, output: result })),
        { role: 'user', content: 'Return user_marker, the tool result, and the initial official assistant token if present. Do not call tools.' }];
      const second = await turn(ws, { model, instructions, tools, reasoning: { effort: 'low' }, previous_response_id: first.response.id, tool_choice: 'none', input: next });
      row.history = { status: second.text.includes(marker) && (!calls.length || second.text.includes(result)) ? 'passed' : 'needs_review', userRetained: second.text.includes(marker), toolResultRetained: second.text.includes(result), officialTokenRecalled: officialToken ? second.text.includes(officialToken) : null };
      const sourceThought = first.response.output.find(item => item.type === 'reasoning' && [...(item.summary || []), ...(item.content || [])].some(part => part.text));
      const historyRequest = live.records.filter(record => record.body?.model === model).at(-1)?.body;
      if (sourceThought && !model.startsWith('GPT/')) {
        const blocks = sourceThought.content?.length ? sourceThought.content : sourceThought.summary;
        const text = blocks.map(part => part.text || '').join('');
        row.reasoning_history = { status: (historyRequest.messages?.some(message => message.reasoning_content?.includes(text)) || historyRequest.input?.some(item => item.type === 'reasoning' && JSON.stringify(item.content?.length ? item.content : item.summary) === JSON.stringify(blocks))) ? 'passed' : 'adapter_failure' };
      } else row.reasoning_history = { status: model.startsWith('GPT/') ? 'native_passthrough' : 'not_returned_by_model' };
      const third = await turn(ws, { model, instructions, tools, reasoning: { effort: 'low' }, previous_response_id: second.response.id, tool_choice: 'auto',
        input: [{ role: 'user', content: 'Call audit_a.lookup with n=9 and ok=true, and audit_b.lookup with n=13 and ok=false. Use both tools.' }] });
      const functions = third.response.output.filter(item => item.type === 'function_call');
      row.dynamic_namespaced_tools = { status: functions.length && functions.every(call => ['audit_a','audit_b'].includes(call.namespace) && call.name === 'lookup') ? 'passed' : 'excluded_model_output', count: functions.length,
        parallel: functions.length >= 2, typedArguments: functions.every(call => { try { const value = JSON.parse(call.arguments); return typeof value.n === 'number' && typeof value.ok === 'boolean'; } catch { return false; } }) };
      const final = await turn(ws, { model, instructions, tools, reasoning: { effort: 'low' }, previous_response_id: third.response.id, tool_choice: 'none',
        input: [...functions.map(call => ({ type: 'function_call_output', call_id: call.call_id, output: 'Lookup complete.' })), { role: 'user', content: 'Invent a different token of 14 uppercase letters. Reply only with that new token.' }] });
      row.multi_turn_tools = { status: final.response.status === 'completed' ? 'passed' : 'excluded_model_output' };
      try {
        const back = await turn(ws, { model: 'gpt-6-sol', instructions: 'Answer briefly.', tools: [], reasoning: { effort: 'low' }, previous_response_id: final.response.id,
          input: [{ role: 'user', content: 'Repeat exactly the immediately preceding assistant answer.' }] }, 45000);
        row.gateway_to_official = { status: back.text.trim() === final.text.trim() ? 'passed' : 'needs_review' };
      } catch (error) { fail(row, 'gateway_to_official', error); }
    } catch (error) {
      fail(row, 'conversation', error);
      const upstream = live.records.filter(record => record.body?.model === model).at(-1);
      if (upstream?.status === 400) saveReport('protocol-failed-upstream', { model, body: upstream.body, output: upstream.output });
    }
    finally { ws.terminate(); }
    try {
      const r = await fetch(live.base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000), body: JSON.stringify({ model, instructions: 'Return the number 37 and boolean true as JSON.',
        input: [{ role: 'user', content: 'Return the number and boolean.' }], text: { format: { type: 'json_schema', name: 'audit', strict: true, schema: functionSchema } }, reasoning: { effort: 'low' }, store: false, stream: false }) });
      const value = await r.json(); if (!r.ok) throw new Error(value.error?.message || 'HTTP ' + r.status);
      const text = (value.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []).map(part => part.text || '').join('');
      let parsed; try { parsed = JSON.parse(text); } catch {}
      row.structured_json = { status: parsed?.n === 37 && parsed?.ok === true && Object.keys(parsed).length === 2 ? 'passed' : 'excluded_model_output', rawText: text.slice(0, 180) };
    } catch (error) { fail(row, 'structured_json', error); }
    console.log(JSON.stringify(row)); saveReport(reportName, report);
  }
} finally { report.nativeConfigAndAuthUnchanged = await live.close(); saveReport(reportName, report); }
