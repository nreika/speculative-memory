import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createNativeOperator} from './nativeOperator';
import type {OperatorInputClient} from './operatorInput';
import {BrowserOutputsStore} from './browserOutputs';

const python=process.env.OPERATOR_TEST_PYTHON??path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const initial=()=>({schema:1,settings:{mode:'timer',intervalSec:70,imageCount:3,presence:.7,tone:.6,vlmBackend:'local',imageBackend:'local',displayTiming:'each',scenarioPreview:true,labels:false,subtitles:true,fade:false,scenes:{a:{distanceSec:15,continuous:'Sit',oneShot:'Look left'},b:{distanceSec:30,continuous:'Stand',oneShot:''},c:{distanceSec:-30,continuous:'Cheer',oneShot:''}}},display:{layout:['NOW','C','A','B'],visible:true},scenario:{file:'SCN-001.csv'},replay:{active:false},history:'private synthetic history'});
const inputState=()=>({schema:1 as const,inputKind:'test-replay' as const,replay:{active:true,setId:'TSC-001' as const,testRunId:'0123456789abcdef0123456789abcdef',currentFrameId:'TSC-001-F005',offsetSec:0,loop:1,cycle:false,pendingSet:null},history:'synthetic history',sourceScope:'test:TSC-001',observedAtMs:Date.now()});
const bytes=Buffer.from('synthetic no-person test frame bytes'),sha=createHash('sha256').update(bytes).digest('hex');
const frame=():any=>({schema:1,image:'data:image/jpeg;base64,'+bytes.toString('base64'),sha256:sha,suggestedCaptureId:'test-TSC-001-F005-L001-1792322515117',sourceParams:{test:true,source:'test',recordHistory:false,testSceneId:'TSC-001',testFrameId:'TSC-001-F005',testRunId:'0123456789abcdef0123456789abcdef',testLoop:1,testSourceStartedAt:'2026-10-16T00:00:00Z'},sourceFrame:{id:'TSC-001-F005',file:'frames/TSC-001-F005.jpg',offsetSec:0,durationSec:1,originalCaptureId:'synthetic',originalStartedAt:'2026-10-16T00:00:00Z',sha256:sha,width:1280,height:720},state:inputState()});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};};
async function fixture(extra:any={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'native-operator-regression-'));
 await fs.mkdir(path.join(directory,'scenarios'));
 await fs.writeFile(path.join(directory,'bootstrap-state.json'),JSON.stringify(initial()));
 await fs.writeFile(path.join(directory,'scenarios','SCN-001.csv'),'seconds,action,target,value,source_rect,target_rect,fit,opacity,feather_px\n0,scenario,,SCN-001,,,,,\n0,layout,,B|NOW|A|C,,,,,\n180,end,,,,,,,\n');
 let reads=0,selections=0,invocations=0;const bodies:any[]=[];
 const input:OperatorInputClient={readState:async()=>inputState(),readPreview:async()=>({kind:'replay',observedAtMs:Date.now(),setId:'TSC-001',frameId:'TSC-001-F005',loop:1,dataUrl:'synthetic-preview'}),readFrame:async()=>{reads++;return frame();},select:async r=>{selections++;return{...r,state:inputState()};}};
 const scene=(key:string):any=>({schema:1,revision:'saved-'+key,content:{id:key,imageUrl:'/synthetic/'+key+'.png',caption:key,captureId:'saved-capture',sceneKey:key},clock:{serverNowMs:1,worldNowMs:1,rate:1,scope:'test',known:true},selection:{mode:'pinned',contentId:key},temporalRelation:'unknown',selectionStatus:'ready'});
 const scenes={now:scene('now'),a:scene('a'),b:scene('b'),c:scene('c')};
 // The unrelated ten-output registry is external: observe that native routing never mutates it.
 const externalTen=Array.from({length:10},(_,i)=>({id:'screen-'+(i+1),label:'External '+i,source:'a' as const,delaySec:0,scene:'any' as const,visible:i%2===0,labels:true,subtitles:false,fade:false}));
 const tenFile=path.join(directory,'external-ten-outputs.json');await fs.writeFile(tenFile,JSON.stringify({schema:1,outputs:externalTen}));
 const tenStore=new BrowserOutputsStore({configFile:tenFile,loadCatalog:async()=>({contents:[],current:{},sourceScopes:{},clocks:{}})});
 const beforeTen=await tenStore.configuration();
 const operator=await createNativeOperator({directory,python,input,isBusy:()=>false,capture:()=>({active:null}),cancel:()=>{},readScenes:async()=>scenes,invokeGenerate:async(body,accepted)=>{invocations++;bodies.push(body);await accepted();return{status:200,body:{captureId:body.captureId}};},...extra});
 return{operator,directory,bodies,scenes,externalTen,beforeTen,tenStore,tenFile,get reads(){return reads;},get invocations(){return invocations;},get selections(){return selections;},close:async()=>{operator.close();await new Promise(r=>setTimeout(r,25));assert.ok(path.basename(directory).startsWith('native-operator-regression-'));await fs.rm(directory,{recursive:true,force:true});}};
}
const action=(op:Awaited<ReturnType<typeof createNativeOperator>>,name:string,id:string,data:Record<string,unknown>={}):Promise<any>=>op.handle({method:'POST',route:'/native/action',payload:{action:name,requestId:id,data}});

