import fs from 'node:fs/promises';
import {sceneNotes} from './sceneNotes';
import {operatorWarnings} from './operatorWarnings';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createOperatorInputClient,servePreviewStream,type OperatorInputClient} from './operatorInput';
import {withRemoteCamera,remoteCamera,remoteStaleMessage,type RemoteCameraStore} from './remoteCamera';
import {createOperatorState,OperatorStateError} from './operatorState';
import {createOperatorGeneration,type OperatorGenerateCommand,type OperatorGenerationOptions} from './operatorGeneration';
import {createOperatorScenario,ScenarioFormatError,type OperatorScenarioOptions} from './operatorScenario';
import {createOperatorLibrary} from './operatorLibrary';
import {createScenarioSubmissions} from './scenarioSubmit';
import {createOperatorScenarioSettings} from './operatorScenarioSettings';
import type {BrowserDisplaySnapshot} from './browserDisplay';
import {createScenarioRunArchive,csvSha256,type ScenarioRunArchive,type ScenarioRunTag} from './scenarioRunArchive';

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
 /** History text for the remote-device input (the laptop bridge's history is the other camera's scope): from the server's own observation records. */
 readHistoryText?:()=>string;
 /** Real action / exact image prompt / reference note of a displayed scene image (MAIN only; from the saved generation record). */
 readSceneDetails?:(identity:{captureId:string;sceneKey:string;imageUrl:string})=>{predictionPrompt?:string;imagePromptFull?:string;referenceNote?:string}|undefined;
 /** Recent browser-side display problems (one short line per screen+kind with a count) for the Errors panel. */
 readDisplayErrors?:()=>string[];
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
 /** G-27 run archive (exact CSV copy + sidecar + scenario-runs.jsonl); defaults to <logsDirectory>/scenario-runs. */
 scenarioRuns?:ScenarioRunArchive;
 /** Where scenario-runs live when scenarioRuns is not given (default <directory>/logs). */
 logsDirectory?:string;
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
/**
 * MAIN settings edits start the next capture 3 s later. Edits made by a scenario (while it owns the layout) and the settings
 * restore when it stops are absorbed (no trigger), so the CSV's timer interval is kept exactly.
 */
