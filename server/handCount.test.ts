import test from 'node:test';import assert from 'node:assert/strict';import os from 'node:os';import path from 'node:path';
import {parseHandCount,countHands,handCounter} from './handCount';
const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.alloc(16)]);
test('valid worker JSON is parsed; count must match the boxes and boxes must stay inside the image',()=>{
 const ok=parseHandCount({status:'detected',count:3,hands:[{x:.1,y:.1,w:.1,h:.1,score:.9},{x:0,y:.2,w:.06,h:.1,score:.97},{x:.05,y:.5,w:.05,h:.1,score:.8}],detectorMs:312.4,method:'m'});
 assert.equal(ok.status,'detected');assert.equal(ok.count,3);assert.equal(ok.detectorMs,312);
 assert.deepEqual(parseHandCount({status:'no-hands',count:0,hands:[]}),{status:'no-hands',count:0,hands:[]});
 for(const bad of [null,'x',{status:'detected',count:2,hands:[{x:.1,y:.1,w:.1,h:.1}]},{status:'detected',count:0,hands:[]},{status:'no-hands',count:1,hands:[{x:.1,y:.1,w:.1,h:.1}]},{status:'detected',count:1,hands:[{x:.95,y:.1,w:.1,h:.1}]},{status:'detected',count:1,hands:[{x:.1,y:.1,w:0,h:.1}]},{status:'weird',count:0,hands:[]}])
  assert.equal(parseHandCount(bad).status,'error');
 assert.deepEqual(parseHandCount({status:'unavailable',hands:[],count:0}),{status:'unavailable',count:0,hands:[]});
});
test('missing interpreter or model is unavailable and non-image bytes are an error, without spawning',async()=>{
 const none=path.join(os.tmpdir(),'no-such-hand-python.exe');
 assert.equal((await handCounter.count(png,{python:none})).status,'unavailable');
 assert.equal((await handCounter.count(png,{model:path.join(os.tmpdir(),'no-such.task')})).status,'unavailable');
 assert.equal((await handCounter.count(Buffer.from('test'),{python:none})).status,'error');
});
test('countHands strips a data URL prefix and never throws when the counter fails',async t=>{
 let seen:Buffer|undefined;
 t.mock.method(handCounter,'count',async(b:Buffer)=>{seen=b;return {status:'no-hands',count:0,hands:[]};});
 await countHands('data:image/png;base64,'+png.toString('base64'));assert.ok(seen?.equals(png));
 t.mock.method(handCounter,'count',async()=>{throw Error('boom');});
 assert.equal((await countHands(png)).status,'error');
});
