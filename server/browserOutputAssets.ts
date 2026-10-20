import fs from 'node:fs/promises';import path from 'node:path';import {randomUUID}from'node:crypto';import{execFile}from'node:child_process';
import {validateBrowserDisplayContents,type BrowserDisplayContent}from'./browserDisplay';
const PREFIX='/captures/browser-output-assets/';
const FILE=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp)$/;
const MIMES={png:'image/png',jpg:'image/jpeg',webp:'image/webp'}as const;
export class BrowserOutputAssetError extends Error{readonly statusCode=400;constructor(message:string){super(message);}}
interface Asset {filename:string;content:BrowserDisplayContent}
export interface BrowserOutputAssetsOptions{directory:string;maxBytes?:number;maxPixels?:number;python?:string;repositoryRoot?:string;inspect?:(data:Buffer,maxPixels:number)=>Promise<{format:'PNG'|'JPEG'|'WEBP';width:number;height:number}>}
const INSPECT=`import sys,io,json
from PIL import Image
im=Image.open(io.BytesIO(sys.stdin.buffer.read()))
w,h=im.size
if im.format not in ('PNG','JPEG','WEBP') or not 0<w<=16384 or not 0<h<=16384 or w*h>int(sys.argv[1]):raise ValueError('Invalid image')
fmt=im.format
im.load()
print(json.dumps(dict(format=fmt,width=w,height=h)))
`;
function decode(python:string,data:Buffer,maxPixels:number){return new Promise<{format:'PNG'|'JPEG'|'WEBP';width:number;height:number}>((resolve,reject)=>{
 const child=execFile(python,['-c',INSPECT,String(maxPixels)],{windowsHide:true,timeout:10000,maxBuffer:8192},(error,stdout)=>{try{if(error)throw error;resolve(JSON.parse(stdout));}catch{reject(new BrowserOutputAssetError('Image data is invalid or unsupported'));}});
 child.stdin?.on('error',()=>{});child.stdin?.end(data);
});}
export function createBrowserOutputAssets(options:BrowserOutputAssetsOptions){
 const directory=path.resolve(options.directory),repository=path.resolve(options.repositoryRoot??process.cwd());
 const comparable=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
 if(!path.isAbsolute(options.directory)||comparable(directory)===comparable(repository)||comparable(directory).startsWith(comparable(repository)+path.sep))throw Error('Output assets must be outside the public repository');
 const maxBytes=options.maxBytes??8*1024*1024,maxPixels=options.maxPixels??32*1024*1024;
 const inspect=options.inspect??((data,pixels)=>decode(options.python??process.env.TURBO_CPU_PYTHON??process.env.PEOPLE_DETECTOR_PYTHON??path.join(process.env.USERPROFILE??'','Documents/ComfyUI/.venv/Scripts/python.exe'),data,pixels));
 const registry=path.join(directory,'registry.json');let loaded:Promise<Map<string,Asset>>|undefined,tail:Promise<unknown>=Promise.resolve();
 const load=()=>loaded??=(async()=>{
  let rows:Asset[];try{const stat=await fs.lstat(registry);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid asset registry');rows=JSON.parse(await fs.readFile(registry,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')rows=[];else throw error;}
  if(!Array.isArray(rows))throw Error('Invalid asset registry');const map=new Map<string,Asset>();
  for(const row of rows){if(!row||!FILE.test(row.filename)||row.content?.imageUrl!==PREFIX+row.filename||row.content?.id!==row.filename.split('.')[0]||row.content?.provenance!=='uploaded'||row.content?.scope!=='uploaded'||![row.content.targetAtMs,row.content.recordedAtMs,row.content.generatedAtMs,row.content.sourceRecordedAtMs].every(t=>t===null)||typeof row.content.caption!=='string')throw Error('Invalid asset registry');const [content]=validateBrowserDisplayContents([row.content]);map.set(row.filename,{filename:row.filename,content});}return map;
 })();
 const service={
  async list(){return [...(await load()).values()].map(row=>({...row.content}));},
  async resolve(urlPath:string):Promise<{absolutePath:string;contentType:string}|null>{
   if(typeof urlPath!=='string'||!urlPath.startsWith(PREFIX))return null;const filename=urlPath.slice(PREFIX.length);if(!FILE.test(filename)||!(await load()).has(filename))return null;
   const absolutePath=path.join(directory,filename);try{const stat=await fs.lstat(absolutePath);if(!stat.isFile()||stat.isSymbolicLink())return null;const actual=await fs.realpath(absolutePath),root=await fs.realpath(directory);if(!actual.startsWith(root+path.sep))return null;}catch{return null;}
   return {absolutePath,contentType:MIMES[filename.split('.').pop()as keyof typeof MIMES]};
  },
  importImage(input:{filename:string;imageDataUrl:string}):Promise<BrowserDisplayContent>{
   const work=async()=>{
    if(!input||typeof input.filename!=='string'||!input.filename||input.filename.length>200||/[\\/:\u0000-\u001f\u007f]/.test(input.filename)||input.filename==='.'||input.filename==='..')throw new BrowserOutputAssetError('Use a plain image filename');
    if(typeof input.imageDataUrl!=='string'||input.imageDataUrl.length>Math.ceil(maxBytes/3)*4+64)throw new BrowserOutputAssetError('Image exceeds size limit');
    const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.imageDataUrl);if(!match)throw new BrowserOutputAssetError('PNG, JPEG or WebP data URL is required');
    const data=Buffer.from(match[2],'base64');if(!data.length||data.length>maxBytes||data.toString('base64')!==match[2])throw new BrowserOutputAssetError('Invalid or oversized image');
    const magic=data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'PNG':data.length>3&&data[0]===255&&data[1]===216&&data[2]===255?'JPEG':data.length>12&&data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP'?'WEBP':null;
    const format={png:'PNG',jpeg:'JPEG',webp:'WEBP'}[match[1]];if(!magic||magic!==format)throw new BrowserOutputAssetError('Image signature does not match MIME');
    let dimensions;try{dimensions=await inspect(data,maxPixels);}catch{throw new BrowserOutputAssetError('Image decode failed');}
    if(dimensions.format!==magic||!Number.isSafeInteger(dimensions.width)||!Number.isSafeInteger(dimensions.height)||dimensions.width<1||dimensions.height<1||dimensions.width>16384||dimensions.height>16384||dimensions.width*dimensions.height>maxPixels)throw new BrowserOutputAssetError('Invalid or excessive image dimensions');
    const id=randomUUID(),filename=id+'.'+(magic==='JPEG'?'jpg':magic==='PNG'?'png':'webp');
    const content:BrowserDisplayContent={id,scope:'uploaded',provenance:'uploaded',imageUrl:PREFIX+filename,caption:input.filename,distanceSecSigned:null,targetAtMs:null,recordedAtMs:null,generatedAtMs:null,sourceRecordedAtMs:null};
    await fs.mkdir(directory,{recursive:true});const realDirectory=comparable(await fs.realpath(directory)),realRepository=comparable(await fs.realpath(repository));if(realDirectory===realRepository||realDirectory.startsWith(realRepository+path.sep))throw Error('Output assets must be outside the public repository');
    const rows=await load();await fs.writeFile(path.join(directory,filename),data,{flag:'wx'});
    const next=new Map(rows);next.set(filename,{filename,content});const temporary=path.join(directory,'registry-'+randomUUID()+'.tmp');await fs.writeFile(temporary,JSON.stringify([...next.values()]),{flag:'wx'});await fs.rename(temporary,registry);loaded=Promise.resolve(next);return {...content};
   };
   const result=tail.then(work);tail=result.catch(()=>{});return result;
  }
 };return service;
}
