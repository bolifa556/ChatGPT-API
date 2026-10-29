import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { RESPONSE_TIMEOUTS, protocolError } from '../src/transport.mjs';
import { NonGptAdapter } from '../src/non-gpt-compat.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture=fs.mkdtempSync(path.join(root,'data/testing/adapter-optimization-'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const waitMs=Number(process.env.ADAPTER_LONG_WAIT_MS||250);
const deadlineMs=waitMs+12000;
const checks=[],records=[],sockets=new Set(),timers=new Set(),clients=[];
const models=['GPT/gpt-6-sol','Other/model','词元计划/model'];
const native={...JSON.parse(fs.readFileSync(path.join(root,'assets/model-template.json'))).models[0],slug:'gpt-6-sol'};
const upstreamError={type:'upstream_original_type',code:'original_code',param:'original_parameter',message:'Original upstream error',details:{unchanged:true}};
function later(fn,ms){const t=setTimeout(()=>{timers.delete(t);fn();},ms);timers.add(t);return t;}
const peer=http.createServer(async(req,res)=>{
  try {
    if(req.url.includes('/models')){res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.startsWith('/official')?{models:[native]}:{data:models.map(id=>({id}))}));return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const wire=Buffer.concat(chunks);
    const decoder={zstd:zlib.zstdDecompressSync,gzip:zlib.gunzipSync,br:zlib.brotliDecompressSync,deflate:zlib.inflateSync}[req.headers['content-encoding']];
    const raw=decoder?decoder(wire):wire,body=JSON.parse(raw);
    const record={body,raw,wireBytes:wire.length,encoding:req.headers['content-encoding'],closed:false};records.push(record);
    res.on('close',()=>{record.closed=true;});
    if(body.testWrongContentType){res.writeHead(200,{'content-type':'application/json'});res.write('{');return;}
    if(body.testFailure){res.writeHead(429,{'content-type':'application/json','x-request-id':'original-id'});res.end(JSON.stringify({error:upstreamError}));return;}
    if(body.testWaitForever)return;
    const respond=()=>{
      if(res.destroyed)return;
      if(req.url.includes('/images/')){res.setHeader('content-type','application/json');res.end(JSON.stringify({created:1,data:[{b64_json:'aW5lcnQ='}]}));return;}
      const output=[{type:'message',role:'assistant',id:'msg_fixture',status:'completed',content:[{type:'output_text',text:'Original result',annotations:[]}]}];
      let stream;
      if(req.url.endsWith('/chat/completions')){
        const base={id:'chat_fixture',model:body.model,created:1};
        stream=[{...base,choices:[{index:0,delta:{content:'Original result'}}]},
          {...base,choices:[{index:0,delta:{},finish_reason:'stop'}]},
          {...base,choices:[],usage:{prompt_tokens:12,completion_tokens:3,total_tokens:15}}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n';
      }else stream='data: '+JSON.stringify({type:'response.completed',response:{id:'resp_fixture',object:'response',model:body.model,status:'completed',output,usage:{input_tokens:12,output_tokens:3,total_tokens:15}}})+'\n\n';
      res.writeHead(200,{'content-type':'text/event-stream',...(body.testGzip?{'content-encoding':'gzip'}:{})});
      res.write(body.testGzip?zlib.gzipSync(stream):stream);
      // No HTTP EOF. The native terminal event/[DONE] must release the request.
    };
    if(body.testDelayed||body.prompt==='delay-fixture')later(respond,waitMs);else respond();
  }catch(error){res.writeHead(500);res.end(error.message);}
});
peer.on('connection',socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));});
await new Promise(r=>peer.listen(0,'127.0.0.1',r));
const upstream='http://127.0.0.1:'+peer.address().port;
const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
for(const dir of ['assets','data/cache','data/state','home'])fs.mkdirSync(path.join(fixture,dir),{recursive:true});
for(const name of ['model-template.json','reasoning-levels.json'])fs.copyFileSync(path.join(root,'assets',name),path.join(fixture,'assets',name));
fs.writeFileSync(path.join(fixture,'data/.env'),'BASE_URL='+upstream+'/v1\nAPI_KEY=inert-test-key\nSHIM_PORT='+port+'\nOFFICIAL_BASE='+upstream+'/official\n');
fs.writeFileSync(path.join(fixture,'data/state/route-state.json'),JSON.stringify({mode:'mixed',officialProxy:'',clientVersion:'0.163.0'}));
fs.writeFileSync(path.join(fixture,'data/cache/catalog-state.json'),JSON.stringify({sourceId:crypto.createHash('sha256').update(upstream+'/v1\ninert-test-key').digest('hex'),gatewayAt:new Date().toISOString(),gatewayIds:models,gatewayModels:models.map(id=>({id}))}));
fs.writeFileSync(path.join(fixture,'home/models_cache.json'),JSON.stringify({models:[native]}));
fs.writeFileSync(path.join(fixture,'home/auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'inert-account'}}));
const router=spawn(process.execPath,[path.join(root,'src/shim.mjs')],{env:{...process.env,CHATGPT_API_ROOT:fixture,CODEX_HOME:path.join(fixture,'home')},windowsHide:true,stdio:['ignore','ignore','pipe']});
let errors='';router.stderr.on('data',data=>errors+=data);
const base='http://127.0.0.1:'+port;
const post=(body,options={})=>fetch(base+(options.url||'/v1/responses'),{method:'POST',headers:{'content-type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body),signal:options.signal||AbortSignal.timeout(deadlineMs)});
async function ws(){const socket=new WebSocket(base.replace('http:','ws:')+'/v1/responses');clients.push(socket);socket.on('error',()=>{});await once(socket,'open');return socket;}
async function wsTurn(socket,body){const received=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('WS response deadline')),deadlineMs);const listen=raw=>{const value=JSON.parse(raw);if(['response.completed','error'].includes(value.type)){clearTimeout(timer);socket.off('message',listen);resolve(value);}};socket.on('message',listen);});socket.send(typeof body==='string'?body:JSON.stringify({type:'response.create',...body}));return received;}
async function closed(record){for(let n=0;n<60&&!record.closed;n++)await delay(20);assert(record.closed,'Upstream request remained open');}
try{
  let ready=false;for(let n=0;n<100;n++){try{ready=(await fetch(base+'/healthz')).ok;if(ready)break;}catch{}await delay(30);}assert(ready,errors);
  assert.deepEqual(RESPONSE_TIMEOUTS,{headersTimeout:0,bodyTimeout:0});
  // Use native HTTP pass-through for compression, then cancel on its actual terminal event.
  const input={model:native.slug,input:[{role:'user',content:'Original 中文 '.repeat(20000)}],stream:true};
  const original=JSON.stringify(input),cancel=new AbortController();
  const response=await post(original,{signal:cancel.signal});const reader=response.body.getReader();await reader.read();cancel.abort();await reader.cancel().catch(()=>{});
  assert.equal(records.at(-1).raw.toString(),original);assert.equal(records.at(-1).encoding,'zstd');assert(records.at(-1).wireBytes<Buffer.byteLength(original));await closed(records.at(-1));
  checks.push('Official identity requests gain lossless zstd without reserializing their JSON');
  for(const gzip of [false,true]){
    const result=await post({model:'Other/model',input:[],stream:true,testGzip:gzip});const text=await result.text();assert(text.includes('response.completed'));await closed(records.at(-1));assert.equal(records.at(-1).encoding,undefined);
  }
  checks.push('Converted HTTP streams release identity and gzip upstreams on terminal events; gateway requests stay uncompressed');
  for(const model of ['GPT/gpt-6-sol','Other/model','词元计划/model']){
    const socket=await ws();const result=await wsTurn(socket,{model,input:[],testGzip:true});assert.equal(result.response.usage.total_tokens,15);assert.equal(result.response.output[0].content[0].text,'Original result');await closed(records.at(-1));socket.close();
  }
  checks.push('Gateway WS streams finish and release upstreams; trailing Chat usage is retained before DONE');
  {
    const socket=await ws();const result=await wsTurn(socket,{model:'GPT/gpt-6-sol',input:[],testWrongContentType:true});
    assert.equal(result.error.code,'invalid_upstream_content_type');await closed(records.at(-1));socket.close();
    assert((await fetch(base+'/healthz')).ok);
  }
  checks.push('Invalid upstream content types release unread response bodies without unhandled abort errors');
  const bad=await post('{');assert.equal(bad.status,400);assert.deepEqual((await bad.json()).error,{type:'invalid_request_error',code:'invalid_json_request',message:'The request body must contain valid JSON.'});
  const unknown=await post({model:'missing',input:[]});assert.equal(unknown.status,400);assert.equal((await unknown.json()).error.code,'unknown_model');
  const socket=await ws();assert.equal((await wsTurn(socket,'{')).error.code,'invalid_json_request');
  const originalError=await wsTurn(socket,{model:'GPT/gpt-6-sol',input:[],testFailure:true});assert.equal(originalError.status,429);assert.deepEqual(originalError.error,upstreamError);socket.close();
  const forwardedError=await post({model:'GPT/gpt-6-sol',input:[],testFailure:true});assert.equal(forwardedError.status,429);assert.equal(forwardedError.headers.get('x-request-id'),'original-id');assert.deepEqual((await forwardedError.json()).error,upstreamError);
  assert.equal(protocolError(Object.assign(Error('connect timeout'),{code:'UND_ERR_CONNECT_TIMEOUT'})).status,504);
  checks.push('Local bad requests are precise 400 errors; upstream HTTP/WS status, type, code, parameter and details remain intact');
  for(const url of ['/v1/responses','/v1/images/generations']){
    const stop=new AbortController(),promise=post({model:native.slug,input:[],testWaitForever:true},{url,signal:stop.signal});
    await delay(100);const waiting=records.at(-1);stop.abort();await assert.rejects(promise);await closed(waiting);
  }
  const waitingSocket=await ws();waitingSocket.send(JSON.stringify({type:'response.create',model:'GPT/gpt-6-sol',input:[],testWaitForever:true}));await delay(100);const waiting=records.at(-1);waitingSocket.send(JSON.stringify({type:'response.cancel'}));await closed(waiting);waitingSocket.close();
  checks.push('HTTP, image and gateway WS cancellation close waiting requests with generation timers disabled');
  const started=Date.now();
  await Promise.all([
    (async()=>{const result=await post({model:'Other/model',input:[],stream:true,testDelayed:true});assert((await result.text()).includes('response.completed'));})(),
    (async()=>{const result=await post({model:'gpt-image-2',prompt:'delay-fixture'},{url:'/v1/images/generations'});assert.equal((await result.json()).data[0].b64_json,'aW5lcnQ=');})(),
    (async()=>{const socket=await ws();assert.equal((await wsTurn(socket,{model:'GPT/gpt-6-sol',input:[],testDelayed:true})).type,'response.completed');socket.close();})(),
  ]);
  assert(Date.now()-started>=waitMs-20);
  checks.push('HTTP, image and gateway WS responses complete after '+waitMs+' ms without an adapter response deadline');
  const originalDescription='Original custom tool description',grammar='start: /[a-z]+/';
  const converted=new NonGptAdapter({tools:[{type:'custom',name:'tool',description:originalDescription,format:{type:'grammar',definition:grammar}}]}).request();
  assert.equal(converted.tools[0].description,originalDescription+'\n'+grammar);assert.deepEqual(converted.tools[0].parameters.properties.input,{type:'string'});
  checks.push('Custom tools preserve source descriptions and grammar without adapter-authored behavior prompts');
  const report={passed:true,waitMs,checks};fs.writeFileSync(path.join(root,'data/diagnostics/adapter-optimization-results'+(waitMs>120000?'-long':'')+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{
  for(const timer of timers)clearTimeout(timer);for(const client of clients)client.terminate();router.kill();for(const socket of sockets)socket.destroy();peer.close();
}
