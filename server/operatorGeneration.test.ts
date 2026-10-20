import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {buildOperatorGenerationBody,createOperatorGeneration,type OperatorGenerationFrame,type OperatorGenerationSettings,type OperatorGenerationOptions} from './operatorGeneration';
const bytes=Buffer.from('pinned-original-test-bytes'),sha=createHash('sha256').update(bytes).digest('hex');
const frame=()=>({schema:1,image:'data:image/jpeg;base64,'+bytes.toString('base64'),sha256:sha,suggestedCaptureId:'test-TSC-001-F005-new',sourceParams:{test:true,source:'test',recordHistory:false,testSceneId:'TSC-001',testFrameId:'TSC-001-F005',testRunId:'0123456789abcdef0123456789abcdef',testLoop:1,testSourceStartedAt:'2026-10-16T00:00:00Z'},sourceFrame:{id:'TSC-001-F005',sha256:sha,width:1280,height:720,originalStartedAt:'2026-10-16T00:00:00Z'}} satisfies OperatorGenerationFrame);
const settings=():OperatorGenerationSettings=>({scenes:{a:{distanceSec:15,continuous:'continue A',oneShot:'once A'},b:{distanceSec:30,continuous:'stand',oneShot:''},c:{distanceSec:-110,continuous:'cheer',oneShot:'once C'}},presence:.7,tone:.4,vlmBackend:'local',imageBackend:'local',imageCount:1,notify:true,test:false,source:'browser'});
const cmd={requestId:'command-1',source:'manual' as const};
const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
function setup(extra:Partial<OperatorGenerationOptions>={}){let fetched=0,invoked=0,consumed=0;const bodies:any[]=[];const api=createOperatorGeneration({isBusy:()=>false,authorize:()=>{},readSettings:settings,fetchFrame:async()=>{fetched++;return frame();},invokeGenerate:async(body,accepted)=>{invoked++;bodies.push(body);await accepted();return {status:200,body:{captureId:body.captureId,count:3}};},consumeOneShot:()=>{consumed++;},now:()=>1792318000000,...extra});return {api,bodies,get fetched(){return fetched;},get invoked(){return invoked;},get consumed(){return consumed;}};}
test('whitelist flatten preserves replay scope and all scene instructions while enforcing three images and silent output',()=>{
 const body=buildOperatorGenerationBody(frame(),settings(),{prompts:{a:'scenario A',c:'scenario C'},scenarioControl:{version:1}},'2026-10-18T00:00:00Z');
 assert.equal(body.imageCount,3);assert.equal(body.test,true);assert.equal(body.source,'test');assert.equal(body.recordHistory,false);assert.equal(body.notify,false);assert.equal(body.notifyToSender,false);assert.equal(body.captureId,frame().suggestedCaptureId);assert.equal(body.testRunId,frame().sourceParams.testRunId);assert.equal(body.testLoop,1);
 assert.deepEqual(body.sceneDistancesSec,[15,30,-110]);assert.equal(body.presence,.7);assert.equal(body.tone,.4);assert.deepEqual(body.sceneExtras,{gen_a:'continue A / once A / scenario A',gen_b:'stand',gen_c:'cheer / once C / scenario C'});assert.deepEqual(body.scenarioControl,{version:1});assert.equal(body.sceneTime,'2026-10-18T00:00:00Z');assert.ok(Object.isFrozen(body));assert.ok(Object.isFrozen(body.sceneExtras));
});
test('invalid acquisition identity or bytes fail before invoking existing generation',async()=>{
 for(const mutate of [(f:any)=>f.sourceParams.test=false,(f:any)=>f.sourceParams.recordHistory=true,(f:any)=>f.sourceParams.testRunId='bad',(f:any)=>f.sourceFrame.sha256='0'.repeat(64),(f:any)=>f.sourceFrame.width=640,(f:any)=>f.sourceFrame.id='another',(f:any)=>f.image='data:image/jpeg;base64,AAAA',(f:any)=>f.suggestedCaptureId='live-id']){
  const f=frame();mutate(f);const s=setup({fetchFrame:async()=>f});await assert.rejects(s.api.generate(cmd));assert.equal(s.invoked,0);assert.equal(s.consumed,0);assert.equal(s.api.status().active,null);
 }
});
test('one request reserves before asynchronous acquisition; duplicate returns the same promise, different command conflicts',async()=>{
 const gate=deferred<OperatorGenerationFrame>();const s=setup({fetchFrame:()=>gate.promise});
 const first=s.api.generate(cmd),second=s.api.generate({...cmd});assert.equal(first,second);
 await assert.rejects(s.api.generate({...cmd,source:'timer'}),{statusCode:409,code:'REQUEST_ID_CONFLICT'});
 await assert.rejects(s.api.generate({requestId:'command-2',source:'manual'}),{statusCode:409,code:'GENERATION_BUSY'});
 gate.resolve(frame());await first;assert.equal(s.invoked,1);assert.equal(s.consumed,1);assert.deepEqual(await s.api.generate(cmd),await first);assert.equal(s.invoked,1);
});
test('settings are captured before frame wait and only accepted shots compare-and-clear their captured values',async()=>{
 const current=settings(),gate=deferred<OperatorGenerationFrame>(),started=deferred<void>();let consumed:any;
 const s=setup({readSettings:()=>current,readSettingsSnapshot:()=>({settings:current,settingsRevision:'r1',oneShotTokens:{a:'a1',c:'c1'}}),fetchFrame:()=>{started.resolve();return gate.promise;},consumeOneShot:value=>{consumed=value;}});
 const pending=s.api.generate(cmd);await started.promise;current.scenes.a.oneShot='NEW EDIT';current.scenes.b.distanceSec=99;assert.equal(consumed,undefined);gate.resolve(frame());await pending;
 assert.equal(s.bodies[0].executionSource,'manual');assert.equal(s.bodies[0].sceneExtras.gen_a,'continue A / once A');assert.equal(s.bodies[0].sceneDistancesSec[1],30);assert.equal(consumed.scenes.a,'once A');assert.equal(consumed.snapshotRevision,'r1');assert.equal(consumed.oneShotTokens.a,'a1');
});
test('busy checks before fetch and after fetch protect another capture without cancelling or consuming anything',async()=>{
 let busy=true;const before=setup({isBusy:()=>busy});await assert.rejects(before.api.generate(cmd),{statusCode:409});assert.equal(before.fetched,0);
 busy=false;const gate=deferred<OperatorGenerationFrame>(),started=deferred<void>();const after=setup({isBusy:()=>busy,fetchFrame:()=>{started.resolve();return gate.promise;}});
 const pending=after.api.generate(cmd);await started.promise;busy=true;gate.resolve(frame());await assert.rejects(pending,{statusCode:409});assert.equal(after.invoked,0);assert.equal(after.consumed,0);assert.equal(after.api.status().active,null);
});
test('failed acquisition releases the reservation but an identical request does not silently retry',async()=>{
 let calls=0;const s=setup({fetchFrame:async()=>{calls++;throw Error('source unavailable');}});await assert.rejects(s.api.generate(cmd),/source unavailable/);await assert.rejects(s.api.generate(cmd),/source unavailable/);assert.equal(calls,1);assert.equal(s.api.status().active,null);
 await assert.rejects(s.api.generate({requestId:'explicit-new-command',source:'manual'}));assert.equal(calls,2);
});
test('unconfirmed submissions never consume a shot or automatically resubmit, including malformed success responses',async()=>{
 for(const submit of [async()=>{throw Error('connection outcome unknown');},async()=>({status:200,body:{count:3}})]){
  let calls=0;const s=setup({invokeGenerate:async()=>{calls++;return submit();}});await assert.rejects(s.api.generate(cmd));await assert.rejects(s.api.generate(cmd));assert.equal(calls,1);assert.equal(s.consumed,0);
 }
});
test('accepted generation consumes once even when completion fails; rejection before acceptance does not consume',async()=>{
 const rejected=setup({invokeGenerate:async()=>({status:409,body:{busy:true}})});assert.equal((await rejected.api.generate(cmd)).status,409);assert.equal(rejected.consumed,0);
 const failed=setup({invokeGenerate:async(_body,accepted)=>{await accepted();await accepted();return {status:502,body:{error:'model failed'}};}});assert.equal((await failed.api.generate(cmd)).status,502);assert.equal(failed.consumed,1);await failed.api.generate(cmd);assert.equal(failed.consumed,1);
});
test('authorization runs before acquisition and again before submission; manual hold is not independently rejected',async()=>{
 const seen:string[]=[];const manual=setup({readSettings:()=>({...settings(),submissionHold:true}),authorize:command=>{seen.push(command.source);}});await manual.api.generate(cmd);assert.deepEqual(seen,['manual','manual']);
 const denied=setup({authorize:()=>{throw Object.assign(Error('Scenario owns input'),{statusCode:409});}});await assert.rejects(denied.api.generate(cmd));assert.equal(denied.fetched,0);assert.equal(denied.invoked,0);
 const gate=deferred<OperatorGenerationFrame>(),started=deferred<void>();let allowed=true;const changed=setup({authorize:()=>{if(!allowed)throw Error('Scenario stopped');},fetchFrame:()=>{started.resolve();return gate.promise;}});const p=changed.api.generate({requestId:'scenario-cue',source:'scenario',runId:'run-1',cueId:'cue-3'});await started.promise;allowed=false;gate.resolve(frame());await assert.rejects(p,/Scenario stopped/);assert.equal(changed.invoked,0);
});
test('explicit fresh live-camera frames preserve camera scope and acquisition time without test isolation',async()=>{
 const f:OperatorGenerationFrame={...frame(),suggestedCaptureId:'camera-1792318000000-1234abcd',sourceParams:{source:'live-camera',inputKind:'live-camera',sourceScope:'camera:main',capturedAt:'2026-10-18T00:00:00Z'},sourceFrame:{id:'camera:main',sha256:sha,width:1280,height:720}};
 const body=buildOperatorGenerationBody(f,settings(),undefined,'2026-10-18T00:00:01Z');assert.equal(body.test,false);assert.equal(body.recordHistory,true);assert.equal(body.sourceScope,'camera:main');assert.equal(body.capturedAt,'2026-10-18T00:00:00Z');assert.equal(body.testRunId,undefined);assert.equal(body.notify,false);assert.equal(body.imageCount,3);
 for(const patch of [{sourceScope:'live'},{sourceScope:'camera:other'},{test:true},{capturedAt:'2026-10-18T00:00:00'}])assert.throws(()=>buildOperatorGenerationBody({...f,sourceParams:{...f.sourceParams,...patch} as any},settings(),undefined,'2026-10-18T00:00:01Z'));
});
test('evicted full response bodies leave tombstones so an old request cannot execute again',async()=>{
 const s=setup({maxRemembered:1});await s.api.generate(cmd);await s.api.generate({requestId:'second-command',source:'manual'});await assert.rejects(s.api.generate(cmd),{code:'REQUEST_RETIRED'});assert.equal(s.invoked,2);
});
test('pending scenario receipt is frozen and acknowledged only at the generation acceptance boundary',async()=>{
 const scenario={prompts:{a:'scenario one shot'},receipt:{runId:'run-1',pending:['cue-2']}};
 const gate=deferred<OperatorGenerationFrame>(),started=deferred<void>();let acknowledged:any;let consumptions=0;
 const s=setup({readScenario:()=>scenario,fetchFrame:()=>{started.resolve();return gate.promise;},consumeOneShot:value=>{consumptions++;acknowledged=value.scenarioReceipt;}});
 const pending=s.api.generate(cmd);await started.promise;assert.equal(consumptions,0);scenario.receipt.pending.push('later-cue');gate.resolve(frame());await pending;
 assert.deepEqual(acknowledged,{runId:'run-1',pending:['cue-2']});assert.ok(Object.isFrozen(acknowledged));assert.ok(Object.isFrozen(acknowledged.pending));await s.api.generate(cmd);assert.equal(consumptions,1);
 const rejected=setup({readScenario:()=>scenario,invokeGenerate:async()=>({status:409,body:{busy:true}}),consumeOneShot:()=>{throw Error('Must not consume rejected scenario');}});assert.equal((await rejected.api.generate(cmd)).status,409);
});
test('combined instructions beyond the existing parser budget are rejected without submitting or consuming pending text',async()=>{
 const value=settings();value.scenes.a.continuous='x'.repeat(190);value.scenes.a.oneShot='lost pending shot';
 const s=setup({readSettings:()=>value});await assert.rejects(s.api.generate(cmd),{statusCode:400,code:'SCENE_INSTRUCTIONS_TOO_LONG'});assert.equal(s.invoked,0);assert.equal(s.consumed,0);
 value.scenes.a.continuous='x'.repeat(200);value.scenes.a.oneShot='';assert.equal(buildOperatorGenerationBody(frame(),value,undefined,'2026-10-18T00:00:00Z').sceneExtras.gen_a.length,200);
 assert.throws(()=>buildOperatorGenerationBody(frame(),value,{prompts:{a:'CSV instruction'}},'2026-10-18T00:00:00Z'),{code:'SCENE_INSTRUCTIONS_TOO_LONG'});
});
function imageScenario(mode='asset_only'){
 const chunk=(type:string,data:Buffer)=>{const c=Buffer.alloc(data.length+12);c.writeUInt32BE(data.length);c.write(type,4);data.copy(c,8);let crc=0xffffffff;for(const b of c.subarray(4,-4)){crc^=b;for(let i=0;i<8;i++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}c.writeUInt32BE((crc^0xffffffff)>>>0,c.length-4);return c;};
 const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
 const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,0,0,255,255]))),chunk('IEND',Buffer.alloc(0))]);
 return {version:1,scenarioId:'image-scenario',runId:'run-1',elapsedSec:3,cycle:0,cueIds:['image-cue'],sceneModes:{gen_a:mode},sceneElements:{gen_a:[{id:'card',image:'data:image/png;base64,'+png.toString('base64'),sourceRect:[0,0,1,1],targetRect:[.02,.79,.1,.13],fit:'contain',opacity:1,featherPx:8,instruction:''}]}};
}
test('asset-only versus existing action instructions is rejected before acquiring a frame or consuming either one-shot',async()=>{
 for(const field of ['continuous','oneShot','scenario'] as const){
  const value=settings();value.scenes.a.continuous='';value.scenes.a.oneShot='';if(field!=='scenario')value.scenes.a[field]='raise a hand';
  const scenario={prompts:field==='scenario'?{a:'raise a hand'}:{},scenarioControl:imageScenario(),receipt:{pending:['cue-1']}};
  const s=setup({readSettings:()=>value,readScenario:()=>scenario});await assert.rejects(s.api.generate(cmd),{statusCode:400,code:'INVALID_SCENARIO_CONTROL'});assert.equal(s.fetched,0);assert.equal(s.invoked,0);assert.equal(s.consumed,0);assert.equal(s.api.status().active,null);
 }
});
test('scenario syntax failure is rejected before input while compatible mixed-scene and people-and-assets controls pass',async()=>{
 const invalid=setup({readScenario:()=>({prompts:{},scenarioControl:{version:1}})});await assert.rejects(invalid.api.generate(cmd),{statusCode:400,code:'INVALID_SCENARIO_CONTROL'});assert.equal(invalid.fetched,0);
 const value=settings();value.scenes.a.continuous='';value.scenes.a.oneShot='';
 const asset=setup({readSettings:()=>value,readScenario:()=>({prompts:{b:'stand'},scenarioControl:imageScenario()})});await asset.api.generate(cmd);assert.equal(asset.invoked,1);assert.equal(asset.bodies[0].sceneExtras.gen_a,undefined);assert.match(asset.bodies[0].sceneExtras.gen_b,/stand/);
 const people=setup({readScenario:()=>({prompts:{a:'raise hand'},scenarioControl:imageScenario('people_and_assets')})});await people.api.generate(cmd);assert.equal(people.invoked,1);assert.match(people.bodies[0].sceneExtras.gen_a,/once A/);
});

