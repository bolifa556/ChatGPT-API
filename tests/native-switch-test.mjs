// Actual unmodified app-server, actual compatibility router, isolated mock models.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { root, delay } from './live-support.mjs';

const models = JSON.parse(fs.readFileSync(path.join(root,'data/cache/catalog-state.json'),'utf8')).gatewayIds;
const fixture = fs.mkdtempSync(path.join(root,'data/testing/native-switch-'));
const home = path.join(fixture,'home'), cwd = path.join(fixture,'workspace');
const reportFile=path.join(root,'data/diagnostics',(process.env.NATIVE_SWITCH_REPORT_NAME||'native-switch-result')+'.json');
const provider=process.env.NATIVE_TEST_PROVIDER||'openai';
const extended=process.env.EXTENDED_NATIVE==='true';
function pngChunk(type,data){const name=Buffer.from(type),body=Buffer.concat([name,data]);let crc=0xffffffff;for(const b of body){crc^=b;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const prefix=Buffer.alloc(4),suffix=Buffer.alloc(4);prefix.writeUInt32BE(data.length);suffix.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([prefix,body,suffix]);}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(64,0);ihdr.writeUInt32BE(64,4);ihdr[8]=8;ihdr[9]=6;
const pixels=Buffer.alloc(64*(1+64*4));for(let y=0;y<64;y++)for(let x=0;x<64;x++){const offset=y*257+1+x*4;pixels[offset]=255;pixels[offset+3]=255;}
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('IDAT',zlib.deflateSync(pixels)),pngChunk('IEND',Buffer.alloc(0))]);
const pixel='data:image/png;base64,'+png.toString('base64');
const wav=Buffer.alloc(1644);wav.write('RIFF');wav.writeUInt32LE(1636,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(1600,40);
const audio='data:audio/wav;base64,'+wav.toString('base64');
for (const directory of [home,cwd,path.join(fixture,'src'),path.join(fixture,'assets'),path.join(fixture,'data/cache'),path.join(fixture,'data/state')]) fs.mkdirSync(directory,{recursive:true});
for (const name of ['model-template.json','reasoning-levels.json']) fs.copyFileSync(path.join(root,'assets',name),path.join(fixture,'assets',name));
for(const name of ['Common.ps1','Package-Paths.ps1','Launcher-State.ps1','Router-Control.ps1','shim.mjs','history-compat.mjs','non-gpt-compat.mjs','chat-compat.mjs','sse.mjs'])fs.copyFileSync(path.join(root,'src',name),path.join(fixture,'src',name));
fs.copyFileSync(path.join(root,'Read-ApiKey.ps1'),path.join(fixture,'Read-ApiKey.ps1'));
const official = { ...JSON.parse(fs.readFileSync(path.join(root,'assets/model-template.json'),'utf8')).models[0], slug:'gpt-6-astra', supported_in_api:true };
// Only this synthetic endpoint advertises audio to exercise native serialization.
// The production catalog is not changed or claimed to have audio capability.
if(extended)official.input_modalities=[...new Set([...(official.input_modalities||[]),'audio'])];
fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'inert-native',account_id:'inert-account'}}));
fs.writeFileSync(path.join(home,'models_cache.json'),JSON.stringify({models:[official]}));
const sockets=new Set(),children=[],records=[],cases=[],errors=[];
let phase, serial=0, routerBase, client, notifications, pending, rpcId, lines;
const flatten=(tools,ns)=>tools.flatMap(t=>t.type==='namespace'?flatten(t.tools,t.name):[{...(t.function||t),namespace:ns}]);
const isExec=t=>t.name==='exec'||/^cx_(?:functions)?_exec_/.test(t.name||'');
function events(body, url, send) {
  const id='resp_native_'+(++serial), base={id,object:'response',model:body.model,created_at:1,status:'in_progress',output:[]};
  const extra=body.stream_id?{stream_id:body.stream_id}:{}; let sequence=0;
  const emit=e=>send({...e,sequence_number:sequence++,...extra});
  const input=body.input||body.messages||[];
  const record={model:body.model,url,generate:body.generate,previous:body.previous_response_id,body};records.push(record);
  emit({type:'response.created',response:base});
  if(body.generate===false){emit({type:'response.completed',response:{...base,status:'completed'}});return;}
  const count=++phase.requests;
  if(phase.interrupt)return;
  if(body.model!==official.slug){
    assert(!body.previous_response_id);assert(JSON.stringify(input).includes(phase.marker),'Original native user context disappeared');
  }
  const names=flatten([...(body.tools||[]),...input.filter(i=>i.type==='additional_tools').flatMap(i=>i.tools||[])]);
  if(!body.previous_response_id)assert(names.some(isExec),'Native executable tool missing on full request');
  if(url.startsWith('/backend-api') && input.some(i=>i.type==='reasoning')){
    assert(!input.some(i=>i.type==='reasoning' && (i.id?.startsWith('rs_gateway_')||i.id?.startsWith('msg_'))),'Foreign reasoning ID reached official');
    assert(!input.some(i=>i.type==='reasoning'&&i.content?.length&&!i.encrypted_content),'Foreign reasoning content reached official');
  }
  let item;
  const toolCount=phase.write||phase.question?2:1;
  if(count<=toolCount){
    const patch='*** Begin Patch\n*** Add File: '+phase.file.replaceAll('\\','/')+'\n+'+phase.marker+'\n*** End Patch';
    const cmd="Get-Content -LiteralPath '"+phase.file.replaceAll("'","''")+"'";
    let source=phase.write&&count===1?'text(await tools.apply_patch('+JSON.stringify(patch)+'));':'text(await tools.exec_command({cmd:'+JSON.stringify(cmd)+',shell:"powershell.exe",max_output_tokens:300}));';
    if(phase.media)source+='image('+JSON.stringify(pixel)+');audio('+JSON.stringify(audio)+');';
    if(phase.mcp)source+='const fixtureTool=ALL_TOOLS.find(t=>t.name.includes("fixture_echo"));if(!fixtureTool)throw Error("Local MCP tool missing");text(await tools[fixtureTool.name]('+JSON.stringify({value:phase.marker,n:19,enabled:false})+'));';
    const tool=names.find(isExec)||{name:'exec',type:'custom',namespace:'functions'};
    const custom=tool.type==='custom';
    item={type:custom?'custom_tool_call':'function_call',id:(custom?'ctc_':'fc_')+serial,call_id:'call_'+serial,name:tool.name,status:'completed',
      ...(tool.namespace?{namespace:tool.namespace}:{}),...(custom?{input:source}:{arguments:JSON.stringify({input:source})})};
    if(phase.question&&count===2){
      const question=names.find(t=>t.name.includes('request_user_input'));assert(question,'Native plan question tool missing');
      item={type:'function_call',id:'fc_'+serial,call_id:'call_'+serial,name:question.name,status:'completed',...(question.namespace?{namespace:question.namespace}:{}),
        arguments:JSON.stringify({questions:[{id:'fixture_choice',header:'Fixture',question:'Choose the isolated test value.',options:[{label:'NATIVE_ANSWER',description:'Use the fixture answer.'},{label:'unused',description:'An unused fixture answer.'}]}]})};
    }
  }else{
    const toolOutputs=JSON.stringify(input.filter(i=>i.role==='tool'||i.type?.endsWith('_output')));
    assert(toolOutputs.includes(phase.marker),'Actual terminal tool result not present in native continuation');
    if(phase.mcp)assert(toolOutputs.includes('MCP_FIXTURE_ECHO'),'Actual MCP result not present in native continuation');
    if(phase.question)assert(toolOutputs.includes('NATIVE_ANSWER'),'Native question answer not present in continuation');
    item={type:'message',id:'msg_'+serial,role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'NATIVE_OK '+phase.marker,annotations:[]}]};
  }
  // Include a gateway-owned reasoning item to exercise persisted mixed history.
  if(body.model!==official.slug){
    const reasoning={type:'reasoning',id:'msg_thought_'+serial,summary:[{type:'summary_text',text:'  SAME_ORIGINAL_THOUGHT\n'}]};
    emit({type:'response.output_item.added',output_index:0,item:reasoning});emit({type:'response.output_item.done',output_index:0,item:reasoning});
  }
  const index=body.model===official.slug?0:1;
  emit({type:'response.output_item.added',output_index:index,item:{...item,status:'in_progress'}});
  emit({type:'response.output_item.done',output_index:index,item});
  emit({type:'response.completed',response:{...base,status:'completed',output:[],usage:{input_tokens:200,output_tokens:20,total_tokens:220}}});
}
const server=http.createServer(async(req,res)=>{
  try{
    if(req.url.includes('/models')){res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.startsWith('/backend-api')?{models:[official]}:{data:models.map(id=>({id}))}));return;}
    let text='';for await(const b of req)text+=b;const body=JSON.parse(text);
    res.writeHead(200,{'content-type':'text/event-stream'});
    if(req.url.endsWith('/chat/completions')){
      // Reuse the same audited response logic, encoding its original output as Chat.
      const items=[];events(body,req.url,e=>{if(e.type==='response.output_item.done')items.push(e.item);});
      if(phase.interrupt)return;
      const call=items.find(i=>i.type==='function_call'),message=items.find(i=>i.type==='message');
      const chunk={id:'chat_'+serial,created:1,model:body.model,choices:[{index:0,delta:{reasoning_content:'  SAME_ORIGINAL_THOUGHT\n',...(call?{tool_calls:[{index:0,id:call.call_id,type:'function',function:{name:call.name,arguments:call.arguments}}]}:{content:message.content[0].text})}}]};
      res.write('data: '+JSON.stringify(chunk)+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:call?'tool_calls':'stop'}]})+'\n\n');
    }else events(body,req.url,e=>res.write('data: '+JSON.stringify(e)+'\n\n'));
    if(!phase.interrupt)res.end();
  }catch(e){errors.push(e.message);res.end('data: '+JSON.stringify({type:'error',error:{message:e.message}})+'\n\n');}
});
server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
const wss=new WebSocketServer({server});wss.on('connection',(ws,req)=>{ws.on('error',()=>{});ws.on('message',raw=>{
  const body=JSON.parse(raw);if(body.type==='response.cancel')return;
  try{events(body,req.url,e=>ws.send(JSON.stringify(e)));}catch(e){errors.push(e.message);ws.send(JSON.stringify({type:'error',error:{message:e.message}}));}
});});
async function processRun(file,args,env){const p=spawn(file,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let text='';p.stdout.on('data',b=>text+=b);p.stderr.on('data',b=>text+=b);const[code]=await once(p,'exit');assert.equal(code,0,text);return text;}
function send(value){if(!client.stdin.destroyed)client.stdin.write(JSON.stringify(value)+'\n');}
function rpc(method,params){return new Promise((resolve,reject)=>{const id=++rpcId,timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout '+method));},15000);pending.set(id,{resolve,reject,timer});send({id,method,params});});}
async function startClient(){
  pending=new Map();notifications=[];rpcId=0;
  const cli=process.env.CODEX_CLI_PATH||path.join(process.env.LOCALAPPDATA,'OpenAI/Codex/bin/faa963e871dd422c/codex.exe');
  client=spawn(cli,['app-server','--stdio'],{cwd,env:{...process.env,CODEX_HOME:home,OPENAI_API_KEY:'inert-native'},windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(client);client.stderr.resume();
  lines=readline.createInterface({input:client.stdout});lines.on('line',text=>{let v;try{v=JSON.parse(text);}catch{return;}
    if(v.id!==undefined&&!v.method){const p=pending.get(v.id);if(p){pending.delete(v.id);clearTimeout(p.timer);v.error?p.reject(Error(v.error.message)):p.resolve(v.result);}}
    else if(v.id!==undefined&&v.method==='item/tool/requestUserInput'){
      assert(phase?.question);assert(v.params.questions.some(q=>q.id==='fixture_choice'));phase.questionAnswered=true;
      send({id:v.id,result:{answers:{fixture_choice:{answers:['NATIVE_ANSWER']}}}});
    }
    else if(v.id!==undefined)send({id:v.id,error:{code:-32601,message:'Unexpected isolated test request '+v.method}});
    else notifications.push(v);
  });
  await rpc('initialize',{clientInfo:{name:'native-switch-validation',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized',params:{}});
}
async function stopClient(){if(!client)return;client.kill();lines.close();for(const p of pending.values())clearTimeout(p.timer);pending.clear();await delay(200);}
async function doTurn(threadId,model,options){
  phase={requests:0,...options};const offset=notifications.length,recordOffset=records.length;
  const started=await rpc('turn/start',{threadId,model,effort:'low',sandboxPolicy:{type:'dangerFullAccess'},input:[{type:'text',text:phase.marker+'; exercise existing tools.'}],
    ...(phase.plan?{collaborationMode:{mode:'plan',settings:{model,reasoning_effort:'low',developer_instructions:null}}}:{})});
  if(phase.interrupt){
    for(let n=0;n<100&&!phase.requests;n++)await delay(30);
    if(phase.steer)await rpc('turn/steer',{threadId,expectedTurnId:started.turn.id,input:[{type:'text',text:'NATIVE_STEERED_CONTEXT'}]});
    await rpc('turn/interrupt',{threadId,turnId:started.turn.id});
  }
  let done;for(let n=0;n<700;n++){done=notifications.slice(offset).find(v=>v.method==='turn/completed'&&v.params?.turn?.id===started.turn.id);if(done)break;await delay(50);}
  assert(done,'Native turn never completed');assert.equal(done.params.turn.status,phase.interrupt?'interrupted':'completed',JSON.stringify(done.params.turn.error));
  if(!phase.interrupt){
    assert.equal(fs.readFileSync(phase.file,'utf8').trim(),phase.marker);assert(phase.requests>1,'Native tool execution did not continue the model');
    assert(notifications.slice(offset).some(n=>n.method==='item/completed'&&n.params.item.type==='commandExecution'&&n.params.item.exitCode===0),'No successful native terminal execution');
    if(phase.media){
      const media=[];const visit=value=>{if(!value||typeof value!=='object')return;if(['input_image','image_url','input_audio'].includes(value.type))media.push(value);for(const child of Object.values(value))visit(child);};
      for(const record of records.slice(recordOffset))visit(record.body.input||record.body.messages);
      assert(media.some(p=>p.type==='input_image'||p.type==='image_url'),'Actual native image result disappeared');
      assert(media.some(p=>p.type==='input_audio'),'Actual native audio result disappeared');
    }
  }
  if(phase.question)assert(phase.questionAnswered,'Native question callback was not invoked');
  return{model,status:done.params.turn.status,requests:phase.requests,media:phase.media||false,plan:phase.plan||false,steer:phase.steer||false,mcp:phase.mcp||false,question:phase.questionAnswered||false,itemTypes:[...new Set(notifications.slice(offset).filter(n=>n.method==='item/completed').map(n=>n.params.item.type))]};
}
async function applyEntry(entry){
  const script=path.join(fixture,'apply-entry.ps1');
  const quote=s=>"'"+s.replaceAll("'","''")+"'";
  fs.writeFileSync(script,["$ErrorActionPreference='Stop'",...['Common','Package-Paths','Launcher-State'].map(n=>'. '+quote(path.join(root,'src',n+'.ps1'))),
    'Restore-LauncherConfig '+quote(fixture)+' '+quote(path.join(home,'config.toml')),
    'Apply-LauncherConfig '+quote(fixture)+' '+quote(path.join(home,'config.toml'))+" 'mixed' "+quote(routerBase+'/v1')+" 'http://isolated.invalid/v1' "+quote(entry)].join('\n'));
  await processRun('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script],{...process.env,CODEX_HOME:home});
}
try{
  server.listen(0,'127.0.0.1');await once(server,'listening');const peerBase='http://127.0.0.1:'+server.address().port;
  const reserve=http.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');routerBase='http://127.0.0.1:'+reserve.address().port;await new Promise(r=>reserve.close(r));
  fs.writeFileSync(path.join(fixture,'data/.env'),['BASE_URL='+peerBase+'/v1','API_KEY=inert-gateway','OFFICIAL_BASE='+peerBase+'/backend-api/codex','SHIM_PORT='+new URL(routerBase).port].join('\n'));
  fs.writeFileSync(path.join(fixture,'data/state/route-state.json'),JSON.stringify({mode:'mixed',officialProxy:''}));
  const env={...process.env,CODEX_HOME:home,CHATGPT_API_ROOT:fixture,CHATGPT_API_ENV_PATH:path.join(fixture,'data/.env'),CHATGPT_GATEWAY_BASE:peerBase+'/v1',CHATGPT_SHIM_PORT:new URL(routerBase).port};
  await processRun(process.execPath,[path.join(root,'src/shim.mjs'),'--prepare'],env);
  const router=spawn(process.execPath,[path.join(root,'src/shim.mjs')],{env,windowsHide:true,stdio:'ignore'});children.push(router);
  for(let n=0;n<100;n++){try{if((await fetch(routerBase+'/healthz')).ok)break;}catch{}await delay(30);}
  fs.writeFileSync(path.join(home,'config.toml'),['model="gpt-6-astra"','approval_policy="never"','sandbox_mode="workspace-write"','web_search="disabled"','[features]','code_mode_host=true','[analytics]','enabled=false','[model_providers.smr]','name="Legacy test"',
    ...(extended?['[mcp_servers.fixture_echo]','command='+JSON.stringify(process.execPath),'args=['+JSON.stringify(path.join(root,'tests/fixtures/mcp-echo.mjs'))+']']:[]),''].join('\n'));
  await applyEntry('api');await startClient();
  const selected=process.argv.slice(2);
  for(const model of models.filter(m=>!selected.length||selected.some(v=>m.includes(v)))){
    const row={model,steps:[]};cases.push(row);const marker='NATIVE_'+cases.length,file=path.join(cwd,'marker-'+cases.length+'.txt');
    try{
      const started=await rpc('thread/start',{model:official.slug,modelProvider:provider,cwd,approvalPolicy:'never',sandbox:'danger-full-access',runtimeWorkspaceRoots:[cwd]});const threadId=started.thread.id;
      row.permissions={sandbox:started.sandbox,profile:started.activePermissionProfile};console.log(JSON.stringify({phase:'resolved_permissions',...row.permissions}));
      row.steps.push(await doTurn(threadId,official.slug,{marker,file,write:true}));
      row.steps.push(await doTurn(threadId,model,{marker,file}));
      if(extended){
        row.steps.push(await doTurn(threadId,model,{marker,file,interrupt:true,steer:true}));
        row.steps.push(await doTurn(threadId,model,{marker,file,media:true,plan:true,mcp:true,question:true}));
      }
      row.steps.push(await doTurn(threadId,official.slug,{marker,file}));
      if(extended){
        const fork=await rpc('thread/fork',{threadId,excludeTurns:true,ephemeral:true});assert.notEqual(fork.thread.id,threadId);
        const read=await rpc('thread/read',{threadId});assert.equal(read.thread.id,threadId);
        const list=await rpc('thread/list',{limit:100});assert(list.data.some(t=>t.id===threadId));
        await rpc('thread/name/set',{threadId,name:'Isolated native fixture '+cases.length});
        await rpc('thread/archive',{threadId});await rpc('thread/unarchive',{threadId});
        row.nativeThreadManagement={read:true,list:true,fork:true,rename:true,archive:true,unarchive:true};
      }
      // Restore this exact persisted conversation via the other launcher config.
      await stopClient();await applyEntry('official');await startClient();
      const resumed=await rpc('thread/resume',{threadId,model:official.slug,excludeTurns:true});assert.equal(resumed.thread.id,threadId);
      row.steps.push(await doTurn(threadId,official.slug,{marker,file}));row.sameThreadAfterEntrySwitch=true;
      // Verify native cancellation, then continued tool use in the same thread.
      row.steps.push(await doTurn(threadId,official.slug,{marker,file,interrupt:true}));
      row.steps.push(await doTurn(threadId,official.slug,{marker,file}));
      await stopClient();await applyEntry('api');await startClient();
      row.passed=true;
    }catch(e){row.passed=false;row.error=e.message;row.recentErrors=notifications.filter(n=>n.method==='error').slice(-2);row.toolItems=notifications.filter(n=>n.method==='item/completed').map(n=>n.params.item);row.lastRequests=records.slice(-4);}
    console.log(JSON.stringify({model,passed:row.passed,error:row.error,steps:row.steps.map(s=>({model:s.model,status:s.status,requests:s.requests}))}));
    fs.writeFileSync(reportFile,JSON.stringify({cases,errors,fixture},null,2));
    if(!row.passed)break;
  }
}finally{
  await stopClient();for(const c of children)c.kill();for(const ws of wss.clients)ws.terminate();for(const s of sockets)s.destroy();server.close();
  const report={at:new Date().toISOString(),passed:cases.length>0&&cases.every(c=>c.passed)&&errors.length===0,fixture,provider,syntheticAudioCapability:extended,scope:'Unmodified native app-server plus production router with isolated upstreams and launcher configurations; real patch and terminal tools execute only in fixture',cases,errors};
  fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
  if(!report.passed)process.exitCode=1;
}
