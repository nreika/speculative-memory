import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {generateTurboCandidate,generateTurboProduction,buildTurboWorkflow,matchTurboActors,turboCandidateConfig,TurboCandidateGeometryError,TURBO_SIGMAS,validateTurboImageInputs,type TurboCandidateParams} from './turboCandidate';
const actor={id:'actor-0',box:[10,10,30,60] as [number,number,number,number],attached:[[15,10,10,12] as [number,number,number,number]]};
const detection=(boxes:number[][])=>({count:boxes.length,persons:boxes.map(box=>({box,score:.9})),inferenceMs:1,elapsedMs:2});
const params:TurboCandidateParams={test:true,sceneImage:'data:image/png;base64,YQ==',prompt:'Move the existing person',sourceActors:[actor],sourceEvidenceComplete:true,expectedPeople:1,seed:1009};
test('test-only and official settings rejected before side effects',async()=>{
 await assert.rejects(generateTurboCandidate({...params,test:false} as any),/test-only/);
 await assert.rejects(generateTurboCandidate({...params,cfg:2}),/official/);
 await assert.rejects(generateTurboCandidate({...params,steps:4}),/official/);
});
test('explicit isolated configuration rejects production/external server',()=>{
 for(const url of ['http://127.0.0.1:8000','https://example.com:8001','http://127.0.0.1:8001/path'])assert.throws(()=>turboCandidateConfig({TURBO_CANDIDATE_URL:url}),/isolated/);
 assert.throws(()=>turboCandidateConfig({}),/explicit absolute/);
});
test('official single forward graph preserves full prompt and reference crops',()=>{
 const prompt='Original long positive preservation instructions';
 const graph=buildTurboWorkflow({...params,prompt},'source.png',[{name:'head.png',crop:{x:1,y:2,width:20,height:30}}],1009,'test');
 assert.equal(graph['5'].inputs.prompt,prompt);assert.equal(graph['5'].inputs.resolution,0);
 assert.equal(graph['9'].inputs.cfg,1);assert.equal(graph['7'].inputs.sigmas,TURBO_SIGMAS);
 assert.deepEqual(graph['9'].inputs.model,['6',0]);assert.equal(graph['6'].inputs.device,'auto');
 assert.equal(Object.values(graph).filter(n=>n.class_type==='SamplerCustom').length,1);
 assert.equal(Object.values(graph).filter(n=>n.class_type==='ImageCrop').length,1);assert.equal(graph['21'].inputs.x,1);
 assert.equal(Object.values(graph).some(n=>n.class_type==='SetLatentNoiseMask'),false);
});
test('one spatial match expands exactly once and keeps attachment original',()=>{
 const r=matchTurboActors([actor],detection([[12,5,44,75]]),1);assert.equal(r.ok,true);if(!r.ok)return;
 assert.deepEqual(r.actors[0].source,[-6,-6,62,92]);assert.deepEqual(r.actors[0].generated,[-4,-11,64,102]);
 assert.deepEqual(r.actors[0].sourceAttached,actor.attached);assert.equal(r.identityProof,false);
});
test('extra/competing/missing/far matches remain unknown',()=>{
 assert.equal(matchTurboActors([actor],detection([[10,10,40,70],[50,10,90,70]]),1).ok,false);
 assert.equal(matchTurboActors([actor],detection([[10,10,40,70],[11,10,41,70]]),2).ok,false);
 assert.equal(matchTurboActors([actor],detection([]),1).ok,false);
 assert.equal(matchTurboActors([actor],detection([[900,500,930,560]]),1).ok,false);
 const other={...actor,id:'actor-1'};assert.equal(matchTurboActors([actor,other],detection([[10,10,40,70]]),2).ok,false);
});
async function mocked(unknown=false,missingSource=false,production=false,fullFrame=false,candidateFallback=false,partOverlap=false,nearDuplicate=false,inputPatch:Record<string,unknown>={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'turbo-adapter-'));let prompts=0,detectorCalls=0;let submittedGraph:any;const cpuCalls:string[]=[];
 const cpu=async(q:any)=>{
  cpuCalls.push(q.op);if(production&&!['prepare','restore','release'].includes(q.op))throw Error('Full-frame must not detect/compose people');
  if(q.op==='prepare'){await fs.writeFile(q.output,'prepared');return {transform:{source_width:1280,source_height:720},prepareMs:1};}
  if(q.op==='restore')return {imageBase64:production?Buffer.from('restored-frame').toString('base64'):'YQ==',restoreMs:1};
  if(q.op==='final'){if(!unknown)await fs.writeFile(q.output,'new-display');return {status:unknown?'unknown':'composited',output:unknown?null:q.output,evidence:{reason:unknown?'actor_sweep_overlaps_protected_region':null},composeMs:2};}
  return {};
 };
 const http:typeof fetch=async(input,init)=>{const url=String(input);
  if(url.endsWith('/upload/image'))return Response.json({name:'uploaded.png'});
  if(url.endsWith('/prompt')){submittedGraph=JSON.parse(String(init?.body)).prompt;prompts++;return Response.json({prompt_id:'id-1'});}
  if(url.endsWith('/history/id-1'))return Response.json({'id-1':{status:{completed:true},outputs:{'11':{images:[{filename:'native.png'}]}}}});
  if(url.includes('/view?'))return new Response('native');
  throw Error('Unexpected HTTP '+url);
 };
 const generate=production?(p:any,d:any)=>{const {test,...request}=p;return generateTurboProduction(fullFrame?{...request,compositionMode:'full-frame',sourceActors:undefined,expectedPeople:undefined}:{...request,compositionMode:'protected'},d,{LOCAL_IMAGE_ENGINE:'qwen21-turbo'});}:generateTurboCandidate;
 const request=generate({...params,sourceEvidenceComplete:!missingSource,...inputPatch},{config:{url:'http://127.0.0.1:8001',python:'unused',worker:path.join(dir,'worker.py'),artifactDir:dir,pollMs:1,timeoutMs:100},cpu,fetch:http,detect:async()=>{detectorCalls++;return nearDuplicate?{count:2,persons:[{box:[10,10,40,70],score:.72},{box:[8,10,34,70],score:.62}],inferenceMs:1,elapsedMs:2}:partOverlap?{count:2,persons:[{box:[10,10,40,70],score:.93},{box:[8,20,20,60],score:.53}],inferenceMs:1,elapsedMs:2}:candidateFallback?{count:0,persons:[],candidates:[{box:[12,5,44,75],score:.35}],inferenceMs:1,elapsedMs:2}:detection([[12,5,44,75]]);}});
 return {request,dir,cpuCalls,graph:()=>submittedGraph,stats:()=>({prompts,detectorCalls})};
}
test('successful result comes from new composition, one generation and detector',async()=>{
 const m=await mocked();try{const r=await m.request;assert.equal(r.buffer.toString(),'new-display');assert.equal(r.trace.geometryStatus,'composited');assert.equal(r.trace.automaticRetries,0);assert.deepEqual(m.stats(),{prompts:1,detectorCalls:1});}finally{await fs.rm(m.dir,{recursive:true,force:true});}
});
test('protection collision archives unknown and returns no source/old/native image',async()=>{
 const m=await mocked(true);try{await assert.rejects(m.request,(e:any)=>{assert.ok(e instanceof TurboCandidateGeometryError);assert.equal(e.reason,'actor_sweep_overlaps_protected_region');assert.equal('dataUrl' in e,false);assert.ok(e.nativePath);return true;});
  const jobs=await fs.readdir(m.dir);const job=path.join(m.dir,jobs[0]);const proof=JSON.parse(await fs.readFile(path.join(job,'unknown.json'),'utf8'));assert.equal(proof.display,null);await assert.rejects(fs.access(path.join(job,'display.png')));assert.deepEqual(m.stats(),{prompts:1,detectorCalls:1});
 }finally{await fs.rm(m.dir,{recursive:true,force:true});}
});
test('missing source evidence fails before generation with explicit unknown',async()=>{
 const m=await mocked(false,true);try{await assert.rejects(m.request,TurboCandidateGeometryError);assert.deepEqual(m.stats(),{prompts:0,detectorCalls:0});}finally{await fs.rm(m.dir,{recursive:true,force:true});}
});

