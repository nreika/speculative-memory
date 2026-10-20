/** Isolated, opt-in test adapter. Never substitutes source/old frames for unknown. */
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import type {QwenEditParams} from './comfyClient';
import {referenceScaleSize} from './referenceCrop';
import {detectPeople,classifySingleActorCountAmbiguity,type Detection} from './lightPeopleDetector';

export type TurboBox = [number,number,number,number];
export interface TurboSourceActor {id:string;box:TurboBox;attached?:TurboBox[]}
export interface TurboProductionParams extends QwenEditParams {
 compositionMode?:'protected'|'full-frame';sourceActors?:TurboSourceActor[];protectedBoxes?:TurboBox[];
 sourceEvidenceComplete?:boolean;expectedPeople?:number;
}
export interface TurboCandidateParams extends TurboProductionParams {test:true;sourceActors:TurboSourceActor[];sourceEvidenceComplete:boolean;expectedPeople:number}
export class TurboCandidateGeometryError extends Error {
 readonly code='TURBO_COMPOSITION_UNKNOWN';
 constructor(public reason:string,public evidence:Record<string,unknown>,public evidencePath:string,public nativePath?:string){
  super(`Turbo composition unknown: ${reason}`);this.name='TurboCandidateGeometryError';
 }
}
export const TURBO_SIGMAS='1,0.978453,0.95418,0.926626,0.89508,0.845148,0.704534,0.414568,0';
export interface TurboCandidateConfig {url:string;python:string;worker:string;artifactDir:string;timeoutMs:number;pollMs:number}
export function turboCandidateConfig(env:NodeJS.ProcessEnv=process.env):TurboCandidateConfig {
 const url=(env.TURBO_CANDIDATE_URL||'http://127.0.0.1:8001').replace(/\/$/,'');
 const parsed=new URL(url);
 if(parsed.protocol!=='http:'||!['127.0.0.1','localhost'].includes(parsed.hostname)||parsed.port!=='8001'||parsed.pathname!=='/'||parsed.search||parsed.username||parsed.password)throw Error('Turbo requires isolated local port 8001');
 for(const name of ['TURBO_CPU_PYTHON','TURBO_CPU_WORKER','TURBO_CANDIDATE_ARTIFACT_DIR'])if(!env[name]||!path.isAbsolute(env[name]!))throw Error(`${name} must be an explicit absolute path`);
 return {url,python:env.TURBO_CPU_PYTHON!,worker:env.TURBO_CPU_WORKER!,artifactDir:env.TURBO_CANDIDATE_ARTIFACT_DIR!,timeoutMs:300000,pollMs:100};
}
type Rpc=(request:Record<string,unknown>,signal?:AbortSignal)=>Promise<any>;
export interface TurboCandidateDependencies {config?:TurboCandidateConfig;fetch?:typeof fetch;cpu?:Rpc;detect?:(image:string,signal?:AbortSignal)=>Promise<Detection>}
let worker:ChildProcessWithoutNullStreams|undefined,workerIdentity='',sequence=0;
const pending=new Map<number,{resolve:(r:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
function stopWorker(error:Error){const old=worker;worker=undefined;for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();old?.kill();}
process.once('exit',()=>worker?.kill());
export function stopTurboCandidateWorker(){stopWorker(new Error('Turbo CPU worker stopped'));}
function cpuRpc(config:TurboCandidateConfig):Rpc {
 return async (request,signal)=>{
  signal?.throwIfAborted();const identity=config.python+'|'+config.worker;
  if(worker&&workerIdentity!==identity)throw Error('Turbo CPU worker config changed while active');
  if(!worker){
   const child=spawn(config.python,['-u',config.worker],{windowsHide:true,stdio:['pipe','pipe','pipe']});
   worker=child;workerIdentity=identity;
   child.on('error',e=>{if(worker===child)stopWorker(e);});
   child.on('exit',()=>{if(worker===child)stopWorker(new Error('Turbo CPU worker exited'));});
   child.stdin.on('error',e=>{if(worker===child)stopWorker(e);});
   child.stderr.resume();
   createInterface({input:child.stdout}).on('line',line=>{try{
    const r=JSON.parse(line),p=pending.get(r.id);if(!p)return;pending.delete(r.id);clearTimeout(p.timer);
    if(r.error)p.reject(new Error(r.error));else p.resolve(r);
   }catch{if(worker===child)stopWorker(new Error('Invalid Turbo CPU JSON'));}});
  }
  const child=worker,id=++sequence;
  const abort=()=>stopWorker(new Error('Turbo CPU aborted'));
  signal?.addEventListener('abort',abort,{once:true});
  try{return await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>stopWorker(new Error('Turbo CPU timeout')),30000);
   pending.set(id,{resolve,reject,timer});child!.stdin.write(JSON.stringify({...request,id})+'\n');
  });}finally{signal?.removeEventListener('abort',abort);}
 };
}
function validBox(b:unknown):b is TurboBox {return Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[2]>0&&b[3]>0;}
function iou(a:TurboBox,b:TurboBox){const area=Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));return area/(a[2]*a[3]+b[2]*b[3]-area||1);}
const expand=(b:TurboBox):TurboBox=>[b[0]-16,b[1]-16,b[2]+32,b[3]+32];
/** Geometric correspondence is a veto, never an identity/count certification. */
export function matchTurboActors(actors:TurboSourceActor[],d:Detection,expectedPeople:number){
 const partOverlap=classifySingleActorCountAmbiguity(d,expectedPeople,actors);
 if(partOverlap)return {ok:true as const,actors:[] as any[],allPeopleDetectedClaim:false,identityProof:false,correspondenceEvidence:{mode:partOverlap.kind==='near-duplicate-body-overlap-uncertain'?'single-actor-near-duplicate':'single-actor-part-overlap',...partOverlap,extentProven:false}};
 if(!Number.isInteger(d.count)||d.count<0||d.count!==d.persons.length||d.count>expectedPeople)return {ok:false as const,reason:'output_count_inconsistent_or_extra'};
 const metrics=(a:TurboBox,b:TurboBox)=>({overlap:iou(a,b),distance:Math.hypot(a[0]+a[2]/2-b[0]-b[2]/2,a[1]+a[3]/2-b[1]-b[3]/2)/Math.max(Math.hypot(a[2],a[3]),Math.hypot(b[2],b[3]))});
 const boxOf=(p:{box:number[]})=>[p.box[0],p.box[1],p.box[2]-p.box[0],p.box[3]-p.box[1]] as TurboBox;
 let pool=d.persons.map((p,index)=>({index,score:p.score,box:boxOf(p)}));
 let correspondenceEvidence:Record<string,unknown>={mode:'thresholded-persons',rawDetectorCount:d.count};
 if(pool.some(p=>!validBox(p.box)||!Number.isFinite(p.score)||p.score<.5))return {ok:false as const,reason:'invalid_output_detection'};
 // Only recover a composition box, never promote a detector candidate into a
 // certified person count or identity. The caller's existing integrity check remains required.
 if(d.count===0&&actors.length===1&&expectedPeople===1&&d.candidates?.length){
  if(!validBox(actors[0].box))return {ok:false as const,reason:'invalid_source_actor'};
  const candidates=d.candidates.map((p,index)=>({index,score:p.score,box:boxOf(p)}));
  if(candidates.some(p=>!validBox(p.box)||!Number.isFinite(p.score)||p.score<.15||p.score>=.5))return {ok:false as const,reason:'invalid_candidate_detection'};
  const eligible=candidates.filter(p=>{const m=metrics(actors[0].box,p.box);return p.score>=.30&&m.overlap>=.20&&m.distance<=.45;});
  if(eligible.length!==1)return {ok:false as const,reason:'missing_or_competing_actor_candidate'};
  const best=eligible[0];
  // Include lower-confidence candidates when vetoing ambiguity. A nearby or
  // overlapping second box is not silently discarded just because its score is lower.
  const competing=candidates.filter(p=>{if(p.index===best.index)return false;const m=metrics(actors[0].box,p.box);return m.overlap>=.10||m.distance<=.60||iou(best.box,p.box)>=.10;});
  if(competing.length)return {ok:false as const,reason:'competing_actor_candidates'};
  const m=metrics(actors[0].box,best.box);
  correspondenceEvidence={mode:'single-actor-candidate',rawDetectorCount:d.count,candidateScore:best.score,candidateIndex:best.index,candidateCount:candidates.length,competingCandidates:0,overlap:m.overlap,normalizedCenterDistance:m.distance,thresholds:{minimumScore:.30,minimumOverlap:.20,maximumCenterDistance:.45},requiresDownstreamIntegrity:true,extentProven:false};
  // A candidate may omit the head or limbs: never turn this box into a mask.
  return {ok:true as const,actors:[] as any[],allPeopleDetectedClaim:false,identityProof:false,correspondenceEvidence};
 }
 const used=new Set<number>(),matches:any[]=[];
 for(const actor of actors){
  const scored=pool.map(p=>({...p,...metrics(actor.box,p.box)})).sort((a,b)=>b.overlap-a.overlap);
  const best=scored[0];
  const accepted=best&&(expectedPeople===1&&scored.length===1?(best.overlap>=.05||best.distance<=.6):(best.overlap>=.1&&(scored.length===1||best.overlap-scored[1].overlap>=.08)));
  if(!accepted||used.has(best.index))return {ok:false as const,reason:pool.length?'ambiguous_actor_correspondence':'missing_output_actor_detection'};
  used.add(best.index);matches.push({id:actor.id,source:expand(actor.box),generated:expand(best.box),confidence:1,ambiguous:false,sourceAttached:actor.attached||[],generatedAttached:[],match:{overlap:best.overlap,normalizedCenterDistance:best.distance,detectorScore:best.score}});
 }
 return {ok:true as const,actors:matches,allPeopleDetectedClaim:false,identityProof:false,correspondenceEvidence};
}
export function buildTurboWorkflow(params:QwenEditParams,sourceName:string,refs:Array<{name:string;crop?:QwenEditParams['faceCrop']}>,seed:number,prefix:string){
 if(!Array.isArray(refs)||refs.length>15)throw Error('Turbo supports at most 16 images including source');
 const w:Record<string,any>={
 '1':{class_type:'UNETLoader',inputs:{unet_name:'qwen_image_2.1_turbo_int8_convrot.safetensors',weight_dtype:'default'}},
 '2':{class_type:'CLIPLoader',inputs:{clip_name:'qwen3vl_8b_w4a8.safetensors',type:'qwen_image',device:'default'}},
 '3':{class_type:'VAELoader',inputs:{vae_name:'qwen_image_2.1_vae_bf16.safetensors'}},
 '4':{class_type:'LoadImage',inputs:{image:sourceName}},
 '5':{class_type:'TextEncodeQwenImage21',inputs:{clip:['2',0],vae:['3',0],prompt:params.prompt,negative_prompt:params.negativePrompt||'',resolution:0,'images.image_1':['4',0]}},
 '6':{class_type:'QwenImage21Cache',inputs:{model:['1',0],device:'auto',dtype:'default'}},
 '7':{class_type:'ManualSigmas',inputs:{sigmas:TURBO_SIGMAS}},
 '8':{class_type:'KSamplerSelect',inputs:{sampler_name:'euler'}},
 '9':{class_type:'SamplerCustom',inputs:{model:['6',0],add_noise:true,noise_seed:seed,cfg:1,positive:['5',0],negative:['5',1],sampler:['8',0],sigmas:['7',0],latent_image:['5',2]}},
 '10':{class_type:'VAEDecode',inputs:{samples:['9',0],vae:['3',0]}},
 '11':{class_type:'SaveImage',inputs:{images:['10',0],filename_prefix:prefix}}
 };
 refs.forEach((r,i)=>{const n=String(20+i*3);w[n]={class_type:'LoadImage',inputs:{image:r.name}};let link=[n,0];
  if(r.crop){const c=r.crop;const crop=String(+n+1),scale=String(+n+2);w[crop]={class_type:'ImageCrop',inputs:{image:link,...c}};w[scale]={class_type:'ImageScale',inputs:{image:[crop,0],upscale_method:'lanczos',...referenceScaleSize(c.width,c.height),crop:'disabled'}};link=[scale,0];}
  w['5'].inputs[`images.image_${i+2}`]=link;
 });return w;
}
function bytes(data:string){if(typeof data!=='string')throw Error('Invalid Turbo image data URL');const m=/^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);if(!m)throw Error('Invalid Turbo image data URL');const result=Buffer.from(m[1],'base64');if(!result.length||result.toString('base64')!==m[1])throw Error('Invalid Turbo image data URL');return result;}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
let tail:Promise<void>=Promise.resolve();
export async function generateTurboCandidate(params:TurboCandidateParams,deps:TurboCandidateDependencies={}){
 // Before any side effect or model request; caller cannot opt in with a truthy string.
 if(params.test!==true)throw Error('Turbo candidate is test-only');
 return executeTurbo(params,deps,'test');
}
export async function generateTurboProduction(params:TurboProductionParams,deps:TurboCandidateDependencies={},env:NodeJS.ProcessEnv=process.env){
 if(env.LOCAL_IMAGE_ENGINE!=='qwen21-turbo')throw Error('Production Turbo is not configured');
 // Production always publishes this generation restored to the source frame.
 // A caller's legacy protected flag must never restore old source-body/background pixels.
 return executeTurbo({...params,compositionMode:'full-frame'},deps,'production');
}
export function validateTurboImageInputs(p:TurboProductionParams):void {
 if(!p||typeof p!=='object')throw Error('Invalid Turbo image inputs');
 bytes(p.sceneImage);
 if(p.faceImage!==undefined)bytes(p.faceImage);
 if(p.referenceImages!==undefined&&!Array.isArray(p.referenceImages))throw Error('Invalid Turbo reference images');
 const refs=p.referenceImages??[];
 if(1+(p.faceImage!==undefined?1:0)+refs.length>16)throw Error('Turbo supports at most 16 images including source');
 for(const ref of refs)bytes(ref);
 if(p.referenceCrops!==undefined&&(!Array.isArray(p.referenceCrops)||p.referenceCrops.length>refs.length))throw Error('Invalid Turbo reference crops');
 const crop=(c:unknown)=>{if(c===undefined)return;const v=c as Record<string,number>;if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['x','y','width','height'].includes(k))||![v.x,v.y,v.width,v.height].every(Number.isSafeInteger)||v.x<0||v.y<0||v.width<1||v.height<1)throw Error('Invalid Turbo reference crop');referenceScaleSize(v.width,v.height);};
 crop(p.faceCrop);for(const c of p.referenceCrops??[])crop(c);
}
async function executeTurbo(params:TurboProductionParams,deps:TurboCandidateDependencies,mode:'test'|'production'){
 validateTurboImageInputs(params);
 if(params.steps!==undefined&&params.steps!==8||params.cfg!==undefined&&params.cfg!==1||params.denoise!==undefined&&params.denoise!==1)throw Error('Turbo requires official 8-step CFG1 full-denoise schedule');
 const previous=tail;let release!:()=>void;tail=new Promise<void>(r=>release=r);
 await previous;
 try{return await run(params,deps,mode);}finally{release();}
}
async function run(p:TurboProductionParams,deps:TurboCandidateDependencies,mode:'test'|'production'){
 p.signal?.throwIfAborted();const c=deps.config||turboCandidateConfig(),http=deps.fetch||fetch,rpc=deps.cpu||cpuRpc(c),detect=deps.detect||detectPeople;
 const fullFrame=mode==='production'&&p.compositionMode==='full-frame';
 const actors=p.sourceActors??[],expectedPeople=p.expectedPeople??0;
 const key=randomUUID(),dir=path.join(c.artifactDir,key);await fs.mkdir(dir,{recursive:true});
 const record=(name:string,value:unknown)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2),{flag:'wx'});
 const unknown=async(reason:string,evidence:Record<string,unknown>,nativePath?:string):Promise<never>=>{const evidencePath=path.join(dir,'unknown.json');await record('unknown.json',{status:'unknown',reason,evidence,nativePath,display:null,automaticRetry:false});throw new TurboCandidateGeometryError(reason,evidence,evidencePath,nativePath);};
 if(!fullFrame&&(!p.sourceEvidenceComplete||!Array.isArray(actors)||!actors.length||!Number.isInteger(expectedPeople)||expectedPeople<actors.length||new Set(actors.map(a=>a.id)).size!==actors.length||actors.some(a=>!a.id||!validBox(a.box)||(a.attached||[]).some(b=>!validBox(b)))||(p.protectedBoxes||[]).some(b=>!validBox(b))))return unknown('missing_or_invalid_source_actor_evidence',{});
 if(!fullFrame&&(p.protectedBoxes||[]).length < expectedPeople-actors.length)return unknown('missing_nonactor_protection_evidence',{});
 const source=path.join(dir,'source-image'),prepared=path.join(dir,'prepared-input.png'),native=path.join(dir,'model-native.png'),output=path.join(dir,'display.png');
 const raw=bytes(p.sceneImage);await fs.writeFile(source,raw,{flag:'wx'});const started=Date.now();let promptId:string|undefined;
 const json=async(url:string,options:RequestInit={})=>{const r=await http(c.url+url,{...options,signal:options.signal||(p.signal?AbortSignal.any([p.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000))});if(!r.ok)throw Error(`Turbo HTTP ${r.status} ${url}`);return r.json() as Promise<any>;};
 const upload=async(buffer:Buffer)=>{const name=`turbo_${sha(buffer)}.png`,form=new FormData();form.set('image',new Blob([buffer],{type:'image/png'}),name);form.set('overwrite','true');const r=await json('/upload/image',{method:'POST',body:form});if(typeof r.name!=='string')throw Error('Invalid Turbo upload result');return r.subfolder?`${r.subfolder}/${r.name}`:r.name;};
 try{
  const prep=await rpc({op:'prepare',key,variant:'after',source,output:prepared},p.signal);await record('prepare.json',prep);
  const sourceName=await upload(await fs.readFile(prepared));const refs:Array<{name:string;crop?:QwenEditParams['faceCrop']}>=[];
  if(p.faceImage)refs.push({name:await upload(bytes(p.faceImage)),crop:p.faceCrop});
  for(let i=0;i<(p.referenceImages?.length||0);i++)refs.push({name:await upload(bytes(p.referenceImages![i])),crop:p.referenceCrops?.[i]});
  const seed=p.seed??Math.floor(Math.random()*2**31),workflow=buildTurboWorkflow(p,sourceName,refs,seed,`turbo-${mode}/${key}`);await record('workflow.json',workflow);
  const genStart=Date.now();const queued=await json('/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:workflow,client_id:key}),signal:AbortSignal.timeout(15000)});
  promptId=queued.prompt_id;if(typeof promptId!=='string')throw Error('Turbo prompt id missing');await record('pending.json',{promptId});let history:any;
  while(Date.now()-genStart<c.timeoutMs){p.signal?.throwIfAborted();history=(await json('/history/'+encodeURIComponent(promptId)))[promptId];if(history?.status?.status_str==='error')throw Error('Turbo Comfy execution failed');if(history?.status?.completed)break;await sleep(c.pollMs,undefined,{signal:p.signal});}
  if(!history?.status?.completed)throw Error('Turbo generation timeout');await record('history.json',history);
  const image=history.outputs?.['11']?.images?.[0];if(!image?.filename)throw Error('Turbo completed without output');
  const response=await http(c.url+'/view?'+new URLSearchParams({filename:image.filename,subfolder:image.subfolder||'',type:image.type||'output'}),{signal:p.signal?AbortSignal.any([p.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});if(!response.ok)throw Error('Turbo image fetch failed');const nativeBytes=Buffer.from(await response.arrayBuffer());await fs.writeFile(native,nativeBytes,{flag:'wx'});
  const generationMs=Date.now()-genStart;
  const restored=await rpc({op:'restore',key,source,native,variant:'after',transform:prep.transform,encodeForDetector:true},p.signal);
  if(fullFrame){
   const restoredBytes=bytes('data:image/png;base64,'+restored.imageBase64);
   // A newly generated full frame, never an old/source substitute. Downstream count/fidelity/caption inspection is unchanged.
   await fs.writeFile(output,restoredBytes,{flag:'wx'});
   const trace={executionMode:mode,compositionMode:'full-frame',protectedBackground:false,sourceBackgroundComposite:false,requiresDownstreamIntegrity:true,model:'Qwen-Image-2.1-Turbo',comfyPromptId:promptId,seed,steps:8,cfg:1,sigmas:TURBO_SIGMAS,cache:'auto/default',automaticRetries:0,sourceSha256:sha(raw),nativeSha256:sha(nativeBytes),transform:prep.transform,sourceFovRetained:true,frameRestoration:'generated-content-only; remove saved letterbox padding',geometryStatus:'full-frame-restored',rawNativePath:native,artifactDir:dir,timings:{totalToDisplayMs:Date.now()-started,generationMs,prepareMs:prep.prepareMs,preparePngMs:prep.preparePngMs,restoreMs:restored.restoreMs,restorePngMs:restored.detectorPngMs},qualityPass:null};
   await record('trace.json',trace);return {buffer:restoredBytes,dataUrl:`data:image/png;base64,${restoredBytes.toString('base64')}`,trace};
  }
  const detection=await detect('data:image/png;base64,'+restored.imageBase64,p.signal),match=matchTurboActors(actors,detection,expectedPeople);await record('detection.json',{detection,match});
  if(match.ok&&['single-actor-candidate','single-actor-part-overlap','single-actor-near-duplicate'].includes(String(match.correspondenceEvidence.mode))){
   // The same generated/restored image proceeds to the existing caller's integrity
   // inspection. No extra generation/detection, mask guess, or source-body substitute.
   if(mode!=='production')return unknown('uncertain_generated_person_extent',{actorMatches:match},native);
   const restoredBytes=bytes('data:image/png;base64,'+restored.imageBase64);
   await fs.writeFile(output,restoredBytes,{flag:'wx'});
   const trace={executionMode:mode,compositionMode:'full-frame',reason:match.correspondenceEvidence.mode==='single-actor-near-duplicate'?'uncertain-near-duplicate-body-overlap':match.correspondenceEvidence.mode==='single-actor-part-overlap'?'uncertain-single-actor-part-overlap':'uncertain-generated-person-extent',protectedBackground:false,rawDetectorCount:detection.count,actorMatches:match,model:'Qwen-Image-2.1-Turbo',comfyPromptId:promptId,seed,steps:8,cfg:1,sigmas:TURBO_SIGMAS,cache:'auto/default',automaticRetries:0,sourceSha256:sha(raw),nativeSha256:sha(nativeBytes),transform:prep.transform,sourceFovRetained:true,frameRestoration:'generated-content-only; remove saved letterbox padding',geometryStatus:'full-frame-restored',rawNativePath:native,artifactDir:dir,timings:{totalToDisplayMs:Date.now()-started,generationMs,prepareMs:prep.prepareMs,preparePngMs:prep.preparePngMs,restoreMs:restored.restoreMs,restorePngMs:restored.detectorPngMs,detectorMs:detection.elapsedMs},qualityPass:null};
   await record('trace.json',trace);return {buffer:restoredBytes,dataUrl:`data:image/png;base64,${restoredBytes.toString('base64')}`,trace};
  }
  const composition=await rpc({op:'final',key,variant:'after',actors:match.ok?match.actors:[],protected:p.protectedBoxes||[],actorEvidenceComplete:match.ok,output},p.signal);
  const totalMs=Date.now()-started;
  await rpc({op:'diagnostics',key,folder:dir},p.signal);
  const trace={executionMode:mode,model:'Qwen-Image-2.1-Turbo',comfyPromptId:promptId,seed,steps:8,cfg:1,sigmas:TURBO_SIGMAS,cache:'auto/default',automaticRetries:0,sourceSha256:sha(raw),nativeSha256:sha(nativeBytes),transform:prep!.transform,geometryProof:composition.evidence,sourceActors:actors,actorMatches:match,protectedBoxes:p.protectedBoxes||[],contextPaddingPixels:16,helperV2Sha256:prep!.helperSha256,geometryStatus:composition.status,rawNativePath:native,artifactDir:dir,timings:{totalToDisplayMs:totalMs,generationMs,prepareMs:prep!.prepareMs,preparePngMs:prep!.preparePngMs,restoreMs:restored.restoreMs,detectorPngMs:restored.detectorPngMs,detectorMs:detection.elapsedMs,composeMs:composition.composeMs,displayPngMs:composition.displayPngMs},qualityPass:null};await record('trace.json',trace);
  if(!match.ok||composition.status!=='composited'||!composition.output)return unknown(!match.ok?match.reason:composition.evidence?.reason||'composition_failed',trace,native);
  const buffer=await fs.readFile(output);return {buffer,dataUrl:`data:image/png;base64,${buffer.toString('base64')}`,trace};
 }catch(e){
  if(promptId&&!(e instanceof TurboCandidateGeometryError)){
   // Remove only our pending prompt, interrupt only if OUR prompt is running.
   try{await http(c.url+'/queue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({delete:[promptId]}),signal:AbortSignal.timeout(5000)});const r=await http(c.url+'/queue',{signal:AbortSignal.timeout(5000)});const q=await r.json();if(q.queue_running?.some((row:any[])=>row[1]===promptId))await http(c.url+'/interrupt',{method:'POST',signal:AbortSignal.timeout(5000)});}catch{}
  }
  if(!(e instanceof TurboCandidateGeometryError))await record('failure.json',{error:String(e),promptId,display:null,automaticRetries:0});throw e;
 }finally{await rpc({op:'release',key}).catch(()=>undefined);}
}


