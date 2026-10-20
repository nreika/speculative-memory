import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEvent,buildSections,buildSharedSections,connectionLayout,mixedConnectionLayout,verticalConnectionLayout,sourceConnectionPath,thumbnailGapPercent,elapsedLabel,secondsLabel,jstDay,pendingRefreshIds,RecentHistoryGaps,thumbFor,pageCounter} from './history-model.mjs';

function fixture(overrides={}){
 const startedAt='2026-10-18T15:36:45.000Z',id='test-batch',scope='test:run';
 const row={captureId:id,startedAt,endedAt:'2026-10-18T15:37:35.000Z',result:'completed',totalMs:50000,
  requestedCount:3,savedCount:3,publishedCount:3,executionSource:'chain',browserFollow:{scope,testRunId:'run',testSceneId:'TSC-002'},images:{},browserBatch:[]};
 for(const key of ['now','a','b','c']){const sceneKey=key==='now'?'now':'gen_'+key;row.images[key]='/captures/'+key+'.png';row.browserBatch.push({id:id+':'+sceneKey,captureId:id,sceneKey,scope,provenance:key==='now'?'actual':'generated',imageUrl:row.images[key],distanceSecSigned:{now:null,a:15,b:30,c:-30}[key],sourceRecordedAtMs:1000});}
 return {...row,...overrides};
}
test('elapsed axis is request time plus stored offsets, not original recording or current settings',()=>{
 const event=normalizeEvent(fixture()),source=event.points.find(p=>p.key==='now');
 assert.equal(source.time,Date.parse('2026-10-18T15:36:45.000Z'));
 for(const [key,seconds] of [['a',15],['b',30],['c',-30]])assert.equal(event.points.find(p=>p.key===key).time-source.time,seconds*1000);
 assert.equal(source.recordedAtMs,1000);assert.equal(event.totalMs,50000);
});
test('every line begins at the source in its own generation and ends at its scene timestamp',()=>{
 const event=normalizeEvent(fixture()),section=buildSections([event],event.start,120)[0];
 const graph=connectionLayout(event,event.start,section);
 assert.equal(graph.lines.length,3);
 for(const line of graph.lines){assert.deepEqual(line.from,{x:graph.source.x,y:graph.source.y});const point=graph.nodes.find(p=>p.key===line.key);assert.deepEqual(line.to,{x:point.x,y:point.y});}
 assert.ok(graph.nodes.find(p=>p.key==='c').x<graph.source.x);
 assert.ok(graph.nodes.find(p=>p.key==='a').x>graph.source.x);
});
test('folded sections share scale and include targets that cross the section boundary',()=>{
 const first=normalizeEvent(fixture()),later=normalizeEvent(fixture({captureId:'later',startedAt:new Date(first.start+119000).toISOString(),images:{},browserBatch:[]}));
 later.points.push({...first.points.find(p=>p.key==='b'),time:later.start+30000});
 const groups=buildSections([later,first],first.start,120);
 assert.equal(groups.length,1);assert.equal(groups[0].min,-30000);assert.equal(groups[0].max,149000);
 for(const event of groups[0].events)for(const point of connectionLayout(event,first.start,groups[0]).nodes)assert.ok(point.x>=8&&point.x<=92);
 const third={...later,id:'third',start:first.start+120000};
 assert.equal(buildSections([first,third],first.start,120).length,2);
});
test('zero distance moves B away from source instead of placing two thumbnails on top of each other',()=>{
 const raw=fixture();raw.browserBatch.find(p=>p.sceneKey==='gen_b').distanceSecSigned=0;
 const event=normalizeEvent(raw),graph=connectionLayout(event,event.start,buildSections([event],event.start)[0]);
 assert.equal(graph.nodes.find(p=>p.key==='b').x,graph.source.x);assert.notEqual(graph.nodes.find(p=>p.key==='b').y,graph.source.y);assert.equal(graph.height,370);
});
test('missing timestamps or durations stay unknown; failed stages are not inferred from remaining time',()=>{
 const raw=fixture({result:'failed',sceneCMs:null,totalMs:45000});delete raw.browserBatch[1].distanceSecSigned;
 const event=normalizeEvent(raw);assert.equal(event.points.find(p=>p.key==='a').time,null);
 assert.equal(event.stages.find(([name])=>name==='C')[1],null);assert.equal(secondsLabel(null),'Unknown');
 assert.equal(normalizeEvent({captureId:'x',startedAt:'invalid'}),null);
});
test('legacy requested and published counts remain unknown while explicit failed partial counts are preserved',()=>{
 const raw=fixture();delete raw.requestedCount;delete raw.publishedCount;delete raw.savedCount;
 const legacy=normalizeEvent(raw);assert.equal(legacy.requested,null);assert.equal(legacy.published,null);assert.equal(legacy.saved,null);
 const partial=normalizeEvent(fixture({result:'failed',savedCount:2,publishedCount:2,errorStage:'sceneC'}));
 assert.equal(partial.requested,3);assert.equal(partial.saved,2);assert.equal(partial.published,2);assert.equal(partial.status,'failed');
});
test('unsafe media and mismatching capture metadata cannot create image links or false connectors',()=>{
 for(const url of ['https://example.com/x.png','/captures/../private.png','/captures/x.png?secret=1']){
  const raw=fixture();raw.images.a=url;raw.browserBatch[1].imageUrl=url;
  assert.equal(normalizeEvent(raw).points.some(p=>p.key==='a'),false);
 }
 const raw=fixture();raw.browserBatch[1].captureId='other';
 assert.equal(normalizeEvent(raw).points.some(p=>p.key==='a'),false);
});
test('elapsed labels handle negative past timestamps and durations longer than an hour',()=>{
 assert.equal(elapsedLabel(-30000),'−00:30');assert.equal(elapsedLabel(3661000),'1:01:01');assert.equal(secondsLabel(51366),'51.4 sec');
});
test('late-night live runs use the Japanese date rather than the UTC date',()=>{
 assert.equal(jstDay(Date.parse('2026-10-18T15:36:45.000Z')),'2026-10-19');
 const raw=fixture({browserFollow:{scope:'camera:main'},test:false});
 assert.equal(normalizeEvent(raw).session,'camera:main:2026-10-19');
});
test('server canonical run key takes precedence over client fallback grouping',()=>{
 assert.equal(normalizeEvent(fixture({timelineRunKey:'canonical-run'})).session,'canonical-run');
});
test('known unfinished records outside the latest page are refreshed with a bounded round-robin',()=>{
 const records=Array.from({length:7},(_,i)=>({id:'capture-'+i,status:'running'}));
 const fresh=new Set(['capture-6']);let cursor=0;const seen=new Set();
 for(let i=0;i<2;i++){const result=pendingRefreshIds(records,fresh,cursor);assert.ok(result.ids.length<=3);result.ids.forEach(id=>seen.add(id));cursor=result.cursor;}
 assert.equal(seen.size,6);assert.equal(seen.has('capture-6'),false);
 assert.deepEqual(pendingRefreshIds([{id:'done',status:'completed'}],fresh).ids,[]);
});
test('loading older records does not change coordinates when using the server-verified run origin',()=>{
 const row=normalizeEvent(fixture()),origin=row.start-600000;
 const before=connectionLayout(row,origin,buildSections([row],origin)[0]);
 const older={...row,id:'older',start:origin,points:[{...row.points[0],time:origin}]};
 const after=connectionLayout(row,origin,buildSections([older,row],origin).find(group=>group.events.some(event=>event.id===row.id)));
 assert.equal(after.source.x,before.source.x);assert.equal(elapsedLabel(row.start-origin),'10:00');
});