test('missing nonactor protection does not silently unlock the second person',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'turbo-protection-'));let calls=0;
 try{await assert.rejects(generateTurboCandidate({...params,expectedPeople:2,protectedBoxes:[]},{config:{url:'http://127.0.0.1:8001',python:'unused',worker:'unused',artifactDir:dir,timeoutMs:100,pollMs:1},fetch:async()=>{calls++;throw Error('No request permitted');}}),(e:any)=>e instanceof TurboCandidateGeometryError&&e.reason==='missing_nonactor_protection_evidence');assert.equal(calls,0);}
 finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('production entry requires configured engine and never needs test request flag',async()=>{
 const {test:ignored,...request}=params;
 await assert.rejects(generateTurboProduction(request,{},{}),/not configured/);
 const m=await mocked(false,false,true);try{const result=await m.request;assert.equal(result.trace.executionMode,'production');assert.equal(result.trace.automaticRetries,0);assert.equal(result.buffer.toString(),'restored-frame');assert.deepEqual(m.stats(),{prompts:1,detectorCalls:0});}finally{await fs.rm(m.dir,{recursive:true,force:true});}
});
test('production ignores legacy protected composition and never invokes source-mask/blend',async()=>{
 const m=await mocked(true,false,true);try{
  const r=await m.request,trace=r.trace as Record<string,unknown>;assert.equal(r.buffer.toString(),'restored-frame');
  assert.equal(trace.compositionMode,'full-frame');assert.equal(trace.sourceBackgroundComposite,false);
  assert.equal(trace.protectedBackground,false);assert.equal(trace.requiresDownstreamIntegrity,true);
  assert.equal(r.trace.qualityPass,null);assert.equal(r.trace.automaticRetries,0);
  assert.deepEqual(m.stats(),{prompts:1,detectorCalls:0});assert.deepEqual(m.cpuCalls,['prepare','restore','release']);
 }finally{await fs.rm(m.dir,{recursive:true,force:true});}
});

