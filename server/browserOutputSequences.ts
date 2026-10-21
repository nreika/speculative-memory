/** Fixed sequences: folders of still images played frame by frame on a browser output.
 * <dataRoot>/sequences/<folder>/*.png|*.jpg, natural filename order, optional captions.json {"<filename>":"字幕"}.
 * Frames are served as /captures/sequences/<folder>/<NNNN>.<ext> (1-based index), never by the original filename. */
import fs from 'node:fs/promises';
import path from 'node:path';
import type {BrowserDisplayContent} from './browserDisplay';

export const SEQUENCE_MAX_FRAMES=2000;
export const SEQUENCE_FOLDER=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FRAME_URL=/^\/captures\/sequences\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/([0-9]{4})\.(png|jpe?g)$/i;
const IMAGE=/\.(png|jpe?g)$/i;
const collator=new Intl.Collator('en',{numeric:true,sensitivity:'base'});

export interface SequenceFrameFile {index:number;filename:string;url:string;caption:string}
export interface SequenceFolder {name:string;frameCount:number;truncated:boolean;thumbnailUrl:string|null;frames:SequenceFrameFile[]}

/** Natural filename order ("2.png" before "10.png"); exact string order breaks ties. */
export function naturalCompare(a:string,b:string):number{return collator.compare(a,b)||(a<b?-1:a>b?1:0);}

/** 1-based frame shown at nowMs. Deterministic from the server clock: no state besides startedAtMs. */
export function sequenceFrame(input:{count:number;startFrame?:number;endFrame?:number;frameSec:number;loop?:boolean;startedAtMs:number;nowMs:number}):{frame:number;start:number;end:number;count:number;nextChangeAtMs:number|null}|null{
 const {count,frameSec,startedAtMs,nowMs}=input;
 if(!Number.isInteger(count)||count<1||!Number.isFinite(frameSec)||frameSec<=0)return null;
 const start=Math.min(Math.max(Math.trunc(input.startFrame??1),1),count);
 const end=Math.min(Math.max(Math.trunc(input.endFrame??count),start),count);
 const span=end-start+1,stepMs=frameSec*1000,loop=input.loop!==false;
 const step=Math.max(0,Math.floor((nowMs-startedAtMs)/stepMs));
 const offset=loop?step%span:Math.min(step,span-1);
 const finished=!loop&&step>=span-1;
 return {frame:start+offset,start,end,count,nextChangeAtMs:span===1||finished?null:startedAtMs+(step+1)*stepMs};
}

export function parseSequenceFrameUrl(urlPath:string):{folder:string;index:number;ext:string}|null{
 const m=FRAME_URL.exec(urlPath);if(!m)return null;
 const index=Number(m[2]);return index>=1&&index<=SEQUENCE_MAX_FRAMES?{folder:m[1],index,ext:m[3].toLowerCase()}:null;
}