test('manual Generate works under hold=true, returns one ACK, clears only accepted shots and remembers duplicate',async()=>{
 const gate=deferred();let calls=0,body:any;
 const f=await fixture({invokeGenerate:async(b:any,accepted:()=>Promise<void>)=>{calls++;body=b;await accepted();await gate.promise;return{status:200,body:{captureId:b.captureId}};}});
 try{
  assert.equal((await f.operator.state.snapshot()).submissionHold,true);
  const first=await action(f.operator,'generation.generate','manual-once');assert.equal(first.body.ok,true);assert.match(first.body.message,/Manual generation accepted/);assert.equal(calls,1);assert.equal(f.reads,1);assert.equal(body.imageCount,3);assert.equal(body.notify,false);assert.equal(body.test,true);assert.equal(body.recordHistory,false);assert.equal(body.sceneExtras.gen_a,'Sit / Look left');
  assert.equal((await f.operator.state.readSettings()).scenes.a.oneShot,'');assert.equal((await f.operator.state.snapshot()).submissionHold,true);
  const duplicate=await action(f.operator,'generation.generate','manual-once');assert.equal(duplicate.body.ok,true);assert.equal(calls,1);
  const busy=await action(f.operator,'generation.generate','manual-second');assert.equal(busy.status,409);assert.equal(f.reads,1);assert.equal(calls,1);
 }finally{gate.resolve();await new Promise(r=>setTimeout(r,20));await f.close();}
});

test('externally busy capture rejects before acquisition and leaves pending text intact',async()=>{
 const f=await fixture({isBusy:()=>true});try{const result=await action(f.operator,'generation.generate','busy-capture');assert.equal(result.status,409);assert.equal(f.invocations,0);assert.equal(f.reads,0);assert.equal((await f.operator.state.readSettings()).scenes.a.oneShot,'Look left');}finally{await f.close();}
});
test('Cancel during acquisition prevents a later generation from starting',async()=>{
 const gate=deferred();let acquiring=false;
 const input:OperatorInputClient={readState:async()=>inputState(),readPreview:async()=>{throw Error('unused');},select:async()=>{throw Error('unused');},readFrame:async()=>{acquiring=true;await gate.promise;return frame();}};
 const f=await fixture({input});try{
  const pending=action(f.operator,'generation.generate','cancel-before-frame');
  while(!acquiring)await new Promise(resolve=>setTimeout(resolve,5));
  const cancelled=await action(f.operator,'generation.cancel','cancel-pending');assert.equal(cancelled.body.ok,true);gate.resolve();
  const result=await pending;assert.equal(result.status,409);assert.equal(f.invocations,0);assert.equal((await f.operator.state.readSettings()).scenes.a.oneShot,'Look left');
 }finally{gate.resolve();await f.close();}
});

test('native four outputs preserve flags, route and state, without mutating unrelated ten-output records',async()=>{
 const f=await fixture();try{
  const result=await f.operator.outputs();assert.equal(result.outputs.length,4);assert.deepEqual(result.outputs.map(x=>x.content?.sceneKey),['now','c','a','b']);for(const out of result.outputs)assert.deepEqual(out.view,{visible:true,labels:false,subtitles:true,fade:false,fadeMode:'none',fadeDurationMs:800,blackHoldMs:120,fadeOnImageChange:false,faceBlur:{enabled:false,strengthPx:12}});
  const one=await f.operator.handle({method:'GET',route:'/native/outputs/2'});assert.equal((one.body as any).content.sceneKey,'c');
  await action(f.operator,'display.hide','hide-native');assert.equal((await f.operator.outputs()).outputs.every(x=>x.view.visible===false),true);assert.deepEqual(await f.tenStore.configuration(),f.beforeTen);assert.deepEqual((JSON.parse(await fs.readFile(f.tenFile,'utf8'))).outputs,f.externalTen);assert.equal(f.invocations,0);assert.equal(f.reads,0);
  const s:any=await f.operator.state.snapshot();assert.equal(s.runtime,'native');assert.equal(s.replay.currentFrameId,'TSC-001-F005');assert.equal(s.settings.scenes.a.continuous,'Sit');assert.equal(s.history,'synthetic history');assert.equal(s.capture.source,'native');
 }finally{await f.close();}
});
test('each native slot retains its own fade choice when sources are rearranged',async()=>{
 const modes={'control-output-1':'original','control-output-2':'crossfade','control-output-3':'none','control-output-4':'original'} as const;
 const f=await fixture({readFadeMode:async(id:keyof typeof modes)=>modes[id],readFadeTiming:async(id:string)=>({fadeDurationMs:id==='control-output-2'?1500:800,blackHoldMs:id==='control-output-2'?0:120})});
 try{
  const state:any=await f.operator.state.snapshot();
  await f.operator.state.action({requestId:'enable-master-fade',action:'settings.apply',baseRevision:state.settingsRevision,data:{fade:true}});
  const first=await f.operator.outputs();assert.deepEqual(first.outputs.map(o=>o.view.fadeMode),['original','crossfade','none','original']);assert.deepEqual(first.outputs.map(o=>o.view.fade),[true,true,false,true]);
  assert.deepEqual(first.outputs.map(o=>[o.view.fadeDurationMs,o.view.blackHoldMs]),[[800,120],[1500,0],[800,120],[800,120]]);
  await action(f.operator,'display.layout','rearrange-fade-sources',{sources:['A','B','C','NOW']});
  const next=await f.operator.outputs();assert.deepEqual(next.outputs.map(o=>o.view.fadeMode),first.outputs.map(o=>o.view.fadeMode));assert.deepEqual(next.outputs.map(o=>o.content?.sceneKey),['a','b','c','now']);assert.equal(f.invocations,0);
  assert.deepEqual(next.outputs.map(o=>[o.view.fadeDurationMs,o.view.blackHoldMs]),first.outputs.map(o=>[o.view.fadeDurationMs,o.view.blackHoldMs]));
 }finally{await f.close();}
});

