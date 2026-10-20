/** Remote phone camera ("remote-device" input). Keeps only the latest frame in memory; nothing is written to disk here. */
import {createHash} from 'node:crypto';
import {OperatorInputError,type OperatorInputClient,type OperatorInputFrame,type OperatorInputSelection,type OperatorInputState} from './operatorInput';

export const REMOTE_FRAME_WIDTH=1280,REMOTE_FRAME_HEIGHT=720,REMOTE_MAX_FRAME_BYTES=2*1024*1024;
export type RemoteCameraState='none'|'fresh'|'stale';
export interface RemoteFrame {image:Buffer;sha256:string;width:number;height:number;receivedAtMs:number}
export interface RemoteCameraStatus {selected:boolean;state:RemoteCameraState;ageSec:number|null;receivedAt:string|null;staleSec:number;intervalSec:number}

function envSec(name:string,fallback:number,min:number,max:number){const n=Number(process.env[name]);return Number.isFinite(n)&&n>=min&&n<=max?n:fallback;}
export const remoteStaleSec=()=>envSec('REMOTE_STALE_SEC',30,5,600);
export const captureIntervalSec=()=>{const n=envSec('CAPTURE_INTERVAL_SEC',10,1,120);return [5,10,20].includes(n)?n:10;};

/** Baseline JPEG/progressive SOF size check (same marker walk as operatorInput.image()). */
export function jpegSize(bytes:Buffer):{width:number;height:number}|null{
 if(bytes.length<12||bytes.readUInt16BE(0)!==0xffd8||bytes.readUInt16BE(bytes.length-2)!==0xffd9)return null;
 let i=2,width=0,height=0;
 while(i<bytes.length-2){
  if(bytes[i++]!==0xff)return null;while(bytes[i]===0xff)i++;const marker=bytes[i++];
  if(marker===0xda)break;if(marker===0xd8||marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
  if(i+2>bytes.length)return null;const n=bytes.readUInt16BE(i);if(n<2||i+n>bytes.length)return null;
  if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){if(n<8)return null;height=bytes.readUInt16BE(i+3);width=bytes.readUInt16BE(i+5);}
  i+=n;
 }
 return width>0&&height>0?{width,height}:null;
}

export class RemoteFrameError extends Error{constructor(public readonly status:number,message:string){super(message);}}

export class RemoteCameraStore {
 private frame:RemoteFrame|null=null;
 selected=false;
 constructor(private readonly options:{now?:()=>number;staleSec?:()=>number}={}){}
 private now(){return (this.options.now??Date.now)();}
 staleSec(){return (this.options.staleSec??remoteStaleSec)();}
 /** Validates a 1280x720 JPEG and replaces the previous frame. */
 setFrame(bytes:Buffer):RemoteFrame{
  if(!Buffer.isBuffer(bytes)||!bytes.length)throw new RemoteFrameError(400,'Empty frame');
  if(bytes.length>REMOTE_MAX_FRAME_BYTES)throw new RemoteFrameError(413,'Frame too large');
  const size=jpegSize(bytes);if(!size)throw new RemoteFrameError(400,'Frame must be a JPEG image');
  if(size.width!==REMOTE_FRAME_WIDTH||size.height!==REMOTE_FRAME_HEIGHT)throw new RemoteFrameError(400,'Frame must be 1280x720');
  this.frame={image:Buffer.from(bytes),sha256:createHash('sha256').update(bytes).digest('hex'),...size,receivedAtMs:this.now()};
  return this.frame;
 }
 latest():RemoteFrame|null{return this.frame;}
 state():RemoteCameraState{if(!this.frame)return 'none';return this.now()-this.frame.receivedAtMs<=this.staleSec()*1000?'fresh':'stale';}
 /** A fresh frame or null (none / older than REMOTE_STALE_SEC). */
 fresh():RemoteFrame|null{return this.state()==='fresh'?this.frame:null;}
 status():RemoteCameraStatus{
  const f=this.frame;
  return {selected:this.selected,state:this.state(),ageSec:f?Math.max(0,Math.round((this.now()-f.receivedAtMs)/1000)):null,receivedAt:f?new Date(f.receivedAtMs).toISOString():null,staleSec:this.staleSec(),intervalSec:captureIntervalSec()};
 }
 clear(){this.frame=null;}
}

/** Process-wide store shared by the public gate (writer) and the native operator (reader). */
export const remoteCamera=new RemoteCameraStore();

export const REMOTE_STALE_MESSAGE='remote camera stale';
export const remoteStaleMessage=(store:RemoteCameraStore)=>{const s=store.status();return s.state==='none'?REMOTE_STALE_MESSAGE+' (no frame received yet)':REMOTE_STALE_MESSAGE+` (last frame ${s.ageSec} s ago)`;};

export type RemoteAwareInputClient=OperatorInputClient&{remote():RemoteCameraStatus};
/**
 * Wraps the laptop input bridge. "remote-device" is selected in Node only (the laptop bridge is not told);
 * any other selection is forwarded and turns remote mode off. The selection is not persisted: after a restart
 * the laptop's own selection applies again, so a forgotten phone cannot keep writing venue history.
 */
export function withRemoteCamera(base:OperatorInputClient,store:RemoteCameraStore=remoteCamera):RemoteAwareInputClient{
 if((base as any).remote)return base as RemoteAwareInputClient;
 const remoteState=async():Promise<OperatorInputState>=>{
  let history:unknown=null;try{history=(await base.readState()).history??null;}catch{/* laptop bridge optional in remote mode */}
  const s=store.status();
  return {schema:1,inputKind:'live-camera',replay:null,history,sourceScope:'camera:remote',observedAtMs:Date.now(),remoteCamera:s};
 };
 return {
  remote:()=>store.status(),
  readState:()=>store.selected?remoteState():base.readState(),
  readPreview:async()=>{
   if(!store.selected)return base.readPreview();
   const f=store.latest();if(!f)throw new OperatorInputError('UNSUPPORTED_LIVE_FRAME',remoteStaleMessage(store));
   return {kind:'camera',dataUrl:'data:image/jpeg;base64,'+f.image.toString('base64'),observedAtMs:f.receivedAtMs,remote:true,state:store.state()};
  },
  readFrame:async()=>{
   if(!store.selected)return base.readFrame();
   const f=store.fresh();if(!f)throw new OperatorInputError('UNSUPPORTED_LIVE_FRAME',remoteStaleMessage(store));
   const state=await remoteState(),capturedAt=new Date(f.receivedAtMs).toISOString();
   return {schema:1,image:'data:image/jpeg;base64,'+f.image.toString('base64'),sha256:f.sha256,suggestedCaptureId:`remote-${f.receivedAtMs}-${f.sha256.slice(0,8)}`,state,
    sourceParams:{source:'live-camera',inputKind:'live-camera',sourceScope:'camera:remote',capturedAt},
    sourceFrame:{id:'camera:remote',sha256:f.sha256,width:f.width,height:f.height}} as OperatorInputFrame;
  },
  select:async request=>{
   if(request.setId==='remote-device'){store.selected=true;return {requestId:request.requestId,setId:request.setId,state:await remoteState()};}
   const result=await base.select(request as {setId:Exclude<OperatorInputSelection,'remote-device'>;requestId:string});store.selected=false;return result;
  }
 };
}
