import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {validateScenarioOutputPatches,type ScenarioOutputPatch}from'./operatorScenarioOutputs';
import {parseScenarioControl} from './scenarioControl';
import {validateScenarioSettingsChange,describeScenarioSettingsChange,type ScenarioSettingsPatch,type ScenarioHold,type ScenarioSettingsChange} from './operatorScenarioSettings';

type Scene='gen_a'|'gen_b'|'gen_c';
type Layout=('A'|'B'|'C'|'NOW')[];
interface Cue {id:string;atSec:number;prompts?:Partial<Record<Scene,string>>;oneShot?:Partial<Record<Scene,string>>;images?:Partial<Record<Scene,any[]>>;sceneModes?:Partial<Record<Scene,string>>;layout?:string[];generate?:boolean;note?:string;outputs?:ScenarioOutputPatch[];settings?:ScenarioSettingsPatch;hold?:ScenarioHold}
export interface OperatorPlan {version:1;id:string;durationSec:number;loop:boolean;participantInstructions?:string;cues:Cue[]}
const sceneKeys:Scene[]=['gen_a','gen_b','gen_c'];
const layoutNames:Record<string,Layout[number]>={display_a:'A',display_b:'B',display_c:'C',display_now:'NOW'};
const inside=(root:string,file:string)=>{const rel=path.relative(root,file);return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);};

/** One CSV problem; row is the 1-based CSV line (header = 1), 0 = the file as a whole. */
export interface ScenarioFormatIssue {row:number;column?:string;message:string;severity:'error'|'warning';/** the offending CSV line (when known) */text?:string}
/** Full-file format check failed: nothing was loaded (HTTP 400 with formatErrors/formatWarnings). */
export class ScenarioFormatError extends Error{
 readonly statusCode=400;
 constructor(readonly formatErrors:ScenarioFormatIssue[],readonly formatWarnings:ScenarioFormatIssue[]=[]){
  super(`FORMAT ERROR: ${formatErrors.length} problem${formatErrors.length===1?'':'s'} in scenario CSV`+(formatErrors[0]?` (${formatErrors[0].row?'row '+formatErrors[0].row:'file'}: ${formatErrors[0].message})`:''));
 }
}
const issue=(row:number,message:string,column?:string):ScenarioFormatIssue=>({row,...(column?{column}:{}),message,severity:'error'});
const rowOf=(cue:Cue)=>{const match=/^row-(\d+)$/.exec(cue.id);return match?Number(match[1]):0;};

async function runParser(python:string,resolved:string){
 try{
  const result=await promisify(execFile)(python,[path.resolve('scripts/operator-scenario/parse_plan.py'),resolved],{timeout:10000,maxBuffer:4*1024*1024,windowsHide:true,encoding:'utf8'});
  return JSON.parse(result.stdout) as {ok:true;plan:OperatorPlan;formatWarnings?:ScenarioFormatIssue[]};
 }catch(error){
  const e=error as {code?:unknown;stdout?:string;stderr?:string;message?:string};
  // Exit 2 = format errors as JSON on stdout; anything else is an unexpected parser failure.
  let report:any;try{report=e.code===2&&e.stdout?JSON.parse(e.stdout):undefined;}catch{report=undefined;}
  if(report&&report.ok===false&&Array.isArray(report.formatErrors))throw new ScenarioFormatError(report.formatErrors,report.formatWarnings??[]);
  throw Error(String(e.stderr||'').trim()||String(e.message??error));
 }
}

/** Reuses the established CSV grammar; all paths are confined to the private library.
 *  Collects every problem; throws ScenarioFormatError (nothing loaded) when any is an error. */
