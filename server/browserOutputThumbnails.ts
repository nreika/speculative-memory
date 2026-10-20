import fs from 'node:fs/promises';import path from 'node:path';import {spawn}from'node:child_process';import {createHash,randomUUID}from'node:crypto';

const PREFIX='/captures/browser-output-thumbnails/';
const PY=String.raw`
import sys,os,warnings
from PIL import Image,ImageOps
source,output,max_bytes,max_pixels=sys.argv[1:];max_bytes=int(max_bytes);max_pixels=int(max_pixels)
if os.stat(source).st_size>max_bytes:raise ValueError('image byte limit')
Image.MAX_IMAGE_PIXELS=max_pixels;warnings.simplefilter('error',Image.DecompressionBombWarning)
with Image.open(source) as im:
 if im.width*im.height>max_pixels:raise ValueError('image pixel limit')
 im=ImageOps.exif_transpose(im);im.thumbnail((320,180),Image.Resampling.LANCZOS)
 if im.mode in ('RGBA','LA') or 'transparency' in im.info:
  rgba=im.convert('RGBA');background=Image.new('RGB',rgba.size,(16,21,29));background.paste(rgba,mask=rgba.getchannel('A'));im=background
 else:im=im.convert('RGB')
 im.save(output,'JPEG',quality=75,optimize=True)
`;

let active=0,maxObserved=0,started=0;const waiting:Array<()=>void>=[];
async function slot<T>(task:()=>Promise<T>):Promise<T>{
 if(active>=2)await new Promise<void>(resolve=>waiting.push(resolve));
 else active++;
 maxObserved=Math.max(maxObserved,active);
 try{return await task();}finally{const next=waiting.shift();if(next)next();else active--;}
}
/** Read-only counters, useful to verify the process limit without starting another operation. */
export function thumbnailProcessDiagnostics(){return {activeProcesses:active,pendingProcesses:waiting.length,maxObserved,startedProcesses:started};}

export interface BrowserOutputThumbnailOptions {
 cacheDirectory:string;
 /** Must resolve only catalog image URLs to trusted local source files, including containment/junction checks. */
 resolveImage:(imageUrl:string)=>string|null|Promise<string|null>;
 pythonPath?:string;maxImageBytes?:number;maxImagePixels?:number;timeoutMs?:number;
}
export interface BrowserOutputThumbnails {thumbnailUrl(imageUrl:string):string|null;resolveThumbnail(url:string):Promise<string|null>}
const canonical=(p:string)=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
const positive=(v:number|undefined,defaultValue:number,maximum:number)=>v===undefined?defaultValue:Number.isSafeInteger(v)&&v>0?Math.min(v,maximum):defaultValue;

