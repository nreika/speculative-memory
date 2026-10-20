import {personReferenceIds} from './operatorPersonReferences';
import type {OperatorSettings,OperatorSettingsSnapshot} from './operatorState';
/** One control-panel setting per scenario cue, shaped exactly like a settings.apply patch. */
export type ScenarioSettingsPatch=
 {mode:'manual'|'timer'|'chain'}|{intervalSec:number}|{presence:number}|{tone:number}|{emptyRoomPersonChance:number}|
 {scenes:Partial<Record<'a'|'b'|'c',{distanceSec?:number;continuousPersonReferenceIds?:string[];oneShotPersonReferenceIds?:string[]}>>};
export type ScenarioHold='pause'|'resume';
export interface ScenarioSettingsChange{settings?:ScenarioSettingsPatch;hold?:ScenarioHold}
const plain=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const ranges:Record<string,[number,number]>={intervalSec:[5,3600],presence:[0,1],tone:[0,1],emptyRoomPersonChance:[0,1],distanceSec:[-3600,3600]};
const finite=(v:unknown,key:string)=>{const [low,high]=ranges[key];if(typeof v!=='number'||!Number.isFinite(v)||v<low||v>high)throw Error(`Scenario ${key} is out of range (${low}..${high})`);};
/** Load-time shape check; settings.apply still performs the authoritative validation at run time. */
export function validateScenarioSettingsChange(raw:ScenarioSettingsChange):ScenarioSettingsChange{
 if(raw.hold!==undefined&&raw.hold!=='pause'&&raw.hold!=='resume')throw Error('Scenario hold is pause or resume');
 if(raw.settings===undefined){if(raw.hold===undefined)throw Error('Empty scenario setting');return structuredClone(raw);}
 if(raw.hold!==undefined)throw Error('A cue changes one setting or the hold, not both');
 const p=raw.settings as Record<string,any>;if(!plain(p)||Object.keys(p).length!==1)throw Error('Invalid scenario setting');
 const [key,value]=Object.entries(p)[0];
 if(key==='mode'){if(!['manual','timer','chain'].includes(value))throw Error('Scenario mode is manual, timer or chain');}
 else if(key in ranges&&key!=='distanceSec')finite(value,key);
 else if(key==='scenes'){
  if(!plain(value)||Object.keys(value).length!==1||!['a','b','c'].includes(Object.keys(value)[0]))throw Error('Invalid scenario scene setting');
  const row=Object.values(value)[0];if(!plain(row)||Object.keys(row).length!==1)throw Error('Invalid scenario scene setting');
  const [field,item]=Object.entries(row)[0];
  if(field==='distanceSec')finite(item,field);
  else if(field==='continuousPersonReferenceIds'||field==='oneShotPersonReferenceIds')personReferenceIds(item);
  else throw Error('Invalid scenario scene setting');
 }else throw Error('Invalid scenario setting');
 return structuredClone(raw);
}
/** Flat item paths, e.g. "presence" or "scenes.a.distanceSec". */
function items(patch:ScenarioSettingsPatch):string[]{
 const p=patch as Record<string,any>;return Object.entries(p).flatMap(([key,value])=>key==='scenes'?Object.entries(value as Record<string,any>).flatMap(([scene,row])=>Object.keys(row).map(field=>`scenes.${scene}.${field}`)):[key]);
}
const read=(settings:OperatorSettings,item:string)=>item.split('.').reduce<any>((v,k)=>v?.[k],settings);
const same=(a:unknown,b:unknown)=>JSON.stringify(a??null)===JSON.stringify(b??null);
function patchOf(entries:[string,unknown][]):Record<string,any>{
 const out:Record<string,any>={};for(const [item,value]of entries){const parts=item.split('.');if(parts[0]==='scenes'){out.scenes??={};(out.scenes[parts[1]]??={})[parts[2]]=structuredClone(value);}else out[item]=structuredClone(value);}return out;
}
export function describeScenarioSettingsChange(change:ScenarioSettingsChange):string{
 if(change.hold)return 'generation.'+change.hold;
 const p=change.settings as Record<string,any>;
 return items(change.settings!).map(item=>{const v=item.split('.').reduce<any>((x,k)=>x?.[k],p);return item+'='+(Array.isArray(v)?(v.length?v.join('|'):'(clear)'):String(v));}).join(', ');
}
interface StatePort{
 scenarioAction(input:{action:'settings.apply'|'generation.pause'|'generation.resume';data:Record<string,unknown>;requestId:string;baseRevision?:string}):Promise<{state:{settings:OperatorSettings}}>;
 readSettingsSnapshot():Promise<OperatorSettingsSnapshot>;readSubmissionHold():Promise<boolean>;
}
export class ScenarioSettingsConflict extends Error{readonly statusCode=409;}
/**
 * Applies scenario setting cues only through settings.apply / generation.pause / generation.resume.
 * Restores only items this run changed, and only while they still hold the value the run wrote.
 */