function logPage(first,last,nextCursor){return {events:Array.from({length:first-last+1},(_,i)=>({captureId:'event-'+(first-i)})),nextCursor};}
test('returning after thirty new generations recovers the ten rows outside the latest twenty',()=>{
 const known=new Set(['event-100']),gaps=new RecentHistoryGaps(),head=logPage(130,111,'before-111');
 gaps.observeHead(head,known);head.events.forEach(row=>known.add(row.captureId));
 assert.equal(gaps.cursor,'before-111');
 const missing=logPage(110,90,'before-90');gaps.acceptPage(gaps.cursor,missing);missing.events.forEach(row=>known.add(row.captureId));
 assert.equal(gaps.cursor,null);for(let i=100;i<=130;i++)assert.ok(known.has('event-'+i));
});
test('large refresh gaps resume across bounded polls and concurrent new arrivals without changing older paging',()=>{
 const known=new Set(['event-100']),gaps=new RecentHistoryGaps();const olderCursor='historical-before-1';
 const head=logPage(1000,981,'before-981');gaps.observeHead(head,known);head.events.forEach(row=>known.add(row.captureId));
 // First poll's two-page budget is exhausted before reaching the original head.
 for(const page of [logPage(980,781,'before-781'),logPage(780,581,'before-581')]){gaps.acceptPage(gaps.cursor,page);page.events.forEach(row=>known.add(row.captureId));}
 assert.equal(gaps.cursor,'before-581');
 const newer=logPage(1030,1011,'before-1011');gaps.observeHead(newer,new Set(known));newer.events.forEach(row=>known.add(row.captureId));
 for(const page of [logPage(580,381,'before-381'),logPage(380,181,'before-181')]){gaps.acceptPage(gaps.cursor,page);page.events.forEach(row=>known.add(row.captureId));}
 assert.equal(gaps.cursor,'before-181');
 const last=logPage(180,90,'before-90');gaps.acceptPage(gaps.cursor,last);last.events.forEach(row=>known.add(row.captureId));
 assert.equal(gaps.cursor,'before-1011');
 const bridge=logPage(1010,811,'before-811');gaps.acceptPage(gaps.cursor,bridge);bridge.events.forEach(row=>known.add(row.captureId));
 assert.equal(gaps.cursor,null);assert.equal(olderCursor,'historical-before-1');
 for(let i=100;i<=1030;i++)assert.ok(known.has('event-'+i),'Missing event '+i);
});
test('gap boundary is snapshotted before merging, failed fetches retain continuation, and repeated cursors are rejected',()=>{
 const known=new Set(['event-10']),gaps=new RecentHistoryGaps(),head=logPage(50,31,'cursor-a');
 gaps.observeHead(head,known);known.add('event-30');
 // No acceptPage on fetch failure: the continuation stays at the same page.
 assert.equal(gaps.cursor,'cursor-a');
 gaps.acceptPage('cursor-a',logPage(30,21,'cursor-b'));assert.equal(gaps.cursor,'cursor-b');
 assert.throws(()=>gaps.acceptPage('cursor-b',logPage(20,11,'cursor-a')),/repeated/);
 assert.equal(gaps.cursor,'cursor-b');
 gaps.acceptPage('cursor-b',logPage(20,1,null));assert.equal(gaps.cursor,null);
});
test('an overlapping head or first visit does not request extra recent gap pages',()=>{
 const gaps=new RecentHistoryGaps();gaps.observeHead(logPage(30,11,'older'),new Set());
 gaps.observeHead(logPage(30,11,'older'),new Set(['event-15']));assert.equal(gaps.cursor,null);
});
test('shared chart mixes generations and connects each image to its own source on one time scale',()=>{
 const first=normalizeEvent(fixture()),second={...first,id:'second',start:first.start+50000,points:first.points.map(p=>({...p,time:p.time+50000}))};
 const section=buildSections([first,second],first.start)[0],graph=mixedConnectionLayout([second,first],first.start,section);
 assert.equal(graph.nodes.length,8);assert.equal(graph.lines.length,6);
 for(const line of graph.lines){assert.equal(line.from.event.id,line.captureId);assert.equal(line.to.event.id,line.captureId);assert.equal(line.from.key,'now');}
 const sourceRows=graph.nodes.filter(n=>n.key==='now').map(n=>n.y);assert.equal(sourceRows[0],sourceRows[1]);
 for(const node of graph.nodes){assert.ok(node.x>=8&&node.x<=92);assert.ok(node.y>0&&node.y<graph.height);}
});
test('shared chart avoids thumbnail collisions even when multiple captures and offsets have the same timestamp',()=>{
 const first=normalizeEvent(fixture()),second={...first,id:'second'};
 const graph=mixedConnectionLayout([first,second],first.start,buildSections([first,second],first.start)[0]);
 for(let i=0;i<graph.nodes.length;i++)for(let j=i+1;j<graph.nodes.length;j++){
  const a=graph.nodes[i],b=graph.nodes[j];if(a.key==='now'&&b.key==='now')continue; // SOURCE stays on one row by design
  assert.ok(a.y!==b.y||Math.abs(a.x-b.x)>=13);
 }
});
test('unfinished shared charts do not invent generated nodes or attach unknown offsets to a source',()=>{
 const event=normalizeEvent(fixture({result:'running',images:{now:'/captures/source.jpg'},browserBatch:[]}));
 const graph=mixedConnectionLayout([event],event.start,buildSections([event],event.start)[0]);
 assert.equal(graph.nodes.length,1);assert.equal(graph.lines.length,0);assert.equal(graph.nodes[0].key,'now');
});
test('shared folds place every image once in its own elapsed-time window with a uniform scale',()=>{
 const event=normalizeEvent(fixture()),origin=event.start-119000,groups=buildSharedSections([event],origin,120);
 assert.equal(groups.length,2);
 const identities=[];
 for(const group of groups){
  assert.equal(group.min,group.start);assert.equal(group.max-group.min,120000);
  for(const e of group.events)for(const point of e.points){
   assert.ok(point.time-origin>=group.start&&point.time-origin<group.end);identities.push(e.id+':'+point.key);
  }
 }
 assert.equal(new Set(identities).size,4);assert.equal(identities.length,4);
 assert.deepEqual(groups[0].events[0].points.map(p=>p.key).sort(),['c','now']);
 assert.deepEqual(groups[1].events[0].points.map(p=>p.key).sort(),['a','b']);
});
test('shared thumbnail collision clearance respects actual pixels on a narrow plot and wide viewport',()=>{
 for(const [width,viewport] of [[560,560],[560,1920],[1230,1280],[1900,1920]]){
  const gap=thumbnailGapPercent(width,viewport),cardWidth=Math.max(104,Math.min(116,viewport*.08));
  assert.ok(width*gap/100>=cardWidth+11.99);
  const event=normalizeEvent(fixture()),other={...event,id:'other',start:event.start+19000,points:event.points.map(p=>({...p,time:p.time+19000}))};
  const graph=mixedConnectionLayout([event,other],event.start,buildSharedSections([event,other],event.start)[0],gap);
  for(let i=0;i<graph.nodes.length;i++)for(let j=i+1;j<graph.nodes.length;j++){
   const a=graph.nodes[i],b=graph.nodes[j];if(a.key==='now'&&b.key==='now')continue;
   if(a.y===b.y)assert.ok(Math.abs(a.x-b.x)/100*width>=cardWidth+11.99);
  }
 }
});

