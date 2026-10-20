import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createOperatorInputClient,type OperatorInputClient} from './operatorInput';
import {withRemoteCamera,remoteCamera,remoteStaleMessage,type RemoteCameraStore} from './remoteCamera';
import {createOperatorState,OperatorStateError} from './operatorState';
import {createOperatorGeneration,type OperatorGenerateCommand,type OperatorGenerationOptions} from './operatorGeneration';
import {createOperatorScenario,ScenarioFormatError,type OperatorScenarioOptions} from './operatorScenario';
import {createOperatorLibrary} from './operatorLibrary';
import {createOperatorScenarioSettings} from './operatorScenarioSettings';
import type {BrowserDisplaySnapshot} from './browserDisplay';

interface Options {
 directory:string;python:string;
 input?:OperatorInputClient;
 /** Remote phone frames (input "remote-device"); defaults to the process-wide store fed by the public gate. */
 remoteCamera?:RemoteCameraStore;
 /** Period of the stored-selection vs bridge-state check (default 60 s). */
 inputCheckMs?:number;
 isBusy:()=>boolean;
 capture:()=>any;
 cancel:()=>unknown;
 invokeGenerate:OperatorGenerationOptions['invokeGenerate'];
 preflightPersonReferences?:OperatorGenerationOptions['preflightPersonReferences'];
 recordFrame?:(body:Record<string,unknown>)=>Promise<unknown>;
 readCost?:()=>unknown;
 latestOutcome?:()=>{result:string;errorMessage?:string|null;captureId:string}|undefined;
 readFadeMode?:(id:string)=>Promise<NonNullable<BrowserDisplaySnapshot['view']>['fadeMode']>;
 readFadeTiming?:(id:string)=>Promise<{fadeDurationMs:number;blackHoldMs:number}|undefined>;
 readFaceBlur?:(id:string)=>Promise<{enabled:boolean;strengthPx:number}|undefined>;
 /** Mapping Label/Text switches per routing slot; ANDed with the global labels/subtitles settings. */
 readCaptions?:(id:string)=>Promise<{labels:boolean;subtitles:boolean}|undefined>;
 presentOutput?:(snapshot:BrowserDisplaySnapshot)=>Promise<BrowserDisplaySnapshot>;
 outputMapping?:OperatorScenarioOptions['outputMapping'];
 /** Existing browser-output ids (screen-N); output_* rows aimed at others get a non-fatal format warning. */
 readOutputIds?:()=>Promise<string[]>|string[];
 /** Returns the IDs without private reference metadata; scenario person_refs rows fail when any are missing. */
 checkPersonReferences?:(ids:string[])=>Promise<string[]>;
 readScenes:(mode:'each'|'all')=>Partial<Record<'now'|'a'|'b'|'c',BrowserDisplaySnapshot>>|Promise<Partial<Record<'now'|'a'|'b'|'c',BrowserDisplaySnapshot>>>;
}
/** A finished generation that produced no scene (all scenes skipped by G-24 / integrity skips). */
export function zeroScenesGenerated(result:{status:number;body?:any}|undefined):boolean{
 return !!result&&result.status<400&&typeof result.body?.count==='number'&&result.body.count===0;
}
/**
 * Timer: interval since the last attempt. Chain: 1 s after the previous capture, except after a capture that generated no
 * scene (all skipped): then the full interval from its completion, so unoccupied replays do not spin every ~14 s.
 */
