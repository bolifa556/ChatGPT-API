import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeGptHistory, normalizeOfficialHistory, readableReasoning } from '../src/history-compat.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url));
const cases=[];
const original={model:'gpt-6-astra',input:[
 {type:'reasoning',id:'msg_foreign',summary:[{type:'summary_text',text:'Foreign summary'}]},
 {type:'reasoning',id:'rs_native',summary:[],encrypted_content:'native-opaque-fixture'},
 {type:'custom_tool_call',id:'msg_wrong',call_id:'call_link',name:'probe',input:'source'},
 {type:'custom_tool_call_output',id:'ctco_output',call_id:'call_link',output:'actual tool result'},
 {type:'item_reference',id:'msg_wrong'},
 {role:'user',content:'Continue'}]};
const before=JSON.stringify(original), r=normalizeGptHistory(original);
assert.equal(JSON.stringify(original),before);assert.equal(r.stats.foreignReasoningConverted,1);
assert.deepEqual(r.payload.input[0],{type:'reasoning',summary:[{type:'summary_text',text:'Foreign summary'}]});
assert.equal(r.payload.input[1],original.input[1]);assert.equal(r.payload.input[2].call_id,'call_link');
assert.equal(r.payload.input[3],original.input[3]);assert.equal(r.payload.input[4].id,'ctc_wrong');
assert.equal(normalizeGptHistory(r.payload).changed,false);
cases.push('Foreign reasoning becomes an ID-free summary with original text; native encrypted reasoning and tool links preserved; immutable and idempotent');
const clean={input:[{type:'message',id:'msg_native',role:'assistant',content:[]},{type:'reasoning',id:'rs_native',encrypted_content:'native'},original.input[3]]};
assert.equal(normalizeGptHistory(clean).payload,clean);cases.push('Valid native input object remains unchanged');
const dynamic={tools:[{type:'namespace',name:'tools',description:'Current',tools:[{type:'function',name:'new',parameters:{type:'object'}}]}],input:[{type:'additional_tools',tools:[{type:'namespace',name:'tools',description:'Earlier',tools:[{type:'function',name:'old',parameters:{type:'object'}}]}]},{role:'user',content:'Continue'}]};
const dynamicBefore=JSON.stringify(dynamic),normalized=normalizeGptHistory(dynamic);
assert.equal(JSON.stringify(dynamic),dynamicBefore);assert.equal(normalized.payload.input.length,1);
assert.equal(normalized.payload.tools[0].description,'Current');assert.deepEqual(normalized.payload.tools[0].tools.map(t=>t.name),['old','new']);
cases.push('Stateless GPT API requests receive a complete top-level tool catalog without changing saved history');
const native={...dynamic,input:[{...dynamic.input[0],id:'at_native',role:'developer'}, {type:'item_reference',id:'at_native'},...dynamic.input.slice(1)]};
assert.equal(normalizeOfficialHistory(native).payload,native);
assert.equal(normalizeOfficialHistory(native).changed,false);
cases.push('Official tool carriers, their references and top-level tools remain at their original positions');
assert.equal(normalizeOfficialHistory(dynamic).payload.input[0].role,'developer');
assert.equal(normalizeOfficialHistory(dynamic).payload.input[0].type,'additional_tools');
const blocks=[{type:'summary_text',text:'  repeat\n'},{type:'summary_text',text:'  repeat\n'},{type:'summary_text',text:''}];
for(const id of ['rs_gateway_vendor','msg_legacy','rs_01a0e39d-84b9-7c60-9a99-2723ab02c29e']) {
 const input={input:[{type:'reasoning',id,summary:blocks,content:[{type:'reasoning_text',text:' content\n'}]},{type:'item_reference',id}]};
 const before=JSON.stringify(input), result=normalizeOfficialHistory(input);
 assert.equal(JSON.stringify(input),before);assert.equal(result.payload.input.length,1);
 assert.deepEqual(result.payload.input[0],{type:'reasoning',summary:[...blocks,{type:'summary_text',text:' content\n'}]});
 assert.equal(normalizeOfficialHistory(result.payload).changed,false);
}
assert.equal(readableReasoning({summary:blocks}),'  repeat\n  repeat\n');
assert.throws(()=>normalizeOfficialHistory({input:[{type:'item_reference',id:'rs_gateway_missing'}]}),e=>e.code==='incomplete_foreign_history');
assert.throws(()=>normalizeOfficialHistory({input:[{type:'reasoning',id:'msg_legacy',content:[{type:'unknown'}]}]}),e=>e.code==='unsupported_reasoning_history');
cases.push('Legacy/vendor/local-UUID reasoning preserves duplicates, whitespace and block order; unsupported or missing content is never fabricated');
fs.mkdirSync(path.join(dir,'../data/diagnostics'),{recursive:true});
const report={passed:true,tests:cases};fs.writeFileSync(path.join(dir,'../data/diagnostics/history-compat-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
