import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs/promises';import os from'node:os';import path from'node:path';import{createOperatorState,OperatorStateError}from'./operatorState';
const initial=()=>({schema:1,project:'Native operator',settings:{mode:'timer',intervalSec:70,imageCount:3,presence:.7,tone:.6,vlmBackend:'local',imageBackend:'local',displayTiming:'each',scenarioPreview:true,labels:true,subtitles:true,fade:true,scenes:{a:{distanceSec:15,continuous:'Sit naturally',oneShot:'Raise right hand'},b:{distanceSec:30,continuous:'Stand up',oneShot:''},c:{distanceSec:-30,continuous:'Cheer',oneShot:''}}},display:{layout:['NOW','C','A','B'],visible:true},capture:{phase:'idle'},scenario:{ownsLayout:false,state:'idle'},replay:{active:false},scenarioLibrary:[],history:''});
async function fixture(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'operator-state-'));return{dir,file:path.join(dir,'operator.json')};}
test('initial migration safely pauses execution while preserving user instructions, distances and output flags',async()=>{
 const f=await fixture();try{let calls=0;const state=createOperatorState({file:f.file,initial:initial(),delegate:async()=>{calls++;}});const s=await state.snapshot();assert.equal(s.runtime,'native');assert.equal(s.submissionHold,true);assert.equal(s.settings.mode,'manual');assert.equal(s.settings.scenarioPreview,false);assert.equal(s.settings.scenes.a.continuous,'Sit naturally');assert.equal(s.settings.scenes.c.distanceSec,-30);assert.deepEqual(s.display.layout,['NOW','C','A','B']);assert.equal(calls,0);}finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
test('settings validation and revision conflict are atomic and scenario ownership is respected',async()=>{
 const f=await fixture();let owned=false;try{const state=createOperatorState({file:f.file,initial:initial(),runtime:()=>({scenario:{ownsLayout:owned}})});let s=await state.snapshot();await assert.rejects(state.action({action:'settings.apply',data:{presence:NaN},requestId:'nan',baseRevision:s.settingsRevision}));assert.equal((await state.readSettings()).presence,.7);
 const accepted=await state.action({action:'settings.apply',data:{scenes:{a:{distanceSec:110}}},requestId:'valid',baseRevision:s.settingsRevision});assert.equal(accepted.state.settings.scenes.a.distanceSec,110);await assert.rejects(state.action({action:'settings.apply',data:{tone:.5},requestId:'stale',baseRevision:s.settingsRevision}),(e:any)=>e.status===409);
 s=await state.snapshot();owned=true;await assert.rejects(state.action({action:'settings.apply',data:{scenes:{a:{continuous:'Changed'}}},requestId:'owned',baseRevision:s.settingsRevision}),(e:any)=>e.status===409);assert.equal((await state.readSettings()).scenes.a.continuous,'Sit naturally');
 }finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
test('delegate executes once across retries/restart; resume/pause only change persistent hold after acceptance',async()=>{
 const f=await fixture();try{let calls=0;const delegate=async()=>{calls++;return{message:'Accepted'};};const state=createOperatorState({file:f.file,initial:initial(),delegate});const request={action:'generation.resume',data:{},requestId:'resume-once'};assert.equal((await state.action(request)).state.submissionHold,false);await state.action(request);assert.equal(calls,1);const reopened=createOperatorState({file:f.file,initial:initial(),delegate});await reopened.action(request);assert.equal(calls,1);await reopened.action({action:'generation.pause',data:{},requestId:'pause'});assert.equal((await reopened.snapshot()).submissionHold,true);assert.equal(calls,2);await assert.rejects(reopened.action({...request,action:'generation.generate'}),(e:any)=>e.status===409);}finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
test('timeout receipt prevents re-execution, and no error exposes delegate private details',async()=>{
 const f=await fixture();try{let calls=0;const state=createOperatorState({file:f.file,initial:initial(),delegate:async()=>{calls++;throw Error('private-token-path');}});const request={action:'generation.generate',data:{},requestId:'unknown'};await assert.rejects(state.action(request),(e:any)=>e.status===504&&e.indeterminate&&!e.message.includes('private-token'));await assert.rejects(state.action(request),(e:any)=>e.status===409&&e.indeterminate);assert.equal(calls,1);}finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
test('oneShot compare-and-clear never clears later edits, and may run inside delegated acceptance without deadlock',async()=>{
 const f=await fixture();try{let state:ReturnType<typeof createOperatorState>;state=createOperatorState({file:f.file,initial:initial(),delegate:async(_action,_data,context)=>{await state.consumeOneShot({scenes:{a:context.settings.scenes.a.oneShot},oneShotTokens:context.oneShotTokens});}});const captured=await state.readSettingsSnapshot();let s=await state.snapshot();await state.action({action:'settings.apply',data:{scenes:{a:{oneShot:'New explicit one-shot'}}},requestId:'edit',baseRevision:s.settingsRevision});assert.equal(await state.consumeOneShot({scenes:{a:captured.settings.scenes.a.oneShot},oneShotTokens:captured.oneShotTokens}),false);assert.equal((await state.readSettings()).scenes.a.oneShot,'New explicit one-shot');await state.action({action:'generation.generate',data:{},requestId:'accept'});assert.equal((await state.readSettings()).scenes.a.oneShot,'');}finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
test('layout actions persist locally, internal scenario layout updates and display flags remain intact',async()=>{
 const f=await fixture();try{const state=createOperatorState({file:f.file,initial:initial()});await state.action({action:'display.layout',data:{sources:['B','NOW','A','C']},requestId:'layout'});await state.action({action:'display.hide',data:{},requestId:'hide'});assert.equal((await state.readDisplay()).visible,false);await state.setDisplay({layout:['C','A','NOW','B']});assert.deepEqual((await state.readDisplay()).layout,['C','A','NOW','B']);await state.action({action:'display.reset',data:{},requestId:'reset'});assert.deepEqual((await state.readDisplay()).layout,['A','B','C','NOW']);assert.equal((await state.readSettings()).subtitles,true);}finally{await fs.rm(f.dir,{recursive:true,force:true});}
});

test('concurrent setting changes with one revision never overwrite each other',async()=>{
 const f=await fixture();try{const state=createOperatorState({file:f.file,initial:initial()});const base=(await state.snapshot()).settingsRevision;const changes=await Promise.allSettled([state.action({action:'settings.apply',data:{tone:.2},requestId:'first',baseRevision:base}),state.action({action:'settings.apply',data:{presence:.3},requestId:'second',baseRevision:base})]);assert.equal(changes.filter(r=>r.status==='fulfilled').length,1);assert.equal(changes.filter(r=>r.status==='rejected').length,1);assert.equal(await state.readSubmissionHold(),true);}finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
test('oneShot token survives unrelated edits but rejects a newer identical oneShot intent',async()=>{
 const f=await fixture();try{const state=createOperatorState({file:f.file,initial:initial()}),captured=await state.readSettingsSnapshot();await state.action({action:'settings.apply',data:{tone:.4},requestId:'tone',baseRevision:captured.settingsRevision});assert.equal(await state.consumeOneShot({scenes:{a:captured.settings.scenes.a.oneShot},oneShotTokens:captured.oneShotTokens}),true);
 let current=await state.snapshot();await state.action({action:'settings.apply',data:{scenes:{a:{oneShot:'Same instruction'}}},requestId:'shot1',baseRevision:current.settingsRevision});const original=await state.readSettingsSnapshot();current=await state.snapshot();await state.action({action:'settings.apply',data:{scenes:{a:{oneShot:'Same instruction'}}},requestId:'shot2',baseRevision:current.settingsRevision});assert.equal(await state.consumeOneShot({scenes:{a:'Same instruction'},oneShotTokens:original.oneShotTokens}),false);assert.equal((await state.readSettings()).scenes.a.oneShot,'Same instruction');}finally{await fs.rm(f.dir,{recursive:true,force:true});}
});

const ref1='11111111-1111-4111-8111-111111111111',ref2='22222222-2222-4222-8222-222222222222';
test('private reference IDs default to empty arrays, validate strictly, and persist without changing text',async()=>{
 const f=await fixture();try{
  const state=createOperatorState({file:f.file,initial:initial()}),before=await state.snapshot();assert.deepEqual(before.settings.scenes.a.continuousPersonReferenceIds,[]);assert.deepEqual(before.settings.scenes.a.oneShotPersonReferenceIds,[]);
  const next=await state.action({action:'settings.apply',data:{scenes:{a:{continuousPersonReferenceIds:[ref1.toUpperCase()],oneShotPersonReferenceIds:[ref2]}}},requestId:'refs',baseRevision:before.settingsRevision});
  assert.deepEqual(next.state.settings.scenes.a.continuousPersonReferenceIds,[ref1]);assert.equal(next.state.settings.scenes.a.oneShot,'Raise right hand');
  const reopened=createOperatorState({file:f.file,initial:initial()});assert.deepEqual((await reopened.readSettings()).scenes.a.oneShotPersonReferenceIds,[ref2]);
  for(const ids of [[ref1,ref1.toUpperCase()],['/private/photo.jpg'],['https://remote/image.jpg'],Array(16).fill(ref1),'not-an-array'])await assert.rejects(reopened.action({action:'settings.apply',data:{scenes:{a:{oneShotPersonReferenceIds:ids}}},requestId:'bad-'+Math.random(),baseRevision:next.state.settingsRevision}));
  assert.deepEqual((await reopened.readSettings()).scenes.a.oneShotPersonReferenceIds,[ref2]);
 }finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
test('image-only OneShot uses the same intent token and compare-clears text plus refs atomically',async()=>{
 const f=await fixture();try{
  const state=createOperatorState({file:f.file,initial:initial()});let s=await state.snapshot();
  await state.action({action:'settings.apply',data:{scenes:{a:{oneShot:'',oneShotPersonReferenceIds:[ref1],continuousPersonReferenceIds:[ref2]}}},requestId:'image-only',baseRevision:s.settingsRevision});
  const captured=await state.readSettingsSnapshot();s=await state.snapshot();
  await state.action({action:'settings.apply',data:{scenes:{a:{oneShotPersonReferenceIds:[ref1]}}},requestId:'new-same-image-intent',baseRevision:s.settingsRevision});
  assert.equal(await state.consumeOneShot({scenes:{a:''},personReferenceIds:{a:[ref1]},oneShotTokens:captured.oneShotTokens}),false);
  const latest=await state.readSettingsSnapshot();assert.equal(await state.consumeOneShot({scenes:{a:''},personReferenceIds:{a:[ref2]},oneShotTokens:latest.oneShotTokens}),false);
  assert.equal(await state.consumeOneShot({scenes:{a:''},personReferenceIds:{a:[ref1]},oneShotTokens:latest.oneShotTokens}),true);
  const after=await state.readSettings();assert.equal(after.scenes.a.oneShot,'');assert.deepEqual(after.scenes.a.oneShotPersonReferenceIds,[]);assert.deepEqual(after.scenes.a.continuousPersonReferenceIds,[ref2]);
 }finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
test('emptyRoomPersonChance: defaults to 0.3 for old stored state, applies 0..1 with a new revision, rejects out-of-range',async()=>{
 const f=await fixture();try{const state=createOperatorState({file:f.file,initial:initial()});let s=await state.snapshot();assert.equal(s.settings.emptyRoomPersonChance,.3);
 for(const bad of [1.5,-0.1,NaN,'0.5'])await assert.rejects(state.action({action:'settings.apply',data:{emptyRoomPersonChance:bad},requestId:'bad-'+String(bad).replace(/[^a-z0-9]/gi,'x'),baseRevision:s.settingsRevision}),(e:any)=>e.status===400);
 const before=s.settingsRevision;const ok=await state.action({action:'settings.apply',data:{emptyRoomPersonChance:.75},requestId:'erp',baseRevision:s.settingsRevision});assert.equal(ok.state.settings.emptyRoomPersonChance,.75);assert.notEqual(ok.state.settingsRevision,before);
 const raw=JSON.parse(await fs.readFile(f.file,'utf8'));delete raw.settings.emptyRoomPersonChance;await fs.writeFile(f.file,JSON.stringify(raw));
 const reopened=createOperatorState({file:f.file,initial:initial()});assert.equal((await reopened.readSettings()).emptyRoomPersonChance,.3);
 }finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
test('per-scene presence/tone: optional 0..1 overrides via settings.apply, null removes, out of range rejected',async()=>{
 const f=await fixture();try{const state=createOperatorState({file:f.file,initial:initial()});let s=await state.snapshot();assert.equal(s.settings.scenes.b.presence,undefined);
 for(const [i,bad] of [1.5,-0.1,'0.5',NaN].entries())await assert.rejects(state.action({action:'settings.apply',data:{scenes:{b:{presence:bad}}},requestId:'bad-scene-'+i,baseRevision:s.settingsRevision}),(e:any)=>e.status===400);
 const before=s.settingsRevision;const ok=await state.action({action:'settings.apply',data:{scenes:{b:{presence:.8},c:{tone:.1}}},requestId:'scene-pt',baseRevision:s.settingsRevision});
 assert.equal(ok.state.settings.scenes.b.presence,.8);assert.equal(ok.state.settings.scenes.c.tone,.1);assert.equal(ok.state.settings.scenes.a.presence,undefined);assert.notEqual(ok.state.settingsRevision,before);
 const cleared=await state.action({action:'settings.apply',data:{scenes:{b:{presence:null}}},requestId:'scene-clear',baseRevision:ok.state.settingsRevision});
 assert.equal('presence' in cleared.state.settings.scenes.b,false);assert.equal(cleared.state.settings.scenes.c.tone,.1);
 const reopened=createOperatorState({file:f.file,initial:initial()});assert.equal((await reopened.readSettings()).scenes.c.tone,.1);
 }finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
