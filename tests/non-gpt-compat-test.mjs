import assert from 'node:assert/strict';
import { NonGptAdapter, NonGptEvents } from '../src/non-gpt-compat.mjs';
import { normalizeGptHistory } from '../src/history-compat.mjs';
import { ssePackets } from '../src/sse.mjs';
import { Readable } from 'node:stream';
const sample={model:'future-vendor/new-model',tools:[{type:'namespace',name:'functions',tools:[
 {type:'custom',name:'exec',format:{type:'text'}},{type:'function',name:'wait',parameters:{type:'object'}}]}],
 reasoning:{effort:'ultra',context:'all_turns'},input:[
 {type:'reasoning',id:'rs_native',encrypted_content:'opaque'},
 {type:'additional_tools',id:'at_legacy',tools:[{type:'function',name:'other',parameters:{type:'object'}}]},
 {type:'custom_tool_call',id:'ctc_x',name:'exec',namespace:'functions',call_id:'c1',input:'text("中文");'},
 {type:'custom_tool_call_output',call_id:'c1',output:'中文'}],tool_choice:{type:'custom',name:'exec',namespace:'functions'}};
const snapshot=JSON.stringify(sample),adapter=new NonGptAdapter(sample),wire=adapter.request();
assert.equal(JSON.stringify(sample),snapshot);assert.equal(wire.reasoning.effort,'ultra');assert(!wire.reasoning.context);
assert.equal(wire.input.length,2);assert.equal(wire.input[0].call_id,wire.input[1].call_id);
assert.equal(JSON.parse(wire.input[0].arguments).input,'text("中文");');assert(wire.tools.every(t=>t.type==='function'));
const name=wire.tool_choice.name, stream=new NonGptEvents(adapter),raw='text("中文\\path");\nnext()', args=JSON.stringify({input:raw});
const item={type:'function_call',id:'msg_badtool',name,call_id:'c1',arguments:''};
const added=stream.convert({type:'response.output_item.added',output_index:0,item})[0];
assert.equal(added.item.type,'custom_tool_call');assert.equal(added.item.id,'ctc_badtool');
for(const delta of [args.slice(0,6),args.slice(6)])assert.deepEqual(stream.convert({type:'response.function_call_arguments.delta',output_index:0,item_id:item.id,delta}),[]);
const done=stream.convert({type:'response.function_call_arguments.done',output_index:0,item_id:item.id,arguments:args});
assert.equal(done[0].delta,raw);assert.equal(done[0].item_id,added.item.id);
const itemDone=stream.convert({type:'response.output_item.done',output_index:0,item})[0];assert.equal(itemDone.item.input,raw);
const completed=stream.convert({type:'response.completed',response:{output:[item]}})[0];assert.equal(completed.response.output[0].input,raw);
assert.equal(completed.response.output[0].id,added.item.id);
const thought=adapter.item({type:'reasoning',id:'msg_thought',summary:[]});assert.equal(thought.id,adapter.reasoningPrefix+'thought');
assert.equal(normalizeGptHistory({input:[thought]}).payload.input.length,0);
const readable={type:'reasoning',id:'rs_native',encrypted_content:'opaque',summary:[{type:'summary_text',text:'Keep test number 7395'}]};
const readableWire=new NonGptAdapter({input:[readable]}).request();assert(readableWire.input[0].content[0].text.includes('7395'));
assert(!JSON.stringify(readableWire).includes('opaque'));assert.equal(readable.encrypted_content,'opaque');
const foreignReadable=adapter.item({...readable,encrypted_content:undefined});
assert(normalizeGptHistory({input:[foreignReadable]}).payload.input[0].content[0].text.includes('7395'));
assert.throws(()=>adapter.raw('{"input":123}'),e=>e.code==='invalid_upstream_tool_arguments');
assert.throws(()=>new NonGptAdapter({input:[{type:'compaction',encrypted_content:'opaque'}]}).request(),/Restore readable context/);
const text='data: '+JSON.stringify({type:'response.output_text.delta',delta:'中文'})+'\r\n\r\ndata: [DONE]';
const packets=[];for await(const p of ssePackets(Readable.from([...Buffer.from(text)].map(x=>Buffer.from([x])))))packets.push(p);
assert.equal(packets[0].data.delta,'中文');assert(packets[1].done);
console.log(JSON.stringify({passed:true,checks:['immutable request; future model policy','custom/namespace/carrier/tool-choice conversion','GPT thinking filtered without changing effort','stream IDs and final output agree','foreign reasoning remains distinguishable after ID repair','malformed tool input not executed or rewritten','opaque compaction fails explicitly','split Unicode/CRLF/EOF SSE']},null,2));
