import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {thumbName,thumbUrlForImage,createLimiter,createCaptureThumbs,type ThumbJob} from './captureThumbs';

function tmp(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capture-thumbs-'));return{dir,close(){assert.ok(path.basename(dir).startsWith('capture-thumbs-'));fs.rmSync(dir,{recursive:true,force:true});}};}
const fakeRunner=(calls:ThumbJob[][])=>async(jobs:ThumbJob[])=>{calls.push(jobs);for(const j of jobs)fs.writeFileSync(j.output,'thumb');};

test('thumb path mapping: top-level captures only, extension replaced with .jpg',()=>{
 assert.equal(thumbName('record_2026-10-20_14-57-23.jpg'),'record_2026-10-20_14-57-23.jpg');
 assert.equal(thumbName('Gen_a_2026-10-20_14-57-40.png'),'Gen_a_2026-10-20_14-57-40.jpg');
 assert.equal(thumbUrlForImage('/captures/Gen_b_2026-10-20_14-57-40.png'),'/captures/thumbs/Gen_b_2026-10-20_14-57-40.jpg');
 assert.equal(thumbUrlForImage('/captures/record_x.jpeg'),'/captures/thumbs/record_x.jpg');
 for(const bad of ['/captures/thumbs/record_x.jpg','/captures/qa_flagged/a.png','/captures/../x.png','/captures/a.png?x=1','/captures/a%2e.png','/captures/latest.json','https://x/captures/a.png','captures/a.png','/captures/.hidden.png',null,42])assert.equal(thumbUrlForImage(bad),null,String(bad));
 assert.equal(thumbName('..\\evil.png'),null);assert.equal(thumbName('notes.md'),null);
});

test('limiter never exceeds its concurrency and runs priority tasks first',async()=>{
 const limiter=createLimiter(2),order:string[]=[];let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const tasks=['a','b','c','d'].map(id=>limiter.run(async()=>{order.push(id);await gate;}));
 const urgent=limiter.run(async()=>{order.push('urgent');},true);
 await new Promise(r=>setImmediate(r));assert.deepEqual(order,['a','b']);assert.equal(limiter.stats().active,2);assert.equal(limiter.stats().pending,3);
 release();await Promise.all([...tasks,urgent]);
 assert.equal(order[2],'urgent');assert.equal(limiter.stats().maxObserved,2);assert.equal(limiter.stats().active,0);
});

test('capture-time enqueue writes thumbs in batches, dedupes and reports thumbUrl only once present',async()=>{
 const t=tmp();try{
  const calls:ThumbJob[][]=[];const thumbs=createCaptureThumbs({capturesDir:t.dir,runBatch:fakeRunner(calls),batchSize:2,log:()=>{}});
  await thumbs.ready;
  for(const n of ['record_1.jpg','Gen_a_1.png','Gen_b_1.png'])fs.writeFileSync(path.join(t.dir,n),'img');
  assert.equal(thumbs.thumbUrl('/captures/record_1.jpg'),null);
  thumbs.enqueue(path.join(t.dir,'record_1.jpg'));thumbs.enqueue(path.join(t.dir,'record_1.jpg'));thumbs.enqueue(path.join(t.dir,'Gen_a_1.png'));thumbs.enqueue(path.join(t.dir,'Gen_b_1.png'));
  thumbs.enqueue(path.join(t.dir,'qa_flagged','x.png'));// outside captures/ top level: ignored
  await thumbs.idle();
  assert.equal(calls.flat().length,3);assert.ok(calls.every(c=>c.length<=2));
  assert.equal(thumbs.thumbUrl('/captures/Gen_a_1.png'),'/captures/thumbs/Gen_a_1.jpg');assert.ok(fs.existsSync(path.join(t.dir,'thumbs','Gen_a_1.jpg')));
  assert.equal(thumbs.diagnostics().generated,3);
  // A new instance learns existing thumbs from disk without regenerating them.
  const again=createCaptureThumbs({capturesDir:t.dir,runBatch:fakeRunner(calls),log:()=>{}});await again.ready;assert.equal(again.thumbUrl('/captures/record_1.jpg'),'/captures/thumbs/record_1.jpg');
 }finally{t.close();}
});

test('on-miss requests fill gradually, wait while busy, skip missing sources and log failures once',async()=>{
 const t=tmp();try{
  let busy=true;const calls:ThumbJob[][]=[];const logs:string[]=[];
  const thumbs=createCaptureThumbs({capturesDir:t.dir,runBatch:fakeRunner(calls),busy:()=>busy,busyRetryMs:5,log:l=>logs.push(l)});await thumbs.ready;
  fs.writeFileSync(path.join(t.dir,'record_old.jpg'),'img');
  thumbs.requestMissing('/captures/record_old.jpg');thumbs.requestMissing('/captures/record_gone.jpg');
  await new Promise(r=>setTimeout(r,30));assert.equal(calls.length,0,'waits while a capture is active');
  busy=false;await thumbs.idle();assert.equal(calls.flat().length,1);assert.equal(thumbs.thumbUrl('/captures/record_old.jpg'),'/captures/thumbs/record_old.jpg');
  const failing=createCaptureThumbs({capturesDir:t.dir,runBatch:async()=>{throw Error('no PIL');},log:l=>logs.push(l)});await failing.ready;
  for(const n of ['record_a.jpg','record_b.jpg']){fs.writeFileSync(path.join(t.dir,n),'img');failing.enqueue(path.join(t.dir,n));}
  await failing.idle();failing.enqueue(path.join(t.dir,'record_a.jpg'));await failing.idle();
  assert.equal(logs.filter(l=>l.includes('no PIL')).length,1);assert.equal(failing.thumbUrl('/captures/record_a.jpg'),null);
  failing.requestMissing('/captures/record_a.jpg');assert.equal(failing.diagnostics().queued,0,'known failures are not re-queued on miss');
 }finally{t.close();}
});
