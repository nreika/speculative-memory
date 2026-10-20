import test from 'node:test';
import assert from 'node:assert/strict';
import {tdBrowserSnapshot,selectTdBrowserRuns} from './tdBrowserFollow';
import type {CaptureEvent} from './events/captureEvents';
import {BrowserDisplayStore} from './browserDisplay';

test('recorded All partial failure never becomes Each publication after global mode changes',()=>{
 const old=row('old'),failed=row('failed',{startedAt:'2026-10-18T00:02:00Z',result:'failed'});
 failed.browserFollow!.updateMode='all';failed.browserBatch=failed.browserBatch!.slice(0,2);
 for(const current of ['each','all']as const)for(const screen of ['td-now','td-a','td-b','td-c']){
  const snapshot=tdBrowserSnapshot(screen,[old,failed],3000,{updateMode:current})!;assert.equal(snapshot.content?.captureId,old.captureId);assert.equal(snapshot.displayStatus?.state,'failed');
 }
});
test('recorded Each partial publication survives switching the current mode to All',()=>{
 const old=row('old'),next=row('each',{startedAt:'2026-10-18T00:02:00Z',result:'running'});
 next.browserFollow!.updateMode='each';next.browserBatch=next.browserBatch!.slice(0,2);
 for(const current of ['all','each']as const){assert.equal(tdBrowserSnapshot('td-a',[old,next],3000,{updateMode:current})?.content?.captureId,next.captureId);assert.equal(tdBrowserSnapshot('td-b',[old,next],3000,{updateMode:current})?.content?.captureId,old.captureId);}
});
test('complete captures publish under either recorded mode independently of current mode',()=>{
 for(const recorded of ['each','all']as const)for(const current of ['each','all']as const){const r=row('complete');r.browserFollow!.updateMode=recorded;for(const screen of ['td-now','td-a','td-b','td-c'])assert.equal(tdBrowserSnapshot(screen,[r],3000,{updateMode:current})?.content?.captureId,r.captureId);}
});
const TD_BROWSER_RUN='2f89a3be481943df9e97ab868092e2a3';
const row=(id='one',values:Partial<CaptureEvent>={}):CaptureEvent=>{
 const captureId='test-TSC-001-F001-'+id,scope='test:TSC-001:'+TD_BROWSER_RUN+':L1';
 return {captureId,source:'test',test:true,startedAt:'2026-10-18T00:00:00Z',endedAt:'2026-10-18T00:01:00Z',result:'completed',images:{now:'/captures/'+id+'-now.jpg',a:'/captures/'+id+'-a.png',b:'/captures/'+id+'-b.png',c:'/captures/'+id+'-c.png'},browserFollow:{testSceneId:'TSC-001',testRunId:TD_BROWSER_RUN,scope,sourceRecordedAtMs:100},browserBatch:['now','gen_a','gen_b','gen_c'].map(sceneKey=>({id:captureId+':'+sceneKey,captureId,sceneKey,scope,provenance:sceneKey==='now'?'actual':'generated',imageUrl:'/captures/'+id+'-'+(sceneKey==='now'?'now.jpg':sceneKey.slice(-1)+'.png'),recordedAtMs:sceneKey==='now'?100:null,sourceRecordedAtMs:100,generatedAtMs:sceneKey==='now'?null:2000,targetAtMs:sceneKey==='now'?null:1500,caption:sceneKey})),...values};
};
test('complete batch atomically updates all four screens, retaining source and target time',()=>{
 const a=row(),b=row('two',{startedAt:'2026-10-18T00:02:00Z'});
 for(const id of ['td-now','td-a','td-b','td-c']){const v=tdBrowserSnapshot(id,[a,b],3000)!;assert.equal(v.content?.captureId,b.captureId);assert.equal(v.content?.sourceRecordedAtMs,100);assert.equal(v.clock.worldNowMs,3000);assert.equal(v.content?.scope,b.browserFollow!.scope);}
 assert.equal(tdBrowserSnapshot('td-a',[a,b],3000)?.content?.targetAtMs,1500);
});
test('failed, running, and incomplete newest captures never mix their images with previous batch',()=>{
 for(const values of [{result:'failed',errorMessage:'fetch failed'},{result:'running'},{browserBatch:row('two').browserBatch!.slice(0,3)}] as Partial<CaptureEvent>[]){
  const a=row(),b=row('two',{startedAt:'2026-10-18T00:02:00Z',...values});
  for(const id of ['td-now','td-a','td-b','td-c']){const v=tdBrowserSnapshot(id,[a,b],3000)!;assert.equal(v.content?.captureId,a.captureId);assert.equal(v.displayStatus?.requestedCaptureId,b.captureId);assert.match(v.displayStatus?.userMessage??'',/前回/);}
 }
});
test('other run, scene, source, and comparison captures cannot enter TD stream',()=>{
 const a=row();for(const b of [row('two',{source:'mobile'}),row('two',{browserFollow:{...a.browserFollow!,testRunId:'other'}}),row('two',{browserFollow:{...a.browserFollow!,testSceneId:'TSC-002'}}),row('two',{captureId:'test-turbo-app-e2e-F012'})])assert.equal(tdBrowserSnapshot('td-a',[b],3000)?.content,null);
 assert.equal(tdBrowserSnapshot('a',[a],3000),undefined);
});
test('changed or unsafe image URLs, and mismatched lineage block publication',()=>{
 for(const mutate of [(r:CaptureEvent)=>r.images!.a='/captures/other.png',(r:CaptureEvent)=>r.browserBatch![1].imageUrl='/captures/../secret.png',(r:CaptureEvent)=>r.browserBatch![1].scope='other']){const r=row();mutate(r);assert.equal(tdBrowserSnapshot('td-a',[r],3000)?.content,null);assert.equal(tdBrowserSnapshot('td-a',[r],3000)?.displayStatus?.state,'failed');}
});
test('original time unknown remains unknown, and image identity survives target-time crossing',()=>{
 const r=row();r.browserBatch![0].recordedAtMs=null;r.browserBatch!.forEach(c=>c.sourceRecordedAtMs=null);
 assert.equal(tdBrowserSnapshot('td-now',[r],1000)?.temporalRelation,'unknown');
 const a=tdBrowserSnapshot('td-a',[r],1000)!,b=tdBrowserSnapshot('td-a',[r],3000)!;
 assert.equal(a.content?.id,b.content?.id);assert.equal(a.temporalRelation,'future');assert.equal(b.temporalRelation,'past');
});
test('TD snapshot provider does not need fixed registry files and continues after store recreation',async()=>{
 const rows=[row()];const make=()=>new BrowserDisplayStore({settingsFile:'unused-settings',contents:[],now:()=>3000,snapshotProvider:(id,now)=>tdBrowserSnapshot(id,rows,now)});
 assert.equal((await make().snapshot('td-b'))?.content?.captureId,rows[0].captureId);
 rows.push(row('two',{startedAt:'2026-10-18T00:02:00Z'}));
 assert.equal((await make().snapshot('td-b'))?.content?.captureId,rows[1].captureId);
});
const otherRun='11111111222233334444555555555555';
function inRun(r:CaptureEvent,run:string):CaptureEvent {
 const scope=`test:TSC-001:${run}:L1`;
 return {...r,browserFollow:{...r.browserFollow!,testRunId:run,scope},browserBatch:r.browserBatch?.map(c=>({...c,scope}))};
}
test('new valid run is selected without manual settings only after its complete batch exists',()=>{
 const old=row(),next=inRun(row('new',{startedAt:'2026-10-18T00:02:00Z'}),otherRun);
 for(const id of ['td-now','td-a','td-b','td-c']){
  const before=tdBrowserSnapshot(id,[old,{...next,result:'running'}],3000)!;
  assert.equal(before.content?.captureId,old.captureId);assert.equal(before.clock.scope,old.browserFollow!.scope);assert.match(before.displayStatus?.userMessage??'',/前セッション/);
  const after=tdBrowserSnapshot(id,[old,next],4000)!;
  assert.equal(after.content?.captureId,next.captureId);assert.equal(after.clock.scope,next.browserFollow!.scope);assert.equal(after.displayStatus?.userMessage,null);
 }
 assert.equal(selectTdBrowserRuns([old,next]).requestRun,otherRun);
 assert.equal(selectTdBrowserRuns([old,next]).selectedCompletedRun,otherRun);
});
test('new run failure/incomplete batch separates requested and completed run and retains old image scope',()=>{
 const old=row();
 for(const values of [{result:'failed'},{result:'cancelled'},{result:'completed',browserBatch:[]}] as Partial<CaptureEvent>[]){
  const next=inRun(row('new',{startedAt:'2026-10-18T00:02:00Z',...values}),otherRun);
  const selection=selectTdBrowserRuns([old,next]);assert.equal(selection.requestRun,otherRun);assert.equal(selection.selectedCompletedRun,TD_BROWSER_RUN);
  for(const id of ['td-now','td-a','td-b','td-c']){const v=tdBrowserSnapshot(id,[old,next],3000)!;assert.equal(v.content?.captureId,old.captureId);assert.equal(v.clock.scope,old.browserFollow!.scope);assert.match(v.displayStatus?.userMessage??'',/前セッション/);assert.equal(v.displayStatus?.state,'failed');}
 }
});
test('an old run completing late cannot roll back a newer completed request',()=>{
 const old=row('old',{startedAt:'2026-10-18T00:00:00Z',endedAt:'2026-10-18T00:10:00Z'});
 const next=inRun(row('new',{startedAt:'2026-10-18T00:02:00Z',endedAt:'2026-10-18T00:03:00Z'}),otherRun);
 for(const rows of [[old,next],[next,old]]){const chosen=selectTdBrowserRuns(rows);assert.equal(chosen.selectedCompletedRun,otherRun);assert.equal(chosen.requestRun,otherRun);assert.equal(tdBrowserSnapshot('td-a',rows,3000)?.content?.captureId,next.captureId);}
});
test('malformed ids and mismatched or capture-isolated scopes never take over the run',()=>{
 const old=row();
 for(const meta of [{testRunId:'bad-run'},{testRunId:otherRun},{testRunId:TD_BROWSER_RUN+'\n'},{scope:'capture:isolated'},{scope:`test:TSC-001:${TD_BROWSER_RUN}:L0`},{scope:`test:TSC-001:${TD_BROWSER_RUN}:L1:extra`},{scope:`test:TSC-002:${TD_BROWSER_RUN}:L1`},{scope:`test:TSC-001:${TD_BROWSER_RUN}:L9007199254740992`},{scope:`test:TSC-001:${TD_BROWSER_RUN}:L1\n`}]){
  const invalid=row('invalid',{startedAt:'2026-10-18T00:05:00Z',browserFollow:{...old.browserFollow!,...meta}});
  assert.equal(selectTdBrowserRuns([old,invalid]).latest?.captureId,old.captureId);
 }
});
test('a new run with no previous completed batch waits in its own scope without fabricated actual time',()=>{
 const r=inRun(row('new',{result:'running'}),otherRun),v=tdBrowserSnapshot('td-now',[r],3000)!;
 assert.equal(v.content,null);assert.equal(v.clock.scope,r.browserFollow!.scope);assert.equal(v.displayStatus?.state,'generating');assert.equal(selectTdBrowserRuns([r]).selectedCompletedRun,null);
});