const refA='11111111-1111-4111-8111-111111111111',refB='22222222-2222-4222-8222-222222222222';
test('scene references are IDs only, stable-unioned per scene and deeply frozen with the pinned body',()=>{
 const value=settings();value.scenes.a.continuousPersonReferenceIds=[refB,refA];value.scenes.a.oneShotPersonReferenceIds=[refA];value.scenes.c.oneShotPersonReferenceIds=[refB];
 const body=buildOperatorGenerationBody(frame(),value,undefined,'2026-10-18T00:00:00Z');assert.deepEqual(body.scenePersonReferences,{gen_a:[{contentId:refB,role:'add-person'},{contentId:refA,role:'add-person'}],gen_c:[{contentId:refB,role:'add-person'}]});assert.ok(Object.isFrozen(body.scenePersonReferences!.gen_a));
 value.scenes.a.continuousPersonReferenceIds.reverse();assert.equal(body.scenePersonReferences!.gen_a![0].contentId,refB);
 for(const bad of [[refA,refA.toUpperCase()],['bad-id'],Array.from({length:16},(_,i)=>`${String(i).padStart(8,'0')}-1111-4111-8111-111111111111`)]){const x=settings();x.scenes.a.oneShotPersonReferenceIds=bad;assert.throws(()=>buildOperatorGenerationBody(frame(),x,undefined,'2026-10-18T00:00:00Z'));}
});
test('reference preflight fails closed before submission and never consumes images for missing IDs or busy race',async()=>{
 const value=settings();value.scenes.a.oneShot='';value.scenes.a.oneShotPersonReferenceIds=[refA];
 const missing=setup({readSettings:()=>value});await assert.rejects(missing.api.generate(cmd),{code:'REFERENCE_PREFLIGHT_UNAVAILABLE'});assert.equal(missing.fetched,0);assert.equal(missing.consumed,0);
 const denied=setup({readSettings:()=>value,preflightPersonReferences:()=>{throw Object.assign(Error('Unknown upload reference'),{statusCode:400});}});await assert.rejects(denied.api.generate(cmd),/Unknown upload/);assert.equal(denied.invoked,0);assert.equal(denied.consumed,0);
 let busy=false;const changed=setup({readSettings:()=>value,isBusy:()=>busy,preflightPersonReferences:()=>{busy=true;}});await assert.rejects(changed.api.generate(cmd),{code:'GENERATION_BUSY'});assert.equal(changed.invoked,0);assert.equal(changed.consumed,0);
});
test('image-only one-shot is captured before frame wait and consumed only on accepted generation',async()=>{
 const value=settings();value.scenes.a.oneShot='';value.scenes.a.oneShotPersonReferenceIds=[refA];const gate=deferred<OperatorGenerationFrame>(),started=deferred<void>();let consumption:any;let checked=0;
 const s=setup({readSettingsSnapshot:()=>({settings:value,oneShotTokens:{a:'original-token'}}),fetchFrame:()=>{started.resolve();return gate.promise;},preflightPersonReferences:body=>{checked++;assert.equal((body.scenePersonReferences as any).gen_a[0].contentId,refA);},consumeOneShot:body=>{consumption=body;}});
 const pending=s.api.generate(cmd);await started.promise;value.scenes.a.oneShotPersonReferenceIds=[refB];gate.resolve(frame());await pending;
 assert.equal(checked,1);assert.deepEqual(consumption.personReferenceIds.a,[refA]);assert.equal(consumption.scenes.a,'');assert.equal(consumption.oneShotTokens.a,'original-token');assert.deepEqual(s.bodies[0].scenePersonReferences.gen_a,[{contentId:refA,role:'add-person'}]);
});
test('asset-only cannot silently discard pending add-person references',async()=>{
 const value=settings();value.scenes.a.continuous='';value.scenes.a.oneShot='';value.scenes.a.oneShotPersonReferenceIds=[refA];
 const s=setup({readSettings:()=>value,readScenario:()=>({prompts:{},scenarioControl:imageScenario()}),preflightPersonReferences:()=>{}});await assert.rejects(s.api.generate(cmd),{code:'INVALID_SCENARIO_CONTROL'});assert.equal(s.fetched,0);assert.equal(s.consumed,0);
});
