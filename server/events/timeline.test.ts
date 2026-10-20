import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CaptureEventStore,timelineRunKey,type CaptureEvent} from './captureEvents';
import {registerEventRoutes} from './routes';
const start='2026-10-18T15:00:00.000Z';
const event=(id:string,at=start,extra:Partial<CaptureEvent>={}):CaptureEvent=>({captureId:id,startedAt:at,result:'completed',...extra});
function fixture(events:CaptureEvent[]){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'event-timeline-')),file=path.join(dir,'events.jsonl');fs.writeFileSync(file,events.map(e=>JSON.stringify(e)).join('\n')+'\n');const store=new CaptureEventStore(file);return{store,file,close(){assert.ok(path.basename(dir).startsWith('event-timeline-'));fs.rmSync(dir,{recursive:true,force:true});}};}

test('same-time 2505 records paginate at limits 200 and 2000 without gaps, duplicates or stalled cursor',()=>{
 const rows=Array.from({length:2505},(_,i)=>event('capture-'+String(i).padStart(5,'0'))).reverse();const f=fixture(rows);try{
  for(const limit of [200,2000]){let cursor:string|undefined,all:string[]=[];const seen=new Set<string>();let count=0;
   do{const page=f.store.timeline({limit,cursor});assert.ok(page.events.length<=limit);assert.ok(page.runOrigins.length<=page.events.length);all.push(...page.events.map(e=>e.captureId));if(page.nextCursor){assert.ok(!seen.has(page.nextCursor));seen.add(page.nextCursor);}cursor=page.nextCursor??undefined;assert.ok(++count<20);}while(cursor);
   assert.equal(all.length,2505);assert.equal(new Set(all).size,2505);assert.deepEqual(all,rows.map(e=>e.captureId));
  }
 }finally{f.close();}
});
test('composite cursor uses numeric start and ordinal ID; append of newer rows does not duplicate next page',()=>{
 const f=fixture([event('A'),event('a'),event('z'),event('older','2026-10-18T14:00:00Z'),event('offset-equivalent','2026-10-19T00:00:00+09:00')]);try{
  const first=f.store.timeline({limit:2});assert.deepEqual(first.events.map(e=>e.captureId),['z','offset-equivalent']);
  fs.appendFileSync(f.file,JSON.stringify(event('newest','2026-10-18T16:00:00Z'))+'\n');const rest=f.store.timeline({limit:200,cursor:first.nextCursor!});assert.deepEqual(rest.events.map(e=>e.captureId),['a','A','older']);assert.equal(rest.nextCursor,null);
 }finally{f.close();}
});
test('origins use all records, return only page run keys and stay fixed while loading older pages',()=>{
 const runA='a'.repeat(32),runB='b'.repeat(32);const f=fixture([event('old','2026-10-18T10:00:00Z',{inputIdentity:{kind:'test',id:'frame',runId:runA}}),event('middle','2026-10-18T14:00:00Z',{browserFollow:{scope:'x',testRunId:runA,sourceRecordedAtMs:0}}),event('newest',start,{inputIdentity:{kind:'test',id:'frame',runId:runA},browserFollow:{scope:'x',testRunId:runB,sourceRecordedAtMs:1}}),event('other','2026-10-17T00:00:00Z',{inputIdentity:{kind:'test',id:'frame',runId:runB}})]);try{
  const first=f.store.timeline({limit:1}),second=f.store.timeline({limit:1,cursor:first.nextCursor!});const origin={key:'test:'+runA,startedAtMs:Date.parse('2026-10-18T10:00:00Z')};assert.deepEqual(first.runOrigins,[origin]);assert.deepEqual(second.runOrigins,[origin]);assert.equal(first.events[0].timelineRunKey,'test:'+runA);assert.ok(!('timelineRunKey'in f.store.get('newest')!));
 }finally{f.close();}
});
test('live and legacy session dates are JST and invalid times never create event rows or origins',()=>{
 assert.equal(timelineRunKey(event('x','2026-10-18T15:30:00Z',{source:'browser'})),'browser:2026-10-19');assert.equal(timelineRunKey(event('x','2026-10-18T14:30:00Z')),'legacy:2026-10-18');assert.equal(timelineRunKey(event('x',start,{source:'browser',browserFollow:{scope:'camera:main',sourceRecordedAtMs:0}})),'camera:main:2026-10-19');
 const f=fixture([event('invalid','nonsense'),event('valid')]);try{const page=f.store.timeline();assert.equal(page.events.length,1);assert.equal(page.runOrigins.length,1);}finally{f.close();}
});
test('query rejects malformed cursor, invalid limits and unsupported keys; empty store has null cursor',()=>{
 const f=fixture([]);try{
  for(const cursor of ['', 'x'.repeat(4097),'bad%token','____',Buffer.from(JSON.stringify([2,Date.now(),'id'])).toString('base64url'),Buffer.from(JSON.stringify([1,'not-time','id'])).toString('base64url')])assert.throws(()=>f.store.timeline({cursor}),(e:any)=>e.status===400);
  for(const limit of [0,2001,1.5,NaN,Infinity])assert.throws(()=>f.store.timeline({limit}),(e:any)=>e.status===400);
  assert.throws(()=>f.store.timeline({before:start}as any),(e:any)=>e.status===400);assert.deepEqual(f.store.timeline(),{schema:1,events:[],nextCursor:null,runOrigins:[]});
 }finally{f.close();}
});
test('valid maximum timestamp with JST shift overflow does not break the timeline page',()=>{
 const f=fixture([event('date-boundary','+275760-09-13T00:00:00.000Z'),event('normal')]);try{
  const first=f.store.timeline({limit:1});assert.equal(first.events[0].captureId,'date-boundary');assert.ok(first.events[0].timelineRunKey.startsWith('legacy:'));assert.ok(first.runOrigins[0].startedAtMs===8640000000000000);
  assert.equal(f.store.timeline({cursor:first.nextCursor!}).events[0].captureId,'normal');
 }finally{f.close();}
});
test('timeline never mutates readAll order or the existing query contract',()=>{
 const f=fixture([event('earlier','2026-10-18T12:00:00Z'),event('A'),event('z')]);try{const before=f.store.readAll().map(e=>e.captureId),query=f.store.query().map(e=>e.captureId);f.store.timeline({limit:1});assert.deepEqual(f.store.readAll().map(e=>e.captureId),before);assert.deepEqual(f.store.query().map(e=>e.captureId),query);assert.equal(f.store.readAll().some(e=>'timelineRunKey'in e),false);}finally{f.close();}
});
test('timeline route is registered ahead of captureId, validates only limit/cursor, and preserves existing route',()=>{
 const f=fixture([event('timeline')]);try{const gets=new Map<string,Function>(),order:string[]=[];const app={get:(route:string,fn:Function)=>{order.push(route);gets.set(route,fn);},post:()=>{}};registerEventRoutes(app as any,f.store);
  assert.ok(order.indexOf('/api/events/timeline')<order.indexOf('/api/events/:captureId'));
  const invoke=(query:any)=>{let status=200,body:any,cache='';const res:any={setHeader:(_k:string,v:string)=>cache=v,status:(s:number)=>{status=s;return res;},json:(v:any)=>{body=v;return res;}};gets.get('/api/events/timeline')!({query},res);return{status,body,cache};};
  const valid=invoke({limit:'1'});assert.equal(valid.status,200);assert.equal(valid.body.schema,1);assert.equal(valid.body.events[0].captureId,'timeline');assert.equal(valid.cache,'no-store');
  for(const query of [{group:'1'},{limit:['1','2']},{cursor:['a','b']},{limit:'1e3'},{limit:'0'},{cursor:'bad%token'}])assert.equal(invoke(query).status,400);
  assert.ok(gets.has('/api/events'));
 }finally{f.close();}
});