test('full-frame production handles absent/many/ambiguous people without geometry limits or legacy generation',async()=>{
 const m=await mocked(false,false,true,true);try{
  const r=await m.request;assert.equal(r.buffer.toString(),'restored-frame');assert.equal(r.trace.executionMode,'production');assert.equal(r.trace.geometryStatus,'full-frame-restored');assert.equal(r.trace.qualityPass,null);assert.equal(r.trace.automaticRetries,0);assert.deepEqual(m.stats(),{prompts:1,detectorCalls:0});assert.deepEqual(m.cpuCalls,['prepare','restore','release']);assert.deepEqual(r.trace.transform,{source_width:1280,source_height:720});
 }finally{await fs.rm(m.dir,{recursive:true,force:true});}
});



test('production has no source-body pixel fallback even when legacy source geometry is missing',async()=>{
 const m=await mocked(false,true,true);try{
  const r=await m.request;assert.equal(r.buffer.toString(),'restored-frame');assert.equal((r.trace as Record<string,unknown>).requiresDownstreamIntegrity,true);
  assert.deepEqual(m.cpuCalls,['prepare','restore','release']);assert.deepEqual(m.stats(),{prompts:1,detectorCalls:0});
 }finally{await fs.rm(m.dir,{recursive:true,force:true});}
});

test('test-only protected candidate does not silently opt into full-frame',async()=>{
 const m=await mocked(false,false,false,false,true);try{
  await assert.rejects(m.request,(e:any)=>e instanceof TurboCandidateGeometryError&&e.reason==='uncertain_generated_person_extent');
  assert.deepEqual(m.stats(),{prompts:1,detectorCalls:1});assert.deepEqual(m.cpuCalls,['prepare','restore','release']);
 }finally{await fs.rm(m.dir,{recursive:true,force:true});}
});






{
const actor={id:'original',box:[100,200,100,200] as [number,number,number,number]};
const low=(candidates:{box:number[],score:number}[])=>({count:0,persons:[],candidates,inferenceMs:1,elapsedMs:2});
const candidate={box:[110,100,210,390],score:.35};
test('single standing actor candidate requires full-frame restoration, never supplies a mask',()=>{
 const d=low([candidate,{box:[1000,200,1040,240],score:.17}]);const before=JSON.stringify(d);
 const r=matchTurboActors([actor],d,1);assert.equal(r.ok,true);if(!r.ok)return;
 assert.equal(JSON.stringify(d),before);assert.equal(d.count,0);assert.equal(r.identityProof,false);assert.equal(r.allPeopleDetectedClaim,false);
 assert.deepEqual(r.actors,[]);assert.equal(r.correspondenceEvidence.rawDetectorCount,0);assert.equal(r.correspondenceEvidence.requiresDownstreamIntegrity,true);
 assert.equal(r.correspondenceEvidence.extentProven,false);
});
test('low-confidence duplicate and nearby competing boxes veto recovery',()=>{
 for(const second of [{box:[111,101,211,391],score:.16},{box:[180,200,280,400],score:.2},{box:[150,150,250,400],score:.4}])assert.equal(matchTurboActors([actor],low([candidate,second]),1).ok,false);
});
test('multiple source people, selected actor subset, and extra high-confidence people never recover',()=>{
 assert.equal(matchTurboActors([actor],low([candidate]),2).ok,false);
 assert.equal(matchTurboActors([actor,{...actor,id:'second'}],low([candidate]),2).ok,false);
 assert.equal(matchTurboActors([actor],{...low([]),count:2,persons:[candidate,candidate]},1).ok,false);
});
test('missing, weak, far, malformed and inconsistent candidates remain unknown',()=>{
 for(const candidates of [[],[{...candidate,score:.29}],[{box:[1000,100,1100,390],score:.4}],[{...candidate,score:NaN}],[{...candidate,score:.6}],[{box:[110,100,100,390],score:.4}]])assert.equal(matchTurboActors([actor],low(candidates),1).ok,false);
 assert.equal(matchTurboActors([actor],{...low([candidate]),count:1},1).ok,false);
});
test('ordinary detections keep their existing threshold and geometry behavior',()=>{
 const good={count:1,persons:[{box:[100,200,200,400],score:.9}],candidates:[candidate],inferenceMs:1,elapsedMs:2};
 const r=matchTurboActors([actor],good,1);assert.equal(r.ok,true);if(r.ok){assert.equal(r.actors[0].confidence,1);assert.equal(r.correspondenceEvidence.mode,'thresholded-persons');}
 assert.equal(matchTurboActors([actor],{...good,persons:[{...good.persons[0],score:.49}]},1).ok,false);
});
test('two-person ambiguity is still rejected',()=>{
 const d={count:2,persons:[{box:[100,200,200,400],score:.9},{box:[101,201,201,401],score:.9}],inferenceMs:1,elapsedMs:2};
 assert.equal(matchTurboActors([actor,{...actor,id:'second'}],d,2).ok,false);
});

}






