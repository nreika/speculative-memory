import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseFrameAlign,frameAligner,alignFrames,type FrameAlignResult} from './frameAlign';
import {framingDriftReason,withFraming,framingFacts,inspectAndCaption,inspectAndCaptionWithReferences} from './generation/combinedInspection';
import {handCounter} from './handCount';
import {archiveRootDir} from './archive/generationArchive';

const aligned=(o:Partial<FrameAlignResult>={}):FrameAlignResult=>({status:'aligned',scale:1,dx:0,dy:0,rotationDeg:0,inliers:2000,inlierRatio:.95,edgeIou:.85,...o});
const img='data:image/png;base64,dGVzdA==';
const person={sourceIndex:0,posture:'standing',hands:2,handPositions:['a','b'],raisedHands:0,objectHands:0,otherHands:2,leftHand:{visibility:'visible',height:'unclear',contact:'none',palm:'unclear'},rightHand:{visibility:'visible',height:'unclear',contact:'none',palm:'unclear'}};

test('parseFrameAlign validates the worker JSON and never turns garbage into a pass value',()=>{
 assert.deepEqual(parseFrameAlign({status:'unavailable'}),{status:'unavailable'});
 assert.equal(parseFrameAlign(null).status,'error');
 assert.equal(parseFrameAlign({status:'aligned',edgeIou:.8,inliers:10}).status,'error');// missing geometry
 assert.equal(parseFrameAlign({status:'aligned',scale:1,dx:0,dy:0,rotationDeg:0,edgeIou:1.5,inliers:10}).status,'error');
 const r=parseFrameAlign({status:'aligned',scale:1.0013,dx:.0148,dy:-.1859,rotationDeg:-1.014,inliers:893,inlierRatio:.746,edgeIou:.535,edgeIouAligned:.7752,ms:177,method:'m'});
 assert.equal(r.status,'aligned');assert.equal(r.dy,-.1859);assert.equal(r.detectorMs,177);
 assert.deepEqual(parseFrameAlign({status:'no-alignment',inliers:0,edgeIou:.2}),{status:'no-alignment',edgeIou:.2,inliers:0});
});
test('framing thresholds: 17-28-38 C fails on dy, the accepted ranges of the same loop pass',()=>{
 assert.equal(framingDriftReason(aligned({scale:1.0013,dx:.0148,dy:-.1859,rotationDeg:-1.014,inliers:893,edgeIou:.535})),'dy -18.6%');
 for(const ok of [aligned({scale:.9916,dx:-.0064,dy:-.0017,edgeIou:.77}),aligned({scale:1.0005,dx:-.0024,dy:.0008,rotationDeg:.037}),aligned({scale:.97,dx:.0365,edgeIou:.68})])assert.equal(framingDriftReason(ok),null);
 assert.match(framingDriftReason(aligned({scale:.93}))!,/scale 0\.930/);
 assert.match(framingDriftReason(aligned({scale:1.07}))!,/scale 1\.070/);
 assert.match(framingDriftReason(aligned({dx:.05}))!,/dx 5\.0%/);
 assert.match(framingDriftReason(aligned({rotationDeg:2.5}))!,/rotation 2\.5 deg/);
 // too few inliers: geometry is not trusted; only a very low edge IoU rejects
 assert.equal(framingDriftReason(aligned({scale:1.5,inliers:20,edgeIou:.6})),null);
 assert.match(framingDriftReason(aligned({scale:1.5,inliers:20,edgeIou:.2}))!,/only 20 matching features/);
 assert.match(framingDriftReason({status:'no-alignment',inliers:0,edgeIou:.1})!,/edge IoU 0\.10/);
 assert.equal(framingDriftReason({status:'no-alignment',inliers:0,edgeIou:.5}),null);
 assert.equal(framingDriftReason({status:'unavailable'}),null);assert.equal(framingDriftReason({status:'error'}),null);
});
test('withFraming rejects with defect framing_drift and keeps an earlier defect',()=>{
 const base:{ok:boolean|null;reason:string;defect?:'extra_hand'|'framing_drift'}={ok:true,reason:'Every original person appears once'};
 const v=withFraming(base,aligned({dy:-.19}));
 assert.equal(v.ok,false);assert.equal(v.defect,'framing_drift');assert.match(v.reason,/^framing_drift: .*dy -19\.0%/);
 const hand=withFraming({ok:false as boolean|null,reason:'extra_hand: x',defect:'extra_hand' as 'extra_hand'|'framing_drift'},aligned({dy:-.19}));
 assert.equal(hand.defect,'extra_hand');assert.match(hand.reason,/extra_hand: x; framing_drift/);
 assert.equal(withFraming(base,{status:'unavailable'}),base);
 assert.equal(framingFacts(aligned({dy:-.19})).drift,'dy -19.0%');assert.equal(framingFacts(aligned()).drift,undefined);
});
test('inspectAndCaption runs the framing check against frameSource (NOW), records facts, and falls back to VLM-only',async t=>{
 const seen:Buffer[][]=[];
 const run=async(r:FrameAlignResult,frameSource?:string)=>{
  t.mock.restoreAll();
  t.mock.method(globalThis,'fetch',async()=>Response.json({response:JSON.stringify({people:[person]}),done_reason:'stop'}));
  t.mock.method(handCounter,'count',async()=>({status:'no-hands',count:0,hands:[]}));
  t.mock.method(frameAligner,'align',async(s:Buffer,o:Buffer)=>{seen.push([s,o]);return r;});
  return inspectAndCaption('data:image/png;base64,UkVDRU5U',img,1,15,[],undefined,frameSource);
 };
 let v=await run(aligned({dy:-.1859,rotationDeg:-1.014,inliers:893,edgeIou:.535}),'data:image/jpeg;base64,Tk9X');
 assert.equal(v.ok,false);assert.equal(v.defect,'framing_drift');
 assert.equal(seen.at(-1)![0].toString(),'NOW');assert.equal(seen.at(-1)![1].toString(),'test');
 assert.equal(v.observationFacts.framing?.dy,-.1859);assert.equal(v.observationFacts.framing?.drift,'dy -18.6%');
 v=await run(aligned());assert.equal(v.ok,true);assert.equal(seen.at(-1)![0].toString(),'RECENT');// default: source
 v=await run({status:'unavailable'});assert.equal(v.ok,true);assert.equal(v.observationFacts.framing?.status,'unavailable');
});
test('reference-cast inspection applies the same framing rule',async t=>{
 const p={position:'left',pose:'seated',clothes:'blue shirt',facing:'away'};
 const ref={contentId:'uploaded-ref',imageDataUrl:'data:image/png;base64,'+Buffer.from('reference').toString('base64'),sha256:createHash('sha256').update('reference').digest('hex'),people:[{position:'center',pose:'standing',clothes:'red jacket',facing:'front'}]};
 const cast=(inventoryId:string)=>({...person,inventoryId});
 t.mock.method(globalThis,'fetch',async()=>Response.json({response:JSON.stringify({originalSourceCount:1,people:[cast('ref:uploaded-ref:0'),cast('source:0')]}),done_reason:'stop'}));
 t.mock.method(handCounter,'count',async()=>({status:'no-hands',count:0,hands:[]}));
 t.mock.method(frameAligner,'align',async()=>aligned({scale:1.09}));
 const v=await inspectAndCaptionWithReferences(img,img,[p],[ref],15);
 assert.equal(v.ok,false);assert.equal(v.defect,'framing_drift');assert.equal(v.observationFacts.framing?.scale,1.09);
});
test('frame-align.py on the archived 17-28-38 frames: C drifts, A keeps the framing',{timeout:60000},async t=>{
 const dir=path.join(archiveRootDir(),'2026-10-19','2026-10-19_17-27-37');
 if(!fs.existsSync(path.join(dir,'2026-10-19_17-27-37_C.png')))return t.skip('archive not present');
 const now=fs.readFileSync(path.join(dir,'2026-10-19_17-27-37_NOW.jpg'));
 const c=await alignFrames(now,fs.readFileSync(path.join(dir,'2026-10-19_17-27-37_C.png')));
 if(c.status==='unavailable')return t.skip('python/cv2 unavailable');
 assert.match(framingDriftReason(c)??'',/dy -1\d\.\d%/);
 const a=await alignFrames(now,fs.readFileSync(path.join(dir,'2026-10-19_17-27-37_A.png')));
 assert.equal(framingDriftReason(a),null);assert.ok(a.edgeIou!>.75);
});