test('routing-slot Label/Text switches AND with the global labels/subtitles settings',async()=>{
 const caps:Record<string,{labels:boolean;subtitles:boolean}>={'control-output-1':{labels:true,subtitles:true},'control-output-2':{labels:false,subtitles:true},'control-output-3':{labels:true,subtitles:false},'control-output-4':{labels:false,subtitles:false}};
 const f=await fixture({readCaptions:async(id:string)=>caps[id]});
 try{
  const off=await f.operator.outputs();assert.deepEqual(off.outputs.map(o=>[o.view.labels,o.view.subtitles]),[[false,true],[false,true],[false,false],[false,false]]);
  const state:any=await f.operator.state.snapshot();
  await f.operator.state.action({requestId:'enable-labels',action:'settings.apply',baseRevision:state.settingsRevision,data:{labels:true}});
  const on=await f.operator.outputs();assert.deepEqual(on.outputs.map(o=>[o.view.labels,o.view.subtitles]),[[true,true],[false,true],[true,false],[false,false]]);
  caps['control-output-2']={labels:true,subtitles:true};const changed=await f.operator.outputs();assert.equal(changed.outputs[1].view.labels,true);assert.notEqual(changed.outputs[1].revision,on.outputs[1].revision);assert.equal(f.invocations,0);
 }finally{await f.close();}
});

test('face blur stays with its output slot and presentation annotates rather than replaces source content',async()=>{
 const f=await fixture({readFaceBlur:async(id:string)=>({enabled:id==='control-output-2',strengthPx:18}),presentOutput:async(snapshot:any)=>snapshot.view.faceBlur.enabled?{...snapshot,content:{...snapshot.content,faceRegions:[{x:.2,y:.2,width:.1,height:.1}],faceRegionStatus:'detected'}}:snapshot});
 try{
  const first=await f.operator.outputs();assert.equal(first.outputs[1].content?.id,'c');assert.equal(first.outputs[1].content?.faceRegions?.length,1);assert.equal(first.outputs[0].content?.faceRegions,undefined);
  await action(f.operator,'display.layout','blur-route-change',{sources:['A','B','C','NOW']});
  const next=await f.operator.outputs();assert.equal(next.outputs[1].content?.id,'b');assert.equal(next.outputs[1].view.faceBlur.enabled,true);assert.equal(next.outputs[1].content?.faceRegionStatus,'detected');assert.equal(f.scenes.b.content?.faceRegions,undefined);assert.equal(f.invocations,0);
 }finally{await f.close();}
});

test('Stop releases scenario ownership and restores layout/manual controls; no generation on cue-only Play',async()=>{
 const f=await fixture();try{
  const played=await action(f.operator,'scenario.play','play-native');assert.equal(played.body.ok,true);assert.equal(f.operator.scenario.ownsLayout(),true);assert.deepEqual((await f.operator.state.readDisplay()).layout,['B','NOW','A','C']);
  const blocked=await action(f.operator,'generation.generate','manual-during-scenario');assert.equal(blocked.status,409);assert.equal(f.reads,0);
  const stopped=await action(f.operator,'scenario.stop','stop-native');assert.equal(stopped.body.ok,true);assert.equal(f.operator.scenario.ownsLayout(),false);assert.deepEqual((await f.operator.state.readDisplay()).layout,['NOW','C','A','B']);
  const changed=await action(f.operator,'display.layout','manual-layout',{sources:['A','B','C','NOW']});assert.equal(changed.body.ok,true);assert.equal((await f.operator.state.snapshot()).runtime,'native');assert.equal(f.invocations,0);assert.equal(f.selections,0);
 }finally{await f.close();}
});

test('saved native settings and hold survive reopening independently of bootstrap and no source is generated',async()=>{
 const f=await fixture();try{
  const s=await f.operator.state.snapshot();await f.operator.state.action({action:'settings.apply',requestId:'persist-tone',baseRevision:s.settingsRevision,data:{tone:.2,labels:true}});f.operator.close();
  // A fresh operator loads its private state; it must not reset to bootstrap on repeated creation.
  const input:OperatorInputClient={readState:async()=>inputState(),readFrame:async()=>{throw Error('Unexpected acquisition');},readPreview:async()=>{throw Error('Unexpected preview');},select:async()=>{throw Error('Unexpected selection');}};
  const reopened=await createNativeOperator({directory:f.directory,python,input,isBusy:()=>false,capture:()=>({active:null}),cancel:()=>{},readScenes:()=>f.scenes,invokeGenerate:async()=>{throw Error('Unexpected generation');}});
  try{const saved=await reopened.state.snapshot();assert.equal(saved.runtime,'native');assert.equal(saved.settings.tone,.2);assert.equal(saved.settings.labels,true);assert.equal(saved.submissionHold,true);assert.equal(saved.settings.mode,'manual');assert.equal(f.invocations,0);}finally{reopened.close();}
 }finally{await f.close();}
});