test('all sixteen image inputs are wired without dropping original identity crops',()=>{
 const crops=[{x:1,y:2,width:20,height:30},{x:40,y:2,width:20,height:30}];
 const refs=Array.from({length:15},(_,i)=>({name:`ref-${i}.png`,...(i<2?{crop:crops[i]}:{})}));
 const graph=buildTurboWorkflow(params,'source.png',refs,1,'test');
 for(let i=0;i<15;i++)assert.ok(graph['5'].inputs[`images.image_${i+2}`]);
 assert.equal(graph['4'].inputs.image,'source.png');assert.equal(graph['21'].inputs.x,1);assert.equal(graph['24'].inputs.x,40);
 assert.deepEqual(graph['5'].inputs['images.image_4'],['26',0]);assert.deepEqual(graph['5'].inputs['images.image_16'],['62',0]);
 assert.equal(Object.values(graph).filter(n=>n.class_type==='SamplerCustom').length,1);
 assert.throws(()=>buildTurboWorkflow(params,'source.png',[...refs,{name:'overflow.png'}],1,'test'),/at most 16/);
});
test('invalid and overflow reference inputs fail before any CPU, network or artifact access',async()=>{
 let calls=0;const deps={cpu:async()=>{calls++;throw Error('forbidden');},fetch:async()=>{calls++;throw Error('forbidden');}};
 const invalid=[{referenceImages:Array(16).fill(params.sceneImage)}, {faceImage:params.sceneImage,referenceImages:Array(15).fill(params.sceneImage)}, {referenceImages:'bad'}, {referenceImages:[null]}, {referenceImages:['http://example.com/ref.png']}, {referenceImages:['data:image/png;base64,%%%']}, {referenceImages:['data:image/png;base64,YQ=']}, {faceImage:3}, {referenceImages:[params.sceneImage],referenceCrops:[{x:0,y:0,width:0,height:10}]}, {referenceCrops:[{x:0,y:0,width:1,height:1}]}];
 for(const patch of invalid)await assert.rejects(generateTurboCandidate({...params,...patch}as any,deps as any),/Turbo/);
 assert.equal(calls,0);
 validateTurboImageInputs({...params,faceImage:params.sceneImage,referenceImages:Array(14).fill(params.sceneImage),referenceCrops:[{x:1,y:2,width:20,height:30}]});
});

test('reference scaling overflow rejects before CPU, uploads or model execution',async()=>{
 let calls=0;const deps={cpu:async()=>{calls++;throw Error('forbidden');},fetch:async()=>{calls++;throw Error('forbidden');}};
 await assert.rejects(generateTurboCandidate({...params,referenceImages:[params.sceneImage],referenceCrops:[{x:0,y:0,width:16384,height:100}]},deps as any),/ImageScale 16384/);assert.equal(calls,0);
});

test('production adapter uploads face plus every reference and preserves two source identity crops',async()=>{
 const crops=[{x:1,y:2,width:20,height:30},{x:40,y:3,width:20,height:30}];
 const m=await mocked(false,false,true,true,false,false,false,{faceImage:params.sceneImage,faceCrop:crops[0],referenceImages:[params.sceneImage,params.sceneImage,params.sceneImage],referenceCrops:[crops[1]]});
 try{await m.request;const g=m.graph();assert.equal(g['21'].inputs.x,1);assert.equal(g['24'].inputs.x,40);assert.deepEqual(g['5'].inputs['images.image_5'],['29',0]);assert.equal(Object.keys(g['5'].inputs).filter(k=>k.startsWith('images.image_')).length,5);assert.deepEqual(m.stats(),{prompts:1,detectorCalls:0});}finally{await fs.rm(m.dir,{recursive:true,force:true});}
});
