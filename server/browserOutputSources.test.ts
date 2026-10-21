import test from'node:test';import assert from'node:assert/strict';import{createBrowserOutputSources}from'./browserOutputSources';import type{BrowserDisplayContent,BrowserDisplaySnapshot}from'./browserDisplay';import type{CaptureEvent}from'./events/captureEvents';
const content=(id:string,provenance:'actual'|'generated'='generated',scope='scope-one'):BrowserDisplayContent=>({id,scope,provenance,imageUrl:'/captures/'+id+'.png',captureId:id,sceneKey:provenance==='actual'?'now':'gen_a',caption:id,recordedAtMs:provenance==='actual'?100:null,sourceRecordedAtMs:100,targetAtMs:provenance==='generated'?999999:null,generatedAtMs:provenance==='generated'?200:null,distanceSecSigned:provenance==='generated'?15:null});
const snapshot=(c:BrowserDisplayContent):BrowserDisplaySnapshot=>({schema:1,revision:'r1',screen:{id:'td-a',label:'A',accent:'#ffffff'},clock:{scope:c.scope,serverNowMs:1000,worldNowMs:500,rate:.5},content:c,selection:{mode:'pinned',contentId:c.id},selectionStatus:'selected',temporalRelation:'future'});
const event=(c:BrowserDisplayContent):CaptureEvent=>({captureId:c.captureId!,source:'test',test:true,startedAt:'2026-10-18T00:00:00Z',result:'completed',browserFollow:{scope:c.scope,sourceRecordedAtMs:100},browserBatch:[c],images:c.sceneKey==='now'?{now:c.imageUrl}:{a:c.imageUrl}});
test('catalog includes current ids and all valid fixed-pool history while automatic source scope stays current',async()=>{
 const now=content('now','actual'),a=content('a'),past=content('past','actual'),old=content('old'),foreign=content('foreign','generated','other-scope');
 const provider=createBrowserOutputSources({readCurrent:()=>({now:snapshot(now),a:snapshot(a)}),readEvents:()=>[event(past),event(old),event(foreign)]});
 const c=await provider.loadCatalog();assert.deepEqual(c.current,{now:'now',a:'a'});assert.deepEqual(c.sourceScopes,{'actual-past':'scope-one','generated-history':'scope-one'});assert.deepEqual(c.clocks['scope-one'],{serverAnchorMs:1000,worldAnchorMs:500,rate:.5});assert.deepEqual(c.contents.map(x=>x.id),['now','a','past','old','foreign']);assert.equal(c.clocks['other-scope'],undefined);assert.equal(c.contents.find(x=>x.id==='old')?.targetAtMs,999999);assert.equal(c.contents.find(x=>x.id==='old')?.distanceSecSigned,15);
});
test('mismatched lineage, unsafe URLs and unknown record-only events are excluded',async()=>{
 const a=content('a'),bad=content('bad'),wrong=event(bad);wrong.images={a:'/captures/different.png'};
 const noLineage={...event(content('missing','actual')),browserFollow:undefined};
 const unsafe=content('unsafe');unsafe.imageUrl='https://example.com/image.png';
 const c=await createBrowserOutputSources({readCurrent:()=>({a:snapshot(a)}),readEvents:()=>[wrong,noLineage,event(unsafe)]}).loadCatalog();assert.deepEqual(c.contents.map(x=>x.id),['a']);assert.equal(c.sourceScopes['actual-past'],undefined);
});
test('uploaded images keep uploaded provenance and unknown times; missing current never enables an automatic scope',async()=>{
 const upload:BrowserDisplayContent={...content('upload'),provenance:'uploaded',scope:'uploaded',captureId:undefined,sceneKey:undefined,recordedAtMs:null,targetAtMs:null,sourceRecordedAtMs:null,generatedAtMs:null,distanceSecSigned:null};
 const c=await createBrowserOutputSources({readCurrent:async()=>({}),readEvents:async()=>[event(content('old'))],readUploads:async()=>[upload]}).loadCatalog();assert.deepEqual(c.current,{});assert.equal(c.contents.length,2);assert.equal(c.contents[1].provenance,'uploaded');assert.deepEqual(c.sourceScopes,{});assert.equal(c.clocks['scope-one'],undefined);
});
test('historical explicit scope clock is accepted without deriving it from capture or target times',async()=>{
 const e=event(content('history','generated','old-scope'));(e.browserFollow as any).clock={serverAnchorMs:10,worldAnchorMs:20,rate:0};
 const c=await createBrowserOutputSources({readCurrent:()=>({}),readEvents:()=>[e]}).loadCatalog();assert.deepEqual(c.clocks['old-scope'],{serverAnchorMs:10,worldAnchorMs:20,rate:0});assert.deepEqual(c.sourceScopes,{});
});
test('camera records enter manual pool without changing active replay scope; thumbnail callback is metadata-only',async()=>{
 const now=content('now','actual','test:TSC-001:run:L1'),record={...content('camera','actual','camera:main'),recordingAutoScope:'camera:main'};let thumbnails=0;
 const catalog=await createBrowserOutputSources({readCurrent:()=>({now:snapshot(now)}),readEvents:()=>[],readRecords:()=>[record],thumbnailUrl:url=>{thumbnails++;return'/captures/thumbs/'+url.split('/').at(-1);}}).loadCatalog();assert.equal(catalog.sourceScopes['actual-past'],now.scope);assert.equal(catalog.contents.length,2);assert.equal(thumbnails,2);assert.ok((catalog.contents[1]as any).thumbnailUrl);assert.equal('recordingAutoScope'in catalog.contents[1],false);
});
test('live actual-past binds camera records only through exact current capture explicit cameraScope',async()=>{
 const now=content('live-now','actual','live'),current=snapshot(now);current.clock={scope:'live',serverNowMs:3000,worldNowMs:3000,rate:1};
 const row=event(now);row.source='td-native';row.test=undefined;(row.browserFollow as any).cameraScope='camera:main';
 const make=(rows:CaptureEvent[])=>createBrowserOutputSources({readCurrent:()=>({now:current}),readEvents:()=>rows,readRecords:()=>[{...content('camera-record','actual','camera:main'),recordingAutoScope:'camera:main'}]}).loadCatalog();
 const yes=await make([row]);assert.equal(yes.sourceScopes['actual-past'],'camera:main');assert.deepEqual(yes.clocks['camera:main'],{serverAnchorMs:3000,worldAnchorMs:3000,rate:1});
 for(const altered of [{...row,captureId:'other-capture'},{...row,test:true},{...row,source:'test'},{...row,browserFollow:{...row.browserFollow!,cameraScope:undefined}}])assert.equal((await make([altered])).sourceScopes['actual-past'],'live');
 const noCurrent=await createBrowserOutputSources({readCurrent:()=>({}),readEvents:()=>[],readRecords:()=>[{...content('camera-record','actual','camera:main'),recordingAutoScope:'camera:main'}]}).loadCatalog();assert.equal(noCurrent.sourceScopes['actual-past'],undefined);
});
test('each-mode captures get a per-capture fade trigger from their first image; current status is carried to the catalog',async()=>{
 const a=content('a'),e=event(a);e.result='running';(e.browserFollow as any).updateMode='each';
 const status={state:'generating' as const,requestedCaptureId:'a',displayedCaptureId:null,error:null,userMessage:'生成中です。前回の画像を表示中。',lastSuccessAtMs:null};
 const c=await createBrowserOutputSources({readCurrent:()=>({a:{...snapshot(a),displayStatus:status}}),readEvents:()=>[e]}).loadCatalog();
 assert.equal(c.fadeBatches?.a?.captureId,'a');assert.equal(c.currentStatus?.a?.state,'generating');
 const all=event(content('b'));(all.browserFollow as any).updateMode='all';all.result='running';
 assert.equal((await createBrowserOutputSources({readCurrent:()=>({}),readEvents:()=>[all]}).loadCatalog()).fadeBatches?.b,undefined);
});