function inScene(r:CaptureEvent,scene:'TSC-001'|'TSC-002'|'TSC-003'):CaptureEvent {
 const captureId=r.captureId.replace('TSC-001',scene),scope=r.browserFollow!.scope.replace('TSC-001',scene);
 return {...r,captureId,browserFollow:{...r.browserFollow!,testSceneId:scene,scope},browserBatch:r.browserBatch?.map(c=>({...c,id:c.id.replace('TSC-001',scene),captureId,scope}))};
}
test('genuine scene two and three captures commit all four screens with original temporal provenance',()=>{
 const first=row();
 for(const scene of ['TSC-002','TSC-003'] as const){
  const next=inScene(row(scene,{startedAt:'2026-10-18T00:02:00Z'}),scene);
  const selected=selectTdBrowserRuns([first,next]);assert.equal(selected.requestScene,scene);assert.equal(selected.selectedCompletedScene,scene);
  for(const id of ['td-now','td-a','td-b','td-c']){const v=tdBrowserSnapshot(id,[first,next],3000)!;assert.equal(v.content?.captureId,next.captureId);assert.equal(v.clock.scope,next.browserFollow!.scope);assert.equal(v.content?.sourceRecordedAtMs,100);assert.equal(v.content?.provenance,id==='td-now'?'actual':'generated');assert.equal(v.content?.targetAtMs,id==='td-now'?null:1500);}
 }
});
test('cycling scenes keeps the last complete batch through running/failed/partial scenes and ignores late prior completion',()=>{
 const old=inScene(row('old',{endedAt:'2026-10-18T00:12:00Z'}),'TSC-002');
 const next=inScene(inRun(row('new',{startedAt:'2026-10-18T00:02:00Z',endedAt:'2026-10-18T00:03:00Z'}),otherRun),'TSC-003');
 for(const values of [{result:'running'},{result:'failed'},{browserBatch:next.browserBatch!.slice(0,3)}] as Partial<CaptureEvent>[]){
  for(const id of ['td-now','td-a','td-b','td-c']){const snapshot=tdBrowserSnapshot(id,[old,{...next,...values}],4000)!;assert.equal(snapshot.content?.captureId,old.captureId);assert.equal(snapshot.clock.scope,old.browserFollow!.scope);assert.equal(snapshot.displayStatus?.requestedCaptureId,next.captureId);assert.ok(snapshot.displayStatus?.userMessage);}
 }
 for(const rows of [[old,next],[next,old]])assert.equal(tdBrowserSnapshot('td-a',rows,4000)?.content?.captureId,next.captureId);
});
test('scene metadata/capture/scope mixtures, unrelated comparisons, non-TD prefixes and non-test sources cannot take over',()=>{
 const old=row(),valid=inScene(row('next',{startedAt:'2026-10-18T00:05:00Z'}),'TSC-003');
 const bad=[
  {...valid,browserFollow:{...valid.browserFollow!,testSceneId:'TSC-002'}},
  {...valid,browserFollow:{...valid.browserFollow!,scope:valid.browserFollow!.scope.replace('TSC-003','TSC-002')}},
  {...valid,browserFollow:{...valid.browserFollow!,scope:undefined}as any},
  {...valid,captureId:'test-TSC-003-comparison'},
  {...valid,captureId:'test-TSC-004-F001-next'},
  {...valid,captureId:'test-turbo-app-e2e-F012'},
  {...valid,captureId:'comparison-test-TSC-003-F001'},
  {...valid,captureId:'test-TSC-003-F001-next\n'},
  {...valid,test:false},{...valid,source:'venue'},
 ] as CaptureEvent[];
 for(const invalid of bad)assert.equal(selectTdBrowserRuns([old,invalid]).latest?.captureId,old.captureId);
 const corruptBatch={...valid,browserBatch:valid.browserBatch!.map((c,i)=>i===2?{...c,scope:c.scope.replace('TSC-003','TSC-001')}:c)};
 assert.equal(selectTdBrowserRuns([old,corruptBatch]).selected?.captureId,old.captureId);
});