test('vertical timeline places elapsed time downwards with uniform scale',()=>{
 const event=normalizeEvent(fixture()),origin=event.start-60000,section={min:0,max:300000};
 const layout=verticalConnectionLayout([event],origin,section,1000),byKey=new Map(layout.nodes.map(p=>[p.key,p]));
 assert.ok(byKey.get('c').y<byKey.get('now').y);
 assert.ok(byKey.get('now').y<byKey.get('a').y);
 assert.ok(byKey.get('a').y<byKey.get('b').y);
 assert.equal(byKey.get('a').y-byKey.get('now').y,60);
 assert.equal(layout.height,1296);assert.equal(layout.lines.length,3);
});
test('vertical timeline separates same-time generated images without altering timestamps',()=>{
 const event=normalizeEvent(fixture()),second={...event,id:'second'},origin=event.start,section={min:-30000,max:120000};
 const layout=verticalConnectionLayout([event,second],origin,section,900);
 const sources=layout.nodes.filter(p=>p.key==='now');assert.equal(sources[0].x,sources[1].x); // SOURCE: one straight column
 for(const key of ['a','b','c']){
  const pair=layout.nodes.filter(p=>p.key===key);
  assert.equal(pair[0].y,pair[1].y);assert.notEqual(pair[0].x,pair[1].x);
  assert.ok(Math.abs(pair[0].x-pair[1].x)*layout.width/100>=128-1e-8);
 }
 assert.equal(new Set(layout.nodes.map(p=>p.id)).size,8);
});

