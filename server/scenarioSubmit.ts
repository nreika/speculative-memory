/**
 * External scenario submissions ("CSVを外部から送って登録"): people outside the venue send an operator-scenario CSV
 * (+ the PNG images it references) through the public gate (/submit/ -> POST /api/scenario-submit). The CSV goes through
 * the same library import as Control's Import… (operatorLibrary.upload -> checkOperatorPlan) into
 * scenarios/browser-imports/<uuid>/ with a sidecar .submission.json {submittedAt,name,note,origin:'external',approved:false}.
 * Nothing is loaded, played or changed: the operator approves (or deletes) it in Control first; unapproved
 * submissions cannot be loaded or played (assertPlayable, enforced by nativeOperator).
 */
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {ScenarioFormatError} from './operatorScenario';

export const SUBMIT_LIMITS={csvBytes:2*1024*1024,imageBytes:5*1024*1024,images:5,name:40,note:200,perHour:10,checksPerHour:30,globalPerHour:60};
/** Whole multipart body: CSV + images + form fields + boundaries. */
export const SUBMIT_MAX_BODY=SUBMIT_LIMITS.csvBytes+SUBMIT_LIMITS.images*SUBMIT_LIMITS.imageBytes+256*1024;
export const SUBMISSION_SIDECAR='.submission.json';
const HOUR=60*60*1000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PNG_MAGIC=Buffer.from([137,80,78,71,13,10,26,10]);

export class SubmitError extends Error{
 constructor(readonly statusCode:number,message:string,readonly extra:Record<string,unknown>={}){super(message);}
}
export interface Submission{id:string;file:string;scenarioId:string;submittedAt:string;name:string;note:string;origin:'external';approved:boolean;approvedAt?:string}
export interface UploadedFile{field:string;filename:string;data:Buffer}
interface Library{
 upload(payload:any,extraFiles?:Record<string,string>):Promise<{file:string;id:string;scenarioId:string;formatWarnings:unknown[]}>;
 check(file:string):Promise<{plan:{id:string};formatWarnings:unknown[]}>;
 forget?():void;
}

/** Minimal multipart/form-data parser for a fully buffered (size-capped) body. */
export function parseMultipart(body:Buffer,contentType:string):{fields:Record<string,string>;files:UploadedFile[]}{
 const m=/;\s*boundary=(?:"([^"]{1,70})"|([^;\s]{1,70}))/i.exec(contentType);
 if(!/^multipart\/form-data\s*;/i.test(contentType)||!m)throw new SubmitError(415,'multipart/form-data is required');
 const delimiter=Buffer.from('--'+(m[1]??m[2]));
 const fields:Record<string,string>={},files:UploadedFile[]=[];
 let pos=body.indexOf(delimiter);if(pos<0)throw new SubmitError(400,'Malformed form data');
 for(let parts=0;;parts++){
  pos+=delimiter.length;
  if(body.subarray(pos,pos+2).toString()==='--')break;
  if(parts>=16)throw new SubmitError(400,'Too many form parts');
  if(body.subarray(pos,pos+2).toString()!=='\r\n')throw new SubmitError(400,'Malformed form data');
  const headerEnd=body.indexOf('\r\n\r\n',pos+2);if(headerEnd<0||headerEnd-pos>4096)throw new SubmitError(400,'Malformed form data');
  const headers=body.subarray(pos+2,headerEnd).toString('utf8');
  const next=body.indexOf(Buffer.concat([Buffer.from('\r\n'),delimiter]),headerEnd+4);if(next<0)throw new SubmitError(400,'Malformed form data');
  const data=body.subarray(headerEnd+4,next);
  const disposition=/content-disposition:\s*form-data;([^\r\n]*)/i.exec(headers)?.[1]??'';
  const name=/\bname="([^"]{1,40})"/.exec(disposition)?.[1];
  const filename=/\bfilename="([^"]{0,255})"/.exec(disposition)?.[1];
  if(!name)throw new SubmitError(400,'Malformed form data');
  if(filename!==undefined){if(filename||data.length)files.push({field:name,filename,data:Buffer.from(data)});}
  else{if(data.length>4096)throw new SubmitError(400,`Field ${name} is too long`);fields[name]=data.toString('utf8');}
  pos=next+2;
 }
 return {fields,files};
}