test('native private-person preflight reaches pinned generation before acceptance; refusal keeps text and image one-shot pending',async()=>{
 const id='11111111-1111-4111-8111-111111111111';let allowed=false,preflights=0;
 const f=await fixture({preflightPersonReferences:async(body:any)=>{preflights++;assert.ok(Object.isFrozen(body));assert.deepEqual(body.scenePersonReferences.gen_a,[{contentId:id,role:'add-person'}]);if(!allowed)throw Object.assign(Error('Private reference unavailable'),{statusCode:400});}});
 try{
  const initial=await f.operator.state.snapshot();await f.operator.state.action({action:'settings.apply',requestId:'add-private-ref',baseRevision:initial.settingsRevision,data:{scenes:{a:{continuousPersonReferenceIds:[id],oneShotPersonReferenceIds:[id]}}}});
  const failed=await action(f.operator,'generation.generate','missing-private-ref');assert.equal(failed.status,400);assert.equal(f.invocations,0);
  let settings=await f.operator.state.readSettings();assert.equal(settings.scenes.a.oneShot,'Look left');assert.deepEqual(settings.scenes.a.oneShotPersonReferenceIds,[id]);
  allowed=true;const accepted=await action(f.operator,'generation.generate','resolved-private-ref');assert.equal(accepted.body.ok,true);assert.equal(f.invocations,1);assert.equal(preflights,2);
  settings=await f.operator.state.readSettings();assert.equal(settings.scenes.a.oneShot,'');assert.deepEqual(settings.scenes.a.oneShotPersonReferenceIds,[]);assert.deepEqual(settings.scenes.a.continuousPersonReferenceIds,[id]);assert.equal((await f.operator.state.snapshot()).submissionHold,true);
 }finally{await f.close();}
});

test('CSV setting rows apply live through settings.apply/pause/resume without pausing the scenario clock, and Stop restores them',async()=>{
 const f=await fixture({checkPersonReferences:async()=>[]});try{
  await fs.writeFile(path.join(f.directory,'scenarios','SETTINGS.csv'),'seconds,action,target,value\n0,scenario,,SETTINGS-NATIVE\n0,distance,A,10\n0,presence,,0.5\n0,pause,,\n0,resume,,\n60,end,,\n');
  assert.equal((await action(f.operator,'scenario.load','load-settings',{file:'SETTINGS.csv'})).body.ok,true);
  const before=await f.operator.state.snapshot();assert.equal(before.submissionHold,true);
  assert.equal((await action(f.operator,'scenario.play','play-settings')).body.ok,true);
  const mid=await f.operator.state.snapshot();assert.equal(mid.settings.scenes.a.distanceSec,10);assert.equal(mid.settings.presence,.5);assert.equal(mid.submissionHold,false);assert.notEqual(mid.settingsRevision,before.settingsRevision);
  assert.equal(f.operator.scenario.status().state,'running');assert.equal(f.operator.scenario.status().appliedSettings,4);assert.equal(f.operator.scenario.status().failedSettings,0);
  assert.equal((await action(f.operator,'scenario.stop','stop-settings')).body.ok,true);
  const after=await f.operator.state.snapshot();assert.equal(after.settings.scenes.a.distanceSec,15);assert.equal(after.settings.presence,.7);assert.equal(after.submissionHold,true);assert.equal(f.invocations,0);
 }finally{await f.close();}
});

test('scenario FORMAT ERROR lists every problem, keeps the last good plan, persists in state until a clean load',async()=>{
 const f=await fixture();try{
  const scenarios=path.join(f.directory,'scenarios');
  // Startup loaded SCN-001; its unused image columns are warnings only.
  assert.equal(f.operator.scenario.status().scenarioId,'SCN-001');assert.ok(f.operator.scenario.status().formatWarnings.length>0);
  await fs.writeFile(path.join(scenarios,'BAD.csv'),'seconds,action,target,value\n0,scenario,,BAD\nx,prompt,A,hi\n1,bogus,,\n2,interval_sec,,4\n3,person_refs,A,nope\n4,image,A,missing.png\n5,end,,\n');
  const bad=await action(f.operator,'scenario.load','load-bad',{file:'BAD.csv'});
  assert.equal(bad.status,400);assert.equal(bad.body.ok,false);assert.match(bad.body.error,/FORMAT ERROR/);
  assert.deepEqual(bad.body.formatErrors.map((e:any)=>e.row),[3,4,5,6,7]);assert.equal(bad.body.formatErrors[0].column,'seconds');
  let status=((await f.operator.state.snapshot()) as any).scenario;
  assert.equal(status.scenarioId,'SCN-001');assert.equal(status.file,'SCN-001.csv');assert.equal(status.formatFile,'BAD.csv');assert.equal(status.formatErrors.length,5);assert.ok(status.formatCheckedAt);
  // Upload with errors: rejected, recorded, not selectable.
  const upload=await f.operator.handle({method:'POST',route:'/native/scenario-upload',payload:{csv:{name:'UP.csv',text:'seconds,action,target,value\n0,mode,,auto\n'},assets:[]}}) as any;
  assert.equal(upload.status,400);assert.equal(upload.body.formatErrors[0].row,2);
  assert.ok(!((await f.operator.state.snapshot()) as any).scenarioLibrary.some((r:any)=>r.file.includes('UP.csv')));
  // A load with warnings only succeeds and clears the errors.
  await fs.writeFile(path.join(scenarios,'WARN.csv'),'seconds,action,target,value\n0,scenario,,WARN\n0,note,,same\n1,note,,same\n');
  const ok=await action(f.operator,'scenario.load','load-warn',{file:'WARN.csv'});assert.equal(ok.body.ok,true);assert.match(ok.body.message,/WARNING/);
  status=((await f.operator.state.snapshot()) as any).scenario;
  assert.equal(status.scenarioId,'WARN');assert.deepEqual(status.formatErrors,[]);assert.deepEqual(status.formatWarnings.map((w:any)=>w.row).sort(),[0,4]);assert.equal(status.formatFile,'WARN.csv');
 }finally{await f.close();}
});

