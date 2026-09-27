import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeGptHistory } from '../src/history-compat.mjs';
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
assert(r.payload.input[0].content[0].text.includes('Foreign summary'));
assert.equal(r.payload.input[1],original.input[1]);assert.equal(r.payload.input[2].call_id,'call_link');
assert.equal(r.payload.input[3],original.input[3]);assert.equal(r.payload.input[4].id,'ctc_wrong');
assert.equal(normalizeGptHistory(r.payload).changed,false);
cases.push('Readable foreign reasoning converted to assistant context; native encrypted reasoning and tool links preserved; immutable and idempotent');
const clean={input:[{type:'message',id:'msg_native',role:'assistant',content:[]},{type:'reasoning',id:'rs_native',encrypted_content:'native'},original.input[3]]};
assert.equal(normalizeGptHistory(clean).payload,clean);cases.push('Valid native input object remains unchanged');
fs.mkdirSync(path.join(dir,'../data/diagnostics'),{recursive:true});
const report={passed:true,tests:cases};fs.writeFileSync(path.join(dir,'../data/diagnostics/history-compat-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
