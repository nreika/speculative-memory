import fs from'node:fs/promises';import path from'node:path';import net from'node:net';import {createHash}from'node:crypto';

export type OperatorSetId='TSC-001'|'TSC-002'|'TSC-003';export type OperatorInputSelection=OperatorSetId|'cycle'|'camera'|'remote-device';
export interface OperatorReplayState {active:boolean;setId:OperatorSetId|'cycle';testRunId:string;currentFrameId:string;offsetSec:number;loop:number;cycle:boolean;pendingSet:OperatorInputSelection|null;[key:string]:unknown}
export interface OperatorInputState {schema:1;inputKind:'test-replay'|'live-camera';replay:OperatorReplayState|null;history:unknown;sourceScope:unknown;observedAtMs:number;[key:string]:unknown}
export interface OperatorReplaySourceParams {test:true;source:'test';recordHistory:false;testSceneId:OperatorSetId;testFrameId:string;testRunId:string;testLoop:number;testSourceStartedAt:string;[key:string]:unknown}
export interface OperatorReplayFrameInfo {id:string;file:string;offsetSec:number;durationSec:number;originalCaptureId:string;originalStartedAt:string;sha256:string;width:number;height:number;personVisibleReviewed?:boolean|null;detectorOccupied?:boolean|null;cameraObstructedReviewed?:boolean|null;[key:string]:unknown}
export interface OperatorLiveSourceParams {source:'live-camera';inputKind:'live-camera';sourceScope:'camera:main'|'camera:remote';capturedAt:string;[key:string]:unknown}
export interface OperatorLiveFrameInfo {id:'camera:main'|'camera:remote';sha256:string;width:number;height:number;[key:string]:unknown}
export type OperatorInputFrame = {schema:1;image:string;sha256:string;suggestedCaptureId:string;state:OperatorInputState;[key:string]:unknown} & ({sourceParams:OperatorReplaySourceParams;sourceFrame:OperatorReplayFrameInfo}|{sourceParams:OperatorLiveSourceParams;sourceFrame:OperatorLiveFrameInfo});
export interface OperatorInputPreview {kind:'replay'|'camera';dataUrl:string;observedAtMs:number;setId?:OperatorSetId|null;frameId?:string|null;loop?:number|null;[key:string]:unknown}
export interface OperatorInputSelectResult {requestId:string;setId:OperatorInputSelection;state:OperatorInputState}
export type OperatorInputErrorCode='CONFIGURATION'|'AUTH_UNAVAILABLE'|'HTTP_REJECTED'|'TIMEOUT'|'TRANSPORT'|'INVALID_RESPONSE'|'UNSUPPORTED_LIVE_FRAME'|'INDETERMINATE';
export class OperatorInputError extends Error {
 constructor(public readonly code:OperatorInputErrorCode,message:string,public readonly indeterminate=false,public readonly httpStatus?:number){super(message);this.name='OperatorInputError';}
}
export interface OperatorInputOptions {env?:NodeJS.ProcessEnv;fetch?:typeof fetch;readToken?:(file:string)=>Promise<string>;timeoutMs?:number;now?:()=>number}
export interface OperatorInputClient {readState():Promise<OperatorInputState>;readPreview():Promise<OperatorInputPreview>;openPreviewStream?(signal:AbortSignal,connectTimeoutMs?:number):Promise<Response>;readFrame():Promise<OperatorInputFrame>;select(request:{setId:OperatorInputSelection;requestId:string;cameraIndex?:number}):Promise<OperatorInputSelectResult>}
const SETS=['TSC-001','TSC-002','TSC-003']as const;const SELECT=[...SETS,'cycle','camera'];const MAX_IMAGE_BYTES=32*1024*1024;
function invalid():never{throw new OperatorInputError('INVALID_RESPONSE','Input bridge returned inconsistent data');}
const object=(x:unknown):x is Record<string,any>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const integer=(x:unknown,min=0)=>Number.isSafeInteger(x)&&Number(x)>=min;
const finite=(x:unknown,min=0)=>typeof x==='number'&&Number.isFinite(x)&&x>=min;
const runId=(x:unknown)=>typeof x==='string'&&/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(x);
const timestamp=(x:unknown)=>typeof x==='string'&&x.length<=64&&Number.isFinite(Date.parse(x));
const sha=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const frameId=(x:unknown,setId:unknown)=>typeof x==='string'&&SETS.includes(setId as OperatorSetId)&&new RegExp('^'+setId+'-F[0-9]{3,8}$').test(x);
function pinned<T>(value:T):T{const copy=structuredClone(value);function freeze(x:any){if(x&&typeof x==='object'){for(const v of Object.values(x))freeze(v);Object.freeze(x);}}freeze(copy);return copy;}
function validateState(value:unknown):OperatorInputState {
 if(!object(value)||value.schema!==1||!['test-replay','live-camera'].includes(value.inputKind)||!integer(value.observedAtMs)||!Object.hasOwn(value,'history')||!Object.hasOwn(value,'sourceScope'))invalid();
 let r=value.replay;
 // live-camera (2026-10-19): the bridge reports an idle replay object {active:false,setId:null,cycle,pendingSet} instead of null;
 // normalise it to null so the strict test-replay checks below do not reject the live state ("inconsistent data" / 504 on select).
 if(value.inputKind==='live-camera'&&object(r)&&r.active===false&&(r.setId===null||r.setId===undefined)&&(r.pendingSet===null||r.pendingSet===undefined||SELECT.includes(r.pendingSet))){r=null;(value as Record<string,unknown>).replay=null;}
 if(value.inputKind==='test-replay'||r!==null){
  if(!object(r)||typeof r.active!=='boolean'||![...SETS,'cycle'].includes(r.setId)||!runId(r.testRunId)||typeof r.currentFrameId!=='string'||r.currentFrameId.length>128||!finite(r.offsetSec)||!integer(r.loop,1)||typeof r.cycle!=='boolean'||!(r.pendingSet===null||SELECT.includes(r.pendingSet)))invalid();
  if(r.setId!=='cycle'&&!frameId(r.currentFrameId,r.setId))invalid();
 }
 return value as OperatorInputState;
}
function image(data:unknown):{bytes:Buffer;width:number;height:number;sha256:string}{
 if(typeof data!=='string'||data.length>Math.ceil(MAX_IMAGE_BYTES*4/3)+128)invalid();const m=/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);if(!m||m[2].length%4!==0)invalid();
 const bytes=Buffer.from(m[2],'base64');if(!bytes.length||bytes.length>MAX_IMAGE_BYTES||bytes.toString('base64')!==m[2])invalid();let width=0,height=0;
 if(m[1]==='png'){
  if(bytes.length<45||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',bytes.length-8,bytes.length-4)!=='IEND')invalid();width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);
 }else{
  if(bytes.length<12||bytes.readUInt16BE(0)!==0xffd8||bytes.readUInt16BE(bytes.length-2)!==0xffd9)invalid();let i=2;
  while(i<bytes.length-2){if(bytes[i++]!==0xff)invalid();while(bytes[i]===0xff)i++;const marker=bytes[i++];if(marker===0xda)break;if(marker===0xd8||marker===0x01||marker>=0xd0&&marker<=0xd7)continue;if(i+2>bytes.length)invalid();const n=bytes.readUInt16BE(i);if(n<2||i+n>bytes.length)invalid();if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){if(n<8)invalid();height=bytes.readUInt16BE(i+3);width=bytes.readUInt16BE(i+5);}i+=n;}
 }
 if(!integer(width,1)||!integer(height,1)||width>8192||height>8192||width*height>16*1024*1024)invalid();return {bytes,width,height,sha256:createHash('sha256').update(bytes).digest('hex')};
}
function validateFrame(value:unknown,now=Date.now()):OperatorInputFrame {
 if(!object(value)||value.schema!==1)invalid();const state=validateState(value.state);
 if(state.inputKind==='live-camera'){
  const p=value.sourceParams,f=value.sourceFrame;
  if(!object(p)||!object(f)||p.source!=='live-camera'||p.inputKind!=='live-camera'||p.sourceScope!=='camera:main'||!timestamp(p.capturedAt)||!p.capturedAt.endsWith('Z')||p.test!==undefined||p.recordHistory!==undefined||Object.keys(p).some(k=>k.startsWith('test'))||state.sourceScope!=='camera:main'||f.id!=='camera:main'||!sha(value.sha256)||f.sha256!==value.sha256)invalid();
  const age=now-Date.parse(p.capturedAt);if(!Number.isFinite(age)||age>2000||age< -2000)invalid();
  const im=image(value.image);if(im.sha256!==value.sha256||f.width!==im.width||f.height!==im.height||typeof value.suggestedCaptureId!=='string'||!/^camera-[0-9]{10,16}-[a-f0-9]{8}$/.test(value.suggestedCaptureId))invalid();
  return value as OperatorInputFrame;
 }
 const p=value.sourceParams,f=value.sourceFrame,r=state.replay!;if(!object(p)||!object(f)||p.test!==true||p.source!=='test'||p.recordHistory!==false||!SETS.includes(p.testSceneId)||!frameId(p.testFrameId,p.testSceneId)||!runId(p.testRunId)||!integer(p.testLoop,1)||!timestamp(p.testSourceStartedAt))invalid();
 if(f.id!==p.testFrameId||!sha(value.sha256)||f.sha256!==value.sha256||!finite(f.offsetSec)||!finite(f.durationSec)||!timestamp(f.originalStartedAt)||Date.parse(f.originalStartedAt)!==Date.parse(p.testSourceStartedAt)||typeof f.originalCaptureId!=='string'||!f.originalCaptureId||f.originalCaptureId.length>200)invalid();
 if(typeof f.file!=='string'||f.file.length>256||f.file.startsWith('/')||f.file.includes('\\')||f.file.split('/').includes('..')||!/^frames\/[A-Za-z0-9_-]+\.(?:jpe?g|png)$/i.test(f.file))invalid();
 for(const key of ['personVisibleReviewed','detectorOccupied','cameraObstructedReviewed'])if(f[key]!==undefined&&f[key]!==null&&typeof f[key]!=='boolean')invalid();
 if(!r.active||r.currentFrameId!==f.id||r.testRunId!==p.testRunId||r.loop!==p.testLoop||!(r.setId===p.testSceneId||r.setId==='cycle'&&r.cycle))invalid();
 const im=image(value.image);if(im.sha256!==value.sha256||f.width!==im.width||f.height!==im.height)invalid();
 if(typeof value.suggestedCaptureId!=='string'||!new RegExp('^test-'+p.testFrameId+'-L'+String(p.testLoop).padStart(3,'0')+'-[0-9]{10,16}$').test(value.suggestedCaptureId))invalid();
 return value as OperatorInputFrame;
}
function validatePreview(value:unknown):OperatorInputPreview {
 if(!object(value)||!['replay','camera'].includes(value.kind)||!integer(value.observedAtMs))invalid();image(value.dataUrl);
 if(value.kind==='replay'&&(!SETS.includes(value.setId)||!frameId(value.frameId,value.setId)||!integer(value.loop,1)))invalid();return value as OperatorInputPreview;
}
function configured(env:NodeJS.ProcessEnv){try{const u=new URL(env.TD_CONTROL_BRIDGE_URL||''),[a,b]=u.hostname.split('.').map(Number);if(u.protocol!=='http:'||net.isIP(u.hostname)!==4||a!==100||b<64||b>127||u.port!=='8767'||u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw Error();const file=env.TD_CONTROL_BRIDGE_TOKEN_FILE;if(!file||!path.isAbsolute(file))throw Error();return {origin:u.origin,file};}catch{throw new OperatorInputError('CONFIGURATION','Input bridge configuration is unavailable or invalid');}}
async function jsonBody(response:Response):Promise<unknown>{
 const limit=48*1024*1024,declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>limit)invalid();
 if(!response.body)invalid();const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit){await reader.cancel();invalid();}chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch(error){if(error instanceof OperatorInputError)throw error;invalid();}finally{reader.releaseLock();}
}
/** Private fixed-endpoint client only. No public route and no automatic mutation retry. */
export function createOperatorInputClient(options:OperatorInputOptions={}):OperatorInputClient {
 const env=options.env??process.env,http=options.fetch??fetch,read=options.readToken??(file=>fs.readFile(file,'utf8')),timeout=options.timeoutMs??5000;
 if(!Number.isInteger(timeout)||timeout<1||timeout>30000)throw new OperatorInputError('CONFIGURATION','Invalid input bridge timeout');
 async function request<T>(endpoint:'state'|'preview'|'frame'|'select',validate:(data:unknown)=>T,payload?:{setId:OperatorInputSelection;requestId:string;cameraIndex?:number}):Promise<T>{
  const {origin,file}=configured(env),mutation=endpoint==='select',ctrl=new AbortController();let dispatched=false,timer:ReturnType<typeof setTimeout>;
  const work=async()=>{try{let token:string;try{token=(await read(file)).trim();}catch{throw new OperatorInputError('AUTH_UNAVAILABLE','Input bridge authorization is unavailable');}ctrl.signal.throwIfAborted();if(!/^[A-Za-z0-9_-]{32,512}$/.test(token))throw new OperatorInputError('AUTH_UNAVAILABLE','Input bridge authorization is unavailable');
   const headers:Record<string,string>={Authorization:'Bearer '+token};if(mutation){headers['Content-Type']='application/json';headers['X-Control-Request']='1';}dispatched=true;
   const response=await http(origin+'/api/input/'+endpoint,{method:mutation?'POST':'GET',headers,signal:ctrl.signal,redirect:'error',cache:'no-store',...(mutation?{body:JSON.stringify(payload)}:{})});ctrl.signal.throwIfAborted();
   if(!response.ok){if(mutation&&(response.status>=500||response.status===408))throw new OperatorInputError('INDETERMINATE','Input selection outcome is unknown; do not resend automatically',true,response.status);throw new OperatorInputError('HTTP_REJECTED','Input bridge rejected the request',false,response.status);}
   return pinned(validate(await jsonBody(response)));
  }catch(error){if(error instanceof OperatorInputError){if(mutation&&dispatched&&error.code==='INVALID_RESPONSE')throw new OperatorInputError('INDETERMINATE','Input selection outcome is unknown; do not resend automatically',true);throw error;}throw new OperatorInputError(mutation&&dispatched?'INDETERMINATE':ctrl.signal.aborted?'TIMEOUT':'TRANSPORT',mutation&&dispatched?'Input selection outcome is unknown; do not resend automatically':'Input bridge request failed',mutation&&dispatched);}};
  const deadline=new Promise<T>((_,reject)=>{timer=setTimeout(()=>{ctrl.abort();reject(new OperatorInputError(mutation&&dispatched?'INDETERMINATE':'TIMEOUT',mutation&&dispatched?'Input selection outcome is unknown; do not resend automatically':'Input bridge request timed out',mutation&&dispatched));},timeout);});
  try{return await Promise.race([work(),deadline]);}finally{clearTimeout(timer!);}
 }
 async function openPreviewStream(signal:AbortSignal,connectTimeoutMs=10000):Promise<Response>{
  const {origin,file}=configured(env);let token:string;
  try{token=(await read(file)).trim();}catch{throw new OperatorInputError('AUTH_UNAVAILABLE','Input bridge authorization is unavailable');}
  if(!/^[A-Za-z0-9_-]{32,512}$/.test(token))throw new OperatorInputError('AUTH_UNAVAILABLE','Input bridge authorization is unavailable');
  const ctrl=new AbortController(),onAbort=()=>ctrl.abort();if(signal.aborted)ctrl.abort();else signal.addEventListener('abort',onAbort,{once:true});
  const timer=setTimeout(()=>ctrl.abort(),connectTimeoutMs);
  try{const response=await http(origin+'/api/input/preview/stream',{method:'GET',headers:{Authorization:'Bearer '+token},signal:ctrl.signal,redirect:'error',cache:'no-store'});
   if(!response.ok||!response.body){await response.body?.cancel().catch(()=>{});throw new OperatorInputError('HTTP_REJECTED','Input bridge rejected the preview stream',false,response.status);}return response;}
  catch(error){signal.removeEventListener('abort',onAbort);if(error instanceof OperatorInputError)throw error;throw new OperatorInputError(ctrl.signal.aborted?'TIMEOUT':'TRANSPORT','Input bridge preview stream failed');}
  finally{clearTimeout(timer);}
 }
 return {openPreviewStream,readState:()=>request('state',validateState),readPreview:()=>request('preview',validatePreview),readFrame:()=>request('frame',value=>validateFrame(value,(options.now??Date.now)())),select:async payload=>{
  if(!object(payload)||!SELECT.includes(payload.setId)||typeof payload.requestId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(payload.requestId)||Object.keys(payload).some(k=>!['setId','requestId','cameraIndex'].includes(k))||payload.cameraIndex!==undefined&&(payload.setId!=='camera'||!Number.isInteger(payload.cameraIndex)||payload.cameraIndex<0||payload.cameraIndex>3))throw new OperatorInputError('CONFIGURATION','Invalid input selection');
  return request('select',data=>{if(!object(data))invalid();if(data.requestId!==undefined&&data.requestId!==payload.requestId)invalid();const state=validateState(object(data.state)?data.state:data);return {requestId:payload.requestId,setId:payload.setId,state};},payload);
 }};
}

