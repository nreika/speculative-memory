import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCaptureHistoryScope, captureHistoryContext, captureHistoryDisplay, ScopedTestHistory, summarizeTestObservations, type CachedOriginalObservation, type ScopedOriginalObservation } from './historyDisplay';

const at='2026-10-18T03:00:00Z';
const scope=(sceneId='TSC-001',runId='run-1',loopId='0')=>resolveCaptureHistoryScope({captureId:'test-1',isTest:true,useLiveHistory:false,testScope:{sceneId,runId,loopId}});
const original=(extra:Partial<ScopedOriginalObservation>={}):ScopedOriginalObservation=>({scopeKey:scope().key,captureId:'test-1',frameId:'F001',sourceImageSha256:'a'.repeat(64),origin:'original-now',observedAt:at,observation:'A person sits at a desk.',...extra});

test('test and history-disabled captures never display the persisted live room/obstruction summary',()=>{
  for(const input of [{captureId:'test-1',isTest:true,useLiveHistory:false},{captureId:'test-1',isTest:true,useLiveHistory:true},{captureId:'mobile-1',isTest:false,useLiveHistory:false}]) {
    const result=captureHistoryDisplay({scope:resolveCaptureHistoryScope(input),at,liveSummary:'長時間無人。(カメラが遮られている可能性)'});
    assert.equal(result.summary,'');assert.equal(result.source,'none');assert.equal(result.observationCount,0);
  }
  const live=resolveCaptureHistoryScope({captureId:'live-1',isTest:false,useLiveHistory:true});
  assert.equal(captureHistoryDisplay({scope:live,at,liveSummary:'現在は人物がいる。'}).summary,'現在は人物がいる。');
});

test('test scene, run and loop are separate scopes even when frame IDs match',()=>{
  for(const other of [scope('TSC-002'),scope('TSC-001','run-2'),scope('TSC-001','run-1','1')]) {
    assert.notEqual(other.key,scope().key);
    assert.equal(captureHistoryDisplay({scope:other,at,observations:[original()]}).summary,'');
  }
  const selected=captureHistoryDisplay({scope:scope(),at,observations:[original(),original({scopeKey:scope('TSC-002').key,observation:'An empty room.'})]});
  assert.equal(selected.summary,'A person sits at a desk.');assert.equal(selected.observationCount,1);
});

test('missing/invalid grouping identifiers fall back to current capture, not a shared unknown test group',()=>{
  for(const testScope of [undefined,{sceneId:'TSC-001'},{sceneId:'TSC-001',runId:'run-1',loopId:0},{sceneId:'TSC-001',runId:'run-1',loopId:''}]) {
    const a=resolveCaptureHistoryScope({captureId:'a',isTest:true,useLiveHistory:false,testScope});
    const b=resolveCaptureHistoryScope({captureId:'b',isTest:true,useLiveHistory:false,testScope});
    assert.equal(a.kind,'capture');assert.notEqual(a.key,b.key);
    assert.equal(captureHistoryDisplay({scope:a,at,observations:[original({scopeKey:a.key,captureId:'b'})]}).summary,'');
    assert.equal(captureHistoryDisplay({scope:a,at,observations:[original({scopeKey:a.key,captureId:'a'})]}).observationCount,1);
  }
});

test('only original NOW observations with frame/hash/time evidence are eligible',()=>{
  for(const extra of [{origin:'generated'},{origin:'composed-input'},{origin:'prediction'},{frameId:''},{sourceImageSha256:''},{observation:''},{observedAt:'bad'},{observedAt:'2026-10-18T03:01:00Z'}]) {
    assert.equal(captureHistoryDisplay({scope:scope(),at,observations:[original(extra as any)]}).summary,'');
  }
  assert.equal(captureHistoryDisplay({scope:scope(),at:'invalid',observations:[original()]}).summary,'');
});

test('repeated frame retries do not become new events and no duration or inferred action is added',()=>{
  const first=original({observedAt:'2026-10-18T02:58:00Z'});
  const second=original({frameId:'F002',sourceImageSha256:'b'.repeat(64),observation:'A person is standing.'});
  const r=captureHistoryDisplay({scope:scope(),at,observations:[second,first,{...first,captureId:'retry'}]});
  assert.equal(r.summary,'A person sits at a desk.\nA person is standing.');
  assert.equal(r.observationCount,2);assert.equal(r.evidence[0].captureId,'test-1');
  assert.doesNotMatch(r.summary,/arrived|left|minutes|立ち上が/);
});

test('scope keys avoid delimiter collisions and selection does not mutate observation records',()=>{
  assert.notEqual(scope('a:b','c','0').key,scope('a','b:c','0').key);
  const rows=Object.freeze([Object.freeze(original())]);const before=JSON.stringify(rows);
  captureHistoryDisplay({scope:scope(),at,observations:rows});assert.equal(JSON.stringify(rows),before);
});

