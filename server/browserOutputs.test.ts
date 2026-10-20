import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {BrowserOutputsStore,registerBrowserOutputsRoutes,validateBrowserOutputs,browserOutputsAccess,type BrowserOutputsCatalog,type BrowserOutputConfig} from './browserOutputs';
import type {BrowserDisplayContent} from './browserDisplay';
const item=(id:string,extra:Partial<BrowserDisplayContent>={}):BrowserDisplayContent=>({id,scope:'run-a',provenance:'generated',imageUrl:'/captures/'+id+'.png',recordedAtMs:null,sourceRecordedAtMs:100,targetAtMs:2000,generatedAtMs:500,caption:'OLD OBSERVATION',captureId:'capture-'+id,sceneKey:'gen_a',...extra});
const output=(id='screen-5',extra:Partial<BrowserOutputConfig>={}):BrowserOutputConfig=>({id,label:'追加画面',source:'a',delaySec:0,scene:'any',visible:true,labels:true,subtitles:true,fade:false,...extra});
const catalog=(contents:BrowserDisplayContent[]=[item('a')]):BrowserOutputsCatalog=>({contents,current:{a:contents[0]?.id},sourceScopes:{'actual-past':'run-a','generated-history':'run-a'},clocks:{'run-a':{serverAnchorMs:0,worldAnchorMs:0,rate:1},'run-b':{serverAnchorMs:0,worldAnchorMs:5000,rate:1},uploaded:{serverAnchorMs:0,worldAnchorMs:0,rate:1}}});
async function fixture(outputs:BrowserOutputConfig[]=[output()],pool=catalog()){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'browser-outputs-'));
 const configFile=path.join(dir,'private','outputs.json');await fs.mkdir(path.dirname(configFile));await fs.writeFile(configFile,JSON.stringify({schema:1,outputs}));
 let time=3000,calls=0;
 const options={configFile,loadCatalog:async()=>{calls++;return pool;},now:()=>time};
 return {dir,configFile,options,get calls(){return calls;},setTime:(t:number)=>{time=t;},cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
test('flattened configuration rejects URLs, paths, duplicate IDs, excess outputs and unsupported fields',()=>{
 assert.equal(validateBrowserOutputs([output()])[0].source,'a');
 for(const bad of [output('screen-0'),output('screen-0005'),output('screen-1000'),output('screen-5',{delaySec:-1}),output('screen-5',{delaySec:86401}),{...output(),url:'https://example.com'},output('screen-5',{contentId:'C:/private.png'}),output('screen-5',{source:'fixed',contentId:undefined})])assert.throws(()=>validateBrowserOutputs([bad]));
 assert.throws(()=>validateBrowserOutputs([output(),output()]));assert.throws(()=>validateBrowserOutputs(Array.from({length:65},(_,i)=>output('screen-'+(i+1)))));
});
test('atomic private configuration survives recreation and stale concurrent writers cannot overwrite it',async()=>{
 const f=await fixture();try{
  const store=new BrowserOutputsStore(f.options),initial=await store.configuration();
  const calls=await Promise.allSettled([store.update({baseRevision:initial.revision,requestId:'one',outputs:[output('screen-6')]}),store.update({baseRevision:initial.revision,requestId:'two',outputs:[output('screen-7')]})]);
  assert.equal(calls.filter(r=>r.status==='fulfilled').length,1);assert.equal(calls.filter(r=>r.status==='rejected').length,1);
  assert.equal((await new BrowserOutputsStore(f.options).configuration()).outputs[0].id,'screen-6');
  assert.deepEqual((await fs.readdir(path.dirname(f.configFile))).filter(x=>x.endsWith('.tmp')),[]);
 }finally{await f.cleanup();}
});
test('fixed content can reference only the validated catalog, never an arbitrary content URL',async()=>{
 const f=await fixture();try{
  const store=new BrowserOutputsStore(f.options),initial=await store.configuration();
  await assert.rejects(store.update({baseRevision:initial.revision,requestId:'bad',outputs:[output('screen-5',{source:'fixed',contentId:'not-in-catalog'})]}));
  const saved=await store.update({baseRevision:initial.revision,requestId:'good',outputs:[output('screen-5',{source:'fixed',contentId:'a'})]});assert.equal(saved.outputs[0].contentId,'a');
 }finally{await f.cleanup();}
});
test('current sources preserve their own scope and original/generated/target timestamps',async()=>{
 const original=item('now',{scope:'run-b',provenance:'actual',sceneKey:'now',recordedAtMs:100,sourceRecordedAtMs:100,targetAtMs:null,generatedAtMs:null,caption:'原観察'}),a=item('a');
 const pool=catalog([original,a]);pool.current={now:'now',a:'a'};
 const f=await fixture([output('screen-5',{source:'now'}),output('screen-6',{source:'a'})],pool);try{
  const store=new BrowserOutputsStore(f.options),now=await store.snapshot('screen-5'),future=await store.snapshot('screen-6');
  assert.equal(now?.clock.scope,'run-b');assert.equal(now?.content?.recordedAtMs,100);assert.equal(now?.content?.caption,'原観察');
  assert.equal(future?.clock.scope,'run-a');assert.equal(future?.content?.targetAtMs,2000);assert.equal(future?.content?.generatedAtMs,500);assert.equal(future?.content?.sourceRecordedAtMs,100);assert.equal(future?.content?.provenance,'generated');assert.equal(future?.content?.caption,'生成指示を確認できません。');
 }finally{await f.cleanup();}
});
test('actual past uses recorded time and cannot borrow another scope or substitute a saved timestamp',async()=>{
 const known=item('actual',{provenance:'actual',sceneKey:'now',recordedAtMs:1500}),later=item('later',{provenance:'actual',sceneKey:'now',recordedAtMs:2900}),foreign=item('foreign',{scope:'run-b',provenance:'actual',sceneKey:'now',recordedAtMs:1800}),unknown=item('unknown',{provenance:'actual',sceneKey:'now',recordedAtMs:null,sourceRecordedAtMs:1,generatedAtMs:2000});
 const pool=catalog([known,later,foreign,unknown]);pool.current={};
 const f=await fixture([output('screen-5',{source:'actual-past',delaySec:1})],pool);try{
  const snap=await new BrowserOutputsStore(f.options).snapshot('screen-5');assert.equal(snap?.content?.id,'actual');assert.equal(snap?.content?.provenance,'actual');
  pool.contents=[unknown];const missing=await new BrowserOutputsStore(f.options).snapshot('screen-5');assert.equal(missing?.content,null);assert.equal(missing?.selectionStatus,'time-unknown');assert.equal(missing?.outputStatus.state,'not-ready');
 }finally{await f.cleanup();}
});
test('generated history selects target time, retains generated provenance, and filters scene without inventing target-source distance',async()=>{
 const a=item('a',{targetAtMs:1000,generatedAtMs:9000,sourceRecordedAtMs:50}),b=item('b',{sceneKey:'gen_b',targetAtMs:1500,generatedAtMs:500}),future=item('future',{targetAtMs:2500,generatedAtMs:100}),foreign=item('foreign',{scope:'run-b',targetAtMs:1900});
 const f=await fixture([output('screen-5',{source:'generated-history',scene:'a',delaySec:1})],catalog([a,b,future,foreign]));try{
  const snap=await new BrowserOutputsStore(f.options).snapshot('screen-5');assert.equal(snap?.content?.id,'a');assert.equal(snap?.content?.provenance,'generated');assert.equal(snap?.content?.targetAtMs,1000);assert.equal(snap?.content?.sourceRecordedAtMs,50);assert.equal(snap?.content?.generatedAtMs,9000);assert.equal(snap?.content?.recordedAtMs,null);
 }finally{await f.cleanup();}
});
test('delaying current generated sources uses generation availability while target remains unchanged',async()=>{
 const old=item('old',{generatedAtMs:1000,targetAtMs:9000}),current=item('current',{generatedAtMs:2500,targetAtMs:9500});const pool=catalog([old,current]);pool.current={a:'current'};
 const f=await fixture([output('screen-5',{delaySec:1})],pool);try{const v=await new BrowserOutputsStore(f.options).snapshot('screen-5');assert.equal(v?.content?.id,'old');assert.equal(v?.content?.targetAtMs,9000);assert.equal(v?.temporalRelation,'future');}finally{await f.cleanup();}
});
test('fixed generated content remains the same image as the clock crosses future to past',async()=>{
 const f=await fixture([output('screen-5',{source:'fixed',contentId:'a'})]);try{
  const store=new BrowserOutputsStore(f.options),a=await store.snapshot('screen-5',1500),b=await store.snapshot('screen-5',2500);assert.equal(a?.temporalRelation,'future');assert.equal(b?.temporalRelation,'past');assert.equal(a?.content?.id,b?.content?.id);assert.equal(a?.content?.imageUrl,b?.content?.imageUrl);assert.equal(b?.content?.provenance,'generated');
 }finally{await f.cleanup();}
});
test('uploaded fixed content keeps all times unknown, and hidden outputs do not publish an image',async()=>{
 const upload=item('upload',{scope:'uploaded',provenance:'uploaded',sceneKey:null,captureId:null,targetAtMs:null,recordedAtMs:null,sourceRecordedAtMs:null,generatedAtMs:null,caption:'sample.png'});
 const pool=catalog([upload]);pool.current={};const f=await fixture([output('screen-5',{source:'fixed',contentId:'upload'}),output('screen-6',{source:'fixed',contentId:'upload',visible:false})],pool);try{
  const store=new BrowserOutputsStore(f.options),v=await store.snapshot('screen-5');assert.equal(v?.content?.provenance,'uploaded');assert.equal(v?.temporalRelation,'unknown');assert.equal(v?.content?.targetAtMs,null);assert.equal((await store.snapshot('screen-6'))?.content,null);assert.equal((await store.snapshot('screen-6'))?.outputStatus.state,'hidden');
 }finally{await f.cleanup();}
});
test('fixed historical images without a known scope clock remain visible with an explicitly unknown time reference',async()=>{
 const pool=catalog([item('old',{scope:'old-scope'})]);pool.current={};
 const f=await fixture([output('screen-5',{source:'fixed',contentId:'old'})],pool);try{
  const v=await new BrowserOutputsStore(f.options).snapshot('screen-5');assert.equal(v?.content?.id,'old');assert.equal(v?.clock.scope,'old-scope');assert.equal(v?.clock.known,false);assert.equal(v?.temporalRelation,'unknown');assert.equal(v?.content?.targetAtMs,2000);assert.equal(v?.outputStatus.state,'ready');
 }finally{await f.cleanup();}
});
test('only selected generated content resolves its instruction and mismatched projection never changes image identity',async()=>{
 const f=await fixture([output()],catalog([item('a'),item('unused')]));try{
  let calls=0;const valid=new BrowserOutputsStore({...f.options,resolveContent:async c=>{calls++;return {...c,caption:'保存された生成指示',targetAtMs:9999};}});const v=await valid.snapshot('screen-5');assert.equal(calls,1);assert.equal(v?.content?.caption,'保存された生成指示');assert.equal(v?.content?.targetAtMs,2000);
  for(const change of [{id:'wrong'},{scope:'alien'},{imageUrl:'/captures/other.png'},{captureId:'other'},{sceneKey:'gen_b'}]){
   const bad=new BrowserOutputsStore({...f.options,resolveContent:async c=>({...c,...change,caption:'wrong instruction'})});const s=await bad.snapshot('screen-5');assert.equal(s?.content?.id,'a');assert.equal(s?.content?.caption,'生成指示を確認できません。');
  }
  assert.equal((await valid.page({})).items[0].caption,'生成指示を確認できません。');assert.equal(calls,1,'catalog never resolves all archived instructions');
 }finally{await f.cleanup();}
});
test('10 parallel outputs share one catalog scan/inflight load and refresh only after TTL',async()=>{
 const f=await fixture(Array.from({length:10},(_,i)=>output('screen-'+(i+5))));try{
  let scans=0;const store=new BrowserOutputsStore({...f.options,loadCatalog:async()=>{scans++;await sleep(15);return catalog(Array.from({length:1000},(_,i)=>item(i?'old-'+i:'a',{generatedAtMs:i})));}});
  const start=performance.now(),results=await Promise.all(Array.from({length:10},(_,i)=>store.snapshot('screen-'+(i+5))));
  assert.equal(scans,1);assert.equal(results.length,10);assert.ok(results.every(v=>v?.content?.id==='a'));console.log(JSON.stringify({browserOutputParallelCount:10,catalogEntries:1000,catalogProviderCalls:scans,wallMs:performance.now()-start}));
  await Promise.all(results.map((_,i)=>store.snapshot('screen-'+(i+5))));assert.equal(scans,1);
  f.setTime(4101);await Promise.all(results.map((_,i)=>store.snapshot('screen-'+(i+5))));assert.equal(scans,2);
 }finally{await f.cleanup();}
});
test('invalid catalog lineage never becomes a ready image; missing clock is not fabricated',async()=>{
 const bad=catalog();bad.current.a='not-real';const f=await fixture([output()],bad);try{
  await assert.rejects(new BrowserOutputsStore(f.options).snapshot('screen-5'));
  const pool=catalog();pool.clocks={};const v=await new BrowserOutputsStore({...f.options,loadCatalog:async()=>pool}).snapshot('screen-5');assert.equal(v?.content,null);assert.equal(v?.outputStatus.reason,'clock-unavailable');
 }finally{await f.cleanup();}
});
test('catalog pagination is bounded, retains provenance and null times, and rejects stale cursors',async()=>{
 const f=await fixture([output()],catalog([item('a'),item('b'),item('c')]));try{
  const store=new BrowserOutputsStore(f.options),first=await store.page({limit:'1'});assert.equal(first.items.length,1);assert.ok(first.nextCursor);assert.equal((await store.page({limit:'1',cursor:first.nextCursor!})).items[0].contentId,'b');assert.equal(first.items[0].provenance,'generated');assert.equal(first.items[0].recordedAtMs,null);
  await assert.rejects(store.page({limit:'101'}));await assert.rejects(store.page({cursor:'private/file'}));await assert.rejects(store.page({kind:'arbitrary-url'}));
 }finally{await f.cleanup();}
});
const request=(extra:any={})=>({method:'POST',headers:{host:'localhost:3000',origin:'http://localhost:3000','content-type':'application/json','x-control-request':'1'},socket:{remoteAddress:'127.0.0.1'},...extra});
test('mutation security requires exact host, socket peer, origin, JSON and custom header; spoofed forwarded headers are ignored',()=>{
 const hosts=new Set(['localhost:3000']);assert.equal(browserOutputsAccess(request(),hosts),null);
 for(const req of [request({headers:{...request().headers,host:'attacker.com'}}),request({headers:{...request().headers,origin:'https://evil.invalid'}}),request({headers:{...request().headers,'x-control-request':'0'}}),request({socket:{remoteAddress:'203.0.113.1'},headers:{...request().headers,'x-forwarded-for':'127.0.0.1'}})])assert.equal(browserOutputsAccess(req,hosts),403);
 assert.equal(browserOutputsAccess(request({headers:{...request().headers,'content-type':'text/plain'}}),hosts),415);
 assert.equal(browserOutputsAccess(request({method:'GET',headers:{host:'localhost:3000'},socket:{remoteAddress:'::1'}}),hosts),null);
});
class Response {
 code=200;body:any;headers:Record<string,string>={};file:string|undefined;
 status(code:number){this.code=code;return this;}json(body:any){this.body=body;return this;}setHeader(k:string,v:string){this.headers[k]=v;}removeHeader(k:string){delete this.headers[k];}type(t:string){this.headers['Content-Type']=t;return this;}sendFile(file:string){this.file=file;return this;}
}
async function routes(f:Awaited<ReturnType<typeof fixture>>,extra:any={}){
 let handle:any;const store=registerBrowserOutputsRoutes({use:(h:any)=>{handle=h;}} as any,{...f.options,...extra});
 const call=async(url:string,options:any={})=>{const res=new Response();await handle({...request({method:'GET',headers:{host:'localhost:3000'}}),url,originalUrl:url,...options},res,()=>{});return res;};return {store,call};
}
test('routes preserve flattened contract and never leak private config paths on errors',async()=>{
 const f=await fixture();try{
  const {call}=await routes(f);const list=await call('/api/browser-outputs');assert.equal(list.body.schema,1);assert.equal(list.body.outputs[0].id,'screen-5');
  const next=await call('/api/browser-outputs',{...request(),body:{baseRevision:list.body.revision,requestId:'one',outputs:[output('screen-7')]}});assert.equal(next.code,200);assert.equal((await call('/api/browser-outputs/screen-7')).body.screen.id,'screen-7');
  assert.equal((await call('/api/browser-outputs/screen-999')).code,404);assert.equal((await call('/api/browser-outputs/catalog?path=C:/private')).code,400);
  const bad=await call('/api/browser-outputs',{...request(),body:{baseRevision:next.body.revision,requestId:'two',outputs:[{...output(),file:'C:/secret'}]}});assert.equal(bad.code,400);assert.doesNotMatch(JSON.stringify(bad.body),/secret|browser-outputs-/);
  assert.equal(list.headers['Cache-Control'],'no-store');assert.equal(list.headers['Cross-Origin-Resource-Policy'],'same-origin');
 }finally{await f.cleanup();}
});
test('import and asset serving use only the injected registry service and invalidate cached catalog',async()=>{
 const f=await fixture();try{
  let imported=0,resolved=0;const uploaded=item('upload',{scope:'uploaded',provenance:'uploaded',sceneKey:null,captureId:null,recordedAtMs:null,generatedAtMs:null,targetAtMs:null,sourceRecordedAtMs:null});
  const {call}=await routes(f,{assets:{importImage:async({filename}:any)=>{assert.equal(filename,'sample.png');imported++;return uploaded;},resolve:async(url:string)=>{resolved++;return url==='/captures/browser-output-assets/known.png'?{absolutePath:path.join(f.dir,'known.png'),contentType:'image/png'}:null;}}});
  const result=await call('/api/browser-outputs/assets',{...request(),body:{filename:'sample.png',imageDataUrl:'data:image/png;base64,TEST'}});assert.equal(result.code,201);assert.equal(result.body.contentId,'upload');assert.equal(result.body.item.id,'upload');assert.equal(result.body.item.contentId,'upload');assert.equal(result.body.item.scene,null);assert.equal(result.body.item.provenance,'uploaded');assert.equal(imported,1);assert.doesNotMatch(JSON.stringify(result.body),/absolutePath/);
  assert.equal((await call('/captures/browser-output-assets/known.png')).file,path.join(f.dir,'known.png'));assert.equal((await call('/captures/browser-output-assets/unknown.png')).code,404);assert.equal(resolved,2);
  const denied=await call('/api/browser-outputs/assets',{...request(),headers:{...request().headers,origin:'https://evil.invalid'},body:{filename:'sample.png',imageDataUrl:'data:image/png;base64,TEST'}});assert.equal(denied.code,403);assert.equal(imported,1);
 }finally{await f.cleanup();}
});
test('catalog front contract exposes id, label and scene with current content first then known capture/generation time',async()=>{
 const uploaded=item('u',{scope:'uploaded',provenance:'uploaded',captureId:null,sceneKey:null,targetAtMs:null,generatedAtMs:null,recordedAtMs:null,sourceRecordedAtMs:null,caption:'imported.jpg'});
 const current=item('z-current',{generatedAtMs:1}),newer=item('newer',{generatedAtMs:9000,sceneKey:'gen_c'}),older=item('older',{provenance:'actual',recordedAtMs:8000,sceneKey:'now',caption:'実写の原観察'});
 const pool=catalog([uploaded,newer,current,older]);pool.current={a:current.id};
 const f=await fixture([output()],pool);try{
  const page=await new BrowserOutputsStore(f.options).page({});assert.deepEqual(page.items.map(c=>c.id),['z-current','newer','older','u']);
  assert.equal(page.items[0].id,page.items[0].contentId);assert.equal(page.items[0].scene,'a');assert.match(page.items[0].label,/生成 A/);assert.equal(page.items[1].scene,'c');assert.equal(page.items[2].scene,'now');assert.equal(page.items[2].label,'実写の原観察');assert.equal(page.items[3].label,'imported.jpg');
 }finally{await f.cleanup();}
});
test('snapshot view flags match player contract while unavailable images remain hidden without changing the desired setting',async()=>{
 const f=await fixture([output('screen-5',{labels:false,subtitles:false,fade:true}),output('screen-6',{source:'b',labels:true,subtitles:false,fade:false})]);try{
  const store=new BrowserOutputsStore(f.options),ready=await store.snapshot('screen-5'),missing=await store.snapshot('screen-6');
  assert.deepEqual(ready?.view,{visible:true,labels:false,subtitles:false,fade:true,fadeMode:'original',fadeDurationMs:800,blackHoldMs:120,fadeOnImageChange:false,faceBlur:{enabled:false,strengthPx:12}});assert.deepEqual(missing?.view,{visible:false,labels:true,subtitles:false,fade:false,fadeMode:'none',fadeDurationMs:800,blackHoldMs:120,fadeOnImageChange:false,faceBlur:{enabled:false,strengthPx:12}});assert.equal(missing?.output.visible,true);assert.equal(missing?.outputStatus.state,'not-ready');
 }finally{await f.cleanup();}
});
test('a late configuration read cannot roll the in-memory state back after an atomic save',async t=>{
 const f=await fixture();
 let releaseWrite!:()=>void,writeStarted!:()=>void,releaseRead!:()=>void,readStarted!:()=>void;
 const writing=new Promise<void>(r=>writeStarted=r),writeGate=new Promise<void>(r=>releaseWrite=r);
 const reading=new Promise<void>(r=>readStarted=r),readGate=new Promise<void>(r=>releaseRead=r);
 try{
  const store=new BrowserOutputsStore(f.options),initial=await store.configuration();
  const originalOpen=fs.open.bind(fs),originalRead=fs.readFile.bind(fs);
  t.mock.method(fs,'open',async(...args:any[])=>{const handle=await (originalOpen as any)(...args);if(String(args[0]).includes('.browser-outputs-')){writeStarted();await writeGate;}return handle;});
  const save=store.update({baseRevision:initial.revision,requestId:'save',outputs:[output('screen-6')]});await writing;
  t.mock.method(fs,'readFile',async(...args:any[])=>{const result=await (originalRead as any)(...args);if(String(args[0])===f.configFile){readStarted();await readGate;}return result;});
  const late=store.configuration(true);await reading;
  releaseWrite();const saved=await save;releaseRead();const read=await late;
  assert.equal(read.revision,saved.revision);assert.equal((await store.configuration()).outputs[0].id,'screen-6');
 }finally{releaseRead?.();releaseWrite?.();await f.cleanup();}
});

test('TD aliases follow current layout and scope while direct mappings remain independent',async()=>{
 const a=item('a'),b=item('b',{sceneKey:'gen_b',scope:'run-b'}),now=item('now',{sceneKey:'now',provenance:'actual',recordedAtMs:100,targetAtMs:null,generatedAtMs:null,caption:'NOW'});
 const pool=catalog([a,b,now]);pool.current={a:'a',b:'b',now:'now'};pool.tdRouting={slots:{'td-1':'b','td-2':'now'},view:{visible:true,labels:false,subtitles:true,fade:true}};
 const f=await fixture([output('screen-1',{source:'td-1',fade:true}),output('screen-2',{source:'td-2'}),output('screen-5')],pool);try{
  const store=new BrowserOutputsStore(f.options),alias=await store.snapshot('screen-1');
  assert.equal(alias?.content?.id,'b');assert.equal(alias?.clock.scope,'run-b');assert.equal(alias?.content?.targetAtMs,2000);assert.equal(alias?.output.source,'td-1');assert.deepEqual(alias?.view,{visible:true,labels:false,subtitles:true,fade:true,fadeMode:'original',fadeDurationMs:800,blackHoldMs:120,fadeOnImageChange:false,faceBlur:{enabled:false,strengthPx:12}});
  assert.equal((await store.snapshot('screen-2'))?.content?.id,'now');assert.equal((await store.snapshot('screen-5'))?.content?.id,'a');assert.equal((await store.snapshot('screen-5'))?.view.labels,true);
  pool.tdRouting.slots['td-1']='a';f.setTime(4101);assert.equal((await store.snapshot('screen-1'))?.content?.id,'a');
 }finally{await f.cleanup();}
});
test('TD aliases require zero delay and never substitute a default for missing routing or slots',async()=>{
 for(const source of ['td-1','td-2','td-3','td-4'] as const){assert.equal(validateBrowserOutputs([output('screen-1',{source})])[0].source,source);assert.throws(()=>validateBrowserOutputs([output('screen-1',{source,delaySec:1})]));}
 const pool=catalog();const f=await fixture([output('screen-1',{source:'td-1'})],pool);try{
  const missing=await new BrowserOutputsStore(f.options).snapshot('screen-1');assert.equal(missing?.content,null);assert.equal(missing?.outputStatus.state,'not-ready');assert.equal(missing?.outputStatus.reason,'td-routing-unavailable');assert.equal(missing?.view.visible,false);
  pool.tdRouting={slots:{'td-2':'a'},view:{visible:true,labels:true,subtitles:true,fade:true}};
  assert.equal((await new BrowserOutputsStore(f.options).snapshot('screen-1'))?.content,null);
  pool.tdRouting.slots['td-1']='b';assert.equal((await new BrowserOutputsStore(f.options).snapshot('screen-1'))?.content,null);
 }finally{await f.cleanup();}
});
test('TD view is intersected with per-output flags only for aliases and invalid routing fails closed',async()=>{
 const pool=catalog();pool.tdRouting={slots:{'td-1':'a'},view:{visible:false,labels:true,subtitles:false,fade:true}};
 const f=await fixture([output('screen-1',{source:'td-1',labels:false,fade:false}),output('screen-5')],pool);try{
  const store=new BrowserOutputsStore(f.options),hidden=await store.snapshot('screen-1');assert.equal(hidden?.content,null);assert.deepEqual(hidden?.view,{visible:false,labels:false,subtitles:false,fade:false,fadeMode:'none',fadeDurationMs:800,blackHoldMs:120,fadeOnImageChange:false,faceBlur:{enabled:false,strengthPx:12}});assert.equal(hidden?.outputStatus.state,'hidden');
  assert.equal((await store.snapshot('screen-5'))?.content?.id,'a');assert.equal((await store.snapshot('screen-5'))?.view.visible,true);
  for(const bad of [{slots:{'td-1':'https://invalid'},view:pool.tdRouting.view},{slots:{'td-5':'a'},view:pool.tdRouting.view},{slots:{'td-1':'a'},view:{visible:true}}]){await assert.rejects(new BrowserOutputsStore({...f.options,loadCatalog:async()=>({...pool,tdRouting:bad as any})}).snapshot('screen-1'));}
 }finally{await f.cleanup();}
});


test('per-output fade mode normalizes legacy booleans and rejects unsupported modes',()=>{
 const normalize=(extra:Record<string,unknown>)=>validateBrowserOutputs([{...output(),...extra}])[0];
 assert.equal(normalize({fade:true}).fadeMode,'original');
 assert.equal(normalize({fade:undefined}).fadeMode,'original');
 assert.equal(normalize({fade:false,fadeMode:'crossfade'}).fadeMode,'none');
 assert.equal(normalize({fade:true,fadeMode:'none'}).fade,false);
 assert.equal(normalize({fade:true,fadeMode:'crossfade'}).fadeMode,'crossfade');
 assert.throws(()=>normalize({fadeMode:'invalid'}));assert.throws(()=>normalize({fade:'true'}));
});
test('independent output fade types persist on reload and master off wins for routed slots',async()=>{
 const pool=catalog();pool.tdRouting={slots:{'td-1':'a'},view:{visible:true,labels:true,subtitles:true,fade:false}};
 const f=await fixture([output('screen-1',{source:'td-1',fade:true,fadeMode:'crossfade'}),output('screen-5',{fade:true,fadeMode:'crossfade'}),output('screen-6',{fade:true,fadeMode:'original'}),output('screen-7',{fade:false})],pool);
 try{
  const store=new BrowserOutputsStore(f.options),before=await store.configuration();
  await store.update({baseRevision:before.revision,requestId:'fade-save',outputs:before.outputs});
  const reloaded=new BrowserOutputsStore(f.options);
  assert.deepEqual((await reloaded.configuration()).outputs.map(o=>o.fadeMode),['crossfade','crossfade','original','none']);
  assert.equal((await reloaded.snapshot('screen-1'))?.view.fadeMode,'none');
  assert.equal((await reloaded.snapshot('screen-5'))?.view.fadeMode,'crossfade');
  assert.equal((await reloaded.snapshot('screen-6'))?.view.fadeMode,'original');
  assert.equal((await reloaded.snapshot('screen-7'))?.view.fadeMode,'none');
 }finally{await f.cleanup();}
});

test('channel fade modes default eight channels, persist independently and preserve omitted settings',async()=>{
 const f=await fixture();try{
  const store=new BrowserOutputsStore(f.options),initial=await store.configuration();
  assert.equal(Object.keys(initial.channelFadeModes).length,8);assert.equal(await store.channelFadeMode('current-c'),'original');assert.equal(await store.channelFadeMode('unknown'),undefined);
  const updated=await store.update({baseRevision:initial.revision,requestId:'channel-fade',outputs:initial.outputs,channelFadeModes:{'current-c':'crossfade','control-output-2':'none'}});
  assert.notEqual(updated.revision,initial.revision);
  const saved=await store.update({baseRevision:updated.revision,requestId:'old-client-save',outputs:updated.outputs});
  assert.equal(saved.channelFadeModes['current-c'],'crossfade');assert.equal(saved.channelFadeModes['current-a'],'original');
  const reloaded=new BrowserOutputsStore(f.options);assert.equal(await reloaded.channelFadeMode('control-output-2'),'none');
  for(const bad of [{'current-z':'none'},{'current-a':'broken'},[]])await assert.rejects(store.update({baseRevision:saved.revision,requestId:'bad-channel',outputs:saved.outputs,channelFadeModes:bad}));
 }finally{await f.cleanup();}
});
test('snapshot fade batch follows selected content capture and changes revision at completion',async()=>{
 const pool=catalog();const f=await fixture([output()],pool);try{
  const store=new BrowserOutputsStore(f.options),before=await store.snapshot('screen-5');assert.equal(before?.fadeBatch,undefined);
  pool.fadeBatches={'capture-a':{captureId:'capture-a',completedAtMs:2900},other:{captureId:'other',completedAtMs:2800}};store.invalidateCatalog();
  const after=await store.snapshot('screen-5');assert.deepEqual(after?.fadeBatch,{captureId:'capture-a',completedAtMs:2900});assert.notEqual(after?.revision,before?.revision);
  pool.fadeBatches={'capture-a':{captureId:'other',completedAtMs:2900}};store.invalidateCatalog();await assert.rejects(store.snapshot('screen-5'));
 }finally{await f.cleanup();}
});

test('fade timing validates integer boundaries, defaults legacy outputs, and does not change mode semantics',()=>{
 const legacy=validateBrowserOutputs([output()])[0];assert.equal(legacy.fadeDurationMs,800);assert.equal(legacy.blackHoldMs,120);
 const immediate=validateBrowserOutputs([output('screen-5',{fade:true,fadeMode:'crossfade',fadeDurationMs:0,blackHoldMs:0})])[0];assert.equal(immediate.fadeDurationMs,0);assert.equal(immediate.blackHoldMs,0);assert.equal(immediate.fadeMode,'crossfade');
 for(const key of ['fadeDurationMs','blackHoldMs'])for(const value of [-1,10001,1.5,'800',null,NaN,undefined])assert.throws(()=>validateBrowserOutputs([{...output(),[key]:value}]));
 assert.equal(validateBrowserOutputs([output('screen-5',{fadeDurationMs:10000,blackHoldMs:10000})])[0].blackHoldMs,10000);
});
test('channel timings persist partial merges and preserve omitted keys across reload without sharing mutable references',async()=>{
 const f=await fixture();try{
  const store=new BrowserOutputsStore(f.options),first=await store.configuration();assert.equal(Object.keys(first.channelFadeTimings).length,8);assert.deepEqual(await store.channelFadeTiming('current-a'),{fadeDurationMs:800,blackHoldMs:120});assert.equal(await store.channelFadeTiming('unknown'),undefined);
  const second=await store.update({baseRevision:first.revision,requestId:'duration',outputs:first.outputs,channelFadeTimings:{'current-a':{fadeDurationMs:0},'control-output-4':{blackHoldMs:10000}}});assert.notEqual(second.revision,first.revision);
  const third=await store.update({baseRevision:second.revision,requestId:'hold',outputs:second.outputs,channelFadeTimings:{'current-a':{blackHoldMs:0}}});
  const last=await store.update({baseRevision:third.revision,requestId:'legacy-ui',outputs:third.outputs});assert.deepEqual(last.channelFadeTimings['current-a'],{fadeDurationMs:0,blackHoldMs:0});assert.equal(last.channelFadeTimings['control-output-4'].blackHoldMs,10000);assert.equal(last.channelFadeTimings['current-b'].fadeDurationMs,800);
  const reopened=new BrowserOutputsStore(f.options),timing=await reopened.channelFadeTiming('current-a');timing!.fadeDurationMs=99;assert.equal((await reopened.channelFadeTiming('current-a'))?.fadeDurationMs,0);
  for(const bad of [{'current-z':{}},{'current-a':{unknown:1}},{'current-a':null},{'current-a':{fadeDurationMs:-1}},{'current-a':{blackHoldMs:0.5}},[]])await assert.rejects(store.update({baseRevision:last.revision,requestId:'bad-timing',outputs:last.outputs,channelFadeTimings:bad}));
 }finally{await f.cleanup();}
});
test('mapped view carries independent timings and only fixed source fades on image change regardless of provenance',async()=>{
 const now=item('now',{provenance:'actual',sceneKey:'now',recordedAtMs:100,targetAtMs:null,generatedAtMs:null});const pool=catalog([item('a'),now]);pool.current={a:'a',now:'now'};
 const f=await fixture([output('screen-1',{source:'fixed',contentId:'a',fadeDurationMs:25,blackHoldMs:0}),output('screen-2',{source:'fixed',contentId:'now'}),output('screen-3',{source:'a',fadeDurationMs:0,blackHoldMs:5})],pool);try{
  const store=new BrowserOutputsStore(f.options),fixedGenerated=await store.snapshot('screen-1'),fixedActual=await store.snapshot('screen-2'),direct=await store.snapshot('screen-3');assert.equal(fixedGenerated?.view.fadeOnImageChange,true);assert.equal(fixedActual?.view.fadeOnImageChange,true);assert.equal(direct?.view.fadeOnImageChange,false);assert.equal(fixedGenerated?.view.fadeDurationMs,25);assert.equal(fixedGenerated?.view.blackHoldMs,0);assert.equal(direct?.view.fadeDurationMs,0);
 }finally{await f.cleanup();}
});

test('face blur defaults are independent from fade and strict integer bounds reject unknown settings',()=>{
 assert.deepEqual(validateBrowserOutputs([output()])[0].faceBlur,{enabled:false,strengthPx:12});
 for(const strengthPx of [0,40])assert.deepEqual(validateBrowserOutputs([{...output(),faceBlur:{enabled:true,strengthPx}}])[0].faceBlur,{enabled:true,strengthPx});
 for(const faceBlur of [null,[],true,{enabled:'true'},{strengthPx:-1},{strengthPx:41},{strengthPx:1.5},{strengthPx:NaN},{strengthPx:Infinity},{url:'x'}])assert.throws(()=>validateBrowserOutputs([{...output(),faceBlur}]));
});
test('face blur persists, preserves omitted settings and merges partial per-output and direct-channel patches',async()=>{
 const f=await fixture();try{const store=new BrowserOutputsStore(f.options),initial=await store.configuration();assert.deepEqual(await store.channelFaceBlur('current-a'),{enabled:false,strengthPx:12});assert.equal(await store.channelFaceBlur('unknown'),undefined);
 let c=await store.update({baseRevision:initial.revision,requestId:'blur-on',outputs:[{...output(),faceBlur:{enabled:true,strengthPx:24}}],channelFaceBlurs:{'current-a':{enabled:true,strengthPx:30},'control-output-4':{strengthPx:0}}});
 assert.deepEqual(c.outputs[0].faceBlur,{enabled:true,strengthPx:24});assert.deepEqual(await store.channelFaceBlur('current-a'),{enabled:true,strengthPx:30});
 c=await store.update({baseRevision:c.revision,requestId:'blur-partial',outputs:[{...output(),faceBlur:{strengthPx:20}}],channelFaceBlurs:{'current-a':{enabled:false}}});assert.deepEqual(c.outputs[0].faceBlur,{enabled:true,strengthPx:20});assert.deepEqual(await store.channelFaceBlur('current-a'),{enabled:false,strengthPx:30});
 c=await store.update({baseRevision:c.revision,requestId:'omit',outputs:[output()]});assert.deepEqual(c.outputs[0].faceBlur,{enabled:true,strengthPx:20});assert.deepEqual(c.channelFaceBlurs['control-output-4'],{enabled:false,strengthPx:0});
 const reloaded=new BrowserOutputsStore(f.options);assert.deepEqual((await reloaded.configuration()).outputs[0].faceBlur,{enabled:true,strengthPx:20});assert.deepEqual((await reloaded.snapshot('screen-5'))?.view.faceBlur,{enabled:true,strengthPx:20});const copy=await reloaded.channelFaceBlur('current-a');copy!.strengthPx=2;assert.equal((await reloaded.channelFaceBlur('current-a'))?.strengthPx,30);
 }finally{await f.cleanup();}
});
test('channel captions default true for eight channels, persist, revise and survive old-client saves',async()=>{
 const f=await fixture();try{
  const store=new BrowserOutputsStore(f.options),initial=await store.configuration();
  assert.equal(Object.keys(initial.channelCaptions).length,8);for(const value of Object.values(initial.channelCaptions))assert.deepEqual(value,{labels:true,subtitles:true});
  assert.deepEqual(await store.channelCaptions('control-output-3'),{labels:true,subtitles:true});assert.equal(await store.channelCaptions('screen-5'),undefined);
  const updated=await store.update({baseRevision:initial.revision,requestId:'captions',outputs:initial.outputs,channelCaptions:{'current-a':{labels:false,subtitles:true},'control-output-4':{subtitles:false}}});
  assert.notEqual(updated.revision,initial.revision);assert.deepEqual(updated.channelCaptions['current-a'],{labels:false,subtitles:true});assert.deepEqual(updated.channelCaptions['control-output-4'],{labels:true,subtitles:false});
  assert.equal(JSON.parse(await fs.readFile(f.configFile,'utf8')).channelCaptions['current-a'].labels,false);
  const legacy=await store.update({baseRevision:updated.revision,requestId:'old-client',outputs:updated.outputs});assert.equal(legacy.revision,updated.revision);assert.deepEqual(legacy.channelCaptions,updated.channelCaptions);
  const reloaded=new BrowserOutputsStore(f.options),copy=await reloaded.channelCaptions('current-a');assert.deepEqual(copy,{labels:false,subtitles:true});copy!.labels=true;assert.equal((await reloaded.channelCaptions('current-a'))?.labels,false);
  for(const bad of [null,[],{'screen-5':{labels:false}},{'current-d':{labels:false}},{'current-a':{labels:'false'}},{'current-a':{visible:false}},{'current-a':null}])await assert.rejects(store.update({baseRevision:legacy.revision,requestId:'bad-captions',outputs:legacy.outputs,channelCaptions:bad}),/Invalid channel captions/);
  assert.equal((await store.configuration()).revision,legacy.revision);
 }finally{await f.cleanup();}
});
test('previously stored state without channelCaptions loads with all switches on and Preview overrides transiently',async()=>{
 const f=await fixture();try{
  await fs.writeFile(f.configFile,JSON.stringify({schema:1,outputs:[output()],channelFadeModes:{'current-a':'none'}}));
  const store=new BrowserOutputsStore(f.options),base=await store.configuration();assert.deepEqual(base.channelCaptions['current-now'],{labels:true,subtitles:true});assert.equal(base.channelFadeModes['current-a'],'none');
  await store.setScenarioPreview('run',base.revision,base.outputs,{...base.channelCaptions,'current-b':{labels:false,subtitles:false}});
  assert.deepEqual(await store.channelCaptions('current-b'),{labels:false,subtitles:false});assert.deepEqual((await store.configuration()).channelCaptions['current-b'],{labels:true,subtitles:true});
  await store.setScenarioPreview('run',base.revision,base.outputs);assert.deepEqual(await store.channelCaptions('current-b'),{labels:true,subtitles:true});
  await store.setScenarioPreview('run',base.revision,base.outputs,{'current-b':{labels:false}});store.clearScenarioPreview('run');assert.deepEqual(await store.channelCaptions('current-b'),{labels:true,subtitles:true});
  await assert.rejects(store.setScenarioPreview('run',base.revision,base.outputs,{'current-z':{labels:false}}),/Invalid channel captions/);
 }finally{await f.cleanup();}
});
test('direct blur map rejects unsupported channel and nested keys without writing configuration',async()=>{
 const f=await fixture();try{const store=new BrowserOutputsStore(f.options),initial=await store.configuration();for(const channelFaceBlurs of [null,[],{'screen-5':{enabled:true}},{'current-a':{strengthPx:41}},{'current-c':{x:1}}])await assert.rejects(store.update({baseRevision:initial.revision,requestId:'invalid',outputs:[output()],channelFaceBlurs}));assert.equal((await store.configuration()).revision,initial.revision);
 }finally{await f.cleanup();}
});

test('snapshot presentation runs after full output metadata and preserves source image reference',async()=>{
 const f=await fixture([{...output(),faceBlur:{enabled:true,strengthPx:12}}]);try{let calls=0;const store=new BrowserOutputsStore({...f.options,presentSnapshot:async(snapshot)=>{calls++;assert.equal((snapshot.view as any).faceBlur.enabled,true);assert.ok((snapshot as any).output);return {...snapshot,content:snapshot.content?{...snapshot.content,faceRegions:[[.1,.2,.3,.4]]}as any:null};}}),shown=await store.snapshot('screen-5');assert.equal(calls,1);assert.deepEqual((shown?.content as any).faceRegions,[[.1,.2,.3,.4]]);assert.equal(shown?.content?.imageUrl,'/captures/a.png');assert.equal(shown?.output.id,'screen-5');const plain=await new BrowserOutputsStore(f.options).snapshot('screen-5');assert.equal((plain?.content as any).faceRegions,undefined);assert.equal(plain?.content?.imageUrl,'/captures/a.png');}finally{await f.cleanup();}
});

test('scenario preview uses transient source and metadata without changing configuration or disk',async()=>{const f=await fixture([output('screen-7')],{...catalog([item('a'),item('b',{sceneKey:'gen_b'})]),current:{a:'a',b:'b'}});try{const store=new BrowserOutputsStore(f.options),base=await store.configuration(),before=await fs.readFile(f.configFile,'utf8');await store.setScenarioPreview('run',base.revision,[{...base.outputs[0],source:'b'}]);assert.equal((await store.configuration()).outputs[0].source,'a');const s=await store.snapshot('screen-7');assert.equal(s?.content?.id,'b');assert.deepEqual(s?.scenarioOverride,{runId:'run',source:'b'});assert.equal(await fs.readFile(f.configFile,'utf8'),before);store.clearScenarioPreview('other');assert.ok((await store.snapshot('screen-7'))?.scenarioOverride);store.clearScenarioPreview('run');assert.equal((await store.snapshot('screen-7'))?.content?.id,'a');assert.equal((await store.snapshot('screen-7'))?.scenarioOverride,undefined);}finally{await f.cleanup();}});
test('manual save clears preview immediately, stale Preview cannot overwrite it',async()=>{const f=await fixture([output('screen-7')]);try{const store=new BrowserOutputsStore(f.options),base=await store.configuration();await store.setScenarioPreview('run',base.revision,[{...base.outputs[0],visible:false}]);const saved=await store.update({baseRevision:base.revision,requestId:'manual',outputs:[{...base.outputs[0],labels:false}]});assert.equal((await store.snapshot('screen-7'))?.scenarioOverride,undefined);await assert.rejects(store.setScenarioPreview('run',base.revision,base.outputs),/manually/);assert.equal((await store.configuration()).revision,saved.revision);}finally{await f.cleanup();}});

test('preview run marker affects snapshot revision even if mapping source and image stay the same',async()=>{const f=await fixture([output('screen-7')]);try{const store=new BrowserOutputsStore(f.options),base=await store.configuration(),original=await store.snapshot('screen-7');await store.setScenarioPreview('run-one',base.revision,base.outputs);const first=await store.snapshot('screen-7');assert.equal(first?.content?.id,original?.content?.id);assert.notEqual(first?.revision,original?.revision);store.clearScenarioPreview('run-one');await store.setScenarioPreview('run-two',base.revision,base.outputs);const second=await store.snapshot('screen-7');assert.notEqual(first?.revision,second?.revision);store.clearScenarioPreview('run-two');assert.equal((await store.snapshot('screen-7'))?.revision,original?.revision);}finally{await f.cleanup();}});