/** Live-camera MJPEG pass-through. Caller guarantees the control access checks; this only bounds and pipes. */
export const MAX_PREVIEW_STREAMS=3;
let activePreviewStreams=0;
export function previewStreamCount(){return activePreviewStreams;}
export async function servePreviewStream(client:OperatorInputClient,isLive:()=>Promise<boolean>|boolean,req:any,res:any):Promise<void>{
 const json=(status:number,body:unknown)=>{if(res.headersSent)return;res.setHeader('Cache-Control','no-store');res.status(status).json(body);};
 if(!client.openPreviewStream)return json(409,{error:'not-live'});
 if(activePreviewStreams>=MAX_PREVIEW_STREAMS)return json(429,{error:'too-many-streams'});
 activePreviewStreams++;const ctrl=new AbortController();let released=false;
 const release=()=>{if(released)return;released=true;activePreviewStreams--;ctrl.abort();};
 res.on?.('close',release);req.on?.('close',release);
 try{
  if(!await isLive())return json(409,{error:'not-live'});
  const upstream=await client.openPreviewStream(ctrl.signal);
  if(released){await upstream.body?.cancel().catch(()=>{});return;}
  res.status(200);res.setHeader('Content-Type',upstream.headers.get('content-type')||'multipart/x-mixed-replace');
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.flushHeaders?.();
  const reader=upstream.body!.getReader();
  try{while(!released){const {value,done}=await reader.read();if(done)break;if(!res.write(Buffer.from(value))&&!released&&res.once)await new Promise<void>(resolve=>{const off=()=>{res.off?.('drain',off);res.off?.('close',off);resolve();};res.once('drain',off);res.once('close',off);});}}
  finally{reader.cancel().catch(()=>{});}
  res.end();
 }catch(error){if(res.headersSent){res.end?.();}else json([404,503].includes((error as any)?.httpStatus)?(error as any).httpStatus:502,{error:'stream-unavailable'});}
 finally{release();}
}