export function watchSettingsChange(w:{lastKey:string|null;changedAt:number|null},o:{key:string;nowMs:number;absorb:boolean;autoMode:boolean}):{lastKey:string;changedAt:number|null;fire:boolean}{
 let changedAt=w.changedAt;
 if(o.absorb)changedAt=null;else if(w.lastKey!==null&&o.key!==w.lastKey)changedAt=o.nowMs;
 let fire=false;
 if(changedAt!==null&&o.nowMs-changedAt>=3000&&o.autoMode){changedAt=null;fire=true;}
 return {lastKey:o.key,changedAt,fire};
}
export async function createNativeOperator(options:Options){
 const initial=JSON.parse(await fs.readFile(path.join(options.directory,'bootstrap-state.json'),'utf8'));
 const remoteStore=options.remoteCamera??remoteCamera,input=withRemoteCamera(options.input??createOperatorInputClient(),remoteStore),library=createOperatorLibrary(path.join(options.directory,'scenarios'),options.python,options.readOutputIds);
 // External CSV submissions (public /submit/): stored through the same library import, listed unapproved until the operator approves.
 const submissions=createScenarioSubmissions({root:path.join(options.directory,'scenarios'),library,onSubmitted:s=>operatorWarnings.push('external',`New external scenario: ${s.name} (${s.scenarioId}) · approve it in the scenario list`)});
 let state:ReturnType<typeof createOperatorState>,generation:ReturnType<typeof createOperatorGeneration>;
 let zeroScenesAt:number|null=null;
 let lastSettingsKey:string|null=null,settingsChangedAt:number|null=null,resyncSettingsKey=false,settingsStopping=false;
 let pausedByHold=false,lastAttempt=Date.now(),inputChecked=0,inputSnapshot:any, inputError='',lastError='';
 let schedulerBusy=false,recordingError='',logError='',mismatchError='';
 // input.select received while a capture runs (chain leaves ~1 s idle): applied at the next idle scheduler tick, before the next auto capture.
 let pendingInput:{setId:string;requestId:string;requestedAt:string;cameraIndex?:number}|null=null,pendingInputError='';
 const selectionFile=path.join(options.directory,'input-selection.json');
 // The last input.select the operator made (persisted so a restart can re-assert it on the bridge); never defaults to anything.
 let storedSelection:string|undefined,storedCameraIndex:number|undefined;
 const camIdx=(v:unknown)=>Number.isInteger(v)&&(v as number)>=0&&(v as number)<=3?v as number:undefined;
 const SELECTIONS=['TSC-001','TSC-002','TSC-003','cycle','camera','remote-device'];
 // Every input selection change is logged with ISO time, origin and before -> after (2026-10-21: a restart silently dropped a remote-device selection).
 const storeSelection=(setId:string,cameraIndex?:number,origin:'ui'|'scenario'|'queued'|'resync'='ui')=>{console.log(`[input] ${new Date().toISOString()} select origin=${origin} ${storedSelection??'none'} -> ${setId}${cameraIndex!==undefined?' camera#'+cameraIndex:''}`);storedSelection=setId;if(setId==='camera'&&cameraIndex!==undefined)storedCameraIndex=cameraIndex;mismatchError='';void fs.writeFile(selectionFile,JSON.stringify({schema:1,setId,...(storedCameraIndex!==undefined?{cameraIndex:storedCameraIndex}:{}),savedAt:new Date().toISOString()})).catch(()=>{});};
 const selectionMatches=(setId:string,bridge:any)=>{
  if(!bridge)return false;
  if(setId==='camera')return bridge.inputKind==='live-camera';
  const r=bridge.replay;return bridge.inputKind==='test-replay'&&!!r&&(setId==='cycle'?r.cycle===true:(r.setId===setId||r.pendingSet===setId)&&r.cycle!==true);
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
   storedSelection=setId;storedCameraIndex=camIdx(raw.cameraIndex);
   if(setId==='remote-device'){
    // The phone selection survives a restart: remote-device is selected again at once (it lives in Node only). Until the first frame
    // arrives MAIN shows the stale-remote error ("waiting for frames"); the bridge camera is NOT switched to meanwhile.
    try{await input.select({setId:'remote-device' as any,requestId:randomUUID()});console.log(`[input] ${new Date().toISOString()} resync: remote-device re-selected after restart (waiting for phone frames)`);}
    catch(error){console.warn('[input] resync remote-device failed: '+String((error as Error)?.message??error));}
    return;
   }
   // 2026-10-21: re-selecting restarted the bridge's cycle from TSC-001 at every server restart. When the bridge already
   // shows the stored selection (cycle: replay.cycle, or the same set) nothing is sent.
   const current=await input.readState().catch(()=>null);
   if(selectionMatches(setId,current)){inputSnapshot=current;inputChecked=Date.now();mismatchError='';console.log(`[input] resync skipped: bridge already on ${setId}`);return;}
   const result=await input.select({setId:setId as any,requestId:randomUUID(),...(setId==='camera'&&storedCameraIndex!==undefined?{cameraIndex:storedCameraIndex}:{})});
   inputSnapshot=result.state;inputChecked=Date.now();
   console.log(`[input] resync: ${setId} → ${result.state?.inputKind}`);
   if(!selectionMatches(setId,result.state)){mismatchError='Input bridge mismatch after resync';console.warn(`[input] resync mismatch: stored ${setId} but bridge reports ${result.state?.inputKind}`);}
  }catch(error){console.warn('[input] resync failed: '+String((error as Error)?.message??error));}
 };
 const cancelledRequests=new Set<string>();
 let recordingBusy=false,lastRecordAt=0,lastFrameKey='';
 const log=(row:Record<string,unknown>)=>{void fs.appendFile(path.join(options.directory,'scenario-events.jsonl'),JSON.stringify({utc:new Date().toISOString(),...row})+'\n').catch(()=>{logError='Scenario log could not be saved';});};
 const scenarioSettings=createOperatorScenarioSettings({state:{scenarioAction:input=>state.scenarioAction(input),readSettingsSnapshot:()=>state.readSettingsSnapshot(),readSubmissionHold:()=>state.readSubmissionHold()},checkPersonReferences:options.checkPersonReferences});
 const runs=options.scenarioRuns??createScenarioRunArchive({logsDirectory:options.logsDirectory??path.join(options.directory,'logs')});
 // Exact CSV text of the loaded plan (captured at load time) and the CSV of the running live run.
 let loadedCsv:{file:string;text:string;sha:string}|undefined,playingCsv:typeof loadedCsv,returnFile='';
 let restoredSettings:string[]=[],runOutputs:unknown[]=[];
 const flatSettings=(settings:any)=>{const out:Record<string,string>={};for(const [k,v]of Object.entries(settings??{})){if(k==='scenes'&&v&&typeof v==='object'){for(const [scene,row]of Object.entries(v as Record<string,any>))for(const [field,value]of Object.entries(row??{}))out[`scenes.${scene}.${field}`]=JSON.stringify(value??null);}else out[k]=JSON.stringify(v??null);}return out;};
 /** Wraps the settings port so every item the restore actually changed (and the hold) is logged one by one. */
 const loggedSettings:typeof scenarioSettings={...scenarioSettings,stop:async()=>{settingsStopping=true;try{return await stopLogged();}finally{settingsStopping=false;resyncSettingsKey=true;}}};
 const stopLogged=async()=>{
  const runId=scenario.status().runId;let before:Record<string,string>={},holdBefore:boolean|undefined;
  try{before=flatSettings((await state.readSettingsSnapshot()).settings);holdBefore=await state.readSubmissionHold();}catch{/* restore still runs */}
  const errors=await scenarioSettings.stop();restoredSettings=[];
  try{
   const after=flatSettings((await state.readSettingsSnapshot()).settings),holdAfter=await state.readSubmissionHold();
   for(const key of new Set([...Object.keys(before),...Object.keys(after)]))if(before[key]!==after[key]){restoredSettings.push(`${key}=${after[key]??'null'}`);log({event:'restore.setting',runId,item:key,from:before[key]??null,to:after[key]??null});}
   if(holdBefore!==undefined&&holdBefore!==holdAfter){restoredSettings.push('submissionHold='+holdAfter);log({event:'restore.hold',runId,from:holdBefore,to:holdAfter});}
  }catch{/* logging only */}
  return errors;
 };
 const outputMapping:OperatorScenarioOptions['outputMapping']=options.outputMapping&&{...options.outputMapping,apply:async patches=>{await options.outputMapping!.apply(patches);const s=scenario.status();if(!s.previewOnly)runOutputs.push(...patches.map(p=>({atSec:Math.round(s.elapsedSec*10)/10,...structuredClone(p)})));}};
 const scenario=createOperatorScenario({setLayout:layout=>state.setDisplay({layout}).then(()=>{}),generate:command=>submit(command),event:log,outputMapping,settings:loggedSettings,finished:info=>onScenarioFinished(info)});
 /** The live run the next/current native capture belongs to (tag for capture-events rows). */
 const scenarioRunTag=():ScenarioRunTag|undefined=>{const s=scenario.status();return s.ownsLayout&&!s.previewOnly&&s.runId&&playingCsv?{runId:s.runId,scenarioId:s.scenarioId,csvSha:playingCsv.sha}:undefined;};
 const csvPath=(file:string)=>path.join(options.directory,'scenarios',...file.split('/'));
 /** Keep the failed check visible in the Scenario panel and push one line to Errors · Skips so it is not missed. */
 const recordFormatFailure=(checkedFile:string,error:ScenarioFormatError)=>{scenario.recordFormat(checkedFile,error);operatorWarnings.push('format',`Scenario ${path.basename(checkedFile).replace(/\.csv$/i,'')}: ${error.formatErrors.length} format error${error.formatErrors.length===1?'':'s'}`);};
 async function loadFile(file:string){
  // Read the exact text before the check so the archived copy is the text this plan was parsed from.
  const text=await fs.readFile(csvPath(file),'utf8').catch(()=>undefined);
  const checked=await library.check(file).catch(error=>{if(error instanceof ScenarioFormatError)recordFormatFailure(file,error);throw error;});
  scenario.load(checked.plan,file,checked.formatWarnings);loadedCsv=text===undefined?undefined:{file,text,sha:csvSha256(text)};
  return checked;
 }
 async function onScenarioFinished(info:Parameters<NonNullable<OperatorScenarioOptions['finished']>>[0]){
  const restored=[...info.restored.filter(item=>item!=='settings'),...restoredSettings];restoredSettings=[];
  // End policy: Play requires a paused operator, so the pre-scenario hold is always "paused". After a natural end,
  // generation is ENABLED unless the CSV's last applied hold cue was pause. Stop keeps the pre-scenario value.
  if(info.reason==='end'&&!info.previewOnly){
   const holds=(info.settingsCues as {change?:string;status?:string}[]).filter(row=>row?.status==='applied'&&/^generation\.(pause|resume)$/.test(String(row.change)));
   const wantHold=holds.at(-1)?.change==='generation.pause';
   try{
    const current=await state.readSubmissionHold();
    if(current!==wantHold)await state.scenarioAction({action:wantHold?'generation.pause':'generation.resume',data:{},requestId:`scn-${info.runId.slice(0,32)}-end-hold`});
    const after=await state.readSubmissionHold();
    for(let i=restored.length-1;i>=0;i--)if(restored[i].startsWith('submissionHold='))restored.splice(i,1);
    restored.push(`submissionHold=${after} (end policy: ${after?'paused by CSV':'enabled'})`);
    log({event:'restore.hold',runId:info.runId,policy:'end',from:current,to:after,note:`restore.hold (end policy: ${after?'paused by CSV':'enabled'})`});
   }catch(error){info.restoreErrors.push('end hold policy: '+String((error as Error)?.message??error));}
  }
  if(!info.previewOnly){
   const record=runs.finish(info.runId,{endReason:info.reason,cuesApplied:info.cueIds.length,cueIds:info.cueIds,settingsCues:info.settingsCues,outputsChanged:runOutputs,restored,restoreErrors:info.restoreErrors});
   log({event:'run.archived',runId:info.runId,scenarioId:info.scenarioId,reason:info.reason,csvFile:record?.csvFile??null,restored,restoreErrors:info.restoreErrors});
  }
  playingCsv=undefined;
  // Natural end of a live run: return to the scenario loaded before (default SCN-001.csv) so the panel is ready/idle.
  if(info.reason==='end'&&!info.previewOnly){
   const target=returnFile||defaultFile;
   reloading=loadFile(target).then(()=>log({event:'scenario.reloaded',runId:info.runId,file:target,reason:'end'}),error=>log({event:'scenario.reload.failed',runId:info.runId,file:target,error:String((error as Error)?.message??error)}));
  }
 }
 let reloading:Promise<void>=Promise.resolve();
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
  runtime:async()=>{const source=await readInput(),settings=await state.readSettings(),selected=await options.readScenes(settings.displayTiming);const currentScenario=scenario.status(),outcome=options.latestOutcome?.(),generationError=lastError||(outcome?.result==='failed'?outcome.errorMessage||'Generation failed':'');return {project:'Speculative Memory',capture:{...capture(),mode:settings.mode,interval:settings.intervalSec,nextTimerTickIn:Math.max(0,settings.intervalSec-(Date.now()-lastAttempt)/1000)},scenario:{...currentScenario,...(!currentScenario.ownsLayout?{previewOnly:settings.scenarioPreview}:{})},scenarioLibrary:submissions.decorate(await library.list()),remoteCamera:input.remote(),cameraIndex:storedCameraIndex??null,replay:source?.inputKind==='live-camera'?{active:false}:source?.replay??initial.replay??{active:false},history:(remoteStore.selected?options.readHistoryText?.():'')||(source?.history??initial.history),cost:options.readCost?.()??initial.cost,sceneText:{now:selected.now?.content?.caption??'',a:selected.a?.content?.caption??'',b:selected.b?.content?.caption??'',past:selected.c?.content?.caption??''},captureScenes:Object.fromEntries(['a','b','c'].map(key=>{const content=selected[key]?.content;const details=content?.captureId&&content.sceneKey&&content.imageUrl?options.readSceneDetails?.({captureId:content.captureId,sceneKey:content.sceneKey,imageUrl:content.imageUrl}):undefined;return ['gen_'+key,{captureId:content?.captureId,sceneKey:content?.sceneKey,imageUrl:content?.imageUrl,distanceSecSigned:content?.distanceSecSigned,...(details?{action:details.predictionPrompt,fullPrompt:details.imagePromptFull,references:details.referenceNote}:{})}];})),pendingInput:pendingInput?{...pendingInput}:null,warnings:operatorWarnings.list(),sceneNotes:sceneNotes.snapshot(),errors:[{operator:'input',message:inputError},{operator:'input',message:mismatchError},{operator:'input',message:pendingInputError},{operator:'native',message:generationError},{operator:'native-recording',message:recordingError},{operator:'native-log',message:logError},...(options.readDisplayErrors?.()??[]).map(message=>({operator:'screen',message}))].filter(error=>error.message)};},
  delegate:async(action,data,context)=>{
   if(action==='generation.generate'){const accepted=await submit({requestId:context.requestId,source:'manual'});return {message:'Manual generation accepted · '+accepted.captureId};}
   if(action==='generation.cancel'){const active=generation.status().active;if(active){cancelledRequests.add(active.requestId);while(cancelledRequests.size>128)cancelledRequests.delete(cancelledRequests.values().next().value!);}options.cancel();return {message:'Cancellation requested'};}
   if(action==='generation.pause'){if(context.origin!=='scenario'&&scenario.status().state==='running'){scenario.pause();pausedByHold=true;}return {message:'New generation requests paused'};}
   if(action==='generation.resume'){if(context.origin!=='scenario'&&scenario.ownsLayout())throw new OperatorStateError(409,'Stop the scenario before starting automatic generation');lastAttempt=Date.now();return {message:'Generation enabled'};}
   if(action==='input.release'){const had=remoteStore.release();return {message:had?'Remote device released':'No remote device was active'};}
   if(action==='input.select'){
    if(!SELECTIONS.includes(String(data.setId)))throw new OperatorStateError(400,'Invalid input selection');
    const setId=String(data.setId);
    if(data.cameraIndex!==undefined&&(setId!=='camera'||camIdx(data.cameraIndex)===undefined))throw new OperatorStateError(400,'Invalid camera index');
    const cameraIndex=setId==='camera'?camIdx(data.cameraIndex)??storedCameraIndex:undefined;
    // Busy: queue (a newer request replaces an older one); applied right after the current capture, before the next one.
    if(options.isBusy()||generation.status().active){console.log(`[input] ${new Date().toISOString()} select queued origin=${context.origin??'ui'} ${setId}`);pendingInput={setId,requestId:context.requestId,requestedAt:new Date().toISOString(),...(cameraIndex!==undefined?{cameraIndex}:{})};return {message:`Input change queued: ${setId} (applied after the current generation)`};}
    pendingInput=null;
    const result=await input.select({setId:setId as any,requestId:context.requestId,...(cameraIndex!==undefined?{cameraIndex}:{})});inputSnapshot=result.state;inputChecked=Date.now();pendingInputError='';storeSelection(setId,cameraIndex);return {message:'Input selected'};
   }
   if(action==='scenario.load'){
    if(scenario.ownsLayout())throw new OperatorStateError(409,'Stop the scenario before loading');
    // Full-file format check: on any error nothing loads, the last good plan stays and the panel shows FORMAT ERROR.
    const file=String(data.file),previous=scenario.status().file;
    await submissions.assertPlayable(file);
    const checked=await loadFile(file);
    if(previous&&previous!==file)returnFile=previous;
    return {message:checked.formatWarnings.length?`Scenario loaded · WARNING: ${checked.formatWarnings.length} format note${checked.formatWarnings.length===1?'':'s'}`:'Scenario loaded'};
   }
   if(action==='scenario.play'){
    // 2026-10-21: Play while a generation is running is queued (like a queued input select) and starts at the next idle point.
    if(options.isBusy()||generation.status().active){
     pendingPlay={requestId:context.requestId,requestedAt:new Date().toISOString()};
     console.log(`[scenario] ${pendingPlay.requestedAt} play queued (a generation is running)`);
     operatorWarnings.push('scenario','Scenario starts after the current generation');
     return {message:'Scenario starts after the current generation'};
    }
    return playNow(context);
   }
   if(action==='scenario.pause'){pausedByHold=false;scenario.pause();return {message:'Scenario playback updated'};}
   if(action==='scenario.stop'){pausedByHold=false;await scenario.stop();return {message:'Scenario stopped; manual controls restored'};}
   throw new OperatorStateError(400,'Unsupported operator action');
  }});
 generation=createOperatorGeneration({isBusy:options.isBusy,
  authorize:async command=>{
   if(cancelledRequests.has(command.requestId))throw new OperatorStateError(409,'Generation request was cancelled');
   if(command.source==='scenario'){if(!scenario.canGenerate())throw new OperatorStateError(409,'Scenario is not running in live mode');}
   // A live run that set mode=timer|chain itself drives auto captures of that source; everything else stays blocked.
   else if(scenario.ownsLayout()&&scenario.autoCaptureMode()!==command.source)throw new OperatorStateError(409,'Scenario owns generation');
   if(['timer','chain'].includes(command.source)&&await state.readSubmissionHold())throw new OperatorStateError(409,'Automatic generation is paused');
  },readSettings:()=>state.readSettings() as any,readSettingsSnapshot:()=>state.readSettingsSnapshot() as any,
  readScenario:()=>scenario.ownsLayout()&&scenario.canGenerate()?scenario.captureSnapshot():undefined,
  preflightPersonReferences:options.preflightPersonReferences,
  fetchFrame:async()=>{const frame=await input.readFrame();if(frame.sourceParams.source==='live-camera')lastFrameKey=frame.sha256+':'+frame.sourceParams.capturedAt;return frame;},invokeGenerate:options.invokeGenerate,
  consumeOneShot:async(value:any)=>{await state.consumeOneShot(value);if(value.scenarioReceipt)scenario.acknowledge(value.scenarioReceipt);}
 });

 async function playNow(context:any){
    // Paused by the operator's generation.pause: Play resumes the same run and clears the hold (as generation.resume would); it is not a restart from 0.
  if(pausedByHold&&scenario.ownsLayout()&&scenario.status().state==='paused'){pausedByHold=false;scenario.pause();lastAttempt=Date.now();return {message:'Scenario resumed · generation enabled',submissionHold:false};}
  await submissions.assertPlayable(scenario.status().file);
  pausedByHold=false;
  // 2026-10-21: Play while a run owns the outputs is "Restart": stop that run first (restores outputs/settings, closes its archive).
  // Before this, a second Play collided with the still-owned output mapping and came back as an unconfirmed 504.
  if(scenario.ownsLayout()){try{await scenario.stop();}catch(error){throw new OperatorStateError(409,'Could not stop the running scenario before restarting: '+String((error as Error).message??error));}}
  const preview=!!context.settings.scenarioPreview,startedAt=new Date().toISOString();
  if(!preview){
   // CSV text captured at load; if it was unreadable then, read it now (still the library file this plan came from).
   const file=scenario.status().file;
   if(!loadedCsv||loadedCsv.file!==file){const text=await fs.readFile(csvPath(file),'utf8').catch(()=>'');loadedCsv={file,text,sha:csvSha256(text)};}
   playingCsv=loadedCsv;
  }
  runOutputs=[];
  try{await scenario.play(preview,(await state.readDisplay()).layout);}catch(error){playingCsv=undefined;throw error;}
  if(!preview&&playingCsv){const s=scenario.status();runs.begin({runId:s.runId,scenarioId:s.scenarioId,file:playingCsv.file,csvText:playingCsv.text,startedAt,outputsChanged:runOutputs});log({event:'run.archive.started',runId:s.runId,scenarioId:s.scenarioId,file:playingCsv.file,sha256:playingCsv.sha});}
  return {message:context.settings.scenarioPreview?'Scenario preview started · no generation':'Scenario live playback started'};
   
 }
 let pendingPlay:{requestId:string;requestedAt:string}|null=null;
 /** Applies the queued input.select once idle; the selection is persisted only when the bridge accepts it. */
 async function applyPendingInput(){
  const pending=pendingInput;if(!pending)return;
  try{
   const result=await input.select({setId:pending.setId as any,requestId:pending.requestId,...(pending.cameraIndex!==undefined?{cameraIndex:pending.cameraIndex}:{})});
   inputSnapshot=result.state;inputChecked=Date.now();pendingInputError='';storeSelection(pending.setId,pending.cameraIndex,'queued');
   console.log(`[input] ${new Date().toISOString()} queued select applied (requested ${pending.requestedAt}): ${pending.setId} → ${remoteStore.selected?'remote-device':result.state?.inputKind}`);
  }catch(error){pendingInputError=`Queued input change to ${pending.setId} failed: ${String((error as Error)?.message??error)}`;console.warn('[input] '+pendingInputError);}
  finally{if(pendingInput===pending)pendingInput=null;}
 }
 const noteCapture=(captureId:unknown)=>{const tag=scenarioRunTag();if(tag&&typeof captureId==='string'&&captureId)runs.note(tag.runId,{captureId});};
 async function submit(command:OperatorGenerateCommand){
  let outcome:{result?:any;error?:any}|undefined;
  void generation.generate(command).then(result=>{outcome={result};if(result.status>=400){lastError=String((result.body as any)?.error??'Generation failed');zeroScenesAt=Date.now();operatorWarnings.push('generation','Generation failed: '+lastError);}
   else if(zeroScenesGenerated(result)){zeroScenesAt=Date.now();void state.readSettings().then(s=>{if(s.mode==='chain')console.log(`[chain] all scenes skipped; waiting ${s.intervalSec}s`);}).catch(()=>{});}
   else zeroScenesAt=null;},error=>{outcome={error};lastError=String(error.message??error);zeroScenesAt=Date.now();operatorWarnings.push('generation','Generation failed: '+lastError);});
  const start=Date.now();
  while(Date.now()-start<20000){
   const active=generation.status().active;
   if(active?.requestId===command.requestId&&active.accepted){lastAttempt=Date.now();lastError='';noteCapture(active.captureId);return {captureId:active.captureId!};}
   if(outcome){if(outcome.error)throw outcome.error;if(outcome.result.status>=400)throw new OperatorStateError(outcome.result.status,String(outcome.result.body?.error??'Generation rejected'));noteCapture(outcome.result.body?.captureId);return {captureId:outcome.result.body?.captureId};}
   await new Promise(resolve=>setTimeout(resolve,15));
  }
  throw new OperatorStateError(504,'Generation acceptance is unconfirmed; do not resubmit',true);
 }
 await state.snapshot();
 const inputResync=resyncInput();
 const selectionTimer=setInterval(()=>{void checkSelection('check');},options.inputCheckMs??60000);selectionTimer.unref();
 const defaultFile=initial.scenario?.file??'SCN-001.csv';
 // A malformed default CSV no longer blocks startup: no plan loads and the panel shows FORMAT ERROR.
 try{await loadFile(defaultFile);}catch(error){if(!(error instanceof ScenarioFormatError))throw error;}
 runs.closeInterrupted();
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
   if(method==='POST'&&route.endsWith('/scenario-upload'))return {body:await library.upload(payload).catch(error=>{if(error instanceof ScenarioFormatError)recordFormatFailure(String(payload?.csv?.name??''),error);throw error;})};
   if(method==='POST'&&route.endsWith('/action'))return {body:await state.action(payload)};
   if(method==='POST'&&route.endsWith('/scenario-submission')){
    const inUse=(file:string)=>file===scenario.status().file||file===playingCsv?.file;
    if(payload?.action==='approve')return {body:await submissions.approve(payload.id)};
    if(payload?.action==='delete')return {body:await submissions.remove(payload.id,inUse)};
    return {status:400,body:{ok:false,error:'Unknown submission action'}};
   }
   return {status:404,body:{ok:false,error:'Unknown native control route'}};
  }catch(error){const e=error as any;return {status:e.statusCode??e.status??400,body:{ok:false,error:String(e.message??error),...(e.indeterminate?{indeterminate:true}:{}),...(error instanceof ScenarioFormatError?{formatErrors:e.formatErrors,formatWarnings:e.formatWarnings}:{})}};}
 }
 const timer=setInterval(()=>{if(schedulerBusy)return;schedulerBusy=true;void(async()=>{
  // Idle point after a capture: apply a queued input change before chain/timer/scenario can start the next capture.
  if(pendingInput&&!options.isBusy()&&!generation.status().active){await applyPendingInput();return;}
  // A queued scenario.play starts at the same idle point (before the next automatic capture can begin).
  if(pendingPlay&&!options.isBusy()&&!generation.status().active){
   const queued=pendingPlay;pendingPlay=null;
   try{await playNow({settings:await state.readSettings()});console.log(`[scenario] ${new Date().toISOString()} queued play started (requested ${queued.requestedAt})`);}
   catch(error){const m='Queued scenario play failed: '+String((error as Error)?.message??error);console.warn('[scenario] '+m);operatorWarnings.push('scenario',m);}
   return;
  }
  await scenario.tick();
  // "CSVで全部制御": a live run whose own mode cue set timer/chain keeps auto capture running at its interval.
  const scenarioAuto=scenario.autoCaptureMode();
  if(scenario.ownsLayout()&&!scenarioAuto||await state.readSubmissionHold()||options.isBusy()||generation.status().active)return;
  const settings=await state.readSettings();
  if(scenarioAuto&&settings.mode!==scenarioAuto)return;
  // 2026-10-20: a MAIN settings change (prompt, distance, presence, tone…) starts the next capture 3 s after the last edit
  // instead of waiting out the interval / the empty-result pause, so the change shows within one generation.
  const settingsKey=JSON.stringify(settings);
  const watched=watchSettingsChange({lastKey:lastSettingsKey,changedAt:settingsChangedAt},{key:settingsKey,nowMs:Date.now(),absorb:scenario.ownsLayout()||settingsStopping||resyncSettingsKey,autoMode:settings.mode==='timer'||settings.mode==='chain'});
  lastSettingsKey=watched.lastKey;settingsChangedAt=watched.changedAt;if(!scenario.ownsLayout()&&!settingsStopping)resyncSettingsKey=false;
  if(watched.fire){zeroScenesAt=null;lastAttempt=0;console.log('[settings] changed on MAIN; starting the next capture now');}
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
   recordingError='';
  })().catch(error=>{recordingError='Live frame recording failed: '+String((error as Error)?.message??error).slice(0,120);console.error('[recording]',error);}).finally(()=>{recordingBusy=false;});
 },250);recordTimer.unref();
 const previewStream=(req:any,res:any)=>servePreviewStream(input,async()=>!remoteStore.selected&&(await readInput())?.inputKind==='live-camera',req,res);
 return {inputResync,checkSelection,handle,submissions,previewStream,state,scenario,generation,outputs,scenarioRuns:runs,scenarioRunTag,whenReloaded:()=>reloading,assertCaptureAllowed(captureId:string){const active=generation.status().active;if(!active||active.captureId!==captureId||cancelledRequests.has(active.requestId))throw new OperatorStateError(409,'Generation request was cancelled');},close:()=>{clearInterval(selectionTimer);clearInterval(timer);clearInterval(recordTimer);}};
}
