import { readRequestJson } from './http-fixture.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
const testsDir=path.dirname(fileURLToPath(import.meta.url));
const root=path.dirname(testsDir), fixture=path.join(root,'data','testing','router');
for(const sub of ['assets','data/state','data/cache','home'])fs.mkdirSync(path.join(fixture,sub),{recursive:true});
for(const file of ['model-template.json','reasoning-levels.json'])fs.copyFileSync(path.join(root,'assets',file),path.join(fixture,'assets',file));
const officialModel={...JSON.parse(fs.readFileSync(path.join(root,'assets/model-template.json'),'utf8')).models[0],slug:'gpt-6-sol',priority:1};
fs.writeFileSync(path.join(fixture,'home/models_cache.json'),JSON.stringify({models:[officialModel]}));
fs.writeFileSync(path.join(fixture,'home/auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'mock-official',account_id:'mock-account'}}));
const records=[], sockets=new Set(), servers=[], children=[], results=[];
let connects=0, gatewayOnline=true;
const listen=server=>new Promise(resolve=>{servers.push(server);server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s))});server.listen(0,'127.0.0.1',()=>resolve(server.address().port))});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const reply={id:'resp_mock',object:'response',status:'completed',model:'Other/test-model',output:[{id:'msg_mock',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'测试通过',annotations:[]}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
function responseEvents(body){
 const response={...reply,id:'resp_'+Math.random().toString(36).slice(2),model:body.model};
 const item=response.output[0], part=item.content[0];
 const events=[
  {type:'response.created',response:{...response,status:'in_progress',output:[]}},
  {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
  {type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{...part,text:''}},
  {type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:part.text},
  {type:'response.output_text.done',item_id:item.id,output_index:0,content_index:0,text:part.text},
  {type:'response.content_part.done',item_id:item.id,output_index:0,content_index:0,part},
  {type:'response.output_item.done',output_index:0,item},
  {type:'response.completed',response}
 ];
 return events.map((e,n)=>({...e,sequence_number:n,...(body.stream_id?{stream_id:body.stream_id}:{})}));
}
function peer(name){
 const server=http.createServer(async(req,res)=>{
  if(name==='official'&&req.url.startsWith('/backend-api/files/download/')){
   res.setHeader('content-type','application/json');res.end(JSON.stringify({download_url:'https://native-files.example.invalid/original-image.png'}));return;
  }
  if(req.url.startsWith('/models')||req.url.startsWith('/v1/models')||req.url.startsWith('/backend-api/codex/models')){
   if(name==='gateway'&&!gatewayOnline){res.writeHead(503);res.end('{}');return}
   res.setHeader('content-type','application/json');res.end(JSON.stringify(name==='official'?{models:[officialModel]}:{data:[{id:'GPT/gpt-6-sol'},{id:'Other/test-model'}]}));return;
  }
  const body=await readRequestJson(req);
  records.push({name,transport:'http',body,headers:req.headers});
  if(name==='gateway'&&('generate' in body||body.previous_response_id)){
   res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Stateless HTTP upstream rejects WS warmup/previous_response_id'}}));return;
  }
  if(body.stream){res.writeHead(200,{'content-type':'text/event-stream'});const stream=responseEvents(body).map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join('');const bytes=Buffer.from(stream);for(let n=0;n<bytes.length;n+=7)res.write(bytes.subarray(n,n+7));setTimeout(()=>res.end(),200)}
  else{res.setHeader('content-type','application/json');res.end(JSON.stringify(body.test_tool_output?{output:[{type:'function_call',id:'msg_jsoncall',call_id:'jsoncall',name:body.tools[0].name,arguments:JSON.stringify({input:'text("中文");'})}]}:{peer:name}))}
 });
 if(name==='official'){
  const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>setTimeout(()=>{if(socket.destroyed)return;wss.handleUpgrade(req,socket,head,ws=>{ws.on('message',data=>{const e=JSON.parse(data);records.push({name,transport:'ws',event:e,headers:req.headers});for(const event of responseEvents(e))ws.send(JSON.stringify(event))});ws.on('error',()=>{})})},150));
 }return server;
}
function run(args){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[path.join(root,'src/shim.mjs'),...args],{env:{...process.env,CODEX_HOME:path.join(fixture,'home'),CHATGPT_API_ROOT:fixture},windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(p);let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('exit',code=>code===0?resolve(out):reject(new Error(err||'exit '+code)))})}
async function request(base,model,extra={}){const r=await fetch(base+'/v1/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer mock-client-token','chatgpt-account-id':'client-account'},body:JSON.stringify({model,input:'hello',...extra}),signal:AbortSignal.timeout(5000)});return{status:r.status,body:await r.json()}}
function websocket(base,model,headers={},input='hello'){return new Promise((resolve,reject)=>{const ws=new WebSocket(base.replace('http:','ws:')+'/v1/responses',{headers});const events=[];const timer=setTimeout(()=>{ws.terminate();reject(new Error('WS timeout'))},5000);ws.on('open',()=>ws.send(JSON.stringify({type:'response.create',model,input,stream_id:'test'})));ws.on('error',reject);ws.on('message',data=>{const e=JSON.parse(data);events.push(e);if(e.type==='error'){clearTimeout(timer);ws.close();reject(new Error(e.message))}if(e.type==='response.completed'){clearTimeout(timer);ws.close();resolve(events)}})})}
try{
 const gatewayPort=await listen(peer('gateway')),officialPort=await listen(peer('official'));
 const proxy=http.createServer();proxy.on('connect',(req,client,head)=>{assert.equal(req.url,'127.0.0.1:'+officialPort);connects++;const upstream=net.connect(officialPort,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client)});sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy())});
 const proxyPort=await listen(proxy);const reserve=http.createServer(),port=await listen(reserve);await new Promise(r=>reserve.close(r));const base='http://127.0.0.1:'+port;
 fs.writeFileSync(path.join(fixture,'data/.env'),['BASE_URL=http://127.0.0.1:'+gatewayPort+'/v1','API_KEY=mock-gateway','SHIM_PORT='+port,'GATEWAY_TRANSPORT=direct','OFFICIAL_BASE=http://127.0.0.1:'+officialPort+'/backend-api/codex'].join('\n'));
 fs.writeFileSync(path.join(fixture,'data/state/route-state.json'),JSON.stringify({mode:'mixed',gatewayTransport:'direct',officialProxy:'http://127.0.0.1:'+proxyPort,clientVersion:'0.159.0'}));
 const prepared=JSON.parse(await run(['--prepare']));assert.equal(prepared.gateway.ready,true);assert.equal(prepared.official.ready,true);
 const menu=JSON.parse(fs.readFileSync(path.join(fixture,'data/cache/models-smr.json'),'utf8')).models;
 assert.deepEqual(menu.map(m=>m.slug),['gpt-6-sol','GPT/gpt-6-sol','Other/test-model']);
 assert(menu[1].priority>menu[0].priority&&menu[2].priority>menu[1].priority);
 assert.deepEqual(menu[2].supported_reasoning_levels,officialModel.supported_reasoning_levels);assert(menu[2].supported_reasoning_levels.some(x=>x.effort==='ultra'));
 results.push('Official models stay above name-sorted gateway models; reasoning levels match official GPT including Ultra');
 const before=fs.statSync(path.join(fixture,'data/cache/models-smr.json')).mtimeMs;await run(['--prepare']);assert.equal(fs.statSync(path.join(fixture,'data/cache/models-smr.json')).mtimeMs,before);results.push('Unchanged catalogs are reused; authenticated refresh succeeds');
 const p=spawn(process.execPath,[path.join(root,'src/shim.mjs')],{env:{...process.env,CODEX_HOME:path.join(fixture,'home'),CHATGPT_API_ROOT:fixture},windowsHide:true,stdio:['ignore','ignore','pipe']});children.push(p);let err='';p.stderr.on('data',d=>err+=d);
 let ready=false;for(let i=0;i<60;i++){try{const h=await(await fetch(base+'/healthz')).json();if(h.service==='chatgpt-api-router'){ready=true;break}}catch{}await delay(50)}assert(ready,err);
 let r=await request(base,'gpt-6-sol');assert.equal(r.body.peer,'official');assert.equal(records.at(-1).headers.authorization,'Bearer mock-client-token');assert(connects>0);results.push('Official HTTP uses local proxy and refreshed client credentials');
 r=await request(base,'Other/test-model');assert.equal(r.body.peer,'gateway');assert.equal(records.at(-1).headers.authorization,'Bearer mock-gateway');assert.equal(records.at(-1).headers['chatgpt-account-id'],undefined);results.push('Gateway HTTP uses configured URL/key and removes account headers');
 r=await request(base,'Other/test-model',{test_tool_output:true,tools:[{type:'custom',name:'exec',format:{type:'text'}}]});assert.equal(r.body.output[0].type,'custom_tool_call');assert.equal(r.body.output[0].name,'exec');assert.equal(r.body.output[0].input,'text("中文");');assert.equal(r.body.output[0].id,'ctc_jsoncall');results.push('Non-stream JSON tool responses restored to native desktop format');
 const count=records.length;r=await request(base,'gpt-unknown');assert.equal(r.status,400);assert.equal(records.length,count);results.push('Unknown models are rejected without forwarding');
 const compactCount=records.length;
 r=await request(base,'Other/test-model',{input:[{type:'compaction_trigger'}]});assert.equal(r.status,400);assert.equal(r.body.error.code,'incompatible_compaction_provider');
 await assert.rejects(websocket(base,'Other/test-model',{},[{type:'compaction_trigger'}]),/native text-compaction provider repair/);
 assert.equal(records.length,compactCount);
 await request(base,'gpt-6-sol',{input:[{type:'compaction_trigger'}]});assert.deepEqual(records.at(-1).body.input,[{type:'compaction_trigger'}]);
 results.push('Non-GPT remote compaction controls fail before upstream forwarding over HTTP and WS; official controls pass unchanged');
 for(const model of ['GPT/gpt-6-sol','Other/test-model']){
  await request(base,model,{input:[{role:'user',content:[{type:'input_image',file_id:'file_native_fixture',detail:'high'}]}]});
  assert.deepEqual(records.at(-1).body.input[0].content[0],{type:'input_image',image_url:'https://native-files.example.invalid/original-image.png',detail:'high'});
 }
 results.push('Native image file IDs resolve through the native read-only file service before API forwarding; original detail is preserved');
 const oldConnects=connects;await websocket(base,'gpt-6-sol',{authorization:'Bearer mock-gateway'});assert(connects>oldConnects);const wsRecord=records.find(x=>x.transport==='ws');assert.equal(wsRecord.event.model,'gpt-6-sol');assert.equal(wsRecord.headers.authorization,'Bearer mock-official');results.push('First WebSocket frame retained; official uses proxy; legacy provider uses local OAuth');
 const events=await websocket(base,'Other/test-model',{authorization:'Bearer mock-client-token','chatgpt-account-id':'client-account'});assert(events.some(e=>e.delta==='测试通过'));assert.equal(records.at(-1).headers['chatgpt-account-id'],undefined);results.push('Gateway WebSocket bridged to HTTP SSE, including Unicode and stream IDs');
 const foreignHistory=[{type:'reasoning',id:'msg_thinking',summary:[]},{type:'custom_tool_call',id:'msg_tool',call_id:'call_original',name:'probe',input:'hello'},{type:'custom_tool_call_output',id:'ctco_original',call_id:'call_original',output:'ok'},{type:'web_search_call',id:'msg_search',status:'completed',action:{type:'search',query:'fixture'}},{role:'user',content:'Continue'}];
 const expected=foreignHistory.slice(1).map(x=>({...x,...(x.id==='msg_tool'?{id:'ctc_tool'}:x.id==='msg_search'?{id:'ws_search'}:{})}));
 await request(base,'gpt-6-sol',{input:foreignHistory});assert.deepEqual(records.at(-1).body.input,expected);
 await websocket(base,'gpt-6-sol',{},foreignHistory);assert.deepEqual(records.at(-1).event.input,expected);
 await request(base,'GPT/gpt-6-sol',{input:foreignHistory});assert.deepEqual(records.at(-1).body.input,expected);
 await websocket(base,'GPT/gpt-6-sol',{},foreignHistory);assert.deepEqual(records.at(-1).body.input,expected);
 await request(base,'Other/test-model',{input:foreignHistory});const nonGptInput=records.at(-1).body.input;
 assert(!nonGptInput.some(x=>x.type==='reasoning'));assert.equal(nonGptInput[0].type,'function_call');assert.equal(nonGptInput[0].call_id,'call_original');assert.equal(nonGptInput[1].type,'function_call_output');
 results.push('Cross-provider history adapted for GPT and non-GPT over HTTP/WS; call IDs/results retained');
 await new Promise((resolve,reject)=>{
  const ws=new WebSocket(base.replace('http:','ws:')+'/v1/responses');let step=0;
  const models=['gpt-6-sol','Other/test-model','gpt-6-sol','GPT/gpt-6-sol'];
  const timer=setTimeout(()=>{ws.terminate();reject(Error('Cross-route WS timeout'))},8000);
  ws.on('error',reject);ws.on('open',()=>ws.send(JSON.stringify({type:'response.create',model:models[0],input:[{role:'user',content:'Retain CROSS_ROUTE_739'}]})));
  ws.on('message',data=>{try{const e=JSON.parse(data);if(e.type==='error')throw Error(e.message);if(e.type!=='response.completed')return;
   if(step){const rec=records.at(-1),body=rec.body||rec.event;assert(!body.previous_response_id);assert(body.input.some(x=>x.content==='Retain CROSS_ROUTE_739'));}
   step++;if(step===models.length){clearTimeout(timer);ws.close();resolve();return}
   ws.send(JSON.stringify({type:'response.create',model:models[step],previous_response_id:e.response.id,input:[{role:'user',content:'Continue '+step}]}));
  }catch(e){clearTimeout(timer);ws.terminate();reject(e)}});
 });results.push('WS official → non-GPT → official → gateway GPT keeps canonical history and does not send foreign previous_response_id');
 gatewayOnline=false;const h=await fetch(base+'/readyz');assert.equal(h.status,503);assert.equal((await h.json()).gateway.ready,false);results.push('Readiness detects gateway failure');
 const fallback=JSON.parse(await run(['--prepare']));assert.equal(fallback.status,'degraded');results.push('Temporary outage reuses a recent cache with a degraded status');
 const stale=JSON.parse(fs.readFileSync(path.join(fixture,'data/cache/catalog-state.json'),'utf8'));stale.gatewayAt='2000-01-01T00:00:00Z';fs.writeFileSync(path.join(fixture,'data/cache/catalog-state.json'),JSON.stringify(stale));
 const sourceCache=JSON.parse(fs.readFileSync(path.join(fixture,'data/cache/gateway-sources.json'),'utf8'));for(const source of sourceCache.sources)source.checkedAt='2000-01-01T00:00:00Z';fs.writeFileSync(path.join(fixture,'data/cache/gateway-sources.json'),JSON.stringify(sourceCache));
 const officialOnly=JSON.parse(await run(['--prepare']));assert.equal(officialOnly.gatewayModels,0);assert.equal(officialOnly.officialModels,1);
 const fallbackMenu=JSON.parse(fs.readFileSync(path.join(fixture,'data/cache/models-smr.json'),'utf8')).models;assert.deepEqual(fallbackMenu.map(m=>m.slug),['gpt-6-sol']);
 results.push('Unavailable gateway with stale cache cannot block the official channel or advertise stale API models');
 gatewayOnline=true;fs.writeFileSync(path.join(fixture,'data/state/route-state.json'),JSON.stringify({mode:'gateway',gatewayTransport:'direct',officialProxy:''}));fs.unlinkSync(path.join(fixture,'home/auth.json'));fs.unlinkSync(path.join(fixture,'home/models_cache.json'));
 const apiOnly=JSON.parse(await run(['--prepare']));assert.equal(apiOnly.official.enabled,false);
 const onlyModels=JSON.parse(fs.readFileSync(path.join(fixture,'data/cache/models-smr.json'),'utf8')).models;assert.deepEqual(onlyModels.map(m=>m.slug),['GPT/gpt-6-sol','Other/test-model']);assert.equal(onlyModels[1].use_responses_lite,false);assert(onlyModels[1].supported_reasoning_levels.some(x=>x.effort==='ultra'));results.push('Fresh no-login catalog uses packaged templates including Ultra, contains only gateway models and disables non-GPT lite');
 gatewayOnline=false;fs.writeFileSync(path.join(fixture,'data/.env'),fs.readFileSync(path.join(fixture,'data/.env'),'utf8').replace('API_KEY=mock-gateway','API_KEY=changed-key'));
 await assert.rejects(run(['--prepare']),/no current cache/);results.push('Changing the key cannot reuse another gateway cache');
 fs.mkdirSync(path.join(root,'data/diagnostics'),{recursive:true});
 const report={passed:true,tests:results};fs.writeFileSync(path.join(root,'data/diagnostics/router-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{for(const child of children)if(child.exitCode===null)child.kill();for(const s of sockets)s.destroy();for(const server of servers){server.close();server.closeAllConnections?.()}}