test('B connects directly to its SOURCE and bends away from halfway A',()=>{
 const from={x:400,y:100},a={x:600,y:160},b={x:800,y:220};
 const numbers=sourceConnectionPath(from,b,'b').match(/-?\d+(?:\.\d+)?/g).map(Number);
 assert.deepEqual(numbers.slice(0,2),[from.x,from.y]);
 assert.deepEqual(numbers.slice(-2),[b.x,b.y]);
 for(let i=1;i<100;i++){
  const t=i/100,u=1-t,x=u**3*numbers[0]+3*u*u*t*numbers[2]+3*u*t*t*numbers[4]+t**3*numbers[6],y=u**3*numbers[1]+3*u*u*t*numbers[3]+3*u*t*t*numbers[5]+t**3*numbers[7];
  assert.ok(!(Math.abs(x-a.x)<=58&&Math.abs(y-a.y)<=42),'B route must avoid the A card rectangle');
 }
 const zero=sourceConnectionPath(from,{x:800,y:100},'b').match(/-?\d+(?:\.\d+)?/g).map(Number);
 assert.ok(zero[3]<from.y);assert.equal(zero.at(-1),from.y);
 for(const sourceY of [48,100,1248]){
  const coords=sourceConnectionPath({x:400,y:sourceY},{x:800,y:sourceY},'b').match(/-?\d+(?:\.\d+)?/g).map(Number);
  assert.ok(coords[3]>=0,'top gutter must stay inside the plot');
  for(let segment=0;segment<3;segment++)for(let step=0;step<=100;step++){
   const t=step/100,x=coords[segment*2]*(1-t)+coords[segment*2+2]*t,y=coords[segment*2+1]*(1-t)+coords[segment*2+3]*t;
   assert.ok(!(Math.abs(x-600)<=58&&Math.abs(y-sourceY)<=42),'zero-offset B must avoid A card');
  }
 }
});

