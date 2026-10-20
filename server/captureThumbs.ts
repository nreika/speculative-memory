import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';

/** History thumbnails: captures/thumbs/<name without extension>.jpg, 320 px wide JPEG.
 * Presentation derivatives only (never artwork or provenance). Only top-level capture files qualify. */
export const THUMB_DIRNAME='thumbs';
export const THUMB_URL_PREFIX='/captures/thumbs/';
export const THUMB_WIDTH=320,THUMB_QUALITY=75;
const SOURCE_NAME=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,239}\.(?:png|jpe?g|webp)$/i;

/** captures/<file> basename -> thumbnail filename, or null when the file is not a capture image. */
export function thumbName(file:string):string|null{
 if(typeof file!=='string'||/[\\/]/.test(file)||!SOURCE_NAME.test(file))return null;
 return path.parse(file).name+'.jpg';
}
/** '/captures/<file>' -> '/captures/thumbs/<name>.jpg'; null for anything else (subfolders, thumbs, foreign URLs). */
export function thumbUrlForImage(imageUrl:unknown):string|null{
 if(typeof imageUrl!=='string')return null;const m=/^\/captures\/([^/?#%\\]+)$/.exec(imageUrl);if(!m)return null;
 const name=thumbName(m[1]);return name?THUMB_URL_PREFIX+name:null;
}

/** FIFO limiter; priority tasks jump the queue (capture-time work before history backfill). */
export function createLimiter(concurrency:number){
 const max=Math.max(1,Math.floor(concurrency)||1);let active=0,maxObserved=0;const waiting:Array<()=>void>=[];
 async function run<T>(task:()=>Promise<T>,priority=false):Promise<T>{
  if(active>=max)await new Promise<void>(resolve=>priority?waiting.unshift(resolve):waiting.push(resolve));else active++;
  maxObserved=Math.max(maxObserved,active);
  try{return await task();}finally{const next=waiting.shift();if(next)next();else active--;}
 }
 return {run,stats:()=>({active,pending:waiting.length,maxObserved})};
}

const PY=String.raw`
import sys,os
from PIL import Image,ImageOps
Image.MAX_IMAGE_PIXELS=64*1024*1024
w=int(sys.argv[1]);q=int(sys.argv[2]);a=sys.argv[3:]
for i in range(0,len(a)-1,2):
 s,o=a[i],a[i+1];t=o+'.tmp'
 try:
  with Image.open(s) as im:
   im.draft('RGB',(w,w))
   im=ImageOps.exif_transpose(im)
   if im.width>w:im=im.resize((w,max(1,round(im.height*w/im.width))),Image.Resampling.LANCZOS)
   if im.mode in ('RGBA','LA','P','PA') or 'transparency' in im.info:
    rgba=im.convert('RGBA');bg=Image.new('RGB',rgba.size,(16,21,29));bg.paste(rgba,mask=rgba.getchannel('A'));im=bg
   elif im.mode!='RGB':im=im.convert('RGB')
   im.save(t,'JPEG',quality=q,optimize=True)
  os.replace(t,o);print('ok',flush=True)
 except Exception as e:
  try:os.remove(t)
  except Exception:pass
  print('err',type(e).__name__,str(e)[:160].replace('\n',' '),flush=True)
`;

export type ThumbJob={source:string;output:string;priority?:boolean};
export type BatchRunner=(jobs:ThumbJob[])=>Promise<void>;
export interface CaptureThumbOptions{
 capturesDir:string;python?:string;width?:number;quality?:number;
 /** Files per python process (one spawn amortised over several images). */
 batchSize?:number;concurrency?:number;
 /** Cap on queued on-miss requests; capture-time requests are always accepted. */
 maxQueue?:number;timeoutMs?:number;
 /** Test seam: replaces the python process. */
 runBatch?:BatchRunner;log?:(line:string)=>void;
 /** While true (a capture is running), on-miss history jobs wait; capture-time jobs still run. */
 busy?:()=>boolean;busyRetryMs?:number;
}
export const defaultThumbPython=()=>process.env.THUMB_PYTHON||process.env.FACE_DETECTOR_PYTHON||path.join(process.env.USERPROFILE||'','claude-code/runtime-face-detector/Scripts/python.exe');

export function pythonThumbBatch(python:string,width=THUMB_WIDTH,quality=THUMB_QUALITY,timeoutMs=20000):BatchRunner{
 return jobs=>new Promise<void>((resolve,reject)=>{
  const child=spawn(python,['-c',PY,String(width),String(quality),...jobs.flatMap(j=>[j.source,j.output])],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let out='',err='',done=false;const finish=(e?:Error)=>{if(done)return;done=true;clearTimeout(timer);e?reject(e):resolve();};
  const timer=setTimeout(()=>{child.kill();finish(Error('thumbnail batch timeout'));},timeoutMs+jobs.length*3000);
  child.stdout.on('data',c=>{if(out.length<65536)out+=String(c);});child.stderr.on('data',c=>{if(err.length<4096)err+=String(c);});
  child.once('error',e=>finish(Error('thumbnail python unavailable: '+e.message)));
  child.once('close',code=>{const bad=out.split(/\r?\n/).find(l=>l.startsWith('err '));if(code!==0)finish(Error('thumbnail python exited '+code+': '+err.trim().split(/\r?\n/).pop()));else if(bad)finish(Error('thumbnail failed: '+bad.slice(4)));else finish();});
 });
}

export interface CaptureThumbs{
 /** Capture-time: queue a thumbnail for a file just written into captures/. Never throws, never blocks. */
 enqueue(sourceFile:string):void;
 /** '/captures/x' -> thumb URL when the thumb is known to exist, else null. */
 thumbUrl(imageUrl:unknown):string|null;
 /** History "generate on first miss": queue (low priority, deduped, capped) when the thumb is missing. */
 requestMissing(imageUrl:unknown):void;
 readonly ready:Promise<void>;
 /** Resolves once nothing is queued or running (tests, backfill). */
 idle():Promise<void>;
 diagnostics():{known:number;queued:number;running:number;generated:number;failed:number};
}

export function createCaptureThumbs(options:CaptureThumbOptions):CaptureThumbs{
 const capturesDir=path.resolve(options.capturesDir),dir=path.join(capturesDir,THUMB_DIRNAME);
 const log=options.log??((line:string)=>console.warn(line));
 const runBatch=options.runBatch??pythonThumbBatch(options.python||defaultThumbPython(),options.width??THUMB_WIDTH,options.quality??THUMB_QUALITY,options.timeoutMs);
 const batchSize=Math.max(1,options.batchSize??8),maxQueue=Math.max(1,options.maxQueue??3000),limiter=createLimiter(options.concurrency??1);
 const known=new Set<string>(),queuedNames=new Set<string>(),failedNames=new Set<string>(),queue:ThumbJob[]=[];
 let running=0,generated=0,failed=0,warned=false,deferred:ReturnType<typeof setTimeout>|null=null,idleWaiters:Array<()=>void>=[];
 const ready=fs.promises.mkdir(dir,{recursive:true}).then(()=>fs.promises.readdir(dir)).then(names=>{for(const n of names)if(/\.jpg$/i.test(n))known.add(n);}).catch(error=>{log('[thumbs] thumbnail folder unavailable: '+(error as Error).message);});
 const settleIdle=()=>{if(!queue.length&&!running&&!deferred){const w=idleWaiters;idleWaiters=[];for(const r of w)r();}};
 function add(source:string,priority:boolean){
  const name=thumbName(path.basename(source));if(!name||known.has(name)||queuedNames.has(name)||!priority&&failedNames.has(name))return;
  if(!priority&&queue.length>=maxQueue)return;
  queuedNames.add(name);const job={source,output:path.join(dir,name),priority};priority?queue.unshift(job):queue.push(job);
  if(priority&&deferred){clearTimeout(deferred);deferred=null;}// capture-time work never waits behind a busy back-off
  pump(priority);
 }
 function pump(priority=false){
  if(!queue.length||running>=Math.max(1,options.concurrency??1)||deferred)return;
  let isBusy=false;try{isBusy=!!options.busy?.();}catch{}
  if(isBusy&&!queue[0].priority){deferred=setTimeout(()=>{deferred=null;pump();},options.busyRetryMs??2000);return;}
  running++;
  void limiter.run(async()=>{
   await ready;let take=0;while(take<queue.length&&take<batchSize&&(!isBusy||queue[take].priority))take++;const batch=queue.splice(0,Math.max(1,take));const todo:ThumbJob[]=[];
   for(const job of batch){const name=path.basename(job.output);if(fs.existsSync(job.output)){known.add(name);queuedNames.delete(name);}else todo.push(job);}
   if(!todo.length)return;
   try{await runBatch(todo);}catch(error){failed++;if(!warned){warned=true;log('[thumbs] thumbnail generation failed (further failures are silent): '+(error as Error).message);}}
   for(const job of todo){const name=path.basename(job.output);queuedNames.delete(name);if(fs.existsSync(job.output)){known.add(name);generated++;}else failedNames.add(name);}
  },priority).catch(()=>undefined).finally(()=>{running--;if(queue.length)pump();else settleIdle();});
 }
 return {
  enqueue(sourceFile){try{if(path.dirname(path.resolve(sourceFile)).toLowerCase()===capturesDir.toLowerCase())add(path.resolve(sourceFile),true);}catch{}},
  thumbUrl(imageUrl){const url=thumbUrlForImage(imageUrl);return url&&known.has(url.slice(THUMB_URL_PREFIX.length))?url:null;},
  requestMissing(imageUrl){const url=thumbUrlForImage(imageUrl),name=url?.slice(THUMB_URL_PREFIX.length);if(!url||!name||known.has(name)||queuedNames.has(name)||failedNames.has(name)||queue.length>=maxQueue)return;const file=path.join(capturesDir,(imageUrl as string).slice('/captures/'.length));if(fs.existsSync(file))add(file,false);},
  ready,
  idle(){return queue.length||running||deferred?new Promise<void>(r=>idleWaiters.push(r)):Promise.resolve();},
  diagnostics:()=>({known:known.size,queued:queue.length,running,generated,failed}),
 };
}
