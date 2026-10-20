import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {stopTurboCandidateWorker} from './turboCandidate';
import {generateImage,backendStatus,type ImageTrace} from './orchestrator';

test('single-image caller with engine omitted uses configured production Turbo full-frame, never legacy server',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'turbo-default-'));
 const changes:Record<string,string>={LOCAL_IMAGE_ENGINE:'qwen21-turbo',TURBO_CANDIDATE_URL:'http://127.0.0.1:8001',TURBO_CPU_PYTHON:process.env.TURBO_CPU_PYTHON||path.join(process.env.USERPROFILE||'','Documents/ComfyUI/.venv/Scripts/python.exe'),TURBO_CPU_WORKER:path.join(dir,'mock-worker.py'),TURBO_CANDIDATE_ARTIFACT_DIR:dir};
 const before=Object.fromEntries(Object.keys(changes).map(key=>[key,process.env[key]]));
 const originalFetch=globalThis.fetch;const urls:string[]=[];let prompts=0;let workflow:any;
 try{
  await fs.writeFile(changes.TURBO_CPU_WORKER,`import sys,json,base64
from pathlib import Path
for line in sys.stdin:
 q=json.loads(line);op=q['op'];r={}
 if op=='prepare':
  Path(q['output']).write_bytes(b'prepared');r={'transform':{'source_width':1280,'source_height':720}}
 elif op=='restore':r={'imageBase64':base64.b64encode(b'new-turbo-frame').decode()}
 elif op!='release':raise Exception('Unexpected CPU operation')
 print(json.dumps(dict(r,id=q['id'])),flush=True)
`);
  Object.assign(process.env,changes);
  globalThis.fetch=async(input,init)=>{
   const url=String(input);urls.push(url);assert.ok(url.startsWith('http://127.0.0.1:8001/'),'only Turbo server is allowed');
   if(url.endsWith('/upload/image'))return Response.json({name:'source.png'});
   if(url.endsWith('/prompt')){prompts++;workflow=JSON.parse(String(init?.body)).prompt;return Response.json({prompt_id:'fresh'});}
   if(url.endsWith('/history/fresh'))return Response.json({fresh:{status:{completed:true},outputs:{'11':{images:[{filename:'new.png'}]}}}});
   if(url.includes('/view?'))return new Response('new-turbo-frame');
   throw Error('Unexpected request '+url);
  };
  const trace:ImageTrace={};
  const image=await generateImage({originalImageDataUrl:'data:image/png;base64,YQ==',predictionPrompt:'The existing person raises the right hand.',imageBackend:'local',trace});
  assert.equal(image,'data:image/png;base64,'+Buffer.from('new-turbo-frame').toString('base64'));
  assert.equal(prompts,1);assert.ok(urls.length>=4);assert.equal(workflow['1'].inputs.unet_name,'qwen_image_2.1_turbo_int8_convrot.safetensors');
  assert.ok(workflow['11'].inputs.filename_prefix.startsWith('turbo-production/'));
  assert.equal((trace.turboCandidate as any).executionMode,'production');assert.equal((trace.turboCandidate as any).geometryStatus,'full-frame-restored');
 }finally{
  stopTurboCandidateWorker();
  globalThis.fetch=originalFetch;
  for(const [key,value] of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await fs.rm(dir,{recursive:true,force:true});
 }
});

test('backend status follows selected Turbo URL and model after legacy Comfy stops',async()=>{
 const keys=['LOCAL_IMAGE_ENGINE','TURBO_CANDIDATE_URL'];const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));const before=globalThis.fetch;
 try{
  Object.assign(process.env,{LOCAL_IMAGE_ENGINE:'qwen21-turbo',TURBO_CANDIDATE_URL:'http://127.0.0.1:8001'});
  const seen:string[]=[];globalThis.fetch=async(input)=>{const url=String(input);seen.push(url);if(url.includes(':8000'))throw Error('retired');return Response.json({models:[]});};
  const result=await backendStatus();assert.equal(result.localImageEngine,'qwen21-turbo');assert.equal(result.comfyui.url,'http://127.0.0.1:8001');assert.equal(result.comfyui.reachable,true);assert.equal(result.comfyui.models.unet,'qwen_image_2.1_turbo_int8_convrot.safetensors');assert.ok(!seen.some(url=>url.includes(':8000')));
 }finally{globalThis.fetch=before;for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