export async function checkOperatorPlan(root:string,file:string,python:string,readOutputIds?:()=>Promise<string[]>|string[]):Promise<{plan:OperatorPlan;formatWarnings:ScenarioFormatIssue[]}>{
 if(typeof file!=='string'||file.includes('\\')||file.includes(':')||path.isAbsolute(file)||!file.toLowerCase().endsWith('.csv'))throw Error('Invalid scenario file');
 const realRoot=await fs.realpath(root),resolved=await fs.realpath(path.resolve(realRoot,file));
 if(!inside(realRoot,resolved))throw Error('Scenario is outside its library');
 const parsed=await runParser(python,resolved);
 const plan=parsed.plan,formatWarnings=parsed.formatWarnings??[],errors:ScenarioFormatIssue[]=[];
 // Node-side protocol checks run per cue so each failure is reported against its CSV row.
 const guard=(cue:Cue,work:()=>void,column?:string)=>{try{work();}catch(error){errors.push(issue(rowOf(cue),String((error as Error).message),column));}};
 for(const cue of plan.cues)if(cue.outputs)guard(cue,()=>validateScenarioOutputPatches(cue.outputs!),'value');
 for(const cue of plan.cues)if(cue.settings!==undefined||cue.hold!==undefined)guard(cue,()=>validateScenarioSettingsChange({settings:cue.settings,hold:cue.hold}),'value');
 const folder=path.dirname(resolved),cache=new Map<string,string>();let total=0;
 for(const cue of plan.cues)for(const elements of Object.values(cue.images??{}))for(const element of elements){
  const fail=(message:string)=>errors.push(issue(rowOf(cue),message,'value'));
  if(typeof element.image!=='string'||element.image.includes('\\')||element.image.includes(':')||path.isAbsolute(element.image)){fail('Invalid scenario image path');continue;}
  let asset:string;try{asset=await fs.realpath(path.resolve(folder,element.image));}catch{fail('Image file not found: '+element.image);continue;}
  if(!inside(folder,asset)||!asset.toLowerCase().endsWith('.png')){fail('Scenario image is outside its folder');continue;}
  if(!cache.has(asset)){
   const size=(await fs.stat(asset)).size;if(size>8*1024*1024||(total+=size)>24*1024*1024){fail('Scenario image size limit exceeded');continue;}
   cache.set(asset,'data:image/png;base64,'+(await fs.readFile(asset)).toString('base64'));
  }
  element.image=cache.get(asset);
 }
 // Validate the exact image-element protocol before a run can own the clock.
 if(!errors.length)for(const cue of plan.cues)if(Object.values(cue.images??{}).some(es=>es.length))guard(cue,()=>parseScenarioControl({version:1,scenarioId:plan.id,runId:'load-check',elapsedSec:cue.atSec,cycle:0,cueIds:[cue.id],sceneElements:cue.images}));
 if(errors.length)throw new ScenarioFormatError(errors,formatWarnings);
 // Non-fatal: output_* rows aimed at a screen missing from the current browser outputs (channels are always valid).
 if(readOutputIds&&plan.cues.some(c=>c.outputs?.length)){
  let known:Set<string>|undefined;try{known=new Set(await readOutputIds());}catch{known=undefined;}
  if(known)for(const cue of plan.cues)for(const o of cue.outputs??[])if(/^screen-/.test(o.id)&&!known.has(o.id)){
   const message=`target ${o.id} does not exist in the current browser outputs`;
   if(!formatWarnings.some(w=>w.row===rowOf(cue)&&w.message===message))formatWarnings.push({row:rowOf(cue),column:'value',message,severity:'warning'});
  }
 }
 return {plan,formatWarnings};
}
/** Plan only; throws ScenarioFormatError on any format error. */
export async function loadOperatorPlan(root:string,file:string,python:string,readOutputIds?:()=>Promise<string[]>|string[]):Promise<OperatorPlan>{return (await checkOperatorPlan(root,file,python,readOutputIds)).plan;}

