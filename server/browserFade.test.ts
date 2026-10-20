import test from 'node:test';
import assert from 'node:assert/strict';
import {completedBrowserFadeBatch} from './browserFade';
import type {CaptureEvent} from './events/captureEvents';

function row(count=3):CaptureEvent {
 const captureId='test-TSC-002-F004-ready',scope='test:ready',keys=['now','a','b','c'].slice(0,count+1);
 const images=Object.fromEntries(keys.map(k=>[k,'/captures/ready-'+k+'.png']));
 return {captureId,startedAt:'2026-10-19T00:00:00Z',endedAt:'2026-10-19T00:01:00Z',result:'completed',requestedCount:count,images,browserFollow:{scope,sourceRecordedAtMs:1},browserBatch:keys.map(k=>({id:captureId+':'+k,captureId,scope,sceneKey:k==='now'?'now':'gen_'+k,imageUrl:images[k],provenance:k==='now'?'actual':'generated',recordedAtMs:k==='now'?1:null,sourceRecordedAtMs:1,generatedAtMs:k==='now'?null:2,targetAtMs:k==='now'?null:3,caption:k}))};
}
test('one, two and three saved-scene batches have one stable completed trigger',()=>{
 for(const count of [1,2,3]){const r=row(count);assert.deepEqual(completedBrowserFadeBatch(r),{captureId:r.captureId,completedAtMs:Date.parse(r.endedAt!)});}
 const legacy=row();delete legacy.requestedCount;assert.ok(completedBrowserFadeBatch(legacy));
});
test('Each partials, failure, missing completion time and mismatched publications never trigger',()=>{
 for(const result of ['running','failed','cancelled'] as const){const r=row();r.result=result;assert.equal(completedBrowserFadeBatch(r),undefined);}
 for(const change of [(r:CaptureEvent)=>r.browserBatch!.pop(),(r:CaptureEvent)=>{r.endedAt=undefined;},(r:CaptureEvent)=>{r.endedAt='bad';},(r:CaptureEvent)=>{r.endedAt='2025-01-01T00:00:00Z';},(r:CaptureEvent)=>{r.browserBatch![1].captureId='other';},(r:CaptureEvent)=>{r.browserBatch![1].imageUrl='/captures/other.png';},(r:CaptureEvent)=>{r.browserBatch![1].scope='other';}]){const r=row();change(r);assert.equal(completedBrowserFadeBatch(r),undefined);}
});