async function resyncFixture(stored:string|undefined,bridgeState:()=>any){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'native-operator-resync-'));
 await fs.mkdir(path.join(directory,'scenarios'));
 await fs.writeFile(path.join(directory,'bootstrap-state.json'),JSON.stringify(initial()));
 await fs.writeFile(path.join(directory,'scenarios','SCN-001.csv'),'seconds,action,target,value,source_rect,target_rect,fit,opacity,feather_px\n0,scenario,,SCN-001,,,,,\n0,layout,,B|NOW|A|C,,,,,\n180,end,,,,,,,\n');
 if(stored!==undefined)await fs.writeFile(path.join(directory,'input-selection.json'),JSON.stringify({schema:1,setId:stored}));
 const calls:any[]=[];
 const input:OperatorInputClient={readState:async()=>bridgeState(),readPreview:async()=>{throw Error('unused');},readFrame:async()=>{throw Error('unused');},select:async r=>{calls.push(r);return{...r,state:bridgeState()};}};
 const operator=await createNativeOperator({directory,python,input,isBusy:()=>false,capture:()=>({active:null}),cancel:()=>{},readScenes:async()=>({}),invokeGenerate:async()=>({status:200,body:{}})});
 await operator.inputResync;
 return{operator,calls,close:()=>operator.close()};
}
const cameraState=()=>({...inputState(),inputKind:'live-camera' as const,replay:null,sourceScope:'camera:main'});
const replayState=(setId:string)=>({...inputState(),replay:{...inputState().replay,setId}});

test('startup resync re-sends exactly the stored setId once',async()=>{
 const f=await resyncFixture('TSC-003',()=>replayState('TSC-003'));
 try{assert.equal(f.calls.length,1);assert.equal(f.calls[0].setId,'TSC-003');assert.ok(f.calls[0].requestId);assert.deepEqual(((await f.operator.state.snapshot()) as any).errors,[]);}finally{f.close();}
});
test('startup resync sends nothing when no selection is stored',async()=>{
 const f=await resyncFixture(undefined,()=>cameraState());
 try{assert.equal(f.calls.length,0);}finally{f.close();}
});
test('startup resync honours a stored camera choice',async()=>{
 const f=await resyncFixture('camera',()=>cameraState());
 try{assert.equal(f.calls.length,1);assert.equal(f.calls[0].setId,'camera');}finally{f.close();}
});
test('startup resync skips remote-device',async()=>{
 const f=await resyncFixture('remote-device',()=>cameraState());
 try{assert.equal(f.calls.length,0);}finally{f.close();}
});
test('mismatch after resync and in the periodic check is recorded as an input error',async()=>{
 let live=false;
 const f=await resyncFixture('TSC-003',()=>live?replayState('TSC-003'):cameraState());
 try{
  const has=async()=>((await f.operator.state.snapshot()) as any).errors.some((e:any)=>e.message==='Input bridge mismatch after resync');
  assert.equal(await has(),true);
  live=true;await f.operator.checkSelection('check');assert.equal(await has(),false);
  live=false;await f.operator.checkSelection('check');assert.equal(await has(),true);assert.equal(f.calls.length,1);
 }finally{f.close();}
});

test('operator generation.pause pauses the scenario clock; scenario.play while paused by the operator resumes it instead of timing out',async()=>{
 const f=await fixture({checkPersonReferences:async()=>[]});try{
  await fs.writeFile(path.join(f.directory,'scenarios','PAUSE.csv'),'seconds,action,target,value\n0,scenario,,PAUSE-NATIVE\n0,distance,A,10\n0,pause,,\n0,resume,,\n60,end,,\n');
  assert.equal((await action(f.operator,'scenario.load','load-pause',{file:'PAUSE.csv'})).body.ok,true);
  assert.equal((await action(f.operator,'scenario.play','play-pause-1')).body.ok,true);
  assert.equal(f.operator.scenario.status().state,'running');
  const runId=f.operator.scenario.status().runId;
  const paused=await action(f.operator,'generation.pause','op-pause');assert.equal(paused.body.ok,true);
  assert.equal(f.operator.scenario.status().state,'paused');assert.equal((await f.operator.state.snapshot()).submissionHold,true);
  const played=await action(f.operator,'scenario.play','play-pause-2');
  assert.equal(played.body.ok,true,JSON.stringify(played.body));
  assert.equal(f.operator.scenario.status().state,'running');assert.equal((await f.operator.state.snapshot()).submissionHold,false);
  assert.equal(f.operator.scenario.status().runId,runId,'resumed the same run, not a restart');
  assert.equal((await action(f.operator,'scenario.stop','stop-pause')).body.ok,true);
 }finally{await f.close();}
});

test('chain pacing: a capture with all scenes skipped (count 0) waits the interval; a capture with scenes chains after ~1 s',async()=>{
 const {autoCaptureDue}=await import('./nativeOperator');
 assert.equal(autoCaptureDue({mode:'chain',intervalSec:70,nowMs:10_000,lastAttemptMs:0,zeroScenesAtMs:null}),true);
 assert.equal(autoCaptureDue({mode:'chain',intervalSec:70,nowMs:69_000,lastAttemptMs:0,zeroScenesAtMs:0}),false);
 assert.equal(autoCaptureDue({mode:'chain',intervalSec:70,nowMs:70_000,lastAttemptMs:0,zeroScenesAtMs:0}),true);
 assert.equal(autoCaptureDue({mode:'timer',intervalSec:70,nowMs:69_999,lastAttemptMs:0,zeroScenesAtMs:null}),false);
 assert.equal(autoCaptureDue({mode:'manual',intervalSec:70,nowMs:1e9,lastAttemptMs:0,zeroScenesAtMs:null}),false);
 for(const count of [0,3]){
  const times:number[]=[];
  const f=await fixture({invokeGenerate:async(b:any,accepted:()=>Promise<void>)=>{times.push(Date.now());await accepted();return{status:200,body:{captureId:b.captureId,count}};}});
  try{
   const s=await f.operator.state.snapshot();
   await f.operator.state.action({action:'settings.apply',requestId:'chain-'+count,baseRevision:s.settingsRevision,data:{mode:'chain',intervalSec:5}});
   assert.equal((await action(f.operator,'generation.resume','resume-'+count)).body.ok,true);
   const start=Date.now();while(times.length<1&&Date.now()-start<4000)await new Promise(r=>setTimeout(r,50));
   assert.equal(times.length,1);
   await new Promise(r=>setTimeout(r,2500));
   if(count===0)assert.equal(times.length,1,'all-skip capture must not chain before the interval');
   else assert.ok(times.length>=2,'a capture with scenes chains right away');
   await action(f.operator,'generation.pause','pause-'+count);
  }finally{await f.close();}
 }
});

