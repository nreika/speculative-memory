import {personReferenceIds,mergedPersonReferenceIds} from './operatorPersonReferences';
import {createHash} from 'node:crypto';
import {parseScenarioControl} from './scenarioControl';
import {validateScenarioModes,validateScenarioSceneCount} from './scenarioGeneration';

export type OperatorGenerationSource='manual'|'scenario'|'timer'|'chain';
type Scene='a'|'b'|'c';
export interface OperatorGenerateCommand {requestId:string;source:OperatorGenerationSource;runId?:string;cueId?:string}
export interface OperatorGenerationSettings {
 scenes:Record<Scene,{distanceSec:number;continuous:string;oneShot:string;continuousPersonReferenceIds?:string[];oneShotPersonReferenceIds?:string[];presence?:number;tone?:number}>;
 presence:number;tone:number;emptyRoomPersonChance?:number;vlmBackend:'local'|'gemini';imageBackend:'local'|'gemini';
 imageCount?:number;[key:string]:unknown;
}
export interface OperatorGenerationScenario {
 prompts:Partial<Record<Scene,string>>;scenarioControl?:unknown;receipt?:unknown;
}
/** Structural subset of the independently validated, pinned operatorInput frame. */
export interface OperatorGenerationFrame {
 schema:1;image:string;sha256:string;suggestedCaptureId:string;
 sourceParams:{test:true;source:'test';recordHistory:false;testSceneId:string;testFrameId:string;testRunId:string;testLoop:number;testSourceStartedAt:string}|{source:'live-camera';inputKind:'live-camera';sourceScope:'camera:main'|'camera:remote';capturedAt:string};
 sourceFrame:{id:string;sha256:string;width:number;height:number;originalStartedAt?:string};
}
export interface OperatorGenerationResponse {status:number;body:unknown}
export interface OperatorGenerationSettingsSnapshot {settings:OperatorGenerationSettings;settingsRevision?:string;oneShotTokens?:Partial<Record<Scene,string>>}
export interface OperatorGenerationOptions {
 isBusy:()=>boolean;
 /** Root enforces scenario ownership/running/preview and timer/chain hold policy. Manual hold is allowed. */
 authorize:(command:Readonly<OperatorGenerateCommand>)=>void|Promise<void>;
 readSettings:()=>OperatorGenerationSettings|Promise<OperatorGenerationSettings>;
 readSettingsSnapshot?:()=>OperatorGenerationSettingsSnapshot|Promise<OperatorGenerationSettingsSnapshot>;
 readScenario?:()=>OperatorGenerationScenario|undefined|Promise<OperatorGenerationScenario|undefined>;
 fetchFrame:()=>Promise<OperatorGenerationFrame>;
 /** Call onAccepted only once CaptureManager has accepted this exact capture, including a later failed run. */
 invokeGenerate:(body:Readonly<Record<string,unknown>>,onAccepted:()=>Promise<void>)=>Promise<OperatorGenerationResponse>;
 /** Resolve/check private upload IDs before submission. Required when person references exist; no model call. */
 preflightPersonReferences?:(body:Readonly<Record<string,unknown>>)=>void|Promise<void>;
 /** Compare-and-clear captured text and references together; never consume a later edit. */
 consumeOneShot?:(value:{requestId:string;captureId:string;snapshotRevision?:string;oneShotTokens?:Partial<Record<Scene,string>>;scenarioReceipt?:unknown;scenes:Record<Scene,string>;personReferenceIds:Record<Scene,string[]>})=>unknown|Promise<unknown>;
 now?:()=>number;maxRemembered?:number;
}
export class OperatorGenerationError extends Error {
 constructor(readonly statusCode:number,readonly code:string,message:string){super(message);this.name='OperatorGenerationError';}
}
const scenes=['a','b','c'] as const;
const optionalUnit=(v:unknown)=>v===undefined||typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1;
const plain=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const identifier=(v:unknown,max=128):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&/^[A-Za-z0-9_-]+$/.test(v);
const uuid=(v:unknown)=>typeof v==='string'&&/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(v);
const iso=(v:unknown)=>typeof v==='string'&&v.length<=64&&/(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
const fail=(status:number,code:string,message:string):never=>{throw new OperatorGenerationError(status,code,message);};
function frozenCopy<T>(v:T):T {
 const copy=structuredClone(v);
 const freeze=(x:any)=>{if(x&&typeof x==='object'){for(const value of Object.values(x))freeze(value);Object.freeze(x);}};
 freeze(copy);return copy;
}
function command(raw:unknown):OperatorGenerateCommand {
 if(!plain(raw)||Object.keys(raw).some(k=>!['requestId','source','runId','cueId'].includes(k))||!identifier(raw.requestId)||!['manual','scenario','timer','chain'].includes(raw.source)||['runId','cueId'].some(k=>raw[k]!==undefined&&!identifier(raw[k])))return fail(400,'INVALID_COMMAND','Invalid generation command');
 return {requestId:raw.requestId,source:raw.source,...(raw.runId?{runId:raw.runId}:{}),...(raw.cueId?{cueId:raw.cueId}:{})};
}
function validateSettings(value:OperatorGenerationSettings){
 if(!plain(value)||!plain(value.scenes)||!Number.isFinite(value.presence)||value.presence<0||value.presence>1||!Number.isFinite(value.tone)||value.tone<0||value.tone>1||!['local','gemini'].includes(value.vlmBackend)||!['local','gemini'].includes(value.imageBackend))return fail(400,'INVALID_SETTINGS','Invalid generation settings');
 for(const key of scenes){const s=value.scenes[key];if(!plain(s)||!Number.isFinite(s.distanceSec)||typeof s.continuous!=='string'||typeof s.oneShot!=='string'||s.continuous.length>4000||s.oneShot.length>4000||!optionalUnit(s.presence)||!optionalUnit(s.tone))return fail(400,'INVALID_SETTINGS','Invalid scene settings');try{mergedPersonReferenceIds(s.continuousPersonReferenceIds,s.oneShotPersonReferenceIds);}catch(error){return fail(400,'INVALID_PERSON_REFERENCES',(error as Error).message);}}
}
export function operatorScenePersonReferences(settings:OperatorGenerationSettings){
 const result:Partial<Record<'gen_a'|'gen_b'|'gen_c',Array<{contentId:string;role:'add-person'}>>>={};
 for(const key of scenes){const ids=mergedPersonReferenceIds(settings.scenes[key].continuousPersonReferenceIds,settings.scenes[key].oneShotPersonReferenceIds);if(ids.length)result[('gen_'+key) as 'gen_a'|'gen_b'|'gen_c']=ids.map(contentId=>({contentId,role:'add-person'}));}
 return result;
}
function sceneInstructions(settings:OperatorGenerationSettings,scenario:OperatorGenerationScenario|undefined){
 if(scenario!==undefined&&(!plain(scenario)||!plain(scenario.prompts)||scenes.some(k=>scenario.prompts[k]!==undefined&&(typeof scenario.prompts[k]!=='string'||scenario.prompts[k]!.length>4000))))return fail(400,'INVALID_SCENARIO','Invalid scenario prompts');
 const extras:Partial<Record<'gen_a'|'gen_b'|'gen_c',string>>={};
 for(const key of scenes){
  const text=[settings.scenes[key].continuous,settings.scenes[key].oneShot,scenario?.prompts[key]].filter(v=>typeof v==='string'&&v.trim()).join(' / ');
  // Match the existing sceneExtras parser's 200-character normalized budget. Never
  // submit a truncated command and then acknowledge the lost one-shot/CSV text.
  if(text.replace(/\s+/g,' ').trim().length>200)return fail(400,'SCENE_INSTRUCTIONS_TOO_LONG','Combined scene instructions exceed the existing 200-character limit');
  if(text)extras[('gen_'+key) as 'gen_a'|'gen_b'|'gen_c']=text;
 }
 return extras;
}
function validateScenario(settings:OperatorGenerationSettings,scenario:OperatorGenerationScenario|undefined){
 const extras=sceneInstructions(settings,scenario);
 try{
  const control=parseScenarioControl(scenario?.scenarioControl);
  validateScenarioSceneCount(control,3);validateScenarioModes(control,extras);
  const refs=operatorScenePersonReferences(settings);for(const key of ['gen_a','gen_b','gen_c'] as const)if(refs[key]?.length&&control?.sceneModes?.[key]==='asset_only')throw Error('Person references cannot be added in asset-only mode');
 }catch(error){return fail(400,'INVALID_SCENARIO_CONTROL',error instanceof Error?error.message:'Invalid scenario control');}
 return extras;
}
/** Acquisition identity is pinned by operatorInput; never infer live mode from absent test fields. */
export function buildOperatorGenerationBody(frame:OperatorGenerationFrame,settings:OperatorGenerationSettings,scenario:OperatorGenerationScenario|undefined,sceneTime:string){
 validateSettings(settings);
 if(!plain(frame)||frame.schema!==1||typeof frame.image!=='string'||!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(frame.image)||!identifier(frame.suggestedCaptureId)||typeof frame.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(frame.sha256)||!plain(frame.sourceParams)||!plain(frame.sourceFrame))return fail(400,'INVALID_FRAME','Invalid pinned acquisition frame');
 const p=frame.sourceParams,f=frame.sourceFrame;
 if(typeof f.sha256!=='string'||f.sha256.toLowerCase()!==frame.sha256.toLowerCase()||f.width!==1280||f.height!==720)return fail(400,'INVALID_FRAME','Frame SHA256 or dimensions mismatch');
 let acquisition:{test:boolean;source:string;recordHistory:boolean;inputKind?:string;sourceScope?:string;capturedAt?:string;testSceneId?:string;testFrameId?:string;testRunId?:string;testLoop?:number;testSourceStartedAt?:string};
 if(p.source==='test'){
  if(!/^test-/i.test(frame.suggestedCaptureId)||p.test!==true||p.recordHistory!==false||!/^TSC-00[123]$/.test(p.testSceneId)||!identifier(p.testFrameId)||!uuid(p.testRunId)||!Number.isSafeInteger(p.testLoop)||p.testLoop<1||!iso(p.testSourceStartedAt)||f.id!==p.testFrameId||f.originalStartedAt!==p.testSourceStartedAt)return fail(400,'INVALID_FRAME','Replay identity or history scope mismatch');
  acquisition={test:true,source:'test',recordHistory:false,testSceneId:p.testSceneId,testFrameId:p.testFrameId,testRunId:p.testRunId,testLoop:p.testLoop,testSourceStartedAt:p.testSourceStartedAt};
 }else if(p.source==='live-camera'){
  const remote=p.sourceScope==='camera:remote';
  if(!(remote?/^remote-\d{13}-[a-f0-9]{8}$/:/^camera-\d{13}-[a-f0-9]{8}$/).test(frame.suggestedCaptureId)||p.inputKind!=='live-camera'||!['camera:main','camera:remote'].includes(p.sourceScope)||f.id!==p.sourceScope||!iso(p.capturedAt)||Object.keys(p).some(k=>!['source','inputKind','sourceScope','capturedAt'].includes(k)))return fail(400,'INVALID_FRAME','Live-camera identity mismatch');
  acquisition={test:false,source:'live-camera',recordHistory:true,inputKind:'live-camera',sourceScope:p.sourceScope,capturedAt:p.capturedAt};
 }else return fail(400,'INVALID_FRAME','Unconfirmed input kind');
 const bytes=Buffer.from(frame.image.split(',')[1],'base64');
 if(createHash('sha256').update(bytes).digest('hex')!==frame.sha256.toLowerCase())return fail(400,'INVALID_FRAME','Original frame SHA256 mismatch');
 if(!iso(sceneTime))return fail(400,'INVALID_SCENE_TIME','Scene time requires an explicit timezone');
 const extras=sceneInstructions(settings,scenario),scenePersonReferences=operatorScenePersonReferences(settings);
 // Explicit whitelist: neither settings nor arbitrary source fields may override acquisition identity.
 // MAIN "Images" (2026-10-21): 1 = A only, 2 = A and B, 3 = A, B and C.
 return frozenCopy({image:frame.image,captureId:frame.suggestedCaptureId,imageCount:Number.isInteger(settings.imageCount)&&settings.imageCount!>=1&&settings.imageCount!<=3?settings.imageCount:3,sceneTime,
  ...acquisition,notify:false,notifyToSender:false,
  sceneDistancesSec:scenes.map(k=>settings.scenes[k].distanceSec),presence:settings.presence,tone:settings.tone,
  // Per-scene effective presence / tone (a scene without an override sends the global value); server.ts falls back to the global presence/tone for a missing key.
  scenePresence:Object.fromEntries(scenes.map(k=>['gen_'+k,settings.scenes[k].presence??settings.presence])),sceneTone:Object.fromEntries(scenes.map(k=>['gen_'+k,settings.scenes[k].tone??settings.tone])),
  ...(typeof settings.emptyRoomPersonChance==='number'?{emptyRoomPersonChance:settings.emptyRoomPersonChance}:{}),
  ...(settings.displayTiming==='each'||settings.displayTiming==='all'?{displayTiming:settings.displayTiming}:{}),
  vlmBackend:settings.vlmBackend,imageBackend:settings.imageBackend,sceneExtras:extras,
  ...(Object.keys(scenePersonReferences).length?{scenePersonReferences}:{}),
  ...(scenario?.scenarioControl!==undefined?{scenarioControl:scenario.scenarioControl}:{})});
}
type RecordState='reserved'|'fetching'|'submitting'|'accepted'|'completed'|'failed';
export function createOperatorGeneration(options:OperatorGenerationOptions){
 const now=options.now??Date.now,limit=options.maxRemembered??128;
 if(!Number.isInteger(limit)||limit<1||limit>1024)throw Error('Invalid generation command history bound');
 type Entry={identity:string;requestId:string;state:RecordState;captureId:string|null;accepted:boolean;startedAtMs:number;completedAtMs:number|null;promise:Promise<OperatorGenerationResponse>;oneShotError?:string};
 const remembered=new Map<string,Entry>(),retired=new Set<string>();let active:Entry|null=null;
 function generate(raw:OperatorGenerateCommand):Promise<OperatorGenerationResponse>{
  let cmd:OperatorGenerateCommand;try{cmd=command(raw);}catch(error){return Promise.reject(error);}
  const identity=JSON.stringify(cmd),previous=remembered.get(cmd.requestId);
  if(previous)return previous.identity===identity?previous.promise:Promise.reject(new OperatorGenerationError(409,'REQUEST_ID_CONFLICT','requestId already belongs to another command'));
  if(retired.has(cmd.requestId))return Promise.reject(new OperatorGenerationError(409,'REQUEST_RETIRED','This request was already processed; do not resubmit it'));
  if(active||options.isBusy())return Promise.reject(new OperatorGenerationError(409,'GENERATION_BUSY','Another generation is active'));
  let resolve!:(v:OperatorGenerationResponse)=>void,reject!:(e:unknown)=>void;
  const promise=new Promise<OperatorGenerationResponse>((a,b)=>{resolve=a;reject=b;});
  const entry:Entry={identity,requestId:cmd.requestId,state:'reserved',captureId:null,accepted:false,startedAtMs:now(),completedAtMs:null,promise};
  active=entry;remembered.set(cmd.requestId,entry);
  // Bounded memory keeps recent failed/unknown submissions, without evicting a running command.
  while(remembered.size>limit){const oldest=[...remembered.values()].find(e=>e!==active);if(!oldest)break;remembered.delete(oldest.requestId);retired.add(oldest.requestId);}
  void(async()=>{
   try{
    await options.authorize?.(frozenCopy(cmd));
    const settingsSnapshot=frozenCopy(options.readSettingsSnapshot?await options.readSettingsSnapshot():{settings:await options.readSettings()});
    const settings=settingsSnapshot.settings,scenario=frozenCopy(await options.readScenario?.());
    validateSettings(settings);validateScenario(settings,scenario);const refs=operatorScenePersonReferences(settings);if(Object.keys(refs).length&&!options.preflightPersonReferences)return fail(503,'REFERENCE_PREFLIGHT_UNAVAILABLE','Person reference resolver is unavailable');entry.state='fetching';
    const frame=frozenCopy(await options.fetchFrame());
    // Source selection/fetch does not reserve CaptureManager; refuse a capture that won in between.
    if(options.isBusy())return fail(409,'GENERATION_BUSY','Another generation became active while acquiring the frame');
    await options.authorize?.(frozenCopy(cmd));
    const body=frozenCopy({...buildOperatorGenerationBody(frame,settings,scenario,new Date(now()).toISOString()),executionSource:cmd.source});
    if(Object.keys(refs).length){await options.preflightPersonReferences!(body);if(options.isBusy())return fail(409,'GENERATION_BUSY','Another generation became active during reference validation');await options.authorize?.(frozenCopy(cmd));}
    entry.captureId=body.captureId;entry.state='submitting';
    const onAccepted=async()=>{
     if(entry.accepted)return;entry.accepted=true;entry.state='accepted';
     try{await options.consumeOneShot?.({requestId:cmd.requestId,captureId:body.captureId,snapshotRevision:settingsSnapshot.settingsRevision,oneShotTokens:settingsSnapshot.oneShotTokens,scenarioReceipt:scenario?.receipt,scenes:{a:settings.scenes.a.oneShot,b:settings.scenes.b.oneShot,c:settings.scenes.c.oneShot},personReferenceIds:{a:personReferenceIds(settings.scenes.a.oneShotPersonReferenceIds),b:personReferenceIds(settings.scenes.b.oneShotPersonReferenceIds),c:personReferenceIds(settings.scenes.c.oneShotPersonReferenceIds)}});}
     catch{entry.oneShotError='One-shot consumption could not be confirmed';}
    };
    const result=await options.invokeGenerate(body,onAccepted);
    if(!result||!Number.isInteger(result.status)||result.status<100||result.status>599)throw new OperatorGenerationError(502,'SUBMISSION_UNKNOWN','Generation submission outcome is unknown; do not retry this command');
    // invokeGenerate must report acceptance at the real lifecycle boundary, not merely on HTTP invocation.
    if(result.status>=200&&result.status<300&&!entry.accepted)throw new OperatorGenerationError(502,'SUBMISSION_UNKNOWN','Generation acceptance was not confirmed; do not retry this command');
    entry.state=result.status>=200&&result.status<300?'completed':'failed';resolve(frozenCopy(result));
   }catch(error){entry.state='failed';reject(error);}
   finally{entry.completedAtMs=now();if(active===entry)active=null;}
  })();
  return promise;
 }
 function status(){return {schema:1,active:active?{requestId:active.requestId,state:active.state,captureId:active.captureId,accepted:active.accepted,startedAtMs:active.startedAtMs}:null};}
 return {generate,status};
}
