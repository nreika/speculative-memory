/**
 * G-27: every live scenario run keeps an exact copy of the CSV it played (the library CSV may be edited later).
 *   logs/scenario-runs/<startISO>_<scenarioId>_<runId>.csv   exact text used
 *   logs/scenario-runs/<same>.json                            sidecar, rewritten at start and at end/stop
 *   logs/scenario-runs.jsonl                                  one row at start and one at end (fold by runId, later wins)
 * Writes never throw into the scenario: a failed archive write is logged and the run continues.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export type ScenarioRunEndReason='end'|'stop'|'error';
export interface ScenarioRunRecord {
 schema:1;runId:string;scenarioId:string;file:string;sha256:string;csvFile:string;
 startedAt:string;endedAt:string|null;endReason:ScenarioRunEndReason|null;
 cuesApplied:number;cueIds:string[];settingsCues:unknown[];outputsChanged:unknown[];captureIds:string[];
 restored?:string[];restoreErrors?:string[];
}
export interface ScenarioRunTag {runId:string;scenarioId:string;csvSha:string}
const RUN_ID=/^[A-Za-z0-9_-]{1,64}$/;
export const csvSha256=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
const safePart=(value:string)=>value.replace(/[^A-Za-z0-9_.-]+/g,'-').replace(/^[-.]+/,'').slice(0,64)||'scenario';

export function createScenarioRunArchive(options:{logsDirectory:string;now?:()=>Date}){
 const now=options.now??(()=>new Date());
 const folder=path.join(options.logsDirectory,'scenario-runs'),index=path.join(options.logsDirectory,'scenario-runs.jsonl');
 const active=new Map<string,ScenarioRunRecord>();
 const guard=(label:string,work:()=>void)=>{try{work();}catch(error){console.error('[scenario-runs] '+label+' failed (run continues):',error);}};
 const sidecarPath=(record:ScenarioRunRecord)=>path.join(folder,record.csvFile.replace(/\.csv$/,'.json'));
 const writeSidecar=(record:ScenarioRunRecord)=>{fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(sidecarPath(record),JSON.stringify(record,null,1)+'\n','utf8');};
 const appendIndex=(record:ScenarioRunRecord)=>{fs.mkdirSync(options.logsDirectory,{recursive:true});fs.appendFileSync(index,JSON.stringify(record)+'\n','utf8');};
 /** All runs folded by runId (later rows win), oldest first. */
 function list():ScenarioRunRecord[]{
  let text='';try{text=fs.readFileSync(index,'utf8');}catch{return [];}
  const byId=new Map<string,ScenarioRunRecord>();
  for(const line of text.split('\n')){if(!line.trim())continue;try{const row=JSON.parse(line);if(row&&typeof row.runId==='string'&&RUN_ID.test(row.runId))byId.set(row.runId,{...(byId.get(row.runId)??{}),...row});}catch{/* torn line */}}
  for(const [id,record]of active)byId.set(id,structuredClone(record));
  return [...byId.values()].filter(r=>typeof r.startedAt==='string'&&Number.isFinite(Date.parse(r.startedAt))).sort((a,b)=>Date.parse(a.startedAt)-Date.parse(b.startedAt));
 }
 const get=(runId:string)=>RUN_ID.test(runId)?list().find(r=>r.runId===runId)??null:null;
 return{
  folder,index,list,get,
  /** Copies the exact CSV text and writes the first sidecar + index row. */
  begin(input:{runId:string;scenarioId:string;file:string;csvText:string;startedAt?:string;outputsChanged?:unknown[]}):ScenarioRunRecord{
   const startedAt=input.startedAt??now().toISOString(),sha256=csvSha256(input.csvText);
   const csvFile=`${startedAt.replace(/[:.]/g,'-')}_${safePart(input.scenarioId)}_${safePart(input.runId)}.csv`;
   const record:ScenarioRunRecord={schema:1,runId:input.runId,scenarioId:input.scenarioId,file:input.file,sha256,csvFile,startedAt,endedAt:null,endReason:null,cuesApplied:0,cueIds:[],settingsCues:[],outputsChanged:structuredClone(input.outputsChanged??[]),captureIds:[]};
   active.set(input.runId,record);
   guard('csv copy',()=>{fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,csvFile),input.csvText,{encoding:'utf8',flag:'wx'});});
   guard('sidecar',()=>writeSidecar(record));guard('index',()=>appendIndex(record));
   return structuredClone(record);
  },
  /** Live counters (kept in memory; persisted at finish). */
  note(runId:string,patch:Partial<Pick<ScenarioRunRecord,'cuesApplied'|'cueIds'|'settingsCues'>>&{captureId?:string}){
   const record=active.get(runId);if(!record)return;
   if(patch.cuesApplied!==undefined)record.cuesApplied=patch.cuesApplied;
   if(patch.cueIds)record.cueIds=[...patch.cueIds].slice(-500);
   if(patch.settingsCues)record.settingsCues=structuredClone(patch.settingsCues).slice(-200);
   if(patch.captureId&&!record.captureIds.includes(patch.captureId))record.captureIds.push(patch.captureId);
  },
  finish(runId:string,result:{endReason:ScenarioRunEndReason;cuesApplied?:number;cueIds?:string[];settingsCues?:unknown[];outputsChanged?:unknown[];restored?:string[];restoreErrors?:string[]}):ScenarioRunRecord|null{
   const record=active.get(runId);if(!record)return null;active.delete(runId);
   Object.assign(record,{endedAt:now().toISOString(),endReason:result.endReason,
    ...(result.cuesApplied!==undefined?{cuesApplied:result.cuesApplied}:{}),...(result.cueIds?{cueIds:result.cueIds.slice(-500)}:{}),
    ...(result.settingsCues?{settingsCues:structuredClone(result.settingsCues).slice(-200)}:{}),...(result.outputsChanged?{outputsChanged:structuredClone(result.outputsChanged).slice(-500)}:{}),
    ...(result.restored?{restored:result.restored}:{}),...(result.restoreErrors?.length?{restoreErrors:result.restoreErrors}:{})});
   guard('sidecar',()=>writeSidecar(record));guard('index',()=>appendIndex(record));
   return structuredClone(record);
  },
  /** Startup: runs left open by a crash/restart are closed as endReason=error (no CSV is changed). */
  closeInterrupted(){
   for(const record of list())if(!record.endedAt&&!active.has(record.runId)){
    const closed={...record,endedAt:now().toISOString(),endReason:'error' as const,restoreErrors:['run interrupted (server stopped before end/stop)']};
    guard('sidecar',()=>writeSidecar(closed));guard('index',()=>appendIndex(closed));
   }
  },
  readCsv(runId:string):string|null{const record=get(runId);if(!record||!/^[A-Za-z0-9_.-]+\.csv$/.test(record.csvFile))return null;try{return fs.readFileSync(path.join(folder,record.csvFile),'utf8');}catch{return null;}},
 };
}
export type ScenarioRunArchive=ReturnType<typeof createScenarioRunArchive>;

/** GET /api/scenario-runs (list), /api/scenario-runs/:runId (sidecar), /api/scenario-runs/:runId/csv (exact copy). */
export function registerScenarioRunRoutes(app:{get:(route:string,handler:(req:any,res:any)=>void)=>unknown},archive:ScenarioRunArchive){
 app.get('/api/scenario-runs',(_req,res)=>{res.setHeader('Cache-Control','no-store');res.json({schema:1,runs:archive.list().slice(-500)});});
 app.get('/api/scenario-runs/:runId/csv',(req,res)=>{
  res.setHeader('Cache-Control','no-store');const text=archive.readCsv(String(req.params.runId));
  if(text===null)return res.status(404).json({error:'Scenario run CSV not found'});
  res.type('text/plain; charset=utf-8').send(text);
 });
 app.get('/api/scenario-runs/:runId',(req,res)=>{res.setHeader('Cache-Control','no-store');const record=archive.get(String(req.params.runId));if(!record)return res.status(404).json({error:'Scenario run not found'});res.json(record);});
}
