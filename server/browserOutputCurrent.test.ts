import test from'node:test';import assert from'node:assert/strict';import{browserOutputCurrent}from'./browserOutputCurrent';import type{CaptureEvent}from'./events/captureEvents';
const run='11111111222233334444555555555555';

test('recorded publication mode cannot be reinterpreted by a later global change for live or test captures',()=>{
 for(const testSource of [false,true])for(const recorded of ['all','each']as const)for(const current of ['all','each']as const){
  const old=event('old-fixed',0,testSource),next=event('partial-fixed',1,testSource);next.result='failed';next.browserBatch=next.browserBatch!.slice(0,2);next.browserFollow!.updateMode=recorded;
  const selected=browserOutputCurrent([old,next],3000,{updateMode:current});
  for(const key of ['now','a','b','c']as const){const wasSaved=key==='now'||key==='a';assert.equal(selected[key]?.content?.captureId,recorded==='each'&&wasSaved?next.captureId:old.captureId);assert.equal(selected[key]?.displayStatus?.state,recorded==='each'&&wasSaved?'completed':'failed');}
 }
});
test('complete four-image rows publish with fixed All or Each under both current modes',()=>{
 for(const testSource of [false,true])for(const recorded of ['all','each']as const)for(const current of ['all','each']as const){const r=event('complete-fixed',1,testSource);r.browserFollow!.updateMode=recorded;const selected=browserOutputCurrent([r],3000,{updateMode:current});for(const item of Object.values(selected))assert.equal(item?.content?.captureId,r.captureId);assert.equal(Object.keys(selected).length,4);}
});
test('Each publishes immediately but the same image gains one fade trigger only on batch completion',()=>{
 const r=event('fade-ready',1);r.browserFollow!.updateMode='each';r.result='running';
 const partial=browserOutputCurrent([r],3000).a!;assert.ok(partial.content);assert.equal(partial.fadeBatch,undefined);
 r.result='completed';r.endedAt='2026-10-18T00:02:00Z';
 const complete=browserOutputCurrent([r],3000).a!;assert.equal(complete.content?.id,partial.content?.id);assert.equal(complete.fadeBatch?.captureId,r.captureId);assert.notEqual(complete.revision,partial.revision);
 r.result='failed';assert.equal(browserOutputCurrent([r],3000).a?.fadeBatch,undefined);
});
function event(id:string,minute:number,isTest=false):CaptureEvent{
 const captureId=isTest?'test-TSC-001-F001-'+id:'td-'+id,scope=isTest?'test:TSC-001:'+run+':L1':'live';
 return{captureId,source:isTest?'test':'td-native',test:isTest||undefined,startedAt:`2026-10-18T00:${String(minute).padStart(2,'0')}:00Z`,result:'completed',browserFollow:{scope,sourceRecordedAtMs:100,...(isTest?{testSceneId:'TSC-001',testRunId:run}:{})},images:{now:'/captures/'+id+'-now.jpg',a:'/captures/'+id+'-a.png',b:'/captures/'+id+'-b.png',c:'/captures/'+id+'-c.png'},browserBatch:['now','gen_a','gen_b','gen_c'].map((sceneKey,i)=>({id:captureId+':'+sceneKey,captureId,sceneKey,scope,provenance:i===0?'actual':'generated',imageUrl:'/captures/'+id+'-'+(i===0?'now.jpg':sceneKey.slice(-1)+'.png'),recordedAtMs:i===0?100:null,sourceRecordedAtMs:100,generatedAtMs:i===0?null:200,targetAtMs:i===0?null:999999,distanceSecSigned:i===0?null:15,caption:sceneKey}))};
}
test('latest published live/test switches without relabeling source or replacing times',()=>{
 const oldTest=event('old-test',0,true),live=event('new-live',1),nextTest=event('new-test',2,true);
 for(const rows of [[oldTest,live],[live,oldTest]]){const c=browserOutputCurrent(rows,3000);for(const key of ['now','a','b','c']as const){assert.equal(c[key]?.content?.captureId,live.captureId);assert.equal(c[key]?.clock.scope,'live');assert.equal(c[key]?.content?.sourceRecordedAtMs,100);}}
 const c=browserOutputCurrent([oldTest,live,nextTest],3000);assert.equal(c.a?.content?.captureId,nextTest.captureId);assert.equal(c.a?.content?.provenance,'generated');assert.equal(c.a?.content?.targetAtMs,999999);assert.equal(c.now?.content?.recordedAtMs,100);assert.equal(c.a?.clock.scope,nextTest.browserFollow!.scope);
});
test('all requires complete four batch while each follows saved scenes and retains prior others',()=>{
 const previous=event('old',0,true),next:CaptureEvent={...event('partial',1),result:'running'};next.browserBatch=next.browserBatch!.slice(0,2);
 const all=browserOutputCurrent([previous,next],3000,{updateMode:'all'});for(const value of Object.values(all))assert.equal(value?.content?.captureId,previous.captureId);
 const each=browserOutputCurrent([previous,next],3000,{updateMode:'each'});assert.equal(each.now?.content?.captureId,next.captureId);assert.equal(each.a?.content?.captureId,next.captureId);assert.equal(each.b?.content?.captureId,previous.captureId);assert.equal(each.b?.displayStatus?.state,'generating');
 next.result='failed';assert.equal(browserOutputCurrent([previous,next],3000,{updateMode:'each'}).b?.displayStatus?.state,'failed');
});
test('mobile, test impersonation and mismatched lineage cannot take over live outputs',()=>{
 const previous=event('valid',0);for(const mutate of [(r:CaptureEvent)=>r.source='mobile',(r:CaptureEvent)=>r.test=true,(r:CaptureEvent)=>r.source='test',(r:CaptureEvent)=>r.browserFollow!.scope='test:fake',(r:CaptureEvent)=>r.browserFollow!.testSceneId='TSC-001',(r:CaptureEvent)=>r.images!.a='/captures/not-a.png',(r:CaptureEvent)=>r.browserBatch![1].scope='other']){const bad=event('bad',1);mutate(bad);assert.equal(browserOutputCurrent([previous,bad],3000).a?.content?.captureId,previous.captureId);}
});
test('unknown live recording/target times stay unknown and older late completion cannot roll back',()=>{
 const previous=event('older',0),next=event('newer',1);previous.endedAt='2026-10-18T00:30:00Z';next.browserBatch!.forEach(c=>{c.recordedAtMs=null;c.sourceRecordedAtMs=null;c.targetAtMs=null;});const result=browserOutputCurrent([next,previous],3000);assert.equal(result.a?.content?.captureId,next.captureId);assert.equal(result.now?.content?.recordedAtMs,null);assert.equal(result.a?.content?.targetAtMs,null);assert.equal(result.now?.temporalRelation,'unknown');assert.equal(result.a?.temporalRelation,'unknown');
});
test('G-24 skipped scene: the batch is still complete, NOW and generated scenes update, the skipped screen keeps the previous image without a fade or failure',()=>{
 for(const testSource of [false,true])for(const mode of ['all','each']as const){
  const old=event('prev',0,testSource);old.endedAt='2026-10-18T00:00:30Z';old.browserFollow!.updateMode=mode;
  const next=event('skip-b',1,testSource);next.endedAt='2026-10-18T00:01:30Z';next.browserFollow!.updateMode=mode;
  next.browserBatch=next.browserBatch!.filter(c=>c.sceneKey!=='gen_b');delete next.images!.b;next.skippedScenes=[{sceneKey:'gen_b',reason:'no_recent_activity'}];
  const c=browserOutputCurrent([old,next],5000,{updateMode:mode});
  for(const key of ['now','a','c']as const){assert.equal(c[key]?.content?.captureId,next.captureId,key+' '+mode);assert.equal(c[key]?.fadeBatch?.captureId,next.captureId);}
  assert.equal(c.b?.content?.captureId,old.captureId);assert.equal(c.b?.content?.imageUrl,old.images!.b);
  assert.equal(c.b?.fadeBatch?.captureId,old.captureId,'the kept image only carries its own (already shown) fade batch');
  if(!testSource){assert.equal(c.b?.displayStatus?.state,'completed');assert.equal(c.b?.displayStatus?.userMessage,null);}
  else assert.notEqual(c.b?.displayStatus?.state,'failed');
 }
});
test('G-24 all three scenes skipped: NOW (and /display/current-now) still publishes the new frame; A/B/C keep the previous images',async()=>{
 const {currentBrowserSnapshot}=await import('./currentBrowserDisplay');
 for(const testSource of [false,true])for(const mode of ['all','each']as const){
  const old=event('prev-all',0,testSource);old.endedAt='2026-10-18T00:00:30Z';old.browserFollow!.updateMode=mode;
  const next=event('skip-all',1,testSource);next.endedAt='2026-10-18T00:01:30Z';next.browserFollow!.updateMode=mode;
  next.browserBatch=next.browserBatch!.filter(c=>c.sceneKey==='now');delete next.images!.a;delete next.images!.b;delete next.images!.c;
  next.skippedScenes=(['gen_a','gen_b','gen_c']as const).map(sceneKey=>({sceneKey,reason:'no_recent_activity'}));
  const c=browserOutputCurrent([old,next],5000,{updateMode:mode});
  assert.equal(c.now?.content?.captureId,next.captureId,'now '+mode);assert.equal(c.now?.fadeBatch?.captureId,next.captureId);
  for(const key of ['a','b','c']as const){assert.equal(c[key]?.content?.captureId,old.captureId);assert.notEqual(c[key]?.displayStatus?.state,'failed');}
  assert.equal(currentBrowserSnapshot('current-now',[old,next],5000,{updateMode:mode})?.content?.captureId,next.captureId);
 }
});
