// Opt-in: real endpoints, a synthetic red image, and no tool side effects.
import zlib from 'node:zlib';
import {startLive,connect,turn,classify,saveReport} from './live-support.mjs';
function chunk(type,data){const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const b of body){crc^=b;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([length,body,sum]);}
const header=Buffer.alloc(13);header.writeUInt32BE(64,0);header.writeUInt32BE(64,4);header[8]=8;header[9]=6;
const pixels=Buffer.alloc(64*257);for(let y=0;y<64;y++)for(let x=0;x<64;x++){pixels[y*257+1+x*4]=255;pixels[y*257+4+x*4]=255;}
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
const image={type:'input_image',image_url:'data:image/png;base64,'+png.toString('base64'),detail:'high'};
const tool={type:'custom',name:'fixture_image',format:{type:'text'},description:'Returns a synthetic image.'};
const live=await startLive('media-live'),selected=process.argv.slice(2);
const report={at:new Date().toISOString(),scope:'Real model endpoints; synthetic image in a user message and a native custom tool result; no code execution',models:[]};
try{
  const queue=live.models.filter(m=>!selected.length||selected.some(s=>m.includes(s)));
  async function worker(){while(queue.length){
    const model=queue.shift(),row={model};report.models.push(row);
    for(const phase of ['user_image','tool_result_image']){
      let ws;
      try{
        ws=await connect(live.base);
        const input=phase==='user_image'?[{role:'user',content:[{type:'input_text',text:'What color fills this image? Reply with the color only.'},image]}]:[
          {role:'user',content:'Inspect the image returned by fixture_image. Reply with its color only.'},
          {type:'custom_tool_call',id:'ctc_fixture_image',call_id:'call_fixture_image',name:tool.name,input:'existing fixture'},
          {type:'custom_tool_call_output',call_id:'call_fixture_image',output:[image]},
        ];
        const result=await turn(ws,{model,stream:true,input,tools:phase==='user_image'?[]:[tool],tool_choice:'none',reasoning:{effort:'low'}},45000);
        row[phase]={status:/red|红/i.test(result.text)?'passed':'excluded_model_output',answer:result.text.slice(0,160)};
      }catch(error){row[phase]={status:classify(error),code:error.code,error:error.message.slice(0,500)};}
      finally{ws?.terminate();console.log(JSON.stringify({model,phase,...row[phase]}));saveReport('media-live-2026-09-28',report);}
    }
  }}
  await Promise.all([worker(),worker(),worker()]);
}finally{report.nativeConfigAndAuthUnchanged=await live.close();report.models.sort((a,b)=>a.model.localeCompare(b.model));saveReport('media-live-2026-09-28',report);}
