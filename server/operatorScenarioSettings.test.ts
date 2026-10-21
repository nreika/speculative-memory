import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs/promises';import os from'node:os';import path from'node:path';
import{createOperatorState}from'./operatorState';import{createOperatorScenarioSettings,validateScenarioSettingsChange}from'./operatorScenarioSettings';import{createOperatorScenario}from'./operatorScenario';
const initial=()=>({schema:1,settings:{mode:'timer',intervalSec:70,imageCount:3,presence:.7,tone:.6,vlmBackend:'local',imageBackend:'local',displayTiming:'each',scenarioPreview:false,labels:true,subtitles:true,fade:true,scenes:{a:{distanceSec:15,continuous:'Sit',oneShot:''},b:{distanceSec:30,continuous:'',oneShot:''},c:{distanceSec:-30,continuous:'',oneShot:''}}},display:{layout:['NOW','C','A','B'],visible:true}});
const ref1='11111111-1111-4111-8111-111111111111',ref2='22222222-2222-4222-8222-222222222222';
const fifteen=()=>Array.from({length:15},(_,i)=>`${String(i).padStart(8,'0')}-1111-4111-8111-111111111111`);
async function fixture(missing:string[]=[]){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'scenario-settings-'));const delegated:any[]=[];
 // The scenario owns the layout throughout: scenario-origin settings.apply must pass, manual scene edits must not.
 const state=createOperatorState({file:path.join(dir,'state.json'),initial:initial(),runtime:()=>({scenario:{ownsLayout:true}}),delegate:async(action,_data,context)=>{delegated.push([action,context.origin]);}});
 const settings=createOperatorScenarioSettings({state,checkPersonReferences:async ids=>ids.filter(id=>missing.includes(id))});
 const manual=async(data:Record<string,unknown>)=>state.action({action:'settings.apply',data,requestId:'manual-'+Math.random().toString(36).slice(2),baseRevision:(await state.snapshot()).settingsRevision});
 return{state,settings,delegated,manual,close:()=>fs.rm(dir,{recursive:true,force:true})};
}
test('live apply goes through settings.apply with a new revision; Stop restores only changed items',async()=>{const f=await fixture();try{
 const before=await f.state.snapshot();await f.settings.begin({runId:'r1'});
 await f.settings.apply({settings:{scenes:{a:{distanceSec:10}}}});await f.settings.apply({settings:{presence:.5}});await f.settings.apply({settings:{mode:'chain'}});await f.settings.apply({settings:{intervalSec:30}});
 const mid=await f.state.snapshot();assert.notEqual(mid.settingsRevision,before.settingsRevision);assert.equal(mid.settings.scenes.a.distanceSec,10);assert.equal(mid.settings.presence,.5);assert.equal(mid.settings.mode,'chain');assert.equal(mid.settings.intervalSec,30);
 await f.manual({tone:.2});// unrelated manual change survives restore
 assert.deepEqual(await f.settings.stop(),[]);const after=(await f.state.snapshot()).settings;assert.equal(after.scenes.a.distanceSec,15);assert.equal(after.presence,.7);assert.equal(after.mode,'manual');assert.equal(after.intervalSec,70);assert.equal(after.tone,.2);
}finally{await f.close();}});
test('manual change after the scenario wrote an item wins and is reported; other items still restore',async()=>{const f=await fixture();try{
 await f.settings.begin({runId:'r2'});await f.settings.apply({settings:{presence:.5}});await f.settings.apply({settings:{scenes:{b:{distanceSec:-100}}}});
 const owned=await f.state.snapshot();await assert.rejects(f.state.action({action:'settings.apply',data:{scenes:{b:{distanceSec:5}}},requestId:'blocked',baseRevision:owned.settingsRevision}),(e:any)=>e.status===409);
 await f.manual({presence:.9});
 const errors=await f.settings.stop();assert.equal(errors.length,1);assert.match(errors[0],/presence changed after the scenario set it; not restored/);
 const after=(await f.state.snapshot()).settings;assert.equal(after.presence,.9);assert.equal(after.scenes.b.distanceSec,30);
}finally{await f.close();}});
test('pause/resume use generation.pause/resume with scenario origin and restore the starting hold under the conflict rule',async()=>{const f=await fixture();try{
 assert.equal(await f.state.readSubmissionHold(),true);await f.settings.begin({runId:'r3'});await f.settings.apply({hold:'resume'});assert.equal(await f.state.readSubmissionHold(),false);
 assert.deepEqual(await f.settings.stop(),[]);assert.equal(await f.state.readSubmissionHold(),true);assert.deepEqual(f.delegated,[['generation.resume','scenario'],['generation.pause','scenario']]);
 await f.settings.begin({runId:'r4'});await f.settings.apply({hold:'resume'});await f.state.action({action:'generation.pause',data:{},requestId:'manual-pause'});
 const errors=await f.settings.stop();assert.match(errors.join(),/generation hold changed after the scenario set it/);assert.equal(await f.state.readSubmissionHold(),true);
 await f.settings.begin({runId:'r5'});await f.settings.apply({hold:'pause'});assert.deepEqual(await f.settings.stop(),[]);assert.equal(await f.state.readSubmissionHold(),true);
}finally{await f.close();}});
test('person references use settings.apply validation (limit, union) and fail on missing metadata without writing',async()=>{const f=await fixture([ref2]);try{
 await f.settings.begin({runId:'r6'});
 await f.settings.apply({settings:{scenes:{a:{continuousPersonReferenceIds:[ref1.toUpperCase()]}}}});assert.deepEqual((await f.state.readSettings()).scenes.a.continuousPersonReferenceIds,[ref1]);
 await assert.rejects(f.settings.apply({settings:{scenes:{a:{oneShotPersonReferenceIds:[ref2]}}}}),/Unknown person reference IDs/);
 await assert.rejects(f.settings.apply({settings:{scenes:{a:{oneShotPersonReferenceIds:fifteen()}}}}),/exceed/);
 assert.throws(()=>validateScenarioSettingsChange({settings:{scenes:{a:{oneShotPersonReferenceIds:[...fifteen(),ref1]}}}}));
 assert.deepEqual((await f.state.readSettings()).scenes.a.oneShotPersonReferenceIds,[]);
 assert.deepEqual(await f.settings.stop(),[]);assert.deepEqual((await f.state.readSettings()).scenes.a.continuousPersonReferenceIds,[]);
}finally{await f.close();}});
test('validator rejects out-of-range values and unsupported settings',()=>{for(const v of [{settings:{presence:1.1}},{settings:{intervalSec:4}},{settings:{mode:'auto'}},{settings:{scenes:{a:{distanceSec:3601}}}},{settings:{scenarioPreview:true}},{settings:{scenes:{a:{continuous:'x'}}}},{hold:'stop'},{settings:{tone:.1},hold:'pause'},{}]as any[])assert.throws(()=>validateScenarioSettingsChange(v));});
test('runner + state: Live applies at cue time, a failing row is isolated, Stop restores everything it changed',async()=>{const f=await fixture();try{let clock=0;
 const s=createOperatorScenario({now:()=>clock,setLayout:()=>{},generate:async()=>{},settings:f.settings});
 s.load({version:1,id:'S',durationSec:20,loop:false,cues:[{id:'d',atSec:0,settings:{scenes:{a:{distanceSec:10}}}},{id:'refs',atSec:1,settings:{scenes:{c:{continuousPersonReferenceIds:[ref1]}}}},{id:'bad',atSec:2,settings:{scenes:{c:{oneShotPersonReferenceIds:fifteen()}}}},{id:'t',atSec:8,settings:{tone:.3}},{id:'h',atSec:12,hold:'resume'}]},'S.csv');
 await s.play(false,['A','B','C','NOW']);clock=12;await s.tick();const st=s.status();
 assert.equal(st.state,'running');assert.equal(st.appliedSettings,4);assert.equal(st.failedSettings,1);assert.equal(st.settingsCues.find((r:any)=>r.cueId==='bad').status,'failed');assert.match(st.lastSettingsError,/^bad \(scenes\.c\.oneShotPersonReferenceIds=.*\): Person references exceed/);
 assert.equal((await f.state.readSettings()).tone,.3);assert.equal(await f.state.readSubmissionHold(),false);
 await s.stop();const after=await f.state.readSettings();assert.equal(after.tone,.6);assert.equal(after.scenes.a.distanceSec,15);assert.deepEqual(after.scenes.c.continuousPersonReferenceIds,[]);assert.equal(await f.state.readSubmissionHold(),true);
}finally{await f.close();}});
test('runner reports Stop restore conflicts as lastSettingsError and 409 without overwriting',async()=>{const f=await fixture();try{
 const s=createOperatorScenario({now:()=>0,setLayout:()=>{},generate:async()=>{},settings:f.settings});
 s.load({version:1,id:'S',durationSec:20,loop:false,cues:[{id:'p',atSec:0,settings:{presence:.4}}]},'S.csv');await s.play(false,['A','B','C','NOW']);await f.manual({presence:.95});
 await assert.rejects(s.stop(),(e:any)=>e.statusCode===409&&/presence changed/.test(e.message));assert.match(s.status().lastSettingsError,/^Restore on stop: presence changed/);assert.equal((await f.state.readSettings()).presence,.95);
}finally{await f.close();}});
test('empty_person cue (emptyRoomPersonChance) applies live through settings.apply and Stop restores it under the conflict rule',async()=>{const f=await fixture();try{
 assert.throws(()=>validateScenarioSettingsChange({settings:{emptyRoomPersonChance:1.2}}));assert.throws(()=>validateScenarioSettingsChange({settings:{emptyRoomPersonChance:-0.1}}));
 await f.settings.begin({runId:'erp1'});await f.settings.apply({settings:{emptyRoomPersonChance:.5}});assert.equal((await f.state.readSettings()).emptyRoomPersonChance,.5);
 assert.deepEqual(await f.settings.stop(),[]);assert.equal((await f.state.readSettings()).emptyRoomPersonChance,.3);
 await f.settings.begin({runId:'erp2'});await f.settings.apply({settings:{emptyRoomPersonChance:.9}});await f.manual({emptyRoomPersonChance:.1});
 const errors=await f.settings.stop();assert.match(errors.join(),/emptyRoomPersonChance changed after the scenario set it; not restored/);assert.equal((await f.state.readSettings()).emptyRoomPersonChance,.1);
}finally{await f.close();}});
test('per-scene presence/tone cue (CSV target A|B|C) applies through settings.apply; Stop removes an override that did not exist before',async()=>{const f=await fixture();try{
 assert.throws(()=>validateScenarioSettingsChange({settings:{scenes:{b:{presence:1.2}}}}));assert.throws(()=>validateScenarioSettingsChange({settings:{scenes:{b:{tone:-0.1}}}}));
 await f.settings.begin({runId:'pst1'});await f.settings.apply({settings:{scenes:{b:{presence:.8}}}});await f.settings.apply({settings:{scenes:{c:{tone:.2}}}});
 const mid=(await f.state.readSettings()).scenes;assert.equal(mid.b.presence,.8);assert.equal(mid.c.tone,.2);
 assert.deepEqual(await f.settings.stop(),[]);const after=(await f.state.readSettings()).scenes;assert.equal(after.b.presence,undefined);assert.equal(after.c.tone,undefined);assert.equal(after.b.distanceSec,30);
}finally{await f.close();}});
test('scenario Stop does not wipe directions the operator typed during the run',async()=>{const f=await fixture();try{
 await f.settings.begin({runId:'rd'});await f.settings.apply({settings:{scenes:{a:{distanceSec:10}}}});
 await f.manual({scenes:{a:{continuous:'Operator direction',oneShot:'Once'}}});
 assert.deepEqual(await f.settings.stop(),[]);const after=(await f.state.snapshot()).settings;assert.equal(after.scenes.a.distanceSec,15);assert.equal(after.scenes.a.continuous,'Operator direction');assert.equal(after.scenes.a.oneShot,'Once');
}finally{await f.close();}});
