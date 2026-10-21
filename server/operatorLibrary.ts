import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadOperatorPlan,checkOperatorPlan} from './operatorScenario';

export function createOperatorLibrary(root:string,python:string,readOutputIds?:()=>Promise<string[]>|string[]){
 const load=(file:string)=>loadOperatorPlan(root,file,python,readOutputIds);
 /** Plan plus non-fatal format warnings; throws ScenarioFormatError listing every error. */
 const check=(file:string)=>checkOperatorPlan(root,file,python,readOutputIds);
 // 2026-10-21: list() runs on every state snapshot; with ~5000 imported folders it took ~0.7 s and made each settings.apply take 3 s
 // (scenario cues drifted 3 s late). Cache the scan briefly; upload() invalidates it.
 let cached:{at:number;rows:{file:string;name:string}[]}|undefined,inflight:Promise<{file:string;name:string}[]>|undefined;
 const list=()=>{if(cached&&Date.now()-cached.at<5000)return Promise.resolve(cached.rows.map(r=>({...r})));
  return (inflight??=scan().then(rows=>{cached={at:Date.now(),rows};return rows;}).finally(()=>{inflight=undefined;})).then(rows=>rows.map(r=>({...r})));};
 async function scan(){
  const rows:{file:string;name:string}[]=[];
  async function walk(folder:string){for(const entry of await fs.readdir(folder,{withFileTypes:true})){
   if(entry.isSymbolicLink()||entry.name.startsWith('.'))continue;
   const target=path.join(folder,entry.name);
   if(entry.isDirectory())await walk(target);
   else if(entry.isFile()&&entry.name.toLowerCase().endsWith('.csv'))rows.push({file:path.relative(root,target).split(path.sep).join('/'),name:path.basename(entry.name,'.csv')});
  }}
  await fs.mkdir(root,{recursive:true});await walk(root);return rows.sort((a,b)=>a.file.localeCompare(b.file));
 }
 /** extraFiles: dot-named sidecars (e.g. .submission.json) written into the folder before it becomes selectable. */
 async function upload(payload:any,extraFiles:Record<string,string>={}){
  cached=undefined;
  const safe=(name:unknown,ext:string)=>typeof name==='string'&&/^[A-Za-z0-9][A-Za-z0-9_. -]{0,120}$/.test(name)&&name.toLowerCase().endsWith(ext)&&!name.includes('..');
  if(!payload||!safe(payload.csv?.name,'.csv')||typeof payload.csv.text!=='string'||Buffer.byteLength(payload.csv.text)>2*1024*1024||!Array.isArray(payload.assets)||payload.assets.length>64)throw Error('Invalid scenario upload');
  const id=randomUUID(),imports=path.join(root,'browser-imports'),folder=path.join(imports,'.'+id),final=path.join(imports,id);
  await fs.mkdir(folder,{recursive:true});let total=0;const names=new Set<string>();
  try{
   await fs.writeFile(path.join(folder,payload.csv.name),payload.csv.text,{encoding:'utf8',flag:'wx'});
   for(const asset of payload.assets){
    if(!safe(asset?.name,'.png')||names.has(asset.name.toLowerCase())||typeof asset.base64!=='string'||asset.base64.length>12*1024*1024||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.base64))throw Error('Invalid scenario PNG upload');
    names.add(asset.name.toLowerCase());const raw=Buffer.from(asset.base64,'base64');
    if(raw.length>8*1024*1024||(total+=raw.length)>24*1024*1024||!raw.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Scenario PNG size or format invalid');
    await fs.writeFile(path.join(folder,asset.name),raw,{flag:'wx'});
   }
   // Validate paths and exact image protocol before making the import selectable.
   for(const [name,text] of Object.entries(extraFiles)){if(!/^\.[A-Za-z0-9_-]{1,40}\.json$/.test(name))throw Error('Invalid sidecar name');await fs.writeFile(path.join(folder,name),text,{encoding:'utf8',flag:'wx'});}
   const {plan,formatWarnings}=await checkOperatorPlan(root,`browser-imports/.${id}/${payload.csv.name}`,python,readOutputIds);
   await fs.rename(folder,final);
   cached=undefined;return {ok:true,file:`browser-imports/${id}/${payload.csv.name}`,id,scenarioId:plan.id,formatWarnings};
  }catch(error){
   // Preserve a failed upload outside the selectable library for diagnosis.
   await fs.writeFile(path.join(folder,'.failed'),String((error as Error).message),'utf8').catch(()=>{});
   throw error;
  }
 }
 /** Drop the cached listing (after a folder was removed outside upload()). */
 const forget=()=>{cached=undefined;};
 return {load,check,list,upload,forget};
}