export interface OperatorScenarioOptions {
 now?:()=>number;
 outputMapping?:{begin:(input:{preview:boolean;runId:string})=>Promise<void>;apply:(patches:ScenarioOutputPatch[])=>Promise<void>;stop:()=>Promise<void>};
 /** Control-panel settings: Live only, through settings.apply / generation.pause / generation.resume. stop() returns restore conflicts. */
 settings?:{begin:(input:{runId:string})=>Promise<void>;apply:(change:ScenarioSettingsChange)=>Promise<void>;stop:()=>Promise<string[]>};
 setLayout:(layout:Layout)=>void|Promise<void>;
 generate:(request:{requestId:string;source:'scenario'})=>Promise<unknown>;
 event?:(row:Record<string,unknown>)=>void;
 /** A run released ownership: natural end (same restore as Stop) or Stop. Called after layout/outputs/settings restore. */
 finished?:(info:{reason:'end'|'stop';runId:string;scenarioId:string;previewOnly:boolean;cueIds:string[];settingsCues:unknown[];restored:string[];restoreErrors:string[]})=>void|Promise<void>;
}
/** One monotonic Node clock. A cue is attempted once, never silently retried. */
export function createOperatorScenario(options:OperatorScenarioOptions){
 const now=options.now??(()=>performance.now()/1000);
 let plan:OperatorPlan|undefined,file='',state='stopped',runId='',preview=true,owned=false;
 let elapsed=0,anchor=0,cursor=0,cycle=0,baseline:Layout|undefined;
 let prompts:Partial<Record<Scene,string>>={},images:Partial<Record<Scene,any[]>>={},modes:Partial<Record<Scene,string>>={};
 const pending=new Map<string,{scene:Scene;text:string}>();let applied:string[]=[];
 let currentLayout:Layout|undefined,processing=false,lastOutputError='';
 let format:{formatErrors:ScenarioFormatIssue[];formatWarnings:ScenarioFormatIssue[];formatCheckedAt:string;formatFile:string;formatRows:number}={formatErrors:[],formatWarnings:[],formatCheckedAt:'',formatFile:'',formatRows:0};
 const generations:{cueId:string;captureId?:string;skipped?:string;status:string}[]=[];
 type SettingsRow={cueId:string;atSec:number;change:string;status:'applied'|'skipped'|'failed';skipped?:string;error?:string};
 const settingsRows:SettingsRow[]=[];let lastSettingsError='',settingsOwned=false;
 // mode cue applied live by this run (timer|chain): the native scheduler then runs auto captures during playback.
 let autoMode:'timer'|'chain'|undefined;
 const hasSettings=()=>!!plan?.cues.some(c=>c.settings!==undefined||c.hold!==undefined);
 const record=(row:SettingsRow)=>{settingsRows.push(row);if(settingsRows.length>200)settingsRows.splice(0,settingsRows.length-200);};
 /** Restores only items this run changed; conflicts are reported in lastSettingsError, never overwritten. */
 async function restoreSettings(reason:'end'|'stop'){
  if(!settingsOwned||!options.settings)return [] as string[];settingsOwned=false;
  let errors:string[];try{errors=await options.settings.stop();}catch(error){errors=[String((error as Error).message)];}
  if(errors.length){lastSettingsError=`Restore on ${reason}: `+errors.join('; ');emit('settings.restore.failed',{reason,errors});}else emit('settings.restored',{reason});
  return errors;
 }
 /** Shared by Stop and natural end: layout baseline, output mapping, then settings/hold; each restored item is logged. */
 async function release(reason:'end'|'stop',wasOwned=owned){
  const cueIds=[...applied],restored:string[]=[],restoreErrors:string[]=[];owned=false;autoMode=undefined;reset();
  if(baseline){const previous=baseline;baseline=undefined;await options.setLayout(previous);restored.push('layout='+previous.join('|'));emit('restore.layout',{reason,layout:previous});}
  let outputError:unknown;
  try{if(options.outputMapping){await options.outputMapping.stop();if(wasOwned&&plan?.cues.some(c=>c.outputs)){restored.push('outputs');emit('restore.outputs',{reason});}}}
  catch(error){lastOutputError=String((error as Error).message);emit('output.mapping.failed',{reason,error:lastOutputError});outputError=error;restoreErrors.push('outputs: '+lastOutputError);}
  const hadSettings=settingsOwned,settingsErrors=await restoreSettings(reason);restoreErrors.push(...settingsErrors);
  if(hadSettings&&!settingsErrors.length)restored.push('settings');
  if(wasOwned&&runId)try{await options.finished?.({reason,runId,scenarioId:plan?.id??'',previewOnly:preview,cueIds,settingsCues:structuredClone(settingsRows),restored,restoreErrors});}catch(error){emit('run.finished.failed',{reason,error:String((error as Error).message)});}
  return {outputError,settingsErrors};
 }
 const time=()=>elapsed+(state==='running'?Math.max(0,now()-anchor):0);
 const emit=(event:string,extra:Record<string,unknown>={})=>options.event?.({event,runId,scenarioId:plan?.id,elapsedSec:time(),previewOnly:preview,...extra});
 const reset=()=>{cursor=0;prompts={};images={};modes={};pending.clear();applied=[];currentLayout=undefined;};
 const snapshot=()=>{
  const combined={...prompts};for(const {scene,text} of pending.values())combined[scene]=[combined[scene],text].filter(Boolean).join('\n');
  return {prompts:{a:combined.gen_a??'',b:combined.gen_b??'',c:combined.gen_c??''},receipt:{runId,tokens:[...pending.keys()]},
   ...(owned&&!preview&&plan&&Object.values(images).some(es=>es.length)?{scenarioControl:{version:1,scenarioId:plan.id,runId,elapsedSec:Math.min(time(),86400),cycle,cueIds:applied.slice(-64),sceneElements:structuredClone(images),...(Object.keys(modes).length?{sceneModes:{...modes}}:{})}}:{})};
 };
 async function tick(){
  if(processing||state!=='running'||!plan)return;processing=true;
  try{
   const full=time(),nextCycle=plan.loop?Math.floor(full/plan.durationSec):0;
   if(nextCycle!==cycle){cycle=nextCycle;reset();}
   const offset=plan.loop?full%plan.durationSec:Math.min(full,plan.durationSec);
   const requests:Cue[]=[];let changedLayout=false;
   while(cursor<plan.cues.length&&plan.cues[cursor].atSec<=offset&&state==='running'){
    const cue=plan.cues[cursor++];Object.assign(prompts,cue.prompts);Object.assign(images,structuredClone(cue.images??{}));
    for(const [key,mode]of Object.entries(cue.sceneModes??{})){if(mode==='default')delete modes[key];else modes[key]=mode;}
    for(const scene of sceneKeys)if(cue.oneShot?.[scene])pending.set(`${cycle}:${cue.id}:${scene}`,{scene,text:cue.oneShot[scene]!});
    if(cue.layout){currentLayout=cue.layout.map(x=>layoutNames[x]??x) as Layout;changedLayout=true;}
    if(cue.outputs){if(!options.outputMapping)throw Error('Scenario output mapping is unavailable');try{await options.outputMapping.apply(cue.outputs);}catch(error){lastOutputError=String((error as Error).message);elapsed=time();state='paused';emit('output.mapping.failed',{cueId:cue.id,error:lastOutputError});throw error;}}
    if(cue.settings!==undefined||cue.hold!==undefined){
     const change={settings:cue.settings,hold:cue.hold},row:SettingsRow={cueId:cue.id,atSec:cue.atSec,change:describeScenarioSettingsChange(change),status:'applied'};
     if(preview){row.status='skipped';row.skipped='preview';emit('settings.skipped',{cueId:cue.id,change:row.change,reason:'preview'});}
     else try{if(!options.settings||!settingsOwned)throw Error('Scenario settings control is unavailable');await options.settings.apply(change);emit('settings.applied',{cueId:cue.id,change:row.change});const m=(cue.settings as {mode?:string}|undefined)?.mode;if(m!==undefined)autoMode=m==='timer'||m==='chain'?m:undefined;}
     catch(error){row.status='failed';row.error=String((error as Error).message);lastSettingsError=`${cue.id} (${row.change}): ${row.error}`;emit('settings.failed',{cueId:cue.id,change:row.change,error:row.error});}
     record(row);
    }
    applied.push(cue.id);emit('cue.applied',{cueId:cue.id});
    if(cue.generate)requests.push(cue);
   }
   if(changedLayout&&currentLayout)await options.setLayout([...currentLayout]);
   for(const cue of requests){
     if(state!=='running')break;
     const reason=preview?'preview':cue!==requests.at(-1)||offset-cue.atSec>2?'late':'';
     const row:{cueId:string;captureId?:string;skipped?:string;status:string}={cueId:cue.id,status:reason?'skipped':'requested'};generations.push(row);
     if(reason){row.skipped=reason;emit('generation.skipped',{cueId:cue.id,reason});}
     else{
      const identity={runId,scenarioId:plan.id,cycle,elapsedSec:time()};
      // Do not await inference: the scenario clock and Stop remain responsive.
      void options.generate({requestId:`${runId}_${cycle}_${cue.id}`,source:'scenario'}).then((result:any)=>{
       row.captureId=result?.captureId;row.status='accepted';emit('capture.requested',{...identity,cueId:cue.id,captureId:row.captureId});
      }).catch(error=>{row.status='skipped';row.skipped=String(error?.message??error);emit('generation.skipped',{...identity,cueId:cue.id,reason:row.skipped});});
     }
   }
   if(!plan.loop&&full>=plan.durationSec&&state==='running'){
    elapsed=plan.durationSec;state='completed';emit('run.completed');
    // Natural end performs the same restore as Stop (layout, output mapping, settings + hold); failures are reported, not thrown.
    const result=await release('end');
    if(result.outputError){lastOutputError=String((result.outputError as Error).message);}
   }
  }finally{processing=false;}
 }
 return {
  /** Keeps the last full-file check visible until the next clean load clears it; the loaded plan is untouched. */
  recordFormat(checkedFile:string,result:{formatErrors?:ScenarioFormatIssue[];formatWarnings?:ScenarioFormatIssue[]}){format={formatErrors:structuredClone(result.formatErrors??[]),formatWarnings:structuredClone(result.formatWarnings??[]),formatCheckedAt:new Date().toISOString(),formatFile:checkedFile,formatRows:0};},
  load(next:OperatorPlan,nextFile:string,formatWarnings:ScenarioFormatIssue[]=[]){if(owned)throw Error('Stop the scenario before loading');plan=structuredClone(next);file=nextFile;format={formatErrors:[],formatWarnings:structuredClone(formatWarnings),formatCheckedAt:new Date().toISOString(),formatFile:nextFile,formatRows:next.cues.length};state='ready';elapsed=0;runId='';lastOutputError='';lastSettingsError='';settingsRows.length=0;generations.length=0;reset();},
  async play(dry:boolean,layout:Layout){if(!plan)throw Object.assign(Error('Load a scenario first'),{statusCode:409});if(processing)throw Object.assign(Error('Scenario is updating; retry'),{statusCode:409});const nextRunId=randomUUID().replaceAll('-','');if(plan.cues.some(c=>c.outputs)){if(!options.outputMapping)throw Error('Scenario output mapping is unavailable');await options.outputMapping.begin({preview:dry,runId:nextRunId});}if(!dry&&hasSettings()){if(!options.settings)throw Error('Scenario settings control is unavailable');await options.settings.begin({runId:nextRunId});settingsOwned=true;}autoMode=undefined;baseline??=[...layout];owned=true;preview=dry;runId=nextRunId;lastOutputError='';lastSettingsError='';settingsRows.length=0;state='running';elapsed=0;anchor=now();cycle=0;reset();generations.length=0;emit('run.started');await tick();},
  pause(){if(state==='running'){elapsed=time();state='paused';emit('run.paused');}else if(state==='paused'){anchor=now();state='running';emit('run.resumed');}},
  async stop(){const wasOwned=owned;elapsed=time();state='stopped';emit('run.stopped');const {outputError,settingsErrors}=await release('stop',wasOwned);if(outputError)throw outputError;if(settingsErrors.length)throw Object.assign(Error(lastSettingsError),{statusCode:409});},
  tick,snapshot,
  captureSnapshot(){
   for(const scene of sceneKeys)if(modes[scene]==='asset_only'&&!images[scene]?.length)throw Object.assign(Error('asset_only requires an active image element for '+scene),{statusCode:400});
   const result=snapshot();if(result.scenarioControl)parseScenarioControl(result.scenarioControl);return result;
  },
  acknowledge(receipt:{runId:string;tokens:string[]}){if(receipt.runId===runId)for(const token of receipt.tokens)pending.delete(token);},
  canGenerate(){return owned&&state==='running'&&!preview;},
  /** timer|chain when this live run set the mode itself (CSV mode cue) and is running; otherwise undefined. */
  autoCaptureMode(){return owned&&state==='running'&&!preview?autoMode:undefined;},
  ownsLayout(){return owned;},
  status(){return {state,status:state,previewOnly:preview,scenarioId:plan?.id??'',runId,elapsedSec:time(),durationSec:plan?.durationSec??0,ownsLayout:owned,file,layout:currentLayout??null,prompts:Object.fromEntries(Object.entries(snapshot().prompts).map(([key,value])=>['gen_'+key,value])),cueIds:[...applied],instructions:plan?.participantInstructions??'',requestedGenerations:generations.filter(g=>g.status!=='skipped').length,skippedGenerations:generations.filter(g=>g.status==='skipped').length,lastGenerationReason:generations.at(-1)?.skipped??'',lastGenerationSkipped:generations.at(-1)?.skipped??'',lastOutputError,generationCues:structuredClone(generations),appliedSettings:settingsRows.filter(r=>r.status==='applied').length,skippedSettings:settingsRows.filter(r=>r.status==='skipped').length,failedSettings:settingsRows.filter(r=>r.status==='failed').length,lastSettingsSkipped:settingsRows.at(-1)?.skipped??'',lastSettingsError,settingsCues:structuredClone(settingsRows),...structuredClone(format)};}
 };
}