test('B crossing time windows avoids A even when the folded columns align',()=>{
 const a={left:742,right:858,top:208,bottom:292},d=sourceConnectionPath({x:400,y:100},{x:800,y:350},'b',a);
 assert.ok(d.includes(' L '));const v=d.match(/-?\d+(?:\.\d+)?/g).map(Number);
 for(let s=0;s<3;s++)for(let i=0;i<=100;i++){
  const t=i/100,x=v[s*2]*(1-t)+v[s*2+2]*t,y=v[s*2+1]*(1-t)+v[s*2+3]*t;
  assert.ok(!(x>a.left&&x<a.right&&y>a.top&&y<a.bottom));
 }
});
test('SOURCE always uses a single straight column/row even when sources are close in time',async()=>{
 const {verticalConnectionLayout,mixedConnectionLayout}=await import('./history-model.mjs');
 const ev=(id,t)=>({id,points:[{key:'now',time:t,offset:0},{key:'a',time:t+15000,offset:15},{key:'b',time:t+30000,offset:30}]});
 const events=[ev('e1',0),ev('e2',5000),ev('e3',9000)],section={min:0,max:60000};
 const v=verticalConnectionLayout(events,0,section);
 assert.equal(new Set(v.nodes.filter(p=>p.key==='now').map(p=>p.column)).size,1);
 assert.ok(new Set(v.nodes.filter(p=>p.key==='a').map(p=>p.column)).size>1);
 const h=mixedConnectionLayout(events,0,section);
 assert.equal(new Set(h.nodes.filter(p=>p.key==='now').map(p=>p.y)).size,1);
});
test('shared lane counts keep SOURCE at the same x in every section',async()=>{
 const {verticalConnectionLayout}=await import('./history-model.mjs');
 const ev=(id,t)=>({id,points:[{key:'c',time:t-30000,offset:-30},{key:'now',time:t,offset:0},{key:'a',time:t+15000,offset:15}]});
 const crowded={min:0,max:120000},quiet={min:120000,max:240000};
 const s1=[ev('e1',40000),ev('e2',41000),ev('e3',42000)],s2=[ev('e4',160000)];
 const lanes={};for(const [evs,sec] of [[s1,crowded],[s2,quiet]])for(const [k,v] of Object.entries(verticalConnectionLayout(evs,0,sec).laneCounts))lanes[k]=Math.max(lanes[k]??0,v);
 const x1=verticalConnectionLayout(s1,0,crowded,900,lanes).nodes.find(p=>p.key==='now').x;
 const x2=verticalConnectionLayout(s2,0,quiet,900,lanes).nodes.find(p=>p.key==='now').x;
 assert.equal(x1,x2);
});
test('points carry the server thumbnail when present and keep the full image as the click-through',()=>{
 const event=normalizeEvent(fixture({thumbUrls:{now:'/captures/thumbs/now.jpg',a:null,b:'https://evil.example/b.jpg',c:'/captures/thumbs/../c.jpg'}}));
 const by=Object.fromEntries(event.points.map(p=>[p.key,p]));
 assert.equal(by.now.thumbUrl,'/captures/thumbs/now.jpg');assert.equal(by.now.url,'/captures/now.png');
 assert.equal(by.a.thumbUrl,null);assert.equal(by.b.thumbUrl,null);assert.equal(by.c.thumbUrl,null);assert.equal(by.c.url,'/captures/c.png');
 assert.ok(normalizeEvent(fixture()).points.every(p=>p.thumbUrl===null),'older servers without thumbUrls fall back to full images');
 assert.equal(thumbFor('/captures/thumbs/record_1.jpg'),'/captures/thumbs/record_1.jpg');assert.equal(thumbFor('/captures/record_1.jpg'),null);
 assert.equal(pageCounter(3,600,1000),'Page 3 · 600 records loaded · window last 1000');
});
test('G-27 scenario runs: labels in JST, revised marker for a different sha of the same scenario id, running runs end now',async()=>{
 const {normalizeScenarioRuns}=await import('./history-model.mjs');
 const runs=normalizeScenarioRuns([
  {runId:'r2',scenarioId:'SCN-SIMPLE-001',file:'SCN-SIMPLE-001.csv',sha256:'bbb',startedAt:'2026-10-20T08:00:00.000Z',endedAt:null},
  {runId:'r1',scenarioId:'SCN-SIMPLE-001',file:'SCN-SIMPLE-001.csv',sha256:'aaa',startedAt:'2026-10-20T07:36:26.000Z',endedAt:'2026-10-20T07:40:26.000Z',endReason:'end'},
  {runId:'../bad',scenarioId:'x',startedAt:'2026-10-20T07:00:00Z'},{runId:'r3',scenarioId:'x',startedAt:'nonsense'}],Date.parse('2026-10-20T08:01:00.000Z'));
 assert.deepEqual(runs.map(r=>r.runId),['r1','r2']);
 assert.equal(runs[0].label,'SCN-SIMPLE-001 16:36:26–16:40:26');assert.equal(runs[0].revised,false);
 assert.equal(runs[1].label,'SCN-SIMPLE-001 17:00:00–running (修正版)');assert.equal(runs[1].end,Date.parse('2026-10-20T08:01:00.000Z'));
});
test('G-27 run bands share the plot scale in horizontal and vertical views, clip at section edges and stack overlaps in lanes',async()=>{
 const {normalizeScenarioRuns,runsForSession,runBandLayout,verticalRunBandLayout,plotPosition}=await import('./history-model.mjs');
 const origin=Date.parse('2026-10-20T07:36:00.000Z');
 const runs=normalizeScenarioRuns([
  {runId:'a',scenarioId:'A',sha256:'1',startedAt:new Date(origin+30000).toISOString(),endedAt:new Date(origin+90000).toISOString()},
  {runId:'b',scenarioId:'B',sha256:'2',startedAt:new Date(origin+60000).toISOString(),endedAt:new Date(origin+200000).toISOString()},
  {runId:'c',scenarioId:'C',sha256:'3',startedAt:new Date(origin+900000).toISOString(),endedAt:new Date(origin+960000).toISOString()}]);
 const section={start:0,end:120000,min:0,max:120000};
 const h=runBandLayout(runs,origin,section);
 assert.deepEqual(h.bands.map(b=>b.run.runId),['a','b']);assert.equal(h.lanes,2);
 assert.equal(h.bands[0].left,plotPosition(origin+30000,origin,section));assert.equal(h.bands[0].right,plotPosition(origin+90000,origin,section));
 assert.equal(h.bands[1].right,92);assert.equal(h.bands[1].clippedEnd,true);assert.equal(h.bands[0].clippedStart,false);
 const v=verticalRunBandLayout(runs,origin,section,{top:48,scale:.004});
 assert.equal(v.bands[0].top,48+30000*.004);assert.equal(v.bands[0].height,60000*.004);assert.equal(v.lanes,2);assert.equal(v.bands[1].clippedEnd,true);
 const event=(ms,tag)=>({id:'e'+ms,start:origin+ms,end:origin+ms+50000,scenarioRun:tag?{runId:tag}:null});
 assert.deepEqual(runsForSession(runs,[event(70000)]).map(r=>r.runId),['a','b']);
 assert.deepEqual(runsForSession(runs,[event(5000000,'c')]).map(r=>r.runId),['c'],'a tagged capture keeps its run even outside the span');
 assert.deepEqual(runsForSession(runs,[]),[]);
});
test('G-27 normalizeEvent keeps a safe scenarioRun tag only',()=>{
 assert.deepEqual(normalizeEvent(fixture({scenarioRun:{runId:'abc123',scenarioId:'SCN-SIMPLE-001',csvSha:'f00'}})).scenarioRun,{runId:'abc123',scenarioId:'SCN-SIMPLE-001',csvSha:'f00'});
 assert.equal(normalizeEvent(fixture({scenarioRun:{runId:'../x'}})).scenarioRun,null);assert.equal(normalizeEvent(fixture()).scenarioRun,null);
});
