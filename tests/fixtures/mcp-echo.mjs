// Read-only local MCP server used only by isolated native-client tests.
import readline from 'node:readline';
const lines=readline.createInterface({input:process.stdin});
lines.on('close',()=>process.exit(0));
// Windows may retain an inherited pipe briefly after the isolated app-server exits.
const owner=process.ppid;
setInterval(()=>{try{process.kill(owner,0);}catch{process.exit(0);}},1000).unref();
lines.on('line',line=>{
  let request;try{request=JSON.parse(line);}catch{return;}
  if(request.id===undefined)return;
  let result;
  if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture_echo',version:'1'}};
  else if(request.method==='tools/list')result={tools:[{name:'echo',description:'Echo isolated test arguments without side effects.',inputSchema:{type:'object',properties:{value:{type:'string'},n:{type:'integer'},enabled:{type:'boolean'}},required:['value','n','enabled'],additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false}}]};
  else if(request.method==='tools/call'&&request.params.name==='echo')result={content:[{type:'text',text:'MCP_FIXTURE_ECHO '+JSON.stringify(request.params.arguments)}]};
  else if(request.method==='ping')result={};
  else{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unsupported fixture method'}})+'\n');return;}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