test('TD batch keeps explicit capture distances 15/30/110 or negative while legacy distance remains unknown',()=>{
 for(const distances of [[15,30,110],[-15,30,-110]]){
  const capture=row();capture.browserBatch!.forEach((c,index)=>{c.distanceSecSigned=index===0?null:distances[index-1];});
  assert.equal(tdBrowserSnapshot('td-now',[capture],3000)?.content?.distanceSecSigned,null);
  for(const [index,id]of ['td-a','td-b','td-c'].entries()){
   const content=tdBrowserSnapshot(id,[capture],3000)!.content!;assert.equal(content.distanceSecSigned,distances[index]);assert.equal(content.targetAtMs,1500);assert.equal(content.sourceRecordedAtMs,100);assert.equal(content.provenance,'generated');
  }
 }
 for(const id of ['td-now','td-a','td-b','td-c'])assert.equal(tdBrowserSnapshot(id,[row('legacy')],3000)?.content?.distanceSecSigned,null);
});


test('generated subtitle comes only from the exact archived instruction while NOW remains its recognition text',()=>{
 const capture=row();const original=JSON.stringify(capture);
 for(const id of ['td-a','td-b','td-c']){
  let calls=0;
  const v=tdBrowserSnapshot(id,[capture],3000,{instructionLookup:identity=>{calls++;return {...identity,plannedDescription:'30秒後、机の前の人物が立ち上がる。'};}})!;
  assert.equal(v.content?.caption,'30秒後、机の前の人物が立ち上がる。');assert.equal(calls,1);
 }
 assert.equal(tdBrowserSnapshot('td-now',[capture],3000,{instructionLookup:()=>{throw new Error('NOW must not need an instruction');}})?.content?.caption,'now');
 assert.equal(JSON.stringify(capture),original,'saved event/archive evidence is not changed');
});
test('missing or mismatched instruction never falls back to an image description or a different capture',()=>{
 const capture=row();capture.browserBatch![1].caption='人物が物を持っている。';
 for(const override of [{captureId:'test-other'},{sceneKey:'gen_b'},{imageUrl:'/captures/stale.png'},{plannedDescription:''},{plannedDescription:'   '}]){
  const v=tdBrowserSnapshot('td-a',[capture],3000,{instructionLookup:identity=>({...identity,plannedDescription:'別の指示',...override})})!;
  assert.equal(v.content?.caption,'生成指示を確認できません。');
 }
 for(const options of [{},{instructionLookup:()=>undefined},{instructionLookup:()=>{throw new Error('missing archive');}}])assert.equal(tdBrowserSnapshot('td-a',[capture],3000,options)?.content?.caption,'生成指示を確認できません。');
});
test('a new failed request looks up the actually selected old image, not the latest request instruction',()=>{
 const old=row('old');const failed=row('new',{startedAt:'2026-10-18T00:02:00Z',result:'failed'});
 let requested:any;
 const v=tdBrowserSnapshot('td-a',[old,failed],3000,{instructionLookup:identity=>{requested=identity;return {...identity,plannedDescription:'前回の保存画像に対応する指示'};}})!;
 assert.deepEqual(requested,{captureId:old.captureId,sceneKey:'gen_a',imageUrl:old.images!.a});
 assert.equal(v.content?.caption,'前回の保存画像に対応する指示');assert.equal(v.displayStatus?.requestedCaptureId,failed.captureId);assert.equal(v.content?.captureId,old.captureId);
});
test('instruction changes update the revision without changing image identity, scope or time',()=>{
 const capture=row();
 const snap=(plannedDescription:string)=>tdBrowserSnapshot('td-a',[capture],3000,{instructionLookup:identity=>({...identity,plannedDescription})})!;
 const a=snap('保存指示A'),b=snap('保存指示B');
 assert.notEqual(a.revision,b.revision);assert.equal(a.content?.id,b.content?.id);assert.equal(a.content?.imageUrl,b.content?.imageUrl);assert.deepEqual(a.clock,b.clock);assert.equal(a.content?.targetAtMs,b.content?.targetAtMs);
});