/** These JPEGs are presentation derivatives, never separate generated artwork or source provenance. */
export function createBrowserOutputThumbnails(options:BrowserOutputThumbnailOptions):BrowserOutputThumbnails {
 if(!path.isAbsolute(options.cacheDirectory))throw Error('Thumbnail cache directory must be an absolute private path');
 const configured=path.resolve(options.cacheDirectory);const python=options.pythonPath||process.env.SCENARIO_COMPOSITION_PYTHON||process.env.PEOPLE_DETECTOR_PYTHON||path.join(process.env.USERPROFILE||'','Documents/ComfyUI/.venv/Scripts/python.exe');
 const maxBytes=positive(options.maxImageBytes,32*1024*1024,32*1024*1024),maxPixels=positive(options.maxImagePixels,16*1024*1024,16*1024*1024),timeoutMs=positive(options.timeoutMs,10000,30000);
 const registered=new Map<string,string>(),inflight=new Map<string,Promise<string|null>>();
 const ready=fs.mkdir(configured,{recursive:true}).then(()=>fs.realpath(configured)).catch(()=>null);
 const cacheStable=async(base:string)=>{try{return canonical(await fs.realpath(configured))===canonical(base);}catch{return false;}};
 function thumbnailUrl(imageUrl:string):string|null {
  if(typeof imageUrl!=='string'||imageUrl.length>4096||!imageUrl.startsWith('/')||imageUrl.startsWith('//')||imageUrl.startsWith(PREFIX)||/[\\\u0000-\u001f?#]/.test(imageUrl))return null;
  try{const decoded=decodeURIComponent(imageUrl);if(decoded.split('/').includes('..')||decoded.includes('\\')||/[\u0000-\u001f]/.test(decoded))return null;}catch{return null;}
  const key=createHash('sha256').update(imageUrl).digest('hex');registered.set(key,imageUrl);return PREFIX+key+'.jpg';
 }
 async function safeRegular(file:string){try{const s=await fs.lstat(file);return s.isFile()&&!s.isSymbolicLink()?s:null;}catch{return null;}}
 async function resolveKey(key:string,imageUrl:string):Promise<string|null>{
  const base=await ready;if(!base||!await cacheStable(base))return null;
  let source:string|null;try{source=await options.resolveImage(imageUrl);}catch{return null;}if(!source||!path.isAbsolute(source))return null;
  const given=await safeRegular(source);if(!given||given.size>maxBytes)return null;
  try{source=await fs.realpath(source);}catch{return null;}const st=await safeRegular(source);if(!st||st.size>maxBytes)return null;
  const output=path.join(base,key+'.jpg'),metaFile=path.join(base,key+'.json');
  const fingerprint={source:canonical(source),mtimeMs:st.mtimeMs,size:st.size};
  const previous=await safeRegular(output),metaStat=await safeRegular(metaFile);
  if(previous&&previous.size<=1024*1024&&metaStat&&metaStat.size<=8192){try{const meta=JSON.parse(await fs.readFile(metaFile,'utf8'));if(meta.source===fingerprint.source&&meta.mtimeMs===fingerprint.mtimeMs&&meta.size===fingerprint.size&&meta.outputSize===previous.size&&await cacheStable(base))return output;}catch{}}
  const temp=path.join(base,key+'.'+randomUUID()+'.tmp.jpg'),tempMeta=temp+'.json';
  try{
   const ok=await slot(async()=>{if(!await cacheStable(base))return false;started++;
    return new Promise<boolean>(resolve=>{const child=spawn(python,['-c',PY,source!,temp,String(maxBytes),String(maxPixels)],{windowsHide:true,stdio:['ignore','ignore','ignore']});let expired=false,settled=false;const finish=(success:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(success);};const timer=setTimeout(()=>{expired=true;child.kill();},timeoutMs);child.once('error',()=>finish(false));child.once('close',code=>finish(!expired&&code===0));});
   });
   if(!ok||!await cacheStable(base))return null;const end=await safeRegular(source),thumb=await safeRegular(temp);if(!end||end.mtimeMs!==st.mtimeMs||end.size!==st.size||!thumb||thumb.size<4||thumb.size>1024*1024)return null;
   if((await fs.lstat(output).catch(()=>null))?.isSymbolicLink()||(await fs.lstat(metaFile).catch(()=>null))?.isSymbolicLink())return null;
   await fs.writeFile(tempMeta,JSON.stringify({...fingerprint,outputSize:thumb.size}),{flag:'wx'});
   if(!await cacheStable(base))return null;await fs.rename(temp,output);await fs.rename(tempMeta,metaFile);return output;
  }catch{return null;}finally{await fs.unlink(temp).catch(()=>undefined);await fs.unlink(tempMeta).catch(()=>undefined);}
 }
 async function resolveThumbnail(url:string):Promise<string|null>{
  const match=typeof url==='string'?/^\/captures\/browser-output-thumbnails\/([a-f0-9]{64})\.jpg$/.exec(url):null;if(!match)return null;
  const key=match[1],imageUrl=registered.get(key);if(!imageUrl)return null;const existing=inflight.get(key);if(existing)return existing;
  const work=resolveKey(key,imageUrl).finally(()=>inflight.delete(key));inflight.set(key,work);return work;
 }
 return {thumbnailUrl,resolveThumbnail};
}
