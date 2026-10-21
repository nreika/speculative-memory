/** Display-only CPU boxes. This service never writes, removes or substitutes source images. */
import{readDisplayFaces}from'./displayDerivatives';
import fs from 'node:fs/promises';import path from 'node:path';import{createHash}from'node:crypto';import{spawn,type ChildProcessWithoutNullStreams}from'node:child_process';import{existsSync}from'node:fs';
export interface FaceBox{x:number;y:number;width:number;height:number}
export interface FaceDetection{status:'detected'|'no-faces'|'unavailable'|'error';width?:number;height?:number;boxes:FaceBox[];detectorMs?:number;method?:string}
export interface BrowserFaceBoxesResult extends FaceDetection{schema:1;imageUrl:string;imageSha256:string|null}
export interface BrowserFaceBoxesOptions{resolveImage:(url:string)=>Promise<string|null>|string|null;allowedRoots:string[];python:string;worker:string;detect?:(bytes:Buffer)=>Promise<FaceDetection>;maxBytes?:number;timeoutMs?:number;cacheLimit?:number}
const safeUrl=(url:unknown):url is string=>typeof url==='string'&&url.length<2048&&/^\/captures\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|webp)$/i.test(url)&&!url.split('/').some(p=>p==='.'||p==='..')&&!url.includes('//');
export function createBrowserFaceBoxes(options:BrowserFaceBoxesOptions){
 if(!options.allowedRoots.length||options.allowedRoots.some(p=>!path.isAbsolute(p))||!path.isAbsolute(options.python)||!path.isAbsolute(options.worker))throw Error('Face detector requires explicit private local paths');
 const max=options.maxBytes??24*1024*1024,timeout=options.timeoutMs??8000,limit=options.cacheLimit??256;
 if(!Number.isSafeInteger(max)||max<1||max>32*1024*1024||!Number.isInteger(timeout)||timeout<1||timeout>30000||!Number.isInteger(limit)||limit<1||limit>4096)throw Error('Invalid face detector limits');
 const cache=new Map<string,{value:FaceDetection;until:number}>(),inflight=new Map<string,Promise<FaceDetection>>();let active=0;const waiters:Array<()=>void>=[];
 const normalize=(p:string)=>process.platform==='win32'?p.toLowerCase():p;
 const allowed=async(file:string)=>{const actual=await fs.realpath(file),roots=await Promise.all(options.allowedRoots.map(p=>fs.realpath(p).catch(()=>null)));return roots.some(root=>{if(root===null)return false;const rel=path.relative(normalize(root),normalize(actual));return rel!==''&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);})?actual:null;};
 // 2026-10-21: one resident worker (same detector code, Python + OpenCV started once) answers requests serially: ~0.07 s per image instead of
 // ~0.3-1 s for a fresh process, so a new screen image no longer waits for a spawn. Falls back to the one-shot process when the wrapper is absent.
 const serveWorker=path.join(path.dirname(options.worker),'browser-face-boxes-serve.py');
 const residentDetect=(()=>{
  if(options.detect||!existsSync(serveWorker))return null;
  let child:ChildProcessWithoutNullStreams|null=null,buffer='',waiter:{resolve:(r:FaceDetection)=>void;timer:NodeJS.Timeout}|null=null,chain:Promise<unknown>=Promise.resolve();
  const settle=(r:FaceDetection)=>{const w=waiter;waiter=null;if(w){clearTimeout(w.timer);w.resolve(r);}};
  const start=()=>{
   const c=spawn(options.python,['-u',serveWorker,options.worker],{windowsHide:true,stdio:['pipe','pipe','pipe']});child=c;buffer='';
   c.stderr.resume();c.stdin.on('error',()=>settle({status:'error',boxes:[]}));
   c.stdout.on('data',chunk=>{buffer+=String(chunk);if(buffer.length>400000){c.kill();return settle({status:'error',boxes:[]});}for(let i=buffer.indexOf('\n');i>=0;i=buffer.indexOf('\n')){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{settle(JSON.parse(line));}catch{settle({status:'error',boxes:[]});}}});
   c.on('error',()=>{if(child===c)child=null;settle({status:'unavailable',boxes:[]});});
   c.on('close',()=>{if(child===c)child=null;settle({status:'unavailable',boxes:[]});});
  };
  return (bytes:Buffer)=>{
   const job=chain.then(()=>new Promise<FaceDetection>(resolve=>{
    if(!child)start();
    const timer=setTimeout(()=>{child?.kill();child=null;resolve({status:'error',boxes:[]});},timeout);
    waiter={resolve,timer};
    try{child!.stdin.write(JSON.stringify({image:bytes.toString('base64')})+'\n');}catch{settle({status:'error',boxes:[]});}
   }));
   chain=job.catch(()=>undefined);return job;
  };
 })();
 const detect=options.detect??residentDetect??((bytes:Buffer)=>new Promise<FaceDetection>((resolve)=>{
  const child=spawn(options.python,['-u',options.worker],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='',done=false;const finish=(r:FaceDetection)=>{if(done)return;done=true;clearTimeout(timer);resolve(r);};const timer=setTimeout(()=>{child.kill();finish({status:'error',boxes:[]});},timeout);
  child.stderr.resume();child.on('error',()=>finish({status:'unavailable',boxes:[]}));child.stdin.on('error',()=>finish({status:'error',boxes:[]}));child.stdout.on('data',chunk=>{output+=String(chunk);if(output.length>100000){child.kill();finish({status:'error',boxes:[]});}});child.on('close',()=>{try{finish(JSON.parse(output));}catch{finish({status:'error',boxes:[]});}});child.stdin.end(JSON.stringify({image:bytes.toString('base64')}));
 }));
 async function run(bytes:Buffer):Promise<FaceDetection>{
  if(active>=2)await new Promise<void>(resolve=>waiters.push(resolve));else active++;
  try{const r=await detect(bytes);if(!r||!['detected','no-faces','unavailable','error'].includes(r.status)||!Array.isArray(r.boxes)||r.boxes.length>64||r.boxes.some(b=>!b||![b.x,b.y,b.width,b.height].every(Number.isFinite)||b.x<0||b.y<0||b.width<=0||b.height<=0||b.x+b.width>1.000001||b.y+b.height>1.000001))throw Error('Invalid face boxes');
   if((r.status==='detected'||r.status==='no-faces')&&(!Number.isInteger(r.width)||!Number.isInteger(r.height)||r.width!<1||r.height!<1||r.width!*r.height!>40000000)||r.status==='detected'&&!r.boxes.length||r.status!=='detected'&&r.boxes.length)throw Error('Invalid face result');
   return structuredClone(r);
  }catch{return {status:'error',boxes:[]};}finally{const next=waiters.shift();if(next)next();else active--;}
 }
 return {async inspect(imageUrl:string):Promise<BrowserFaceBoxesResult>{
  const empty=(status:FaceDetection['status']):BrowserFaceBoxesResult=>({schema:1,imageUrl,imageSha256:null,status,boxes:[]});if(!safeUrl(imageUrl))return empty('error');
  try{const pre=readDisplayFaces(imageUrl);if(pre&&pre.imageSha256&&(pre.status==='detected'||pre.status==='no-faces'))return{schema:1,imageUrl,...pre};const resolved=await options.resolveImage(imageUrl);if(!resolved||!path.isAbsolute(resolved))return empty('error');const file=await allowed(resolved);if(!file)return empty('error');const stat=await fs.stat(file);if(!stat.isFile()||stat.size>max)return empty('error');const bytes=await fs.readFile(file);if(bytes.length>max)return empty('error');const sha=createHash('sha256').update(bytes).digest('hex');const cached=cache.get(sha);let result=cached&&cached.until>Date.now()?cached.value:undefined;if(!result){let flight=inflight.get(sha);if(!flight){if(inflight.size>=32)return empty('error');flight=run(bytes).then(r=>{cache.set(sha,{value:r,until:r.status==='detected'||r.status==='no-faces'?Infinity:Date.now()+5000});while(cache.size>limit)cache.delete(cache.keys().next().value!);return r;}).finally(()=>inflight.delete(sha));inflight.set(sha,flight);}result=await flight;}
   return {schema:1,imageUrl,imageSha256:sha,...structuredClone(result)};
  }catch{return empty('error');}
 }};
}


