import {personReferenceIds,mergedPersonReferenceIds} from './operatorPersonReferences';
/** Main-owned operator state. No TD calls, generation loop, camera access or network. */
import{DEFAULT_EMPTY_ROOM_PERSON_CHANCE}from'./generation/emptyRoomDecision';
import fs from'node:fs/promises';import path from'node:path';import{createHash,randomUUID}from'node:crypto';
import {renameRetry} from './renameRetry';
export type OperatorScene='a'|'b'|'c';
export interface OperatorSettings {mode:'manual'|'timer'|'chain';intervalSec:number;imageCount:number;presence:number;tone:number;emptyRoomPersonChance:number;vlmBackend:'local'|'gemini';imageBackend:'local'|'gemini';displayTiming:'each'|'all';scenarioPreview:boolean;labels:boolean;subtitles:boolean;fade:boolean;scenes:Record<OperatorScene,{distanceSec:number;continuous:string;oneShot:string;continuousPersonReferenceIds?:string[];oneShotPersonReferenceIds?:string[];/** Per-scene override 0..1; absent = the global presence / tone. */presence?:number;tone?:number}>}
export interface OperatorDisplay{layout:('A'|'B'|'C'|'NOW')[];visible:boolean}
export interface OperatorSettingsSnapshot {settings:OperatorSettings;settingsRevision:string;oneShotTokens:Record<OperatorScene,string>}
export interface OperatorAction {action:string;data:Record<string,unknown>;requestId:string;baseRevision?:string}
export interface OperatorStateOptions {file:string;initial:Record<string,any>;runtime?:()=>Record<string,any>|Promise<Record<string,any>>;delegate?:(action:string,data:Record<string,unknown>,context:OperatorSettingsSnapshot&{submissionHold:boolean;requestId:string;origin?:'scenario'})=>Promise<{message?:string;submissionHold?:boolean}|void>;receiptLimit?:number}
export class OperatorStateError extends Error{constructor(readonly status:number,message:string,readonly indeterminate=false){super(message);}get statusCode(){return this.status;}}
interface Receipt {id:string;signature:string;status:'pending'|'completed'|'failed';message?:string;errorStatus?:number}
interface Stored {schema:1;settings:OperatorSettings;settingsRevision:string;display:OperatorDisplay;submissionHold:boolean;oneShotTokens:Record<OperatorScene,string>;receipts:Receipt[]}
const scenes=['a','b','c']as const,layoutSources=['A','B','C','NOW'];
const delegated=new Set(['generation.resume','generation.pause','generation.generate','generation.cancel','scenario.load','scenario.play','scenario.pause','scenario.stop','input.select']);
const local=new Set(['settings.apply','display.layout','display.shuffle','display.reset','display.show','display.hide','project.save']);
const clone=<T>(v:T):T=>structuredClone(v),plain=(v:any):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function fail(message='Invalid operator settings'):never{throw new OperatorStateError(400,message);}
function keys(v:Record<string,unknown>,allowed:string[]){if(Object.keys(v).some(k=>!allowed.includes(k)))fail('Unsupported setting');}
function finite(v:unknown,min:number,max:number,integer=false){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||integer&&!Number.isInteger(v))fail();}
function text(v:unknown){if(typeof v!=='string'||v.length>4000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v))fail();}
const sceneOverrides=['presence','tone']as const,sceneKeys=['distanceSec','continuous','oneShot','continuousPersonReferenceIds','oneShotPersonReferenceIds',...sceneOverrides];
/** Scene patch merge: presence/tone null = remove the override (the scene inherits the global value again). */
function assignScene(target:Record<string,any>,patch:Record<string,any>){Object.assign(target,patch);for(const key of sceneOverrides)if(target[key]===null)delete target[key];}
function settings(value:unknown):OperatorSettings{
 if(!plain(value))fail();value=clone(value);if(!plain(value))fail();if(value.emptyRoomPersonChance===undefined)value.emptyRoomPersonChance=DEFAULT_EMPTY_ROOM_PERSON_CHANCE;keys(value,['mode','intervalSec','imageCount','presence','tone','emptyRoomPersonChance','vlmBackend','imageBackend','displayTiming','scenarioPreview','labels','subtitles','fade','scenes']);
 if(!['manual','timer','chain'].includes(value.mode)||!['local','gemini'].includes(value.vlmBackend)||!['local','gemini'].includes(value.imageBackend)||!['each','all'].includes(value.displayTiming))fail();
 finite(value.intervalSec,5,3600);finite(value.imageCount,1,3,true);finite(value.presence,0,1);finite(value.tone,0,1);finite(value.emptyRoomPersonChance,0,1);for(const key of ['scenarioPreview','labels','subtitles','fade'])if(typeof value[key]!=='boolean')fail();
 if(!plain(value.scenes))fail();keys(value.scenes,[...scenes]);for(const scene of scenes){const row=value.scenes[scene];if(!plain(row))fail();keys(row,sceneKeys);for(const key of sceneOverrides)if(row[key]===null||row[key]===undefined)delete row[key];else finite(row[key],0,1);try{row.continuousPersonReferenceIds=personReferenceIds(row.continuousPersonReferenceIds);row.oneShotPersonReferenceIds=personReferenceIds(row.oneShotPersonReferenceIds);mergedPersonReferenceIds(row.continuousPersonReferenceIds,row.oneShotPersonReferenceIds);}catch(error){fail((error as Error).message);}finite(row.distanceSec,-3600,3600);text(row.continuous);text(row.oneShot);}return clone(value)as OperatorSettings;
}
function display(value:unknown):OperatorDisplay{if(!plain(value)||!Array.isArray(value.layout)||value.layout.length!==4||!value.layout.every((v:unknown)=>layoutSources.includes(v as string))||typeof value.visible!=='boolean')fail('Invalid display settings');return{layout:[...value.layout],visible:value.visible};}
const tokens=()=>Object.fromEntries(scenes.map(s=>[s,randomUUID()]))as Record<OperatorScene,string>;
export function createOperatorState(options:OperatorStateOptions){
 if(!path.isAbsolute(options.file))throw Error('Operator state requires private absolute file');const root=path.resolve(process.cwd()),file=path.resolve(options.file),norm=(p:string)=>process.platform==='win32'?p.toLowerCase():p;if(norm(file).startsWith(norm(root)+path.sep))throw Error('Operator state must be outside public repository');
 const limit=options.receiptLimit??128;if(!Number.isInteger(limit)||limit<1||limit>1024)throw Error('Invalid receipt limit');
 let state:Stored,loaded:Promise<void>|undefined,tail:Promise<unknown>=Promise.resolve();
 const queue=<T>(work:()=>Promise<T>)=>{const result=tail.then(work);tail=result.catch(()=>{});return result;};
 const save=async()=>{await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(state),{flag:'wx'});await renameRetry(temp,file);};
 const load=()=>loaded??=(async()=>{try{const data=JSON.parse(await fs.readFile(file,'utf8'));if(data.schema!==1||typeof data.settingsRevision!=='string'||typeof data.submissionHold!=='boolean'||!plain(data.oneShotTokens)||!scenes.every(s=>typeof data.oneShotTokens[s]==='string')||!Array.isArray(data.receipts))throw Error('Invalid stored operator state');state={...data,settings:settings(data.settings),display:display(data.display)};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;state={schema:1,settings:settings({...options.initial.settings,mode:'manual',scenarioPreview:false}),settingsRevision:randomUUID(),display:display(options.initial.display),submissionHold:true,oneShotTokens:tokens(),receipts:[]};await save();}})();
 const runtime=async()=>options.runtime?await options.runtime():{};
 const snapshot=async()=>{await load();const dynamic=await runtime();const base:Record<string,any>={};for(const key of ['schema','project','capture','scenario','scenarioLibrary','replay','history','sceneText','captureScenes','cost','errors','remoteCamera'])base[key]=clone(dynamic[key]??options.initial[key]);base.pendingInput=clone(dynamic.pendingInput??null);base.warnings=clone(Array.isArray(dynamic.warnings)?dynamic.warnings:[]);base.sceneNotes=clone(dynamic.sceneNotes??null);if(base.scenario&&plain(base.scenario)){delete base.scenario.logPath;delete base.scenario.absolutePath;}return{...base,schema:1,connected:true,observedAtMs:Date.now(),settings:clone(state.settings),settingsRevision:state.settingsRevision,display:clone(state.display),submissionHold:state.submissionHold,runtime:'native'};};
 const settingsSnapshot=async():Promise<OperatorSettingsSnapshot>=>{await load();return{settings:clone(state.settings),settingsRevision:state.settingsRevision,oneShotTokens:clone(state.oneShotTokens)};};
 const result=async(message:string)=>({ok:true as const,state:await snapshot(),message});
 const reserve=async(input:OperatorAction,origin?:'scenario')=>{
  await load();if(!input||!plain(input.data)||typeof input.requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.requestId)||!local.has(input.action)&&!delegated.has(input.action))fail('Invalid operator action');
  const signature=createHash('sha256').update(JSON.stringify([input.action,input.data,input.baseRevision??null])).digest('hex'),old=state.receipts.find(r=>r.id===input.requestId);
  if(old){if(old.signature!==signature)throw new OperatorStateError(409,'requestId was already used for another command');if(old.status==='pending')throw new OperatorStateError(409,'Command outcome is unconfirmed; refresh state before continuing',true);if(old.status==='failed')throw new OperatorStateError(old.errorStatus??409,old.message??'Command rejected',old.errorStatus===504);return{done:true as const,message:old.message??'Already applied'};}
  const actual=await runtime();if(input.action==='settings.apply'){
   if(input.baseRevision!==state.settingsRevision)throw new OperatorStateError(409,'Settings changed; refresh before applying');
   if(origin!=='scenario'&&actual.scenario?.ownsLayout&&(Object.keys(input.data).some(k=>['mode','scenarioPreview','scenes'].includes(k))))throw new OperatorStateError(409,'Scenario currently owns these settings');
   const merged=clone(state.settings);keys(input.data,Object.keys(merged));for(const [key,value]of Object.entries(input.data)){if(key==='scenes'){if(!plain(value))fail();keys(value,[...scenes]);for(const [scene,patch]of Object.entries(value)){if(!plain(patch))fail();keys(patch,sceneKeys);assignScene(merged.scenes[scene as OperatorScene],patch);}}else(merged as any)[key]=value;}settings(merged);
  }
  if(actual.scenario?.ownsLayout&&['display.layout','display.shuffle','display.reset'].includes(input.action))throw new OperatorStateError(409,'Scenario currently owns the layout');
  if(input.action==='display.layout')display({layout:input.data.sources,visible:state.display.visible});
  // 2026-10-21: a full journal of pending receipts used to refuse every later command forever (persisted across restarts;
  // MAIN was dead from 03:09 under rapid play/stop). Drop the oldest settled receipt, else the oldest pending one.
  while(state.receipts.length>=limit){let index=state.receipts.findIndex(r=>r.status!=='pending');if(index<0)index=0;state.receipts.splice(index,1);}
  if(delegated.has(input.action)&&!options.delegate)throw new OperatorStateError(503,'Operator runtime unavailable');
  const receipt:Receipt={id:input.requestId,signature,status:'pending'};state.receipts.push(receipt);await save();
  if(local.has(input.action)){await applyLocal(input,receipt);return{done:true as const,message:receipt.message!};}
  return{done:false as const,receipt,context:{...await settingsSnapshot(),submissionHold:state.submissionHold,requestId:input.requestId,...(origin?{origin}:{})}};
 };
 const finish=async(receipt:Receipt,message:string)=>{receipt.status='completed';receipt.message=message;await save();};
 const applyLocal=async(input:OperatorAction,receipt:Receipt)=>{
    if(input.action==='settings.apply'){const next=clone(state.settings);for(const [key,value]of Object.entries(input.data)){if(key==='scenes'){for(const [scene,patch]of Object.entries(value as Record<string,any>)){assignScene(next.scenes[scene as OperatorScene],patch);if(Object.prototype.hasOwnProperty.call(patch,'oneShot')||Object.prototype.hasOwnProperty.call(patch,'oneShotPersonReferenceIds'))state.oneShotTokens[scene as OperatorScene]=randomUUID();}}else(next as any)[key]=value;}state.settings=settings(next);state.settingsRevision=randomUUID();}
    if(input.action==='display.layout')state.display.layout=clone(input.data.sources)as OperatorDisplay['layout'];
    if(input.action==='display.reset')state.display.layout=['A','B','C','NOW'];
    if(input.action==='display.shuffle'){const order=[...state.display.layout];for(let i=order.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[order[i],order[j]]=[order[j],order[i]];}state.display.layout=order;}
    if(input.action==='display.show'||input.action==='display.hide')state.display.visible=input.action==='display.show';
    await finish(receipt,input.action==='project.save'?'Main operator settings saved':'Settings applied');

 };
 const service={snapshot,readSubmissionHold:async()=>{await load();return state.submissionHold;},readSettings:async()=>(await settingsSnapshot()).settings,readSettingsSnapshot:settingsSnapshot,readDisplay:async()=>{await load();return clone(state.display);},
  setDisplay(patch:Partial<OperatorDisplay>){return queue(async()=>{await load();keys(patch,['layout','visible']);state.display=display({...state.display,...patch});await save();return clone(state.display);});},
  consumeOneShot(input:{snapshotRevision?:string;scenes:Partial<Record<OperatorScene,string>>;oneShotTokens?:Partial<Record<OperatorScene,string>>;personReferenceIds?:Partial<Record<OperatorScene,string[]>>}){return queue(async()=>{await load();let changed=false;for(const scene of scenes){const captured=input.scenes[scene],capturedRefs=personReferenceIds(input.personReferenceIds?.[scene]),row=state.settings.scenes[scene];if(typeof captured!=='string'||!captured&&capturedRefs.length===0||row.oneShot!==captured||JSON.stringify(row.oneShotPersonReferenceIds??[])!==JSON.stringify(capturedRefs))continue;const matches=input.oneShotTokens?input.oneShotTokens[scene]===state.oneShotTokens[scene]:input.snapshotRevision===state.settingsRevision;if(matches){state.settings.scenes[scene].oneShot='';state.settings.scenes[scene].oneShotPersonReferenceIds=[];state.oneShotTokens[scene]=randomUUID();changed=true;}}if(changed){state.settingsRevision=randomUUID();await save();}return changed;});},
  /** Scenario cues use the same receipts, validation and revisions; only the ownership guard knows the caller is the scenario. */
  scenarioAction(input:OperatorAction){if(!['settings.apply','generation.pause','generation.resume'].includes(input?.action))return Promise.reject(new OperatorStateError(400,'Unsupported scenario action'));return run(input,'scenario');},
  action(input:OperatorAction){return run(input);}
 };
 async function run(input:OperatorAction,origin?:'scenario'){const prepared=await queue(()=>reserve(input,origin));if(prepared.done)return result(prepared.message);
   if(delegated.has(input.action)){
    try{if(!options.delegate)throw new OperatorStateError(503,'Operator runtime unavailable');const response=await options.delegate(input.action,clone(input.data),prepared.context);await queue(async()=>{if(input.action==='generation.resume')state.submissionHold=false;if(input.action==='generation.pause')state.submissionHold=true;if(response&&typeof response.submissionHold==='boolean')state.submissionHold=response.submissionHold;await finish(prepared.receipt,(response?response.message:undefined)??'Command accepted');});return result(prepared.receipt.message!);}
    catch(error){const e=error as any,status=e.statusCode??e.status,known=Number.isInteger(status)&&status>=400&&status<500&&!e.indeterminate;await queue(async()=>{if(known){prepared.receipt.status='failed';prepared.receipt.errorStatus=status;prepared.receipt.message=e.message;}
      // An unexpected failure is settled as 'failed' (504) instead of staying pending forever; a retry with the same requestId gets the same 504.
      else{prepared.receipt.status='failed';prepared.receipt.errorStatus=504;prepared.receipt.message='Command outcome is unconfirmed; refresh state before continuing';}await save();});if(known)throw error;throw new OperatorStateError(504,'Command outcome is unconfirmed; refresh state before continuing',true);}
   }
   return result(prepared.receipt.message!);
 }
 return service;
}
