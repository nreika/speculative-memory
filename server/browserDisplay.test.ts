import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {buildBrowserDisplaySnapshot as snapshot,validateBrowserDisplayContents,validateBrowserDisplaySettings,isBrowserDisplayImageUrl,registerBrowserDisplayRoutes,BrowserDisplayStore,type BrowserDisplayContent,type BrowserDisplayScreen} from './browserDisplay';
const item=(id:string,values:Partial<BrowserDisplayContent>={}):BrowserDisplayContent=>({id,scope:'run-a',provenance:'generated',imageUrl:'/captures/image.png',targetAtMs:2000,recordedAtMs:null,generatedAtMs:500,sourceRecordedAtMs:100,caption:'説明',...values});
const screen=(values:Partial<BrowserDisplayScreen>={}):BrowserDisplayScreen=>({id:'future',label:'未来',accent:'#c34',clock:{serverAnchorMs:1000,worldAnchorMs:1000,rate:1,scope:'run-a'},selection:{mode:'pinned',contentId:'fixed'},...values});

test('uploaded images remain untimed and never enter actual or generated history',()=>{
 const upload=item('fixed',{provenance:'uploaded',targetAtMs:null,recordedAtMs:null,generatedAtMs:null,sourceRecordedAtMs:null});
 const [validated]=validateBrowserDisplayContents([upload]);
 const pinned=snapshot(screen(),[validated],3000);
 assert.equal(pinned.content?.provenance,'uploaded');assert.equal(pinned.temporalRelation,'unknown');
 assert.equal(snapshot(screen({selection:{mode:'recorded-offset',offsetMs:0}}),[validated],3000).content,null);
 assert.equal(snapshot(screen({selection:{mode:'latest-generated'}}),[validated],3000).content,null);
 assert.throws(()=>validateBrowserDisplayContents([{...upload,recordedAtMs:100}]),/Uploaded image times/);
 assert.throws(()=>validateBrowserDisplayContents([{...upload,distanceSecSigned:30}]),/explicit scene distance/);
});
test('pinned generated identity remains fixed while target moves future to past',()=>{
 const registry=[item('fixed'),item('newer',{generatedAtMs:1400})],s=screen();const a=snapshot(s,registry,1500),b=snapshot(s,registry,2500);
 assert.equal(a.content?.id,'fixed');assert.equal(b.content?.id,'fixed');assert.equal(a.temporalRelation,'future');assert.equal(b.temporalRelation,'past');assert.notEqual(a.revision,b.revision);
 assert.equal(b.content?.provenance,'generated');assert.equal(b.content?.recordedAtMs,null);
});
test('scope separates identical-looking scenes and missing pin never falls back',()=>{
 const r=snapshot(screen(),[item('fixed',{scope:'run-b'}),item('other')],1000);assert.equal(r.content,null);assert.equal(r.selectionStatus,'content-missing');
});
test('recorded offset selects only actual record at or before world offset',()=>{
 const s=screen({selection:{mode:'recorded-offset',offsetMs:200}});
 const r=snapshot(s,[item('old',{provenance:'actual',recordedAtMs:700}),item('right',{provenance:'actual',recordedAtMs:800}),item('later',{provenance:'actual',recordedAtMs:801}),item('generated',{recordedAtMs:790}),item('other-scope',{scope:'run-b',provenance:'actual',recordedAtMs:800})],1000);
 assert.equal(r.content?.id,'right');assert.equal(r.temporalRelation,'past');
});
test('missing actual time is unknown, not replaced with generation or source time',()=>{
 const r=snapshot(screen({selection:{mode:'recorded-offset',offsetMs:0}}),[item('unknown',{provenance:'actual',recordedAtMs:null,generatedAtMs:1,sourceRecordedAtMs:2})],1000);
 assert.equal(r.content,null);assert.equal(r.selectionStatus,'time-unknown');assert.equal(r.temporalRelation,'unknown');
});
test('latest generated uses generated timestamp only and scope',()=>{
 const r=snapshot(screen({selection:{mode:'latest-generated'}}),[item('a'),item('b',{generatedAtMs:700,targetAtMs:100}),item('unknown',{generatedAtMs:null,targetAtMs:10000}),item('actual',{provenance:'actual',generatedAtMs:900}),item('alien',{scope:'run-b',generatedAtMs:1000})],1200);assert.equal(r.content?.id,'b');
});
test('clock rate and anchor are explicit and target null remains unknown',()=>{
 const s=screen({clock:{serverAnchorMs:1000,worldAnchorMs:5000,rate:2,scope:'run-a'}}),r=snapshot(s,[item('fixed',{targetAtMs:null})],1250);
 assert.equal(r.clock.worldNowMs,5500);assert.equal(r.temporalRelation,'unknown');assert.equal(r.content?.sourceRecordedAtMs,100);
});
test('image URL rejects external/private/traversal/query and accepts public image paths',()=>{
 for(const url of ['https://a/image.png','//a/image.png','C:\\private.png','/other/a.png','/captures/../a.png','/captures/%2e%2e/a.png','/captures/%252e%252e/a.png','/captures/a.png?x=1','/captures/a.svg','/captures/a\\b.png','/captures//a.png','/captures/%0a.png'])assert.equal(isBrowserDisplayImageUrl(url),false,url);
 assert.equal(isBrowserDisplayImageUrl('/captures/comparisons/example/image%20a.png'),true);
});
test('validators whitelist content fields and reject duplicate ids/guessed missing times',()=>{
 const clean=validateBrowserDisplayContents([{...item('a'),privatePath:'C:/private/photo.jpg'}]);assert.equal('privatePath' in clean[0],false);
 assert.throws(()=>validateBrowserDisplayContents([item('a'),item('a')]),/Invalid/);
 const bad:any=item('a');delete bad.recordedAtMs;assert.throws(()=>validateBrowserDisplayContents([bad]),/Invalid/);
 assert.throws(()=>validateBrowserDisplaySettings({schema:1,screens:[screen(),screen()]}),/Invalid/);
 assert.throws(()=>validateBrowserDisplaySettings({schema:1,screens:[screen({accent:'url(secret)'})]}),/Invalid/);
});
class MockResponse extends EventEmitter {
 code=200;headers:any={};body:any;chunks:string[]=[];writableEnded=false;
 status(v:number){this.code=v;return this;}setHeader(k:string,v:string){this.headers[k]=v;return this;}json(v:any){this.body=v;return this;}
 flushHeaders(){}write(v:string){this.chunks.push(v);return true;}end(){this.writableEnded=true;this.emit('close');return this;}
}
async function fixture(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'browser-display-')),settingsFile=path.join(dir,'screens.json');await fs.writeFile(settingsFile,JSON.stringify({schema:1,screens:[screen()]}));return {dir,settingsFile};}
test('persisted settings survive store recreation; invalid replacement never serves stale config',async()=>{
 const f=await fixture();try{
  const options={settingsFile:f.settingsFile,contents:[item('fixed')],now:()=>1000};assert.equal((await new BrowserDisplayStore(options).snapshot('future'))?.content?.id,'fixed');assert.equal((await new BrowserDisplayStore(options).snapshot('absent')),null);
  const store=new BrowserDisplayStore(options);await store.snapshot('future');await fs.writeFile(f.settingsFile,'invalid replacement json');await assert.rejects(store.snapshot('future'));
 }finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
test('snapshot route hides configuration paths on error and returns explicit 404',async()=>{
 const f=await fixture(),routes=new Map<string,any>();const api=registerBrowserDisplayRoutes({get:(p,h)=>routes.set(p,h)} as any,{settingsFile:f.settingsFile,contents:[item('fixed')],now:()=>1000});
 try{const handle=routes.get('/api/displays/:screenId'),ok=new MockResponse();await handle({params:{screenId:'future'}},ok);assert.equal(ok.body.schema,1);assert.equal(ok.headers['Cache-Control'],'no-store');
  const missing=new MockResponse();await handle({params:{screenId:'missing'}},missing);assert.equal(missing.code,404);
  await fs.writeFile(f.settingsFile,'bad private path');const bad=new MockResponse();await handle({params:{screenId:'future'}},bad);assert.equal(bad.code,503);assert.deepEqual(bad.body,{error:'display_configuration_unavailable'});
 }finally{api.close();await fs.rm(f.dir,{recursive:true,force:true});}
});
test('SSE sends initial snapshot and clock heartbeat, transition snapshot, then stops after close',async()=>{
 const f=await fixture(),routes=new Map<string,any>();let now=1500;const api=registerBrowserDisplayRoutes({get:(p,h)=>routes.set(p,h)} as any,{settingsFile:f.settingsFile,contents:[item('fixed')],now:()=>now,heartbeatMs:50});const res=new MockResponse();
 try{await routes.get('/api/displays/:screenId/events')({params:{screenId:'future'}},res);assert.match(res.chunks[0],/^event: snapshot/);now=2500;await sleep(85);assert.ok(res.chunks.some(s=>s.startsWith('event: heartbeat')));assert.ok(res.chunks.some(s=>s.includes('"temporalRelation":"past"')));res.end();const n=res.chunks.length;await sleep(70);assert.equal(res.chunks.length,n);}
 finally{api.close();await fs.rm(f.dir,{recursive:true,force:true});}
});

test('client closing during initial read does not leave a stream timer',async()=>{
 const f=await fixture(),routes=new Map<string,any>();const api=registerBrowserDisplayRoutes({get:(p,h)=>routes.set(p,h)} as any,{settingsFile:f.settingsFile,contents:async()=>{await sleep(20);return [item('fixed')];},now:()=>1000,heartbeatMs:50});const res=new MockResponse();
 try{const running=routes.get('/api/displays/:screenId/events')({params:{screenId:'future'}},res);res.end();await running;await sleep(70);assert.equal(res.chunks.length,0);}
 finally{api.close();await fs.rm(f.dir,{recursive:true,force:true});}
});

test('explicit failure status preserves pinned published content and separates requested/displayed lineage',async()=>{
 const f=await fixture();let failed=false;
 try{const store=new BrowserDisplayStore({settingsFile:f.settingsFile,contents:[item('fixed',{captureId:'last-success',sceneKey:'gen_a'})],now:()=>1500,statusProvider:()=>({requestedCaptureId:failed?'failed-new':'last-success',displayedCaptureId:'last-success',state:failed?'failed':'completed',error:failed?'TURBO_COMPOSITION_UNKNOWN':null,userMessage:failed?'今回表示不可・前回画像を表示中':null,lastSuccessAtMs:1000})});
  const good=await store.snapshot('future');failed=true;const bad=await store.snapshot('future');assert.equal(bad?.content?.id,good?.content?.id);assert.equal(bad?.content?.captureId,'last-success');assert.equal(bad?.displayStatus?.requestedCaptureId,'failed-new');assert.equal(bad?.displayStatus?.displayedCaptureId,'last-success');assert.equal(bad?.displayStatus?.state,'failed');assert.notEqual(bad?.revision,good?.revision);
 }finally{await fs.rm(f.dir,{recursive:true,force:true});}
});

test('explicit signed capture distance is retained independently of historical target timestamps',()=>{
 for(const distanceSecSigned of [15,30,110,-25,-110,0]){
  const source=item('distance',{distanceSecSigned,targetAtMs:999999,sourceRecordedAtMs:100});
  const validated=validateBrowserDisplayContents([source])[0];assert.equal(validated.distanceSecSigned,distanceSecSigned);assert.equal(validated.targetAtMs,999999);assert.equal(validated.sourceRecordedAtMs,100);
 }
 const legacy=validateBrowserDisplayContents([item('legacy',{targetAtMs:30100,sourceRecordedAtMs:100})])[0];assert.equal(legacy.distanceSecSigned,null);
 const now=validateBrowserDisplayContents([item('now',{provenance:'actual',distanceSecSigned:null,recordedAtMs:123})])[0];assert.equal(now.distanceSecSigned,null);assert.equal(now.recordedAtMs,123);
 for(const value of [NaN,Infinity,-Infinity,'30'])assert.throws(()=>validateBrowserDisplayContents([item('bad',{distanceSecSigned:value as any})]));
 assert.throws(()=>validateBrowserDisplayContents([item('bad-now',{provenance:'actual',distanceSecSigned:30})]));
});

test('async custom snapshot is awaited and async undefined falls through to existing registry',async()=>{
 const f=await fixture();try{
  const expected=snapshot(screen(),[item('fixed')],1000);
  const custom=new BrowserDisplayStore({settingsFile:'unused',contents:[],snapshotProvider:async()=>{await Promise.resolve();return expected;}});assert.equal(await custom.snapshot('future'),expected);
  const fallback=new BrowserDisplayStore({settingsFile:f.settingsFile,contents:[item('fixed')],now:()=>1000,snapshotProvider:async()=>undefined});assert.equal((await fallback.snapshot('future'))?.content?.id,'fixed');
  const missing=new BrowserDisplayStore({settingsFile:'unused',contents:[],snapshotProvider:async()=>null});assert.equal(await missing.snapshot('future'),null);
 }finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