export function createSequenceLibrary(options:{directory:string;now?:()=>number;ttlMs?:number}){
 const root=path.resolve(options.directory),now=options.now??Date.now,ttl=options.ttlMs??2000;
 const cache=new Map<string,{until:number;value:Promise<SequenceFolder|null>}>();
 async function readFolder(name:string):Promise<SequenceFolder|null>{
  if(!SEQUENCE_FOLDER.test(name))return null;
  const dir=path.join(root,name);
  let entries:import('node:fs').Dirent[];
  try{const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())return null;entries=await fs.readdir(dir,{withFileTypes:true});}catch{return null;}
  const names=entries.filter(e=>e.isFile()&&IMAGE.test(e.name)&&!e.name.startsWith('.')).map(e=>e.name).sort(naturalCompare);
  let captions:Record<string,unknown>={};
  try{const raw=JSON.parse(await fs.readFile(path.join(dir,'captions.json'),'utf8'));if(raw&&typeof raw==='object'&&!Array.isArray(raw))captions=raw;}catch{/* no captions */}
  const frames=names.slice(0,SEQUENCE_MAX_FRAMES).map((filename,i)=>{
   const ext=filename.slice(filename.lastIndexOf('.')+1).toLowerCase(),caption=captions[filename];
   return {index:i+1,filename,url:`/captures/sequences/${name}/${String(i+1).padStart(4,'0')}.${ext}`,caption:typeof caption==='string'?caption.slice(0,8000):''};
  });
  return {name,frameCount:frames.length,truncated:names.length>SEQUENCE_MAX_FRAMES,thumbnailUrl:frames[0]?.url??null,frames};
 }
 function folder(name:string):Promise<SequenceFolder|null>{
  const t=now(),hit=cache.get(name);if(hit&&hit.until>t)return hit.value;
  const value=readFolder(name);cache.set(name,{until:t+ttl,value});
  if(cache.size>256)for(const [k,v] of cache)if(v.until<=t)cache.delete(k);
  return value;
 }
 async function list():Promise<Array<Omit<SequenceFolder,'frames'>>>{
  let entries:import('node:fs').Dirent[];try{entries=await fs.readdir(root,{withFileTypes:true});}catch{return [];}
  const names=entries.filter(e=>e.isDirectory()&&SEQUENCE_FOLDER.test(e.name)).map(e=>e.name).sort(naturalCompare).slice(0,500);
  const folders=await Promise.all(names.map(folder));
  return folders.filter((f):f is SequenceFolder=>!!f).map(({frames:_frames,...rest})=>rest);
 }
 /** Absolute path of a frame URL, or null (unknown folder/index, extension mismatch, symlink, outside the root). */
 async function resolve(urlPath:string):Promise<{absolutePath:string;contentType:string}|null>{
  const parsed=parseSequenceFrameUrl(urlPath);if(!parsed)return null;
  const f=await folder(parsed.folder),frame=f?.frames[parsed.index-1];if(!frame||frame.url!==urlPath)return null;
  const candidate=path.join(root,parsed.folder,frame.filename);
  try{
   const entry=await fs.lstat(candidate);if(!entry.isFile()||entry.isSymbolicLink())return null;
   const [base,actual]=await Promise.all([fs.realpath(root),fs.realpath(candidate)]);
   const rel=path.relative(base,actual);if(!rel||rel.startsWith('..')||path.isAbsolute(rel))return null;
   return {absolutePath:actual,contentType:parsed.ext==='png'?'image/png':'image/jpeg'};
  }catch{return null;}
 }
 /** The content an output shows now, plus the readout for Mapping. */
 async function current(input:{folder:string;frameSec:number;startFrame?:number;endFrame?:number;loop?:boolean;startedAtMs:number;nowMs:number}):Promise<{content:BrowserDisplayContent&{sequenceLabel:string};sequence:{folder:string;frame:number;start:number;end:number;count:number;frameSec:number;loop:boolean;nextChangeAtMs:number|null}}|null>{
  const f=await folder(input.folder);if(!f||!f.frameCount)return null;
  const pick=sequenceFrame({count:f.frameCount,startFrame:input.startFrame,endFrame:input.endFrame,frameSec:input.frameSec,loop:input.loop,startedAtMs:input.startedAtMs,nowMs:input.nowMs});if(!pick)return null;
  const frame=f.frames[pick.frame-1];
  return {content:{id:`sequence:${f.name}:${pick.frame}`,scope:'sequence:'+f.name,provenance:'uploaded',imageUrl:frame.url,distanceSecSigned:null,targetAtMs:null,recordedAtMs:null,generatedAtMs:null,sourceRecordedAtMs:null,caption:frame.caption,sequenceLabel:`SEQ · ${f.name} · ${pick.frame}/${f.frameCount}`},
   sequence:{folder:f.name,frame:pick.frame,start:pick.start,end:pick.end,count:f.frameCount,frameSec:input.frameSec,loop:input.loop!==false,nextChangeAtMs:pick.nextChangeAtMs}};
 }
 /** Import: writes frame <index>.<ext> into <folder>; never overwrites. */
 async function importFrame(input:{folder:string;index:number;imageDataUrl:string}):Promise<{folder:string;index:number}>{
  if(!SEQUENCE_FOLDER.test(input.folder))throw Object.assign(Error('Sequence name: 1-64 characters of A-Z a-z 0-9 _ - (start with a letter or digit)'),{statusCode:400});
  if(!Number.isInteger(input.index)||input.index<1||input.index>SEQUENCE_MAX_FRAMES)throw Object.assign(Error('Frame index must be 1-'+SEQUENCE_MAX_FRAMES),{statusCode:400});
  const m=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(input.imageDataUrl);if(!m)throw Object.assign(Error('Sequences accept PNG or JPEG images'),{statusCode:415});
  const bytes=Buffer.from(m[2],'base64'),png=bytes.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),jpeg=bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff;
  if(!(m[1]==='png'?png:jpeg)||bytes.length>8*1024*1024)throw Object.assign(Error('Sequences accept PNG or JPEG images up to 8 MB'),{statusCode:415});
  const dir=path.join(root,input.folder);await fs.mkdir(dir,{recursive:true});
  const file=path.join(dir,String(input.index).padStart(4,'0')+(m[1]==='png'?'.png':'.jpg'));
  try{await fs.writeFile(file,bytes,{flag:'wx'});}catch(e:any){if(e?.code==='EEXIST')throw Object.assign(Error(`Sequence "${input.folder}" already has frame ${input.index}; choose a new name`),{statusCode:409});throw e;}
  cache.delete(input.folder);return {folder:input.folder,index:input.index};
 }
 return {root,list,folder,resolve,current,importFrame,invalidate:(name?:string)=>name?cache.delete(name):cache.clear()};
}
export type SequenceLibrary=ReturnType<typeof createSequenceLibrary>;