/** Basename only; anything outside [A-Za-z0-9_. -] becomes "_"; must start with a letter/digit; extension lower-cased. */
export function sanitizeFilename(raw:string,allowed:string[]):string|null{
 const base=String(raw).split(/[\\/]/).pop()!.trim();
 const dot=base.lastIndexOf('.');if(dot<=0)return null;
 const ext=base.slice(dot).toLowerCase();if(!allowed.includes(ext))return null;
 let stem=base.slice(0,dot).replace(/[^A-Za-z0-9_. -]/g,'_').replace(/\.{2,}/g,'_').slice(0,100).trim();
 if(!/^[A-Za-z0-9]/.test(stem))stem='f'+stem;
 return stem+ext;
}
const cleanText=(value:unknown,max:number,label:string,required:boolean)=>{
 const text=typeof value==='string'?value.replace(/\r\n?/g,'\n').trim():'';
 if(required&&!text)throw new SubmitError(400,`${label} is required`);
 if([...text].length>max)throw new SubmitError(400,`${label} must be at most ${max} characters`);
 if(/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text))throw new SubmitError(400,`${label} contains control characters`);
 return text;
};

export function createScenarioSubmissions(options:{root:string;library:Library;now?:()=>number;onSubmitted?:(submission:Submission)=>void}){
 const now=options.now??Date.now,imports=path.join(options.root,'browser-imports');
 const known=new Map<string,Submission>();
 const hits=new Map<string,number[]>();
 const sidecarPath=(id:string)=>path.join(imports,id,SUBMISSION_SIDECAR);
 const readSidecar=async(id:string):Promise<Submission|null>=>{
  try{const value=JSON.parse(await fs.readFile(sidecarPath(id),'utf8'));return value&&value.origin==='external'?{...value,id}:null;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
 };
 // One scan at startup (sidecars are the source of truth); afterwards the map is kept in step by submit/approve/remove.
 const ready=(async()=>{
  const entries=await fs.readdir(imports,{withFileTypes:true}).catch(()=>[]);
  for(const entry of entries)if(entry.isDirectory()&&UUID.test(entry.name)){const s=await readSidecar(entry.name).catch(()=>null);if(s)known.set(s.id,s);}
 })();
 const limit=(key:string,max:number)=>{
  const cut=now()-HOUR,list=(hits.get(key)??[]).filter(t=>t>cut);
  if(list.length>=max){hits.set(key,list);return false;}
  list.push(now());hits.set(key,list);if(hits.size>2000)hits.delete(hits.keys().next().value!);return true;
 };
 /** Field/file validation shared by Check and Submit. */
 function validate(fields:Record<string,string>,files:UploadedFile[]){
  const name=cleanText(fields.name,SUBMIT_LIMITS.name,'Name',true),note=cleanText(fields.note,SUBMIT_LIMITS.note,'Note',false);
  const csvs=files.filter(f=>f.field==='csv'),images=files.filter(f=>f.field==='images');
  if(files.some(f=>f.field!=='csv'&&f.field!=='images'))throw new SubmitError(400,'Unexpected file field');
  if(csvs.length!==1)throw new SubmitError(400,'Attach exactly one CSV file');
  const csvName=sanitizeFilename(csvs[0].filename,['.csv']);if(!csvName)throw new SubmitError(400,'The scenario file must be a .csv');
  if(csvs[0].data.length>SUBMIT_LIMITS.csvBytes)throw new SubmitError(413,'CSV exceeds 2 MB');
  const text=csvs[0].data.toString('utf8');if(text.includes('�')||text.includes('\u0000'))throw new SubmitError(400,'CSV must be UTF-8 text');
  if(images.length>SUBMIT_LIMITS.images)throw new SubmitError(400,`At most ${SUBMIT_LIMITS.images} images`);
  const assets:{name:string;base64:string}[]=[],seen=new Set<string>();
  for(const image of images){
   const safe=sanitizeFilename(image.filename,['.png','.jpg','.jpeg']);if(!safe)throw new SubmitError(400,`${image.filename.slice(0,60)}: images must be .png (or .jpg/.jpeg)`);
   if(image.data.length>SUBMIT_LIMITS.imageBytes)throw new SubmitError(413,`${safe} exceeds 5 MB`);
   const isPng=image.data.subarray(0,8).equals(PNG_MAGIC),isJpeg=image.data.length>3&&image.data[0]===0xff&&image.data[1]===0xd8&&image.data[2]===0xff;
   if(safe.endsWith('.png')?!isPng:!isJpeg)throw new SubmitError(400,`${safe} is not a real ${safe.endsWith('.png')?'PNG':'JPEG'} image`);
   // The CSV format only references .png files (scenario_csv.py image rows); a JPEG could never be used by the plan.
   if(!safe.endsWith('.png'))throw new SubmitError(400,`${safe}: scenario image rows only accept PNG; convert it to .png`);
   if(seen.has(safe.toLowerCase()))throw new SubmitError(400,`Duplicate image name ${safe}`);seen.add(safe.toLowerCase());
   assets.push({name:safe,base64:image.data.toString('base64')});
  }
  return {name,note,csv:{name:csvName,text},assets};
 }
 const formatFailure=(error:unknown)=>{
  if(error instanceof ScenarioFormatError)return new SubmitError(400,error.message,{formatErrors:error.formatErrors,formatWarnings:error.formatWarnings});
  if(error instanceof SubmitError)return error;
  return new SubmitError(400,String((error as Error)?.message??error));
 };
 async function check(input:ReturnType<typeof validate>){
  // Validate in a hidden (dot) folder so nothing becomes selectable, then remove it.
  const tmp=`.check-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`,folder=path.join(imports,tmp);
  await fs.mkdir(folder,{recursive:true});
  try{
   await fs.writeFile(path.join(folder,input.csv.name),input.csv.text,'utf8');
   for(const a of input.assets)await fs.writeFile(path.join(folder,a.name),Buffer.from(a.base64,'base64'));
   const result=await options.library.check(`browser-imports/${tmp}/${input.csv.name}`);
   return {ok:true,checked:true,scenarioId:result.plan.id,warnings:result.formatWarnings};
  }catch(error){throw formatFailure(error);}
  finally{await fs.rm(folder,{recursive:true,force:true}).catch(()=>{});}
 }
 return {
  ready,
  /** mode 'check' validates without saving; 'submit' stores via the library import with the sidecar. */
  async receive(body:Buffer,contentType:string,key:string){
   const {fields,files}=parseMultipart(body,contentType);
   const mode=fields.mode==='check'?'check':'submit';
   if(!limit(mode+':'+key,mode==='check'?SUBMIT_LIMITS.checksPerHour:SUBMIT_LIMITS.perHour)||mode==='submit'&&!limit('submit:*',SUBMIT_LIMITS.globalPerHour))
    throw new SubmitError(429,mode==='check'?'Too many checks; try again later':'Too many submissions (10 per hour); try again later');
   const input=validate(fields,files);
   if(mode==='check')return check(input);
   await ready;
   const meta={submittedAt:new Date(now()).toISOString(),name:input.name,note:input.note,origin:'external' as const,approved:false};
   let stored;
   try{stored=await options.library.upload({csv:input.csv,assets:input.assets},{[SUBMISSION_SIDECAR]:JSON.stringify(meta,null,1)});}
   catch(error){throw formatFailure(error);}
   const submission:Submission={...meta,id:stored.id,file:stored.file,scenarioId:stored.scenarioId};
   // scenarioId/file are added to the sidecar after the import so the folder stays self-describing.
   await fs.writeFile(sidecarPath(stored.id),JSON.stringify({...meta,file:stored.file,scenarioId:stored.scenarioId},null,1),'utf8').catch(()=>{});
   known.set(submission.id,submission);options.onSubmitted?.(submission);
   return {ok:true,id:submission.id,scenarioId:submission.scenarioId,warnings:stored.formatWarnings};
  },
  list():Submission[]{return [...known.values()].map(s=>({...s})).sort((a,b)=>b.submittedAt.localeCompare(a.submittedAt));},
  /** Library rows plus {external} for submissions (label/approved for Control). */
  decorate<T extends {file:string;name:string}>(rows:T[]):(T&{external?:{id:string;name:string;note:string;submittedAt:string;approved:boolean;scenarioId:string}})[]{
   return rows.map(row=>{const id=/^browser-imports\/([0-9a-f-]{36})\//.exec(row.file)?.[1],s=id?known.get(id):undefined;
    return s?{...row,external:{id:s.id,name:s.name,note:s.note,submittedAt:s.submittedAt,approved:s.approved,scenarioId:s.scenarioId}}:row;});
  },
  /** Throws 403 when the file is an external submission that is not approved (read from disk: authoritative). */
  async assertPlayable(file:unknown){
   const id=typeof file==='string'?/^browser-imports\/([0-9a-f-]{36})\//.exec(file)?.[1]:undefined;
   if(!id||!UUID.test(id))return;
   const s=await readSidecar(id).catch(()=>({approved:false} as Submission));
   if(s&&s.approved!==true)throw new SubmitError(403,'External scenario is not approved yet; approve it in the scenario list first');
  },
  async approve(id:unknown){
   if(typeof id!=='string'||!UUID.test(id))throw new SubmitError(400,'Invalid submission id');
   const s=await readSidecar(id);if(!s)throw new SubmitError(404,'Unknown external submission');
   const {id:_,...stored}=s;const next={...stored,approved:true,approvedAt:new Date(now()).toISOString()};
   await fs.writeFile(sidecarPath(id),JSON.stringify(next,null,1),'utf8');
   known.set(id,{...next,id,file:s.file??'',scenarioId:s.scenarioId??''});options.library.forget?.();
   return {ok:true,id,message:`Approved external scenario · ${s.name}`};
  },
  async remove(id:unknown,inUse:(file:string)=>boolean){
   if(typeof id!=='string'||!UUID.test(id))throw new SubmitError(400,'Invalid submission id');
   const s=await readSidecar(id);if(!s)throw new SubmitError(404,'Unknown external submission');
   const files=(await fs.readdir(path.join(imports,id))).filter(n=>n.toLowerCase().endsWith('.csv')).map(n=>`browser-imports/${id}/${n}`);
   if(files.some(inUse))throw new SubmitError(409,'This scenario is loaded; load another scenario before deleting it');
   await fs.rm(path.join(imports,id),{recursive:true,force:true});
   known.delete(id);options.library.forget?.();
   return {ok:true,id,message:`Deleted external scenario · ${s.name}`};
  },
 };
}
export type ScenarioSubmissions=ReturnType<typeof createScenarioSubmissions>;

function privatePeer(address=''){
 address=address.replace(/^::ffff:/,'');
 if(address==='::1'||address.startsWith('127.'))return true;
 if(net.isIP(address)===4){const [a,b]=address.split('.').map(Number);return a===100&&b>=64&&b<=127;}
 return address.toLowerCase().startsWith('fd7a:115c:a1e0:');
}
const assets=path.join(path.dirname(fileURLToPath(import.meta.url)),'tdControl');
const PAGES:Record<string,[string,string]>={'/submit/':['submit.html','text/html; charset=utf-8'],'/submit/submit.mjs':['submit.mjs','text/javascript; charset=utf-8'],'/submit/submit.css':['submit.css','text/css; charset=utf-8']};

/**
 * Main-server (:3000) routes. Mounted before cors(); tailnet/localhost peers only. Through Funnel the public gate
 * (server/publicGate/submitGate.ts) checks the capture-token cookie and forwards over loopback with X-Submit-Key.
 */
export function createScenarioSubmitRouter(get:()=>ScenarioSubmissions|undefined){
 return async(req:express.Request,res:express.Response,next:express.NextFunction)=>{
  const route=(req.originalUrl||req.url).split('?')[0];
  if(route!=='/submit'&&!route.startsWith('/submit/')&&route!=='/api/scenario-submit')return next();
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  if(!privatePeer(req.socket.remoteAddress))return res.status(403).type('text/plain').send('Use the public submission link');
  if(route==='/submit')return req.method==='GET'?res.redirect(303,'/submit/'):res.status(405).end();
  if(route!=='/api/scenario-submit'){
   const page=PAGES[route];if(!page)return res.status(404).type('text/plain').send('Not found');
   if(req.method!=='GET'&&req.method!=='HEAD')return res.status(405).end();
   res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'");
   return res.type(page[1]).sendFile(path.join(assets,page[0]));
  }
  if(req.method!=='POST')return res.status(405).json({ok:false,error:'POST only'});
  const origin=req.headers.origin;
  if(origin&&!['http://'+req.headers.host,'https://'+req.headers.host].includes(origin))return res.status(403).json({ok:false,error:'Origin not allowed'});
  if(req.headers['x-submit-request']!=='1')return res.status(403).json({ok:false,error:'Missing submit header'});
  const service=get();if(!service)return res.status(503).json({ok:false,error:'Scenario submissions are unavailable (native operator not running)'});
  const declared=Number(req.headers['content-length']);
  if(Number.isFinite(declared)&&declared>SUBMIT_MAX_BODY)return res.status(413).json({ok:false,error:'Upload too large (CSV 2 MB, images 5 MB each, at most 5)'});
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>SUBMIT_MAX_BODY){req.destroy();return res.status(413).json({ok:false,error:'Upload too large (CSV 2 MB, images 5 MB each, at most 5)'});}chunks.push(chunk);}
  const peer=String(req.socket.remoteAddress??'').replace(/^::ffff:/,''),gateKey=String(req.headers['x-submit-key']??'');
  const key=(peer==='127.0.0.1'||peer==='::1')&&/^[a-f0-9]{16,64}$/.test(gateKey)?'gate:'+gateKey:'peer:'+peer;
  try{return res.json(await service.receive(Buffer.concat(chunks),String(req.headers['content-type']??''),key));}
  catch(error){const e=error instanceof SubmitError?error:new SubmitError(500,'Submission failed');return res.status(e.statusCode).json({ok:false,error:e.message,...e.extra});}
 };
}