export function autoCaptureDue(o:{mode:string;intervalSec:number;nowMs:number;lastAttemptMs:number;zeroScenesAtMs:number|null}):boolean{
 const elapsed=o.nowMs-o.lastAttemptMs;
 if(o.mode==='timer')return elapsed>=o.intervalSec*1000;
 if(o.mode!=='chain')return false;
 return elapsed>=1000&&(o.zeroScenesAtMs===null||o.nowMs-o.zeroScenesAtMs>=o.intervalSec*1000);
}
export async function createNativeOperator(options:Options){
 const initial=JSON.parse(await fs.readFile(path.join(options.directory,'bootstrap-state.json'),'utf8'));
 const remoteStore=options.remoteCamera??remoteCamera,input=withRemoteCamera(options.input??createOperatorInputClient(),remoteStore),library=createOperatorLibrary(path.join(options.directory,'scenarios'),options.python,options.readOutputIds);
 let state:ReturnType<typeof createOperatorState>,generation:ReturnType<typeof createOperatorGeneration>;
 let zeroScenesAt:number|null=null;
 let pausedByHold=false,lastAttempt=Date.now(),inputChecked=0,inputSnapshot:any, inputError='',lastError='';
 let schedulerBusy=false,recordingError='',logError='',mismatchError='';
 // input.select received while a capture runs (chain leaves ~1 s idle): applied at the next idle scheduler tick, before the next auto capture.
 let pendingInput:{setId:string;requestId:string;requestedAt:string}|null=null,pendingInputError='';
 const selectionFile=path.join(options.directory,'input-selection.json');
 // The last input.select the operator made (persisted so a restart can re-assert it on the bridge); never defaults to anything.
 let storedSelection:string|undefined;
 const SELECTIONS=['TSC-001','TSC-002','TSC-003','cycle','camera','remote-device'];
 const storeSelection=(setId:string)=>{storedSelection=setId;mismatchError='';void fs.writeFile(selectionFile,JSON.stringify({schema:1,setId,savedAt:new Date().toISOString()})).catch(()=>{});};
 const selectionMatches=(setId:string,bridge:any)=>{
  if(!bridge)return false;
  if(setId==='camera')return bridge.inputKind==='live-camera';
  const r=bridge.replay;return bridge.inputKind==='test-replay'&&!!r&&(r.setId===setId||r.pendingSet===setId);
 };
 const checkSelection=async(label:string)=>{
  if(!storedSelection||storedSelection==='remote-device'||remoteStore.selected)return;
  try{
   const bridge=await input.readState();
   if(selectionMatches(storedSelection,bridge)){mismatchError='';return;}
   mismatchError='Input bridge mismatch after resync';
   console.warn(`[input] ${label}: stored ${storedSelection} but bridge reports ${bridge?.inputKind}${bridge?.replay?.setId?' '+bridge.replay.setId:''}`);
  }catch{/* unreachable bridge is already reported as 'Input service is unavailable' */}
 };
 /** Startup resync: re-send exactly the stored selection once; nothing stored -> nothing sent. */
 const resyncInput=async()=>{
  try{
   const raw=JSON.parse(await fs.readFile(selectionFile,'utf8').catch(()=>'null'));
   const setId=raw&&typeof raw.setId==='string'&&SELECTIONS.includes(raw.setId)?raw.setId:undefined;
   if(!setId)return;
   storedSelection=setId;
   if(setId==='remote-device')return;
   const result=await input.select({setId:setId as any,requestId:randomUUID()});
   inputSnapshot=result.state;inputChecked=Date.now();
   console.log(`[input] resync: ${setId} → ${result.state?.inputKind}`);
   if(!selectionMatches(setId,result.state)){mismatchError='Input bridge mismatch after resync';console.warn(`[input] resync mismatch: stored ${setId} but bridge reports ${result.state?.inputKind}`);}
  }catch(error){console.warn('[input] resync failed: '+String((error as Error)?.message??error));}
 };
 const cancelledRequests=new Set<string>();
 let recordingBusy=false,lastRecordAt=0,lastFrameKey='';
 const log=(row:Record<string,unknown>)=>{void fs.appendFile(path.join(options.directory,'scenario-events.jsonl'),JSON.stringify({utc:new Date().toISOString(),...row})+'\n').catch(()=>{logError='Scenario log could not be saved';});};
 const scenarioSettings=createOperatorScenarioSettings({state:{scenarioAction:input=>state.scenarioAction(input),readSettingsSnapshot:()=>state.readSettingsSnapshot(),readSubmissionHold:()=>state.readSubmissionHold()},checkPersonReferences:options.checkPersonReferences});
 const scenario=createOperatorScenario({setLayout:layout=>state.setDisplay({layout}).then(()=>{}),generate:command=>submit(command),event:log,outputMapping:options.outputMapping,settings:scenarioSettings});
 const readInput=async()=>{
  if(Date.now()-inputChecked>1000){inputChecked=Date.now();try{inputSnapshot=await input.readState();inputError='';}catch{inputError='Input service is unavailable';}}
  if(remoteStore.selected)inputError=remoteStore.state()==='fresh'?'':remoteStaleMessage(remoteStore);
  return inputSnapshot;
 };
 const capture=()=>{
  const active=options.capture()?.active,request=generation?.status().active;
  return {mode:'manual',interval:70,phase:active?'generating':request?'requested':'idle',captureId:active?.captureId??request?.captureId??'',source:'native',busyFor:active?(Date.now()-Date.parse(active.startedAt))/1000:0,nextTimerTickIn:null,chainDueIn:null};
 };
 state=createOperatorState({file:path.join(options.directory,'state.json'),initial,
  runtime:async()=>{const source=await readInput(),settings=await state.readSettings(),selected=await options.readScenes(settings.displayTiming);const currentScenario=scenario.status(),outcome=options.latestOutcome?.(),generationError=lastError||(outcome?.result==='failed'?outcome.errorMessage||'Generation failed':'');return {project:'Speculative Memory',capture:{...capture(),mode:settings.mode,interval:settings.intervalSec,nextTimerTickIn:Math.max(0,settings.intervalSec-(Date.now()-lastAttempt)/1000)},scenario:{...currentScenario,...(!currentScenario.ownsLayout?{previewOnly:settings.scenarioPreview}:{})},scenarioLibrary:await library.list(),remoteCamera:input.remote(),replay:source?.inputKind==='live-camera'?{active:false}:source?.replay??initial.replay??{active:false},history:source?.history??initial.history,cost:options.readCost?.()??initial.cost,sceneText:{now:selected.now?.content?.caption??'',a:selected.a?.content?.caption??'',b:selected.b?.content?.caption??'',past:selected.c?.content?.caption??''},captureScenes:Object.fromEntries(['a','b','c'].map(key=>{const content=selected[key]?.content;return ['gen_'+key,{captureId:content?.captureId,sceneKey:content?.sceneKey,imageUrl:content?.imageUrl,distanceSecSigned:content?.distanceSecSigned}];})),pendingInput:pendingInput?{...pendingInput}:null,errors:[{operator:'input',message:inputError},{operator:'input',message:mismatchError},{operator:'input',message:pendingInputError},{operator:'native',message:generationError},{operator:'native-recording',message:recordingError},{operator:'native-log',message:logError}].filter(error=>error.message)};},
  delegate:async(action,data,context)=>{
   if(action==='generation.generate'){const accepted=await submit({requestId:context.requestId,source:'manual'});return {message:'Manual generation accepted · '+accepted.captureId};}
   if(action==='generation.cancel'){const active=generation.status().active;if(active){cancelledRequests.add(active.requestId);while(cancelledRequests.size>128)cancelledRequests.delete(cancelledRequests.values().next().value!);}options.cancel();return {message:'Cancellation requested'};}
   if(action==='generation.pause'){if(context.origin!=='scenario'&&scenario.status().state==='running'){scenario.pause();pausedByHold=true;}return {message:'New generation requests paused'};}
   if(action==='generation.resume'){if(context.origin!=='scenario'&&scenario.ownsLayout())throw new OperatorStateError(409,'Stop the scenario before starting automatic generation');lastAttempt=Date.now();return {message:'Generation enabled'};}
   if(action==='input.select'){
    if(!SELECTIONS.includes(String(data.setId)))throw new OperatorStateError(400,'Invalid input selection');
    const setId=String(data.setId);
    // Busy: queue (a newer request replaces an older one); applied right after the current capture, before the next one.
    if(options.isBusy()||generation.status().active){pendingInput={setId,requestId:context.requestId,requestedAt:new Date().toISOString()};return {message:`Input change queued: ${setId} (applied after the current generation)`};}
    pendingInput=null;
    const result=await input.select({setId:setId as any,requestId:context.requestId});inputSnapshot=result.state;inputChecked=Date.now();pendingInputError='';storeSelection(setId);return {message:'Input selected'};
   }
   if(action==='scenario.load'){
    if(scenario.ownsLayout())throw new OperatorStateError(409,'Stop the scenario before loading');
    // Full-file format check: on any error nothing loads, the last good plan stays and the panel shows FORMAT ERROR.
    const file=String(data.file),checked=await library.check(file).catch(error=>{if(error instanceof ScenarioFormatError)scenario.recordFormat(file,error);throw error;});
    scenario.load(checked.plan,file,checked.formatWarnings);
    return {message:checked.formatWarnings.length?`Scenario loaded · WARNING: ${checked.formatWarnings.length} format note${checked.formatWarnings.length===1?'':'s'}`:'Scenario loaded'};
   }
   if(action==='scenario.play'){
    if(options.isBusy()||generation.status().active)throw new OperatorStateError(409,'A generation is running; pause generation first, then start the scenario');
    // Paused by the operator's generation.pause: Play resumes the same run and clears the hold (as generation.resume would); it is not a restart from 0.
    if(pausedByHold&&scenario.ownsLayout()&&scenario.status().state==='paused'){pausedByHold=false;scenario.pause();lastAttempt=Date.now();return {message:'Scenario resumed · generation enabled',submissionHold:false};}
    pausedByHold=false;
    await scenario.play(context.settings.scenarioPreview,(await state.readDisplay()).layout);return {message:context.settings.scenarioPreview?'Scenario preview started · no generation':'Scenario live playback started'};
   }
   if(action==='scenario.pause'){pausedByHold=false;scenario.pause();return {message:'Scenario playback updated'};}
   if(action==='scenario.stop'){pausedByHold=false;await scenario.stop();return {message:'Scenario stopped; manual controls restored'};}
   throw new OperatorStateError(400,'Unsupported operator action');
  }});
 generation=createOperatorGeneration({isBusy:options.isBusy,
  authorize:async command=>{
   if(cancelledRequests.has(command.requestId))throw new OperatorStateError(409,'Generation request was cancelled');
   if(command.source==='scenario'){if(!scenario.canGenerate())throw new OperatorStateError(409,'Scenario is not running in live mode');}
   else if(scenario.ownsLayout())throw new OperatorStateError(409,'Scenario owns generation');
   if(['timer','chain'].includes(command.source)&&await state.readSubmissionHold())throw new OperatorStateError(409,'Automatic generation is paused');
  },readSettings:()=>state.readSettings() as any,readSettingsSnapshot:()=>state.readSettingsSnapshot() as any,
  readScenario:()=>scenario.ownsLayout()&&scenario.canGenerate()?scenario.captureSnapshot():undefined,
  preflightPersonReferences:options.preflightPersonReferences,
  fetchFrame:async()=>{const frame=await input.readFrame();if(frame.sourceParams.source==='live-camera')lastFrameKey=frame.sha256+':'+frame.sourceParams.capturedAt;return frame;},invokeGenerate:options.invokeGenerate,
  consumeOneShot:async(value:any)=>{await state.consumeOneShot(value);if(value.scenarioReceipt)scenario.acknowledge(value.scenarioReceipt);}
 });
 /** Applies the queued input.select once idle; the selection is persisted only when the bridge accepts it. */
 async function applyPendingInput(){
  const pending=pendingInput;if(!pending)return;
  try{
   const result=await input.select({setId:pending.setId as any,requestId:pending.requestId});
   inputSnapshot=result.state;inputChecked=Date.now();pendingInputError='';storeSelection(pending.setId);
   console.log(`[input] queued select applied: ${pending.setId} → ${remoteStore.selected?'remote-device':result.state?.inputKind}`);
  }catch(error){pendingInputError=`Queued input change to ${pending.setId} failed: ${String((error as Error)?.message??error)}`;console.warn('[input] '+pendingInputError);}
  finally{if(pendingInput===pending)pendingInput=null;}
 }
 async function submit(command:OperatorGenerateCommand){
  let outcome:{result?:any;error?:any}|undefined;
  void generation.generate(command).then(result=>{outcome={result};if(result.status>=400)lastError=String((result.body as any)?.error??'Generation failed');
   else if(zeroScenesGenerated(result)){zeroScenesAt=Date.now();void state.readSettings().then(s=>{if(s.mode==='chain')console.log(`[chain] all scenes skipped; waiting ${s.intervalSec}s`);}).catch(()=>{});}
   else zeroScenesAt=null;},error=>{outcome={error};lastError=String(error.message??error);});
  const start=Date.now();
  while(Date.now()-start<20000){
   const active=generation.status().active;
   if(active?.requestId===command.requestId&&active.accepted){lastAttempt=Date.now();lastError='';return {captureId:active.captureId!};}
   if(outcome){if(outcome.error)throw outcome.error;if(outcome.result.status>=400)throw new OperatorStateError(outcome.result.status,String(outcome.result.body?.error??'Generation rejected'));return {captureId:outcome.result.body?.captureId};}
   await new Promise(resolve=>setTimeout(resolve,15));
  }
  throw new OperatorStateError(504,'Generation acceptance is unconfirmed; do not resubmit',true);
 }
 await state.snapshot();
 const inputResync=resyncInput();
 const selectionTimer=setInterval(()=>{void checkSelection('check');},options.inputCheckMs??60000);selectionTimer.unref();
 const defaultFile=initial.scenario?.file??'SCN-001.csv';
 // A malformed default CSV no longer blocks startup: no plan loads and the panel shows FORMAT ERROR.
 try{const checked=await library.check(defaultFile);scenario.load(checked.plan,defaultFile,checked.formatWarnings);}catch(error){if(!(error instanceof ScenarioFormatError))throw error;scenario.recordFormat(defaultFile,error);}
 async function outputs(){
  const settings=await state.readSettings(),display=await state.readDisplay(),scenes=await options.readScenes(settings.displayTiming);
  const fadeModes=await Promise.all([1,2,3,4].map(n=>options.readFadeMode?.('control-output-'+n)??'original'));
  const fadeTimings=await Promise.all([1,2,3,4].map(n=>options.readFadeTiming?.('control-output-'+n)));
  const faceBlurs=await Promise.all([1,2,3,4].map(n=>options.readFaceBlur?.('control-output-'+n)));
  const captions=await Promise.all([1,2,3,4].map(n=>options.readCaptions?.('control-output-'+n)));
  const byLabel={A:'a',B:'b',C:'c',NOW:'now'}as const;
  const routed=display.layout.map((label,index)=>{
   const saved=scenes[byLabel[label]],now=Date.now();
   const base:BrowserDisplaySnapshot=saved??{schema:1,screen:{id:'waiting',label:'Waiting',accent:'#286078'},revision:'empty',clock:{serverNowMs:now,worldNowMs:now,rate:1,scope:'native:unavailable',known:false},content:null,selection:{mode:'pinned',contentId:'not-ready'},temporalRelation:'unknown',selectionStatus:'content-missing'};
   const fadeMode=settings.fade===false?'none':fadeModes[index]??'original';
   const view={visible:display.visible,labels:settings.labels&&captions[index]?.labels!==false,subtitles:settings.subtitles&&captions[index]?.subtitles!==false,fade:settings.fade&&fadeMode!=='none',fadeMode,...(fadeTimings[index]??{fadeDurationMs:800,blackHoldMs:120}),fadeOnImageChange:false,faceBlur:faceBlurs[index]??{enabled:false,strengthPx:12}};
   return {...base,screen:{id:'control-output-'+(index+1),label:'Output '+(index+1)+' · '+label,accent:'#286078'},view,revision:createHash('sha256').update(JSON.stringify([base.revision,label,view])).digest('hex').slice(0,24)};
  });
  const presented=options.presentOutput?await Promise.all(routed.map(async item=>({...item,...await options.presentOutput!(item),view:item.view}))):routed;
  return {schema:1,scenes,outputs:presented};
 }
 async function handle({method,route,payload}:{method:string;route:string;payload?:any}){
  try{
   if(method==='GET'&&route.endsWith('/state'))return {body:await state.snapshot()};
   if(method==='GET'&&route.endsWith('/input-preview'))return {body:await input.readPreview()};
   if(method==='GET'&&route.includes('/outputs')){const all=await outputs(),slot=/\/outputs\/([1-4])$/.exec(route);return {body:slot?all.outputs[Number(slot[1])-1]:all};}
   if(method==='POST'&&route.endsWith('/scenario-upload'))return {body:await library.upload(payload).catch(error=>{if(error instanceof ScenarioFormatError)scenario.recordFormat(String(payload?.csv?.name??''),error);throw error;})};
   if(method==='POST'&&route.endsWith('/action'))return {body:await state.action(payload)};
   return {status:404,body:{ok:false,error:'Unknown native control route'}};
  }catch(error){const e=error as any;return {status:e.statusCode??e.status??400,body:{ok:false,error:String(e.message??error),...(e.indeterminate?{indeterminate:true}:{}),...(error instanceof ScenarioFormatError?{formatErrors:e.formatErrors,formatWarnings:e.formatWarnings}:{})}};}
 }
 const timer=setInterval(()=>{if(schedulerBusy)return;schedulerBusy=true;void(async()=>{
  // Idle point after a capture: apply a queued input change before chain/timer/scenario can start the next capture.
  if(pendingInput&&!options.isBusy()&&!generation.status().active){await applyPendingInput();return;}
  await scenario.tick();
  if(scenario.ownsLayout()||await state.readSubmissionHold()||options.isBusy()||generation.status().active)return;
  const settings=await state.readSettings();
  // Remote phone frame older than REMOTE_STALE_SEC: skip timer/chain; Control shows "remote camera stale".
  if(remoteStore.selected&&remoteStore.state()!=='fresh')return;
  if(autoCaptureDue({mode:settings.mode,intervalSec:settings.intervalSec,nowMs:Date.now(),lastAttemptMs:lastAttempt,zeroScenesAtMs:zeroScenesAt})){lastAttempt=Date.now();await submit({requestId:randomUUID(),source:settings.mode as 'timer'|'chain'});}
 })().catch(error=>{lastError=String(error.message??error);}).finally(()=>{schedulerBusy=false;});},100);timer.unref();
 const recordTimer=setInterval(()=>{
  if(!options.recordFrame||recordingBusy||Date.now()-lastRecordAt<1000)return;
  recordingBusy=true;void(async()=>{
   if(remoteStore.selected&&remoteStore.state()!=='fresh')return;
   const source=await readInput();if(source?.inputKind!=='live-camera'||source?.replay?.pendingSet||await state.readSubmissionHold()&&!scenario.canGenerate())return;
   lastRecordAt=Date.now();const frame=await input.readFrame();if(frame.sourceParams.source!=='live-camera')return;
   const key=frame.sha256+':'+frame.sourceParams.capturedAt;if(key===lastFrameKey)return;lastFrameKey=key;
   await options.recordFrame!({image:frame.image,...frame.sourceParams,recordOnly:true,recordId:randomUUID()});
  })().catch(()=>{recordingError='Live frame recording failed';}).finally(()=>{recordingBusy=false;});
 },250);recordTimer.unref();
 return {inputResync,checkSelection,handle,state,scenario,generation,outputs,assertCaptureAllowed(captureId:string){const active=generation.status().active;if(!active||active.captureId!==captureId||cancelledRequests.has(active.requestId))throw new OperatorStateError(409,'Generation request was cancelled');},close:()=>{clearInterval(selectionTimer);clearInterval(timer);clearInterval(recordTimer);}};
}
