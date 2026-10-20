import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { originalObservationRecord,buildOriginalObservationLedger,SourceObservationIndex } from './sourceObservationIndex';

const image=Buffer.from('an original JPEG test fixture');
const sha=createHash('sha256').update(image).digest('hex');
const manifest={file:'scene-a/frames/frame-a.jpg',sha256:sha,captureId:'td-1700000000000-1',source:'C:/original/run/NOW_NOW.jpg'};
function archive(){return {captureId:manifest.captureId,capturedAt:'2023-11-15T07:13:20',vlm:{guard:{scene:'A visitor sits at a desk.',people:[{position:'left',pose:'seated',clothes:'plain top',facing:'away',hair:'dark hair'}],detector:{person:true}}},nowText:'different translated text',historySummary:'LIVE VENUE SUMMARY',scenes:[{scenarioDescription:'GENERATED FUTURE CAPTION'}]};}

test('extracts only the original observation with exact image and capture provenance',()=>{
 const record=originalObservationRecord(manifest,archive(),sha);
 assert.equal(record.sceneId,'scene-a');assert.equal(record.frameId,'frame-a');
 assert.equal(record.frameFile,manifest.file);
 assert.equal(record.observation,'A visitor sits at a desk.');
 assert.equal(record.observationOrigin,'vlm.guard.scene');
 assert.equal(record.sourceImageSha256,sha);assert.equal(record.originalCaptureId,manifest.captureId);
 assert.equal(record.detectorPerson,true);assert.equal(record.people?.[0].facing,'away');
 assert.doesNotMatch(JSON.stringify(record),/GENERATED|LIVE VENUE|translated|C:\//);
});

test('timezone-less source clock is retained while known TD epoch provides an absolute original time',()=>{
 const record=originalObservationRecord(manifest,archive(),sha);
 assert.equal(record.sourceObservedAt,'2023-11-14T22:13:20.000Z');
 assert.equal(record.sourceCapturedAt,'2023-11-15T07:13:20');
 assert.equal(record.sourceTimeProvenance,'capture-id-epoch');
});

test('explicit original offsets are normalized, while unknown original times remain unknown',()=>{
 const explicit=archive();explicit.capturedAt='2023-11-15T07:13:20+09:00';
 assert.equal(originalObservationRecord(manifest,explicit,sha).sourceTimeProvenance,'archive-offset-time');
 assert.equal(originalObservationRecord(manifest,explicit,sha).sourceObservedAt,'2023-11-14T22:13:20.000Z');
 const unknown={...archive(),captureId:'source-without-known-time'};
 const record=originalObservationRecord({...manifest,captureId:unknown.captureId},unknown,sha);
 assert.equal(record.sourceObservedAt,null);assert.equal(record.sourceTimeProvenance,'unknown');
 assert.equal(record.sourceCapturedAt,'2023-11-15T07:13:20');
});

test('a generated caption, translated NOW text or venue summary cannot fill a missing original observation',()=>{
 for(const guard of [{}, {scene:''},{scene:42}])assert.throws(()=>originalObservationRecord(manifest,{...archive(),vlm:{guard}},sha),/original-observation-unavailable/);
});

test('prefers the same-frame Japanese NOW observation but never a generated Japanese caption',()=>{
 const source={...archive(),vlm:{...archive().vlm,parsedScenarios:[{scene_now:'人物が机に座っている。',scenario_description:'未来には別の人が現れる。'},{scene_now:'人物が机に座っている。'}]},historySummary:'会場全体の古い要約'};
 const record=originalObservationRecord(manifest,source,sha);
 assert.equal(record.observation,'人物が机に座っている。');
 assert.equal(record.observationOrigin,'vlm.parsedScenarios[].scene_now');
 const top=originalObservationRecord(manifest,{...source,nowText:'人物が机に座っている。'},sha);
 assert.equal(top.observationOrigin,'nowText');
 const conflicting={...archive(),vlm:{...archive().vlm,parsedScenarios:[{scene_now:'観察その一。'},{scene_now:'違う観察その二。'}]}};
 assert.equal(originalObservationRecord(manifest,conflicting,sha).observationOrigin,'vlm.guard.scene');
});

test('wrong bytes and unrelated capture metadata are rejected rather than guessed',()=>{
 assert.throws(()=>originalObservationRecord(manifest,archive(),'a'.repeat(64)),/hash-mismatch/);
 assert.throws(()=>originalObservationRecord(manifest,{...archive(),captureId:'another'},sha),/capture-id-mismatch/);
 assert.throws(()=>originalObservationRecord({...manifest,file:'../scene/frame.jpg'},archive(),sha),/manifest-path/);
});

test('read-only build scans only explicit originals and reports missing inputs independently',()=>{
 const files=new Map<string,Buffer>([[manifest.source,image],[manifest.source.replace('_NOW.jpg','_prompts.json'),Buffer.from(JSON.stringify(archive()))]]);
 let reads=0;
 const read=(file:string)=>{reads++;const bytes=files.get(file);if(!bytes)throw new Error('not available');return bytes;};
 const result=buildOriginalObservationLedger([manifest,{...manifest,file:'scene-a/frames/missing.jpg',source:'C:/missing_NOW.jpg'}],read);
 assert.equal(result.total,2);assert.equal(result.available,1);
 assert.deepEqual(result.issues,[{frameFile:'scene-a/frames/missing.jpg',reason:'original-image-unavailable'}]);
 assert.equal(reads,3);
 assert.equal(result.ledger.records[0].observation,'A visitor sits at a desk.');
});

test('missing archives and hash mismatches are unavailable without querying live logs or models',()=>{
 const missing=buildOriginalObservationLedger([manifest],file=>{if(file===manifest.source)return image;throw new Error('missing');});
 assert.equal(missing.available,0);assert.equal(missing.issues[0].reason,'original-archive-unavailable');
 let reads=0;
 const wrong=buildOriginalObservationLedger([manifest],()=>{reads++;return Buffer.from('modified image');});
 assert.equal(wrong.available,0);assert.equal(wrong.issues[0].reason,'source-image-hash-mismatch');
 assert.equal(reads,1);
});

test('repeated same-frame lookup stays in memory and never adds replay/run/loop state to the originals',()=>{
 const record=originalObservationRecord(manifest,archive(),sha);
 const index=new SourceObservationIndex({version:1,kind:'original-source-observations',records:[record]});
 for(let tick=0;tick<100;tick++){
  const found=index.lookupImage(image,{sceneId:'scene-a',frameId:'frame-a'});
  assert.equal(found.status,'hit');if(found.status==='hit')assert.equal(found.record,record);
 }
 assert.deepEqual(index.lookupImage(Buffer.from('new frame')),{status:'miss'});
 assert.deepEqual(index.lookupSha256(sha,{sceneId:'other-scene'}),{status:'miss'});
 assert.doesNotMatch(JSON.stringify(record),/testRunId|testLoop|replayedAt|historyScope/);
});

test('an ambiguous image hash requires explicit scene/frame identity instead of choosing another capture',()=>{
 const first=originalObservationRecord(manifest,archive(),sha);
 const second=originalObservationRecord({...manifest,file:'scene-b/frames/frame-b.jpg'},archive(),sha);
 const index=new SourceObservationIndex({version:1,kind:'original-source-observations',records:[first,second]});
 assert.equal(index.lookupSha256(sha).status,'ambiguous');
 const selected=index.lookupSha256(sha,{sceneId:'scene-b',frameId:'frame-b'});
 assert.equal(selected.status,'hit');if(selected.status==='hit')assert.equal(selected.record.frameId,'frame-b');
});