function queueInput(events:string[],fail?:()=>boolean){
 let kind:'test-replay'|'live-camera'='test-replay';
 const input:OperatorInputClient={readState:async()=>kind==='live-camera'?cameraState():inputState(),readPreview:async()=>{throw Error('unused');},readFrame:async()=>frame(),
  select:async r=>{events.push('select:'+r.setId);if(fail?.())throw Error('bridge refused');kind=r.setId==='camera'?'live-camera':'test-replay';return{...r,state:(kind==="live-camera"?cameraState():replayState(r.setId)) as any};}};
 return input;
}
const waitFor=async(check:()=>boolean,ms=3000)=>{const start=Date.now();while(!check()&&Date.now()-start<ms)await new Promise(r=>setTimeout(r,20));assert.ok(check(),'condition not reached');};
const selectionFile=(d:string)=>fs.readFile(path.join(d,'input-selection.json'),'utf8').then(t=>JSON.parse(t).setId as string,()=>undefined);

test('input.select while busy is queued and applied after the capture completes, before the chain starts the next one',async()=>{
 const events:string[]=[];const gates:Array<()=>void>=[];
 const f=await fixture({input:queueInput(events),invokeGenerate:async(b:any,accepted:()=>Promise<void>)=>{events.push('invoke');await accepted();await new Promise<void>(r=>gates.push(r));return{status:200,body:{captureId:b.captureId,count:3}};}});
 try{
  const s=await f.operator.state.snapshot();
  await f.operator.state.action({action:'settings.apply',requestId:'queue-chain',baseRevision:s.settingsRevision,data:{mode:'chain',intervalSec:5}});
  assert.equal((await action(f.operator,'generation.resume','queue-resume')).body.ok,true);
  await waitFor(()=>events.includes('invoke'));
  const queued=await action(f.operator,'input.select','queue-camera',{setId:'camera'});
  assert.equal(queued.body.ok,true,JSON.stringify(queued.body));assert.equal(queued.body.message,'Input change queued: camera (applied after the current generation)');
  assert.equal(queued.body.state.pendingInput.setId,'camera');assert.equal(queued.body.state.pendingInput.requestId,'queue-camera');
  assert.ok(!events.some(e=>e.startsWith('select')));assert.equal(await selectionFile(f.directory),undefined,'not persisted until applied');
  gates.shift()!();
  await waitFor(()=>events.filter(e=>e==='invoke').length>=2);
  assert.deepEqual(events.slice(0,3),['invoke','select:camera','invoke']);
  assert.equal(((await f.operator.state.snapshot()) as any).pendingInput,null);assert.equal(await selectionFile(f.directory),'camera');
  await action(f.operator,'generation.pause','queue-pause');
 }finally{for(const g of gates)g();await new Promise(r=>setTimeout(r,30));await f.close();}
});
test('a newer queued input.select replaces the older one',async()=>{
 const events:string[]=[];const gate=deferred();
 const f=await fixture({input:queueInput(events),invokeGenerate:async(b:any,accepted:()=>Promise<void>)=>{await accepted();await gate.promise;return{status:200,body:{captureId:b.captureId}};}});
 try{
  assert.equal((await action(f.operator,'generation.generate','replace-gen')).body.ok,true);
  assert.equal((await action(f.operator,'input.select','replace-1',{setId:'TSC-002'})).body.ok,true);
  const second=await action(f.operator,'input.select','replace-2',{setId:'camera'});assert.equal(second.body.state.pendingInput.setId,'camera');
  gate.resolve();await waitFor(()=>events.length>0);await new Promise(r=>setTimeout(r,250));
  assert.deepEqual(events,['select:camera']);assert.equal(await selectionFile(f.directory),'camera');
 }finally{gate.resolve();await f.close();}
});
test('a failed queued input.select is recorded in errors, cleared, and not persisted',async()=>{
 const events:string[]=[];const gate=deferred();
 const f=await fixture({input:queueInput(events,()=>true),invokeGenerate:async(b:any,accepted:()=>Promise<void>)=>{await accepted();await gate.promise;return{status:200,body:{captureId:b.captureId}};}});
 try{
  assert.equal((await action(f.operator,'generation.generate','fail-gen')).body.ok,true);
  assert.equal((await action(f.operator,'input.select','fail-select',{setId:'camera'})).body.ok,true);
  gate.resolve();await waitFor(()=>events.length>0);await new Promise(r=>setTimeout(r,50));
  const snap:any=await f.operator.state.snapshot();
  assert.equal(snap.pendingInput,null);assert.ok(snap.errors.some((e:any)=>/Queued input change to camera failed: bridge refused/.test(e.message)),JSON.stringify(snap.errors));
  assert.equal(await selectionFile(f.directory),undefined);
 }finally{gate.resolve();await f.close();}
});
test('input.select while idle applies immediately and persists',async()=>{
 const events:string[]=[];
 const f=await fixture({input:queueInput(events)});
 try{
  const result=await action(f.operator,'input.select','idle-select',{setId:'TSC-002'});
  assert.equal(result.body.message,'Input selected');assert.deepEqual(events,['select:TSC-002']);assert.equal(result.body.state.pendingInput,null);
  await new Promise(r=>setTimeout(r,30));assert.equal(await selectionFile(f.directory),'TSC-002');
 }finally{await f.close();}
});

