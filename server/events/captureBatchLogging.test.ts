import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {captureBatchCounts,captureExecutionSource,captureInputIdentity,CaptureEventStore,type CaptureEvent} from './captureEvents';

function row(mode:'each'|'all'='each',result:CaptureEvent['result']='failed',saved=1,published=saved):CaptureEvent{
 const id='unit-batch',scope='unit-scope';
 const images={now:'/captures/unit-now.jpg',...Object.fromEntries(['a','b','c'].slice(0,saved).map(key=>[key,'/captures/unit-'+key+'.png']))};
 return{captureId:id,source:'td-native',startedAt:'2026-10-18T15:00:00Z',endedAt:'2026-10-18T15:01:00Z',result,batchLogVersion:1,requestedCount:3,images,browserFollow:{scope,sourceRecordedAtMs:null,updateMode:mode},browserBatch:[{id:id+':now',captureId:id,sceneKey:'now',scope,provenance:'actual',imageUrl:images.now,recordedAtMs:null,sourceRecordedAtMs:null,targetAtMs:null,generatedAtMs:null,caption:''},...['a','b','c'].slice(0,published).map(key=>({id:id+':gen_'+key,captureId:id,sceneKey:'gen_'+key,scope,provenance:'generated' as const,imageUrl:images[key],recordedAtMs:null,sourceRecordedAtMs:null,targetAtMs:null,generatedAtMs:100,caption:''}))]};
}
test('Each counts only published browserBatch members, distinct from saved files and NOW',()=>{
 const r=row('each','failed',2,1);r.images!.now='/captures/unit-now.jpg';assert.deepEqual(captureBatchCounts(r),{requestedCount:3,savedCount:2,publishedCount:1});
 r.browserBatch!.push({...r.browserBatch![1]},{...r.browserBatch![1],captureId:'foreign',sceneKey:'gen_b'},{...r.browserBatch![1],scope:'foreign',sceneKey:'gen_b'});assert.equal(captureBatchCounts(r).publishedCount,0);
});
test('All publishes only a completed full requested batch, never failure/cancel/running partials',()=>{
 for(const status of ['running','failed','cancelled']as const)for(const saved of [0,1,3])assert.equal(captureBatchCounts(row('all',status,saved)).publishedCount,0);
 assert.deepEqual(captureBatchCounts(row('all','completed',3)),{requestedCount:3,savedCount:3,publishedCount:3});assert.equal(captureBatchCounts(row('all','completed',2)).publishedCount,0);
});
test('cancellation preserves already published Each output without claiming full generation success',()=>{
 assert.deepEqual(captureBatchCounts(row('each','cancelled',1)),{requestedCount:3,savedCount:1,publishedCount:1});
});
test('publication counts follow actual selectors: NOW, URL, timestamp, duplicate and scope rejection',()=>{
 const cases:[(r:CaptureEvent)=>unknown,number][]=[[(r)=>r.browserBatch!.push({...r.browserBatch![1]}),0],[(r)=>r.browserBatch![1].id='',2],[(r)=>{r.images!.a=r.browserBatch![1].imageUrl='/captures/../secret.png';},2],[(r)=>r.browserBatch![1].generatedAtMs=NaN,2],[(r)=>r.browserFollow!.scope='test:fake',0]];
 for(const mode of ['all','each']as const)for(const [mutate,eachExpected]of cases){
  const r=row(mode,'completed',3);mutate(r);assert.equal(captureBatchCounts(r).publishedCount,mode==='all'?0:eachExpected);
 }
 const noNow=row('all','completed',3);noNow.browserBatch=noNow.browserBatch!.slice(1);assert.equal(captureBatchCounts(noNow).publishedCount,0);
 for(const count of [1,2]){const r=row('all','completed',count);r.requestedCount=count;assert.equal(captureBatchCounts(r).publishedCount,0);}
});
test('malformed publication metadata cannot stop logging or erase known saved/requested counts',()=>{
 const r=row('each','failed',1);r.browserBatch=[null]as any;assert.doesNotThrow(()=>captureBatchCounts(r));assert.equal(captureBatchCounts(r).savedCount,1);assert.equal(captureBatchCounts(r).requestedCount,3);
});
test('legacy counts and missing legacy mode stay unknown; no global-mode reinterpretation',()=>{
 const legacy=row();delete legacy.batchLogVersion;assert.deepEqual(captureBatchCounts(legacy),{requestedCount:null,savedCount:null,publishedCount:null});
 const noMode=row();delete noMode.browserFollow!.updateMode;assert.deepEqual(captureBatchCounts(noMode),{requestedCount:3,savedCount:1,publishedCount:null});
 const noRequested=row('all','completed',3);delete noRequested.requestedCount;assert.equal(captureBatchCounts(noRequested).publishedCount,null);
});
test('execution source is finite and input logs contain only safe identity metadata',()=>{
 for(const source of ['manual','timer','chain','scenario'])assert.equal(captureExecutionSource(source),source);
 for(const source of [undefined,null,'live-camera','private arbitrary text',{source:'manual'}])assert.equal(captureExecutionSource(source),'unknown');
 assert.deepEqual(captureInputIdentity({testSceneId:'TSC-002',testFrameId:'TSC-002-F008',testRunId:'f8f712bd288d4f65a3c6fc2e62e0fdee',testLoop:1,image:'PRIVATE_IMAGE',token:'PRIVATE_TOKEN'},true),{kind:'test',id:'TSC-002-F008',sceneId:'TSC-002',runId:'f8f712bd288d4f65a3c6fc2e62e0fdee',loop:1});
 assert.deepEqual(captureInputIdentity({testSceneId:'TSC-002',testFrameId:'data:image/jpeg;base64,PRIVATE',testRunId:'PRIVATE',testLoop:-1},true),{kind:'test',id:null,sceneId:'TSC-002'});
 assert.deepEqual(captureInputIdentity({sourceScope:'camera:main',image:'PRIVATE'},false),{kind:'live-camera',id:'camera:main'});
});
test('common finish writes versioned counts, terminal reason and full duration without mutating old source rows',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capture-batch-log-'));try{
  const store=new CaptureEventStore(path.join(dir,'events.jsonl'),path.join(dir,'display.jsonl'),path.join(dir,'no-usage.jsonl'));
  const started=row('all','running',0);delete started.endedAt;store.write(started);store.finish({...row('all','failed',1),errorStage:'sceneB',errorMessage:'identity rejected'});
  const result=store.get('unit-batch')!;assert.equal(result.totalMs,60000);assert.equal(result.savedCount,1);assert.equal(result.publishedCount,0);assert.equal(result.failureReason,'identity rejected');
  const raw=fs.readFileSync(store.filePath,'utf8').trim().split('\n').map(s=>JSON.parse(s));assert.equal(raw[0].result,'running');assert.equal(raw.length,2);
  store.finish({...row('each','completed',3),captureId:'legacy',batchLogVersion:undefined});assert.equal(store.get('legacy')!.savedCount,null);assert.equal(store.get('legacy')!.failureReason,null);
 }finally{assert.ok(path.basename(dir).startsWith('capture-batch-log-'));fs.rmSync(dir,{recursive:true,force:true});}
});