function partialRow(capture:CaptureEvent,scenes:string[],result:CaptureEvent['result']='running'):CaptureEvent {
 const browserBatch=capture.browserBatch!.filter(c=>scenes.includes(c.sceneKey!));
 const images={...capture.images};
 for(const [scene,key]of [['now','now'],['gen_a','a'],['gen_b','b'],['gen_c','c']] as const)if(!scenes.includes(scene))delete images[key];
 return {...capture,result,browserBatch,images};
}
test('each publishes NOW then A then B then C immediately, retaining the other scene images and scopes',()=>{
 const old=row('old'),next=inRun(row('next',{startedAt:'2026-10-18T00:02:00Z'}),otherRun);
 const screens=[['td-now','now'],['td-a','gen_a'],['td-b','gen_b'],['td-c','gen_c']];
 for(let n=0;n<=4;n++){
  const ready=screens.slice(0,n).map(x=>x[1]),partial=partialRow(next,ready);
  for(const [id,scene]of screens){
   const v=tdBrowserSnapshot(id,[old,partial],3000,{updateMode:'each'})!;
   const expected=ready.includes(scene)?next:old;
   assert.equal(v.content?.captureId,expected.captureId);assert.equal(v.clock.scope,expected.browserFollow!.scope);
   assert.equal(v.displayStatus?.requestedCaptureId,next.captureId);
   assert.equal(v.displayStatus?.state,ready.includes(scene)?'completed':'generating');
   assert.equal(v.content?.imageUrl,expected.images![scene==='now'?'now':scene.slice(-1) as 'a'|'b'|'c']);
  }
 }
});
test('all and omitted mode retain the previous complete batch through every partial running stage',()=>{
 const old=row('old'),next=row('next',{startedAt:'2026-10-18T00:02:00Z'});
 for(const mode of [undefined,'all'] as const)for(const scenes of [[],['now'],['now','gen_a'],['now','gen_a','gen_b'],['now','gen_a','gen_b','gen_c']]){
  const partial=partialRow(next,scenes);
  for(const id of ['td-now','td-a','td-b','td-c'])assert.equal(tdBrowserSnapshot(id,[old,partial],3000,{updateMode:mode})?.content?.captureId,old.captureId);
 }
 for(const id of ['td-now','td-a','td-b','td-c'])assert.equal(tdBrowserSnapshot(id,[old,next],3000,{updateMode:'all'})?.content?.captureId,next.captureId);
});
test('each retains saved successes after later scene failure and keeps the failed screen’s previous image',()=>{
 const old=row('old'),next=inRun(row('next',{startedAt:'2026-10-18T00:02:00Z'}),otherRun);
 for(const result of ['failed','cancelled','completed'] as const){
  const failed=partialRow(next,['now','gen_a'],result);
  for(const id of ['td-now','td-a']){const v=tdBrowserSnapshot(id,[old,failed],3000,{updateMode:'each'})!;assert.equal(v.content?.captureId,next.captureId);assert.equal(v.displayStatus?.state,'completed');}
  for(const id of ['td-b','td-c']){const v=tdBrowserSnapshot(id,[old,failed],3000,{updateMode:'each'})!;assert.equal(v.content?.captureId,old.captureId);assert.equal(v.clock.scope,old.browserFollow!.scope);assert.equal(v.displayStatus?.state,'failed');assert.match(v.displayStatus?.userMessage??'',/前セッション/);}
 }
});
test('each does not roll back a saved newer scene when an older capture completes late',()=>{
 const old=row('old',{endedAt:'2026-10-18T00:12:00Z'}),next=inScene(inRun(row('next',{startedAt:'2026-10-18T00:02:00Z'}),otherRun),'TSC-003');
 const partial=partialRow(next,['now','gen_b']);
 for(const rows of [[old,partial],[partial,old]]){
  assert.equal(tdBrowserSnapshot('td-b',rows,3000,{updateMode:'each'})?.content?.captureId,next.captureId);
  assert.equal(tdBrowserSnapshot('td-a',rows,3000,{updateMode:'each'})?.content?.captureId,old.captureId);
 }
});
test('each validates individual URL and lineage and never publishes duplicates or ineligible captures',()=>{
 const old=row('old'),next=partialRow(row('next',{startedAt:'2026-10-18T00:02:00Z'}),['now','gen_a']);
 const mutations=[(r:CaptureEvent)=>r.images!.a='/captures/other.png',(r:CaptureEvent)=>r.browserBatch![1].scope='other',(r:CaptureEvent)=>r.browserBatch![1].captureId=old.captureId,(r:CaptureEvent)=>r.browserBatch![1].imageUrl='/captures/../private.png',(r:CaptureEvent)=>r.browserBatch!.push({...r.browserBatch![1]}),(r:CaptureEvent)=>r.test=false,(r:CaptureEvent)=>r.source='venue',(r:CaptureEvent)=>r.browserFollow!.scope='capture:isolated'];
 for(const mutate of mutations){const bad=structuredClone(next);mutate(bad);assert.equal(tdBrowserSnapshot('td-a',[old,bad],3000,{updateMode:'each'})?.content?.captureId,old.captureId);}
});
test('each instruction lookup uses only the selected scene image and never changes NOW or temporal provenance',()=>{
 const old=row('old'),next=inRun(row('next',{startedAt:'2026-10-18T00:02:00Z'}),otherRun),partial=partialRow(next,['now','gen_a']);
 const original=JSON.stringify([old,partial]);
 for(const [id,capture]of [['td-a',next],['td-b',old]] as const){
  let seen:any;const v=tdBrowserSnapshot(id,[old,partial],3000,{updateMode:'each',instructionLookup:identity=>{seen=identity;return {...identity,plannedDescription:'保存された生成指示'};}})!;
  assert.equal(seen.captureId,capture.captureId);assert.equal(seen.sceneKey,id==='td-a'?'gen_a':'gen_b');assert.equal(seen.imageUrl,v.content?.imageUrl);assert.equal(v.content?.caption,'保存された生成指示');assert.equal(v.content?.sourceRecordedAtMs,100);assert.equal(v.content?.targetAtMs,1500);
 }
 assert.equal(tdBrowserSnapshot('td-now',[old,partial],3000,{updateMode:'each',instructionLookup:()=>{throw Error('NOW lookup forbidden');}})?.content?.caption,'now');
 assert.equal(JSON.stringify([old,partial]),original);
});
test('each with no previous capture waits per screen without fabricating an image or clock scope',()=>{
 const next=partialRow(inRun(row('new'),otherRun),['now']);
 assert.equal(tdBrowserSnapshot('td-now',[next],3000,{updateMode:'each'})?.content?.captureId,next.captureId);
 const a=tdBrowserSnapshot('td-a',[next],3000,{updateMode:'each'})!;assert.equal(a.content,null);assert.equal(a.displayStatus?.state,'generating');assert.equal(a.clock.scope,next.browserFollow!.scope);
});
