/** CPU hand count (MediaPipe HandLandmarker via scripts/hand-count.py) for the pre-publish extra-hand check.
 * One subprocess per image; stdin base64 image, stdout JSON. Never writes, never calls a network/AI service. */
import path from 'node:path';import fs from 'node:fs';import {spawn} from 'node:child_process';
export interface HandBox {x:number;y:number;w:number;h:number;score:number}
export interface HandCountResult {status:'detected'|'no-hands'|'unavailable'|'error';count:number;hands:HandBox[];detectorMs?:number;elapsedMs?:number;method?:string}
export interface HandCountOptions {python?:string;worker?:string;model?:string;timeoutMs?:number;signal?:AbortSignal}

const home=process.env.USERPROFILE||process.env.HOME||'';
/** Same private CPU venv as the face boxes (FACE_DETECTOR_PYTHON), unless HAND_DETECTOR_PYTHON overrides it. */
export const defaultHandPython=()=>process.env.HAND_DETECTOR_PYTHON||process.env.FACE_DETECTOR_PYTHON||path.join(home,'claude-code/runtime-face-detector/Scripts/python.exe');
/** Model lives outside the repository (never committed). */
export const defaultHandModel=()=>process.env.HAND_LANDMARKER_MODEL||path.join(home,'GitHub/speculative-memory_data/models/hand_landmarker.task');
const defaultWorker=()=>path.resolve('scripts/hand-count.py');

const fail=(status:'unavailable'|'error'):HandCountResult=>({status,count:0,hands:[]});
const unit=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1.000001;
/** Validates the worker's JSON; anything malformed is an error (never a silent zero that could pass a bad image). */
export function parseHandCount(raw:unknown):HandCountResult {
 const r=raw as {status?:unknown;hands?:unknown;count?:unknown;detectorMs?:unknown;method?:unknown}|null;
 if(!r||typeof r!=='object')return fail('error');
 if(r.status==='unavailable')return fail('unavailable');
 if(r.status!=='detected'&&r.status!=='no-hands')return fail('error');
 if(!Array.isArray(r.hands)||r.hands.length>32)return fail('error');
 const hands:HandBox[]=[];
 for(const h of r.hands as Array<Record<string,unknown>>){
  if(!h||![h.x,h.y,h.w,h.h].every(unit)||(h.w as number)<=0||(h.h as number)<=0||(h.x as number)+(h.w as number)>1.000001||(h.y as number)+(h.h as number)>1.000001)return fail('error');
  hands.push({x:h.x as number,y:h.y as number,w:h.w as number,h:h.h as number,score:unit(h.score)?h.score as number:0});
 }
 if(r.count!==hands.length||(r.status==='detected')!==(hands.length>0))return fail('error');
 return {status:r.status,count:hands.length,hands,...(typeof r.detectorMs==='number'&&Number.isFinite(r.detectorMs)?{detectorMs:Math.round(r.detectorMs)}:{}),...(typeof r.method==='string'?{method:r.method.slice(0,64)}:{})};
}
const isImage=(b:Buffer)=>b.length>=12&&(b.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))||(b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)||(b.toString('latin1',0,4)==='RIFF'&&b.toString('latin1',8,12)==='WEBP'));

function spawnCount(image:Buffer,options:HandCountOptions={}):Promise<HandCountResult>{
 if(!isImage(image)||image.length>24*1024*1024)return Promise.resolve(fail('error'));
 const python=options.python??defaultHandPython(),worker=options.worker??defaultWorker(),model=options.model??defaultHandModel(),timeout=options.timeoutMs??8000;
 if(!path.isAbsolute(python)||!fs.existsSync(python)||!fs.existsSync(worker)||!fs.existsSync(model))return Promise.resolve(fail('unavailable'));
 const started=Date.now();
 return new Promise<HandCountResult>(resolve=>{
  const child=spawn(python,['-u',worker,model],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='',done=false;
  const finish=(r:HandCountResult)=>{if(done)return;done=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);resolve({...r,elapsedMs:Date.now()-started});};
  const abort=()=>{child.kill();finish(fail('error'));};
  const timer=setTimeout(abort,timeout);options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  child.stderr.resume();child.on('error',()=>finish(fail('unavailable')));child.stdin.on('error',()=>finish(fail('error')));
  child.stdout.on('data',chunk=>{output+=String(chunk);if(output.length>100000){child.kill();finish(fail('error'));}});
  child.on('close',()=>{try{finish(parseHandCount(JSON.parse(output)));}catch{finish(fail('error'));}});
  child.stdin.end(JSON.stringify({image:image.toString('base64')}));
 });
}
/** Mutable seam so tests can replace the subprocess (t.mock.method(handCounter,'count',...)). */
export const handCounter={count:spawnCount};
let warned=false;
/** Counts hands in a data URL / base64 image; logs the first unavailable/error once, then stays quiet. */
export async function countHands(image:string|Buffer,options:HandCountOptions={}):Promise<HandCountResult>{
 let bytes:Buffer;
 try{bytes=Buffer.isBuffer(image)?image:Buffer.from(image.replace(/^data:image\/[^;]+;base64,/,''),'base64');}catch{return fail('error');}
 let r:HandCountResult;
 try{r=await handCounter.count(bytes,options);}catch{r=fail('error');}
 if((r.status==='unavailable'||r.status==='error')&&!warned){warned=true;console.warn(`[hand-count] CPU hand detector ${r.status}; extra-hand check falls back to the VLM count only (python=${defaultHandPython()}, model=${defaultHandModel()})`);}
 return r;
}