export function createOperatorScenarioSettings(options:{state:StatePort;checkPersonReferences?:(ids:string[])=>Promise<string[]>}){
 let active:{runId:string;baseline:OperatorSettings;hold:boolean;written:Map<string,unknown>;holdWritten?:boolean;seq:number}|undefined,tail:Promise<unknown>=Promise.resolve();
 const queue=<T>(f:()=>Promise<T>)=>{const p=tail.then(f);tail=p.catch(()=>{});return p;};
 const id=(run:NonNullable<typeof active>,label:string)=>`scn-${run.runId.slice(0,32)}-${++run.seq}-${label}`.slice(0,128);
 async function apply(run:NonNullable<typeof active>,data:Record<string,any>,label:string){
  const snap=await options.state.readSettingsSnapshot();
  return options.state.scenarioAction({action:'settings.apply',data,requestId:id(run,label),baseRevision:snap.settingsRevision});
 }
 return{
  begin(input:{runId:string}){return queue(async()=>{
   // Play/Restart keeps the original baseline so a later restore still returns to pre-scenario values.
   if(active){active.runId=input.runId;return;}
   const snap=await options.state.readSettingsSnapshot();active={runId:input.runId,baseline:structuredClone(snap.settings),hold:await options.state.readSubmissionHold(),written:new Map(),seq:0};
  });},
  apply(raw:ScenarioSettingsChange){const change=validateScenarioSettingsChange(raw);return queue(async()=>{
   if(!active)throw Error('No scenario settings run');const run=active;
   if(change.hold){await options.state.scenarioAction({action:change.hold==='pause'?'generation.pause':'generation.resume',data:{},requestId:id(run,change.hold)});run.holdWritten=change.hold==='pause';return;}
   const list=items(change.settings!);
   const refs=list.filter(item=>item.endsWith('PersonReferenceIds')).flatMap(item=>personReferenceIds(read(change.settings as unknown as OperatorSettings,item)));
   if(refs.length&&options.checkPersonReferences){const missing=await options.checkPersonReferences(refs);if(missing.length)throw Error('Unknown person reference IDs: '+missing.join('|'));}
   const result=await apply(run,change.settings as Record<string,any>,'settings');
   for(const item of list)run.written.set(item,structuredClone(read(result.state.settings,item)));
  });},
  /** Returns human-readable conflicts/failures; never overwrites an item changed after the run wrote it. */
  stop(){return queue(async()=>{
   if(!active)return [] as string[];const run=active;active=undefined;const errors:string[]=[];
   if(run.written.size){
    const current=(await options.state.readSettingsSnapshot()).settings,restore:[string,unknown][]=[];
    for(const [item,written]of run.written){const now=read(current,item),original=read(run.baseline,item);if(!same(now,written))errors.push(`${item} changed after the scenario set it; not restored`);else if(!same(now,original))restore.push([item,original]);}
    if(restore.length){
     try{await apply(run,patchOf(restore),'restore');}
     catch{for(const entry of restore){try{await apply(run,patchOf([entry]),'restore');}catch(error){errors.push(`${entry[0]} not restored: ${(error as Error).message}`);}}}
    }
   }
   if(run.holdWritten!==undefined){
    const hold=await options.state.readSubmissionHold();
    if(hold!==run.holdWritten)errors.push('generation hold changed after the scenario set it; not restored');
    else if(hold!==run.hold){try{await options.state.scenarioAction({action:run.hold?'generation.pause':'generation.resume',data:{},requestId:id(run,'restore-hold')});}catch(error){errors.push('generation hold not restored: '+(error as Error).message);}}
   }
   return errors;
  });},
  active(){return !!active;}
 };
}
