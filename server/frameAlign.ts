/** CPU framing check (scripts/frame-align.py: ORB + RANSAC partial affine + Canny edge IoU) for the pre-publish
 * framing_drift check (2026-10-19: a published C output was zoomed/shifted and lost the belongings on the chair).
 * One subprocess per image; stdin base64 source+output, stdout JSON. Never writes, never calls a network/AI service. */
import path from 'node:path';import fs from 'node:fs';import {spawn} from 'node:child_process';
import {defaultHandPython} from './handCount';
export interface FrameAlignResult {
 status:'aligned'|'no-alignment'|'unavailable'|'error';
 scale?:number;dx?:number;dy?:number;rotationDeg?:number;inliers?:number;inlierRatio?:number;matches?:number;
 edgeIou?:number;edgeIouAligned?:number;detectorMs?:number;elapsedMs?:number;method?:string;
}
export interface FrameAlignOptions {python?:string;worker?:string;timeoutMs?:number;signal?:AbortSignal}
const defaultWorker=()=>path.resolve('scripts/frame-align.py');
const fail=(status:'unavailable'|'error'):FrameAlignResult=>({status});
const num=(v:unknown,lo:number,hi:number)=>typeof v==='number'&&Number.isFinite(v)&&v>=lo&&v<=hi;
/** Validates the worker's JSON; anything malformed is an error (never a silent pass value). */
export function parseFrameAlign(raw:unknown):FrameAlignResult {
 const r=raw as Record<string,unknown>|null;
 if(!r||typeof r!=='object')return fail('error');
 if(r.status==='unavailable')return fail('unavailable');
 if(r.status!=='aligned'&&r.status!=='no-alignment')return fail('error');
 if(!num(r.edgeIou,0,1)||!num(r.inliers??0,0,1e6))return fail('error');
 const out:FrameAlignResult={status:r.status,edgeIou:r.edgeIou as number,inliers:Math.round((r.inliers as number)??0)};
 if(r.status==='aligned'){
  if(!num(r.scale,0.01,100)||!num(r.dx,-100,100)||!num(r.dy,-100,100)||!num(r.rotationDeg,-180,180))return fail('error');
  Object.assign(out,{scale:r.scale,dx:r.dx,dy:r.dy,rotationDeg:r.rotationDeg});
 }
 if(num(r.inlierRatio,0,1))out.inlierRatio=r.inlierRatio as number;
 if(num(r.matches,0,1e6))out.matches=Math.round(r.matches as number);
 if(num(r.edgeIouAligned,0,1))out.edgeIouAligned=r.edgeIouAligned as number;
 if(num(r.ms,0,1e7))out.detectorMs=Math.round(r.ms as number);
 if(typeof r.method==='string')out.method=r.method.slice(0,64);
 return out;
}
const isImage=(b:Buffer)=>b.length>=12&&(b.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))||(b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)||(b.toString('latin1',0,4)==='RIFF'&&b.toString('latin1',8,12)==='WEBP'));

function spawnAlign(source:Buffer,output:Buffer,options:FrameAlignOptions={}):Promise<FrameAlignResult>{
 if(!isImage(source)||!isImage(output)||source.length>24*1024*1024||output.length>24*1024*1024)return Promise.resolve(fail('error'));
 const python=options.python??defaultHandPython(),worker=options.worker??defaultWorker(),timeout=options.timeoutMs??8000;
 if(!path.isAbsolute(python)||!fs.existsSync(python)||!fs.existsSync(worker))return Promise.resolve(fail('unavailable'));
 const started=Date.now();
 return new Promise<FrameAlignResult>(resolve=>{
  const child=spawn(python,['-u',worker],{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',done=false;
  const finish=(r:FrameAlignResult)=>{if(done)return;done=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);resolve({...r,elapsedMs:Date.now()-started});};
  const abort=()=>{child.kill();finish(fail('error'));};
  const timer=setTimeout(abort,timeout);options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  child.stderr.resume();child.on('error',()=>finish(fail('unavailable')));child.stdin.on('error',()=>finish(fail('error')));
  child.stdout.on('data',chunk=>{out+=String(chunk);if(out.length>100000){child.kill();finish(fail('error'));}});
  child.on('close',()=>{try{finish(parseFrameAlign(JSON.parse(out)));}catch{finish(fail('error'));}});
  child.stdin.end(JSON.stringify({source:source.toString('base64'),output:output.toString('base64')}));
 });
}
/** Mutable seam so tests can replace the subprocess (t.mock.method(frameAligner,'align',...)). */
export const frameAligner={align:spawnAlign};
let warned=false;
const bytes=(image:string|Buffer)=>Buffer.isBuffer(image)?image:Buffer.from(image.replace(/^data:image\/[^;]+;base64,/,''),'base64');
/** Measures OUTPUT framing against SOURCE (data URLs / base64 / buffers); logs the first unavailable/error once. */
export async function alignFrames(source:string|Buffer,output:string|Buffer,options:FrameAlignOptions={}):Promise<FrameAlignResult>{
 let s:Buffer,o:Buffer;
 try{s=bytes(source);o=bytes(output);}catch{return fail('error');}
 let r:FrameAlignResult;
 try{r=await frameAligner.align(s,o,options);}catch{r=fail('error');}
 if((r.status==='unavailable'||r.status==='error')&&!warned){warned=true;console.warn(`[frame-align] CPU framing check ${r.status}; framing_drift check is skipped (VLM-only inspection; python=${defaultHandPython()})`);}
 return r;
}
