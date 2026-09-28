import fs from 'node:fs';
import path from 'node:path';
import { startLive, connect, turn, classify, saveReport, root } from './live-support.mjs';
const live = await startLive('official-native-tools');
const selected = process.argv.slice(2);
const models = JSON.parse(fs.readFileSync(path.join(root,'data/cache/catalog-state.json'),'utf8')).official.map(m => m.slug).filter(m => !selected.length || selected.includes(m));
const report = { at: new Date().toISOString(), scope: 'Real official models through the changed compatibility router; tools only return inert synthetic values', models: [] };
const definition = { type: 'function', name: 'audit_marker', description: 'Return an inert diagnostic marker.', parameters: { type: 'object', properties: { step: { type: 'integer' } }, required: ['step'], additionalProperties: false }, strict: true };
try {
  for (const model of models) {
    const row = { model }; report.models.push(row); let ws;
    try {
      ws = await connect(live.base);
      const common = { model, stream: true, store: false, reasoning: { effort: 'low' }, tool_choice: 'auto' };
      const warm = await turn(ws, { ...common, generate: false, input: [{ type: 'additional_tools', id: 'at_audit_marker', role: 'developer', tools: [definition] }] }, 25000);
      let previous = warm.response.id;
      for (const step of [1,2,3]) {
        const callInput = step === 1 ? [] : [{ type: 'function_call_output', call_id: row.lastCallId, output: 'AUDIT_RESULT_' + (step - 1) }];
        const response = await turn(ws, { ...common, previous_response_id: previous, input: [...callInput, { role: 'user', content: 'Call audit_marker with step=' + step + '. No prose.' }] }, 45000);
        const call = response.response.output.find(i => i.type === 'function_call' && i.name === 'audit_marker');
        if (!call) { row.status = 'excluded_model_output'; row.failedStep = step; row.text = response.text.slice(0,200); break; }
        if (JSON.parse(call.arguments).step !== step) { row.status = 'excluded_model_output'; row.failedStep = step; break; }
        row.lastCallId = call.call_id; row.calls = step; previous = response.response.id;
      }
      if (row.calls === 3) row.status = 'passed';
    } catch (error) { row.status = classify(error); row.error = error.message.slice(0,500); }
    finally { ws?.terminate(); delete row.lastCallId; console.log(JSON.stringify(row)); saveReport('official-client-live-2026-09-28', report); }
  }
} finally { report.nativeConfigAndAuthUnchanged = await live.close(); saveReport('official-client-live-2026-09-28', report); }