test('TD wire adapter uses explicit scene/run/positive loop and echoes them without parsing captureId',()=>{
  const run='12345678-1234-4321-8123-123456789abc';
  const body={testSceneId:'TSC-001',testFrameId:'TSC-001-F001',testRunId:run,testLoop:1,testSourceStartedAt:'2026-10-15T12:00:00Z',scenarioControl:{runId:'unrelated-csv-run'}};
  const r=captureHistoryContext({captureId:'test-TSC-999-F099-L999-epoch',isTest:true,useLiveHistory:false,request:body});
  assert.equal(r.scope.key,`test:TSC-001:${run}:L1`);
  assert.deepEqual(r.echo,{historyScope:r.scope.key,testSceneId:body.testSceneId,testFrameId:body.testFrameId,testRunId:run,testLoop:1,testSourceStartedAt:body.testSourceStartedAt});
  for(const testLoop of [undefined,0,-1,'1',1.5])assert.equal(captureHistoryContext({captureId:'test-TSC-001-F001-L001-epoch',isTest:true,useLiveHistory:false,request:{...body,testLoop}}).scope.kind,'capture');
  const noRun=captureHistoryContext({captureId:'test-TSC-001-F001-L001-epoch',isTest:true,useLiveHistory:false,request:{...body,testRunId:undefined}});
  assert.equal(noRun.scope.kind,'capture');
  assert.equal(captureHistoryDisplay({scope:noRun.scope,at,liveSummary:'古い無人履歴'}).summary,'');
});

const cached=(over:Partial<CachedOriginalObservation>={}):CachedOriginalObservation=>({sceneId:'TSC-001',frameId:'F001',sourceImageSha256:'a'.repeat(64),originalCaptureId:'td-original',sourceObservedAt:'2026-10-15T03:00:00Z',observation:'A person in a white shirt sits.',people:[{clothes:'white shirt',pose:'seated'}],detectorPerson:true,...over});

test('cache observation updates are generation-independent, deduplicated, and keep original/replay clocks separate',()=>{
  const store=new ScopedTestHistory();const first=store.observe(scope(),cached(),at);
  assert.equal(first.updated,true);assert.match(first.snapshot.summary,/原観察「A person in a white shirt sits\.」/);assert.match(first.snapshot.summary,/人物検出：検出あり/);
  assert.equal(first.snapshot.observations[0].sourceObservedAt,'2026-10-15T03:00:00Z');assert.equal(first.snapshot.observations[0].replayedAt,at);
  const same=store.observe(scope(),cached(),'2026-10-18T03:00:01Z');
  assert.equal(same.updated,false);assert.equal(same.snapshot.observationCount,1);
  assert.equal(same.snapshot.observations[0].replayedAt,at,'first presentation evidence is not overwritten by polling');
  const second=store.observe(scope(),cached({frameId:'F002',sourceImageSha256:'b'.repeat(64),sourceObservedAt:'2026-10-15T03:02:00Z'}),'2026-10-18T03:00:02Z');
  assert.match(second.snapshot.summary,/F001〜F002/);assert.doesNotMatch(second.snapshot.summary,/分間|時間|以降|立ち上が/);
});

test('cache never mixes scenes/runs/loops and unknown source evidence cannot create an empty-room claim',()=>{
  const store=new ScopedTestHistory();store.observe(scope(),cached(),at);
  for(const other of [scope('TSC-002'),scope('TSC-001','run-2'),scope('TSC-001','run-1','1')])assert.equal(store.snapshot(other).summary,'');
  assert.equal(store.observe(scope('TSC-002'),cached(),at).updated,false);
  assert.equal(store.observe(scope(),cached({frameId:'bad',observation:''}),at).updated,false);
  const unknown=store.observe(scope(),cached({frameId:'F003',sourceImageSha256:'c'.repeat(64),people:[],detectorPerson:null,observation:'A desk is visible.',sourceObservedAt:null}),at);
  assert.match(unknown.snapshot.summary,/A desk is visible/);assert.doesNotMatch(unknown.snapshot.summary,/無人|見える人物なし/);
});

test('test cache bounds and immutable snapshots do not alter live or previous source records',()=>{
  const store=new ScopedTestHistory(1,2),source=cached();store.observe(scope(),source,at);
  source.people![0].clothes='blue shirt';
  const snapshot=store.snapshot(scope());assert.equal(snapshot.observations[0].people![0].clothes,'white shirt');
  snapshot.observations[0].observation='rewritten';assert.notEqual(store.snapshot(scope()).observations[0].observation,'rewritten');
  store.observe(scope(),cached({frameId:'F002'}),at);store.observe(scope(),cached({frameId:'F003'}),at);assert.equal(store.snapshot(scope()).observationCount,2);
  store.observe(scope('TSC-001','run-2'),cached(),at);assert.equal(store.snapshot(scope()).summary,'');
  const live=resolveCaptureHistoryScope({captureId:'live',isTest:false,useLiveHistory:true});assert.equal(store.observe(live,cached(),at).updated,false);
});

