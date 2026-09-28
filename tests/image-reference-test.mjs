// Native file IDs belong to ChatGPT; API vendors need the original download URL.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = fs.mkdtempSync(path.join(root, 'data/testing/image-reference-'));
const records = [], downloads = [], children = [], sockets = new Set(), servers = [], checks = [];
const models = ['GPT/gpt-6-sol', '阿里云订阅/glm-5.3', '词元计划/glm-5.3-flash'];
const officialModel = { ...JSON.parse(fs.readFileSync(path.join(root,'assets/model-template.json'),'utf8')).models[0], slug:'gpt-6-sol' };
const link = 'https://native-files.example.invalid/original-image.png';
const imageInput = id => [{ role:'user', content:[{type:'input_image',file_id:id,detail:'high'}] }];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for(let n=0;n<150;n++){if(await predicate())return;await delay(20)}throw Error('Condition timed out'); }
function respond(res, value, status=200) { res.writeHead(status, {'content-type':'application/json'});res.end(JSON.stringify(value)); }
async function listen(server) {
  servers.push(server);server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s))});
  server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;
}
function events(model) {
  const response={id:'resp_image_'+Math.random().toString(36).slice(2),object:'response',model,status:'completed',output:[]};
  return [{type:'response.created',response:{...response,status:'in_progress'}},{type:'response.completed',response}];
}
function child(args) {
  const p=spawn(process.execPath,[path.join(root,'src/shim.mjs'),...args],{env:{...process.env,CHATGPT_API_ROOT:fixture,CODEX_HOME:path.join(fixture,'home')},windowsHide:true,stdio:['ignore','ignore','pipe']});
  children.push(p);p.errorText='';p.stderr.on('data',b=>p.errorText+=b);return p;
}
async function wsClient(base) {
  const ws=new WebSocket(base.replace('http:','ws:')+'/v1/responses',{headers:{authorization:'Bearer native-fixture'}});
  const queue=[];ws.on('message',b=>queue.push(JSON.parse(b)));ws.on('error',()=>{});await once(ws,'open');
  return {ws,queue,send:body=>ws.send(JSON.stringify(body)),async next(type){await until(()=>queue.some(e=>e.type===type));return queue.splice(queue.findIndex(e=>e.type===type),1)[0];}};
}
try {
  for(const name of ['assets','home','data/cache','data/state'])fs.mkdirSync(path.join(fixture,name),{recursive:true});
  for(const name of ['model-template.json','reasoning-levels.json'])fs.copyFileSync(path.join(root,'assets',name),path.join(fixture,'assets',name));
  fs.writeFileSync(path.join(fixture,'home/auth.json'),JSON.stringify({tokens:{access_token:'native-fixture',account_id:'fixture'}}));
  fs.writeFileSync(path.join(fixture,'home/models_cache.json'),JSON.stringify({models:[officialModel]}));
  const official=http.createServer(async(req,res)=>{
    if(req.url.startsWith('/backend-api/codex/models'))return respond(res,{models:[officialModel]});
    if(req.url.startsWith('/backend-api/files/download/')){
      const record={id:decodeURIComponent(req.url.split('/').at(-1)),closed:false,auth:req.headers.authorization};downloads.push(record);
      res.on('close',()=>record.closed=true);
      if(record.id.startsWith('slow_'))return;
      if(record.id==='file_no_link')return respond(res,{status:'unavailable'});
      return respond(res,{status:'success',download_url:link});
    }
    let text='';for await(const b of req)text+=b;const body=JSON.parse(text);records.push({target:'official',body});respond(res,{output:[]});
  });
  const wss=new WebSocketServer({noServer:true});
  official.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>{
    ws.on('error',()=>{});ws.on('message',raw=>{const body=JSON.parse(raw);records.push({target:'official',body});for(const e of events(body.model))ws.send(JSON.stringify(e));});
  }));
  const officialBase=await listen(official);
  const gatewayBase=await listen(http.createServer(async(req,res)=>{
    if(req.url==='/v1/models')return respond(res,{data:models.map(id=>({id}))});
    let text='';for await(const b of req)text+=b;const body=JSON.parse(text);records.push({target:'gateway',body});
    const chat=req.url.includes('/chat/completions');
    if(!body.stream)return respond(res,chat?{id:'chat_fixture',choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}]}:{id:'resp_fixture',output:[]});
    res.writeHead(200,{'content-type':'text/event-stream'});
    if(chat){res.write('data: '+JSON.stringify({id:'chat_fixture',choices:[{delta:{role:'assistant',content:'ok'},finish_reason:'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');}
    else{for(const e of events(body.model))res.write('data: '+JSON.stringify(e)+'\n\n');res.end();}
  }));
  const reserve=http.createServer();const base=await listen(reserve);await new Promise(resolve=>reserve.close(resolve));
  fs.writeFileSync(path.join(fixture,'data/.env'),['BASE_URL='+gatewayBase+'/v1','API_KEY=gateway-fixture','SHIM_PORT='+new URL(base).port,'OFFICIAL_BASE='+officialBase+'/backend-api/codex'].join('\n'));
  fs.writeFileSync(path.join(fixture,'data/state/route-state.json'),JSON.stringify({mode:'mixed',gatewayTransport:'direct',officialProxy:''}));
  const prepare=child(['--prepare']);assert.equal((await once(prepare,'exit'))[0],0,prepare.errorText);
  const router=child([]);await until(async()=>{if(router.exitCode!==null)throw Error(router.errorText);try{return (await fetch(base+'/healthz')).ok;}catch{return false;}});
  async function post(model,input,signal) {
    const response=await fetch(base+'/v1/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer native-fixture'},body:JSON.stringify({model,input}),signal:signal||AbortSignal.timeout(5000)});
    return {status:response.status,body:await response.json()};
  }
  const original=imageInput('file_native');
  const before=JSON.stringify(original);
  await post('gpt-6-sol',original);assert.deepEqual(records.at(-1).body.input,original);assert.equal(downloads.length,0);
  checks.push('Official image requests retain file IDs and do not invoke the file resolver');
  for(const model of models){
    for(const transport of ['http','ws']){
      const start=downloads.length;
      // Duplicate references fetch once per outgoing request, without a persistent URL cache.
      const input=[...original,{type:'function_call_output',call_id:'existing',output:original[0].content}];
      if(transport==='http')assert.equal((await post(model,input)).status,200);
      else{const c=await wsClient(base);c.send({type:'response.create',model,input});await c.next('response.completed');c.ws.close();}
      const body=records.at(-1).body;
      assert(!JSON.stringify(body).includes('file_native'));assert(JSON.stringify(body).includes(link));assert(JSON.stringify(body).includes('high'));
      assert.equal(downloads.length,start+1);assert.equal(downloads.at(-1).auth,'Bearer native-fixture');
      assert.equal(JSON.stringify(original),before);
      checks.push(model+' '+transport+': message and tool-result image references preserve URL/detail and deduplicate link reads');
    }
    const c=await wsClient(base);c.send({type:'response.create',model,input:original});const done=await c.next('response.completed');
    c.send({type:'response.create',model:'gpt-6-sol',previous_response_id:done.response.id,input:[{role:'user',content:'Continue'}]});await c.next('response.completed');
    assert.deepEqual(records.at(-1).body.input[0],original[0]);assert(!JSON.stringify(records.at(-1).body).includes(link));c.ws.close();
  }
  checks.push('Gateway → official continuation restores original file IDs from canonical history for all three protocol routes');
  const noLinkCount=records.length;const unavailable=await post(models[2],imageInput('file_no_link'));
  assert.equal(unavailable.status,502);assert.equal(unavailable.body.error.code,'image_reference_unavailable');assert.equal(records.length,noLinkCount);
  checks.push('Missing download URL fails explicitly before model dispatch');
  const controller=new AbortController(),httpCount=records.length;
  const waiting=post(models[1],imageInput('slow_http'),controller.signal).catch(e=>e);
  await until(()=>downloads.some(d=>d.id==='slow_http'));controller.abort();assert((await waiting) instanceof Error);
  await until(()=>downloads.find(d=>d.id==='slow_http').closed);assert.equal(records.length,httpCount);
  checks.push('HTTP disconnect cancels file resolution without dispatching a model request');
  const c=await wsClient(base),wsCount=records.length;
  c.send({type:'response.create',model:models[2],stream_id:'lane',input:imageInput('slow_ws')});
  await until(()=>downloads.some(d=>d.id==='slow_ws'));
  c.send({type:'response.create',model:models[2],stream_id:'lane',input:original});assert.equal((await c.next('error')).status,409);
  c.send({type:'response.cancel',stream_id:'lane'});await c.next('error');await until(()=>downloads.find(d=>d.id==='slow_ws').closed);
  assert.equal(records.length,wsCount);
  c.send({type:'response.create',model:models[2],stream_id:'lane',input:original});await c.next('response.completed');c.ws.close();
  checks.push('WS reserves the stream during resolution, cancels the file request, and releases the stream for continuation');
  const report={at:new Date().toISOString(),passed:true,checks};
  fs.writeFileSync(path.join(root,'data/diagnostics/image-reference-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {
  for(const p of children)if(p.exitCode===null)p.kill();
  for(const socket of sockets)socket.destroy();
  for(const server of servers){server.close();server.closeAllConnections?.();}
}