const outputStore=()=>{let revision=0;let outputs:any[]=[1,2,3].map(n=>({id:'screen-'+n,label:'Output '+n,source:(['now','a','b'] as const)[n-1],delaySec:0,scene:'any',visible:true,labels:true,subtitles:true,fade:false,fadeMode:'original',faceBlur:{enabled:false,strengthPx:12}}));
 return{get outputs(){return structuredClone(outputs);},configuration:async()=>({revision:String(revision),outputs:structuredClone(outputs)}),update:async(raw:any)=>{assert.equal(raw.baseRevision,String(revision));outputs=structuredClone(raw.outputs);revision++;return{revision:String(revision),outputs:structuredClone(outputs)};},setScenarioPreview:async()=>{},clearScenarioPreview:()=>{}};};
const liveSettings=async(op:Awaited<ReturnType<typeof createNativeOperator>>,id:string,data:Record<string,unknown>)=>{const s=await op.state.snapshot();return op.state.action({action:'settings.apply',requestId:id,baseRevision:s.settingsRevision,data});};

test('a live CSV that sets mode itself drives auto captures during playback, tagged with the run; Stop ends them',async()=>{
 const f=await fixture({checkPersonReferences:async()=>[]});try{
  const csv='seconds,action,target,value\n0,scenario,,AUTO-NATIVE\n0,interval_sec,,30\n0,mode,,chain\n0,resume,,\n120,end,,\n';
  await fs.writeFile(path.join(f.directory,'scenarios','AUTO.csv'),csv);
  await liveSettings(f.operator,'live-auto',{scenarioPreview:false});
  assert.equal((await action(f.operator,'scenario.load','load-auto',{file:'AUTO.csv'})).body.ok,true);
  assert.equal((await action(f.operator,'scenario.play','play-auto')).body.ok,true);
  assert.equal(f.operator.scenario.autoCaptureMode(),'chain');
  const tag=f.operator.scenarioRunTag()!;assert.equal(tag.scenarioId,'AUTO-NATIVE');assert.equal(tag.csvSha,createHash('sha256').update(csv).digest('hex'));assert.equal(tag.runId,f.operator.scenario.status().runId);

  await waitFor(()=>f.invocations>=1,4000);
  assert.equal(f.bodies[0].executionSource,'chain');
  const manual=await action(f.operator,'generation.generate','manual-in-auto');assert.equal(manual.status,409,'manual Generate stays blocked while the scenario owns playback');
  await waitFor(()=>(f.operator.scenarioRuns.list().at(-1)?.captureIds.length??0)>=1,2000);
  assert.equal((await action(f.operator,'scenario.stop','stop-auto')).body.ok,true);
  assert.equal(f.operator.scenarioRunTag(),undefined);
  const count=f.invocations;await new Promise(r=>setTimeout(r,1500));assert.equal(f.invocations,count,'no auto capture after Stop (hold and mode restored)');
  const run=f.operator.scenarioRuns.list().at(-1)!;assert.equal(run.endReason,'stop');assert.ok(run.captureIds.length>=1);
 }finally{await f.close();}
});
test('a live CSV without a mode cue never auto-captures (generate rows only)',async()=>{
 const f=await fixture({checkPersonReferences:async()=>[]});try{
  await fs.writeFile(path.join(f.directory,'scenarios','NOMODE.csv'),'seconds,action,target,value\n0,scenario,,NOMODE\n0,resume,,\n120,end,,\n');
  await liveSettings(f.operator,'chain-before',{mode:'chain',intervalSec:5,scenarioPreview:false});
  assert.equal((await action(f.operator,'scenario.load','load-nomode',{file:'NOMODE.csv'})).body.ok,true);
  assert.equal((await action(f.operator,'scenario.play','play-nomode')).body.ok,true);
  assert.equal(f.operator.scenario.autoCaptureMode(),undefined);
  await new Promise(r=>setTimeout(r,1600));assert.equal(f.invocations,0);
  await action(f.operator,'scenario.stop','stop-nomode');
 }finally{await f.close();}
});
test('natural end restores outputs and settings, enables generation (end policy), archives the CSV and reloads the previous scenario',async()=>{
 const store=outputStore(),{createOperatorScenarioOutputs}=await import('./operatorScenarioOutputs');
 const f=await fixture({checkPersonReferences:async()=>[],outputMapping:createOperatorScenarioOutputs(store as any),readOutputIds:()=>['screen-1','screen-2','screen-3']});try{
  const csv='seconds,action,target,value\n0,scenario,,END-NATIVE\n0,distance,A,60\n0,mode,,manual\n0,resume,,\n0,output_source,screen-2,c\n0,output_source,screen-3,a\n1,end,,\n';
  await fs.writeFile(path.join(f.directory,'scenarios','END.csv'),csv);
  await liveSettings(f.operator,'live-end',{scenarioPreview:false});
  const before=await f.operator.state.snapshot();assert.equal(before.submissionHold,true);
  assert.equal((await action(f.operator,'scenario.load','load-end',{file:'END.csv'})).body.ok,true);
  assert.equal((await action(f.operator,'scenario.play','play-end')).body.ok,true);
  const runId=f.operator.scenario.status().runId;
  assert.equal((await f.operator.state.snapshot()).submissionHold,false);assert.deepEqual(store.outputs.map(o=>o.source),['now','c','a']);
  // Edit the library CSV during the run: the archive keeps the text that was played.
  await fs.writeFile(path.join(f.directory,'scenarios','END.csv'),csv.replace('60','90'));
  await waitFor(()=>f.operator.scenario.status().file==='SCN-001.csv',5000);await f.operator.whenReloaded();
  const st=f.operator.scenario.status();assert.equal(st.state,'ready');assert.equal(st.ownsLayout,false);assert.equal(st.scenarioId,'SCN-001');
  const after=await f.operator.state.snapshot();assert.equal(after.submissionHold,false,'end policy: generation enabled after a natural end');assert.equal(after.settings.scenes.a.distanceSec,15);assert.equal(after.settings.mode,before.settings.mode);
  assert.deepEqual(store.outputs.map(o=>o.source),['now','a','b']);
  const run=f.operator.scenarioRuns.get(runId)!;assert.equal(run.endReason,'end');assert.equal(run.scenarioId,'END-NATIVE');assert.equal(run.file,'END.csv');assert.equal(run.sha256,createHash('sha256').update(csv).digest('hex'));
  assert.equal(run.cuesApplied,5);assert.equal(run.outputsChanged.length,2);assert.ok(run.restored!.includes('outputs'),String(run.restored));assert.ok(run.restored!.includes('submissionHold=false (end policy: enabled)'),String(run.restored));assert.ok(run.restored!.some(r=>r.startsWith('scenes.a.distanceSec=')),String(run.restored));
  assert.equal(f.operator.scenarioRuns.readCsv(runId),csv);
  const sidecar=JSON.parse(await fs.readFile(path.join(f.directory,'logs','scenario-runs',run.csvFile.replace(/\.csv$/,'.json')),'utf8'));assert.equal(sidecar.endReason,'end');assert.ok(sidecar.endedAt);
  const rows=(await fs.readFile(path.join(f.directory,'logs','scenario-runs.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l)).filter(r=>r.runId===runId);assert.equal(rows.length,2);assert.equal(rows[0].endedAt,null);
  const events=(await fs.readFile(path.join(f.directory,'scenario-events.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l)).filter(r=>r.runId===runId).map(r=>r.event);
  for(const name of ['run.completed','restore.layout','restore.outputs','restore.setting','restore.hold','run.archived','scenario.reloaded'])assert.ok(events.includes(name),name);
 }finally{await f.close();}
});
test('live frame recording error is set on failure and cleared by the next successful recording',async()=>{
 let n=0,fail=true;const recorded:any[]=[];
 const camFrame=()=>{n++;const b=Buffer.from('camera frame '+n),h=createHash('sha256').update(b).digest('hex');return{...frame(),image:'data:image/jpeg;base64,'+b.toString('base64'),sha256:h,suggestedCaptureId:'camera-1792322515117-abcdef12',sourceParams:{source:'live-camera',inputKind:'live-camera',sourceScope:'camera:main',capturedAt:new Date(Date.now()+n).toISOString()}};};
 const input:OperatorInputClient={readState:async()=>cameraState() as any,readPreview:async()=>{throw Error('unused');},select:async()=>{throw Error('unused');},readFrame:async()=>camFrame()};
 const f=await fixture({input,recordFrame:async(body:any)=>{if(fail)throw Error('disk full');recorded.push(body);return{};}});try{
  await liveSettings(f.operator,'manual-mode',{mode:'manual'});
  assert.equal((await action(f.operator,'generation.resume','resume-rec')).body.ok,true);
  const errors=async()=>((await f.operator.state.snapshot()) as any).errors.filter((e:any)=>e.operator==='native-recording').map((e:any)=>e.message);
  const start=Date.now();while(!(await errors()).length&&Date.now()-start<4000)await new Promise(r=>setTimeout(r,100));
  assert.match((await errors())[0],/^Live frame recording failed: disk full/);
  fail=false;await waitFor(()=>recorded.length>=1,4000);
  assert.deepEqual(await errors(),[]);
 }finally{await f.close();}
});
test('natural end stays paused when the CSV last hold cue was pause; Stop restores the pre-scenario hold',async()=>{
 const f=await fixture({checkPersonReferences:async()=>[]});try{
  await liveSettings(f.operator,'live-pause-end',{scenarioPreview:false});
  await fs.writeFile(path.join(f.directory,'scenarios','PEND.csv'),'seconds,action,target,value\n0,scenario,,PEND\n0,resume,,\n0,pause,,\n1,end,,\n');
  assert.equal((await action(f.operator,'scenario.load','load-pend',{file:'PEND.csv'})).body.ok,true);
  assert.equal((await action(f.operator,'scenario.play','play-pend')).body.ok,true);const runId=f.operator.scenario.status().runId;
  await waitFor(()=>f.operator.scenario.status().file==='SCN-001.csv',5000);await f.operator.whenReloaded();
  assert.equal((await f.operator.state.snapshot()).submissionHold,true);assert.ok(f.operator.scenarioRuns.get(runId)!.restored!.includes('submissionHold=true (end policy: paused by CSV)'));
  await fs.writeFile(path.join(f.directory,'scenarios','RSTOP.csv'),'seconds,action,target,value\n0,scenario,,RSTOP\n0,resume,,\n60,end,,\n');
  assert.equal((await action(f.operator,'scenario.load','load-rstop',{file:'RSTOP.csv'})).body.ok,true);
  assert.equal((await action(f.operator,'scenario.play','play-rstop')).body.ok,true);assert.equal((await f.operator.state.snapshot()).submissionHold,false);
  assert.equal((await action(f.operator,'scenario.stop','stop-rstop')).body.ok,true);assert.equal((await f.operator.state.snapshot()).submissionHold,true,'Stop restores the pre-scenario (paused) hold');
 }finally{await f.close();}
});