test('TD compact UUID32 and hyphen UUID both group and echo the original wire value',()=>{
 for(const run of ['05bc6ec474624b139f467475ec3784a7','05bc6ec4-7462-4b13-9f46-7475ec3784a7']){const r=captureHistoryContext({captureId:'capture',isTest:true,useLiveHistory:false,request:{testSceneId:'TSC-001',testFrameId:'TSC-001-F001',testRunId:run,testLoop:1}});assert.equal(r.scope.kind,'test');assert.equal(r.echo.testRunId,run);assert.equal(r.echo.historyScope,'test:TSC-001:'+run+':L1');}
 for(const run of ['a'.repeat(31),'a'.repeat(33),'g'.repeat(32),'a'.repeat(32)+'\n'])assert.equal(captureHistoryContext({captureId:'capture',isTest:true,useLiveHistory:false,request:{testSceneId:'TSC-001',testRunId:run,testLoop:1}}).scope.kind,'capture');
});


const digest=(over:Partial<CachedOriginalObservation>={})=>
  summarizeTestObservations([{...cached(over),replayedAt:at}]);

test('prose is retained when detector and original observation may disagree, without parsing Japanese occupancy',()=>{
  for(const [observation,detectorPerson] of [
    ['人物が机で作業している。',false],
    ['人物は見えない。',true],
    ['机の向こうは見切れており確認できない。',false],
    ['No person is visible.',true],
  ] as const) {
    const summary=digest({observation,people:[],detectorPerson});
    assert.ok(summary.includes(`原観察「${observation}」`));
    assert.ok(summary.includes(`人物検出：${detectorPerson?'検出あり':'未検出'}`));
    assert.match(summary,/原観察との一致は未確認/);
    assert.doesNotMatch(summary,/人物0人|見える人物なし|人物あり（人数不明）/);
  }
});

test('only an explicit structural contradiction is marked inconsistent, even without source prose',()=>{
  for(const observation of ['机の前に人物がいる。','']) {
    const summary=digest({observation,people:[{clothes:'white shirt',pose:'standing or leaning'}],detectorPerson:false});
    assert.match(summary,/人物情報が不一致（人物記録1件）/);
    assert.match(summary,/人物検出：未検出/);
    assert.doesNotMatch(summary,/起立|人物1人|見える人物なし/);
  }
});

test('empty/missing people and unknown detection never create an absence or zero-count claim',()=>{
  for(const people of [undefined,[]])for(const detectorPerson of [undefined,null,false]) {
    const summary=digest({observation:'',people,detectorPerson});
    assert.match(summary,/原観察なし（人物有無は不明）/);
    assert.doesNotMatch(summary,/人物0人|見える人物なし|無人/);
  }
  assert.match(digest({observation:'遮蔽されている。',people:[],detectorPerson:null}),/人物検出：不明/);
});

test('uncertain posture is not simplified to definite sitting or standing',()=>{
  for(const pose of ['standing or leaning','possibly seated','not standing','unknown']) {
    const observation='姿勢をはっきり確認できない。';
    const summary=digest({observation,people:[{clothes:'white shirt',pose}],detectorPerson:true});
    assert.ok(summary.includes(`原観察「${observation}」`));
    assert.doesNotMatch(summary,/起立|着席|人物1人/);
  }
});

test('identical states compress across frames but changed detector evidence remains separate',()=>{
  const rows=[
    {...cached({frameId:'F001'}),replayedAt:at},
    {...cached({frameId:'F002'}),replayedAt:at},
    {...cached({frameId:'F003',detectorPerson:false}),replayedAt:at},
  ];
  const summary=summarizeTestObservations(rows);
  assert.match(summary,/F001〜F002:/);
  assert.match(summary,/F003:.*人物情報が不一致/);
  assert.doesNotMatch(summary,/F001〜F003|分間|入室|退室/);
});

test('recent whole states are retained without truncating an original sentence into a claim',()=>{
  const rows=Array.from({length:4},(_,i)=>({...cached({frameId:`F00${i+1}`,observation:`観察${i+1}：${'確認できない領域がある。'.repeat(25)}`}),replayedAt:at}));
  const summary=summarizeTestObservations(rows);
  assert.ok(summary.includes(rows[3].observation));
  assert.doesNotMatch(summary,/F001:|F002:|F003:/);
});
