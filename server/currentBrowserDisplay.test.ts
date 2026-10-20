import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {currentBrowserSnapshot} from './currentBrowserDisplay';
import {tdBrowserSnapshot} from './tdBrowserFollow';
import {BrowserDisplayStore,type BrowserDisplayContent} from './browserDisplay';
import type {CaptureEvent} from './events/captureEvents';
const run='a'.repeat(32);
function event(id:string,minute:number,test=false):CaptureEvent {
 const captureId=test?'test-TSC-001-F001-'+id:'live-'+id,scope=test?'test:TSC-001:'+run+':L1':'camera:main';
 const images={now:'/captures/'+id+'-now.jpg',a:'/captures/'+id+'-a.png',b:'/captures/'+id+'-b.png',c:'/captures/'+id+'-c.png'};
 return{captureId,source:test?'test':'td-native',test:test||undefined,startedAt:`2026-10-19T00:${String(minute).padStart(2,'0')}:00Z`,result:'completed',images,browserFollow:{scope,sourceRecordedAtMs:100,updateMode:'each',...(test?{testSceneId:'TSC-001',testRunId:run}:{})},browserBatch:['now','a','b','c'].map((key,index)=>({id:captureId+':'+key,captureId,sceneKey:key==='now'?'now':'gen_'+key,scope,provenance:index===0?'actual':'generated',imageUrl:images[key],recordedAtMs:index===0?100:null,sourceRecordedAtMs:100,targetAtMs:index===0?null:500,generatedAtMs:index===0?null:200,distanceSecSigned:index===0?null:30,caption:key}))};
}
test('fixed current source/A/B/C follow newest live and test without changing scene identity',()=>{
 const old=event('old-test',1,true),live=event('live',2),newTest=event('new-test',3,true);
 for(const [rows,expected]of [[[old,live],live],[[old,live,newTest],newTest]]as [CaptureEvent[],CaptureEvent][]){
  for(const key of ['now','a','b','c']){const id='current-'+key,s=currentBrowserSnapshot(id,rows,500)!;assert.equal(s.screen.id,id);assert.equal(s.content?.captureId,expected.captureId);assert.equal(s.content?.sceneKey,key==='now'?'now':'gen_'+key);}
 }
 // Existing TD namespace remains test-only, whereas current-c accepts live.
 assert.equal(tdBrowserSnapshot('td-c',[old,live],500)?.content?.captureId,old.captureId);assert.equal(currentBrowserSnapshot('current-c',[old,live],500)?.content?.captureId,live.captureId);
});
test('Each and All use captured publication mode, retain old C during partials, and publish exact captions',()=>{
 const old=event('old',1),partial=event('partial',2);partial.result='failed';partial.browserBatch=partial.browserBatch!.slice(0,2);
 partial.browserFollow!.updateMode='all';for(const key of ['now','a','b','c'])assert.equal(currentBrowserSnapshot('current-'+key,[old,partial],500,{updateMode:'each'})?.content?.captureId,old.captureId);
 partial.browserFollow!.updateMode='each';assert.equal(currentBrowserSnapshot('current-a',[old,partial],500,{updateMode:'all'})?.content?.captureId,partial.captureId);assert.equal(currentBrowserSnapshot('current-c',[old,partial],500)?.content?.captureId,old.captureId);
 const c=currentBrowserSnapshot('current-c',[old],500,{instructionLookup:identity=>({...identity,plannedDescription:'Exact C instruction'})})!;assert.equal(c.content?.caption,'Exact C instruction');assert.notEqual(c.revision,tdBrowserSnapshot('td-c',[event('test',1,true)],500)?.revision);
});
test('recognized aliases wait with content null; unknown IDs are unsupported',()=>{
 for(const id of ['current-now','current-a','current-b','current-c']){const s=currentBrowserSnapshot(id,[],500)!;assert.equal(s.content,null);assert.equal(s.clock.known,false);assert.equal(s.temporalRelation,'unknown');assert.equal(s.displayStatus?.state,'idle');}
 for(const id of ['c','td-c','current-C','current-z','__proto__'])assert.equal(currentBrowserSnapshot(id,[],500),undefined);
});
test('current aliases carry saved view settings without changing image identity, including waiting',()=>{
 const rows=[event('view',2)],view={visible:false,labels:false,subtitles:true,fade:false};
 for(const id of ['current-now','current-a','current-b','current-c']){
  const initial=currentBrowserSnapshot(id,rows,500)!;
  const snapshot=currentBrowserSnapshot(id,rows,500,{view})!;
  assert.deepEqual(snapshot.view,view);assert.notEqual(snapshot.view,view);
  assert.equal(snapshot.content?.id,initial.content?.id);assert.notEqual(snapshot.revision,initial.revision);
  assert.deepEqual(currentBrowserSnapshot(id,[],500,{view})?.view,view);
  const on=currentBrowserSnapshot(id,rows,500,{view:{...view,fade:true}})!;
  assert.notEqual(on.revision,snapshot.revision);assert.equal(on.content?.id,snapshot.content?.id);
 }
});
test('current aliases never read or alter old pinned comparison settings, including waiting fallback',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'current-browser-alias-')),file=path.join(dir,'settings.json');
 try{
  const pinned:BrowserDisplayContent={id:'old-2511',scope:'comparison',provenance:'generated',imageUrl:'/captures/old2511.png',targetAtMs:null,recordedAtMs:null,generatedAtMs:1,sourceRecordedAtMs:null,caption:'Old comparison'};
  const screen=(id:string)=>({id,label:id,accent:'#397ad1',clock:{serverAnchorMs:0,worldAnchorMs:0,rate:1,scope:'comparison'},selection:{mode:'pinned',contentId:pinned.id}});
  const settings=JSON.stringify({schema:1,screens:[screen('c'),screen('current-c')]});await fs.writeFile(file,settings);
  let rows:CaptureEvent[]=[];const store=new BrowserDisplayStore({settingsFile:file,contents:[pinned],now:()=>500,snapshotProvider:(id,now)=>currentBrowserSnapshot(id,rows,now)??tdBrowserSnapshot(id,rows,now)});
  assert.equal((await store.snapshot('c'))?.content?.id,pinned.id);assert.equal((await store.snapshot('current-c'))?.content,null);
  rows=[event('new-live',2)];assert.equal((await store.snapshot('current-c'))?.content?.captureId,rows[0].captureId);assert.equal((await store.snapshot('c'))?.content?.id,pinned.id);assert.equal(await fs.readFile(file,'utf8'),settings);
 }finally{assert.ok(path.basename(dir).startsWith('current-browser-alias-'));await fs.rm(dir,{recursive:true,force:true});}
});
