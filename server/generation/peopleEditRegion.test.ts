import test from 'node:test';
import assert from 'node:assert/strict';
import {peopleEditRegion,applyPeopleEditRegion} from './peopleEditRegion';
const source={count:1,persons:[{score:.93,box:[988,243,1280,718]}],inferenceMs:50,elapsedMs:60};
test('local pose edit leaves room for hands while excluding the empty opposite side',()=>{
 const region=peopleEditRegion(source,1,{width:1280,height:720},'The person raises her free hand.')!;
 assert.ok(region.rectangles[0].x<988&&region.rectangles[0].x>800);
 assert.equal(region.rectangles[0].x+region.rectangles[0].width,1280);
 assert.ok(region.rectangles[0].y<243);
});
test('missing people and relocation do not get clipped into an incorrect local region',()=>{
 assert.equal(peopleEditRegion(source,2,{width:1280,height:720},'She smiles.'),undefined);
 for(const action of ['She walks to the left.','He leaves the frame.','They move to the table.'])assert.equal(peopleEditRegion(source,1,{width:1280,height:720},action),undefined);
});
test('both diffusion and final pixels are constrained; original source supplies the unchanged outside',()=>{
 const wf:any={'60':{inputs:{latent_image:['50',0]}},'80':{inputs:{images:['75',0]}}};
 applyPeopleEditRegion(wf,peopleEditRegion(source,1,{width:1280,height:720},'She smiles.')!);
 assert.deepEqual(wf['60'].inputs.latent_image,['97',0]);
 assert.deepEqual(wf['97'].inputs.samples,['50',0]);
 assert.deepEqual(wf['80'].inputs.images,['100',0]);
 assert.deepEqual(wf['100'].inputs.destination,['99',0]);
 assert.deepEqual(wf['99'].inputs.image,['20',0]);
 assert.deepEqual(wf['100'].inputs.mask,['96',0]);
 assert.deepEqual(wf['94'].inputs.mask,['112',0]);
});
test('multiple original people each get an edit region, with invalid rectangles refused',()=>{
 const detection={...source,count:2,persons:[{score:.9,box:[0,300,200,720]},{score:.9,box:[988,243,1280,718]}]};
 const region=peopleEditRegion(detection,2,{width:1280,height:720},'Both people turn their heads.')!;
 const wf:any={'60':{inputs:{}},'80':{inputs:{}}};applyPeopleEditRegion(wf,region);
 assert.equal(region.rectangles.length,2);assert.deepEqual(wf['94'].inputs.mask,['115',0]);
 assert.throws(()=>applyPeopleEditRegion(wf,{width:1280,height:720,rectangles:[{x:1279,y:0,width:2,height:10}]}));
});
test('standing and sitting expand vertically while preserving the original body and horizontal corridor',()=>{
 const size={width:1280,height:720};
 const ordinary=peopleEditRegion(source,1,size,'She smiles.')!.rectangles[0];
 for(const action of ['She stands up.','She is standing.','He rises.','She gets up.','She is sitting down.','He takes a seat.']){
  const r=peopleEditRegion(source,1,size,action)!.rectangles[0];
  assert.equal(r.x,ordinary.x);assert.equal(r.width,ordinary.width);
  assert.equal(r.y,0);assert.equal(r.y+r.height,720);
  assert.ok(r.x<=988&&r.x+r.width>=1280&&r.y<=243&&r.y+r.height>=718);
 }
});
test('vertical transitions preserve space between people and stay inside image edges',()=>{
 const detection={...source,count:2,persons:[{score:.9,box:[0,0,120,200]},{score:.9,box:[1100,300,1280,720]}]};
 const region=peopleEditRegion(detection,2,{width:1280,height:720},'They stand up.')!;
 const [left,right]=region.rectangles;
 assert.ok(left.x+left.width<right.x);
 for(const r of region.rectangles){
  assert.ok(Object.values(r).every(Number.isInteger));
  assert.ok(r.x>=0&&r.y>=0&&r.x+r.width<=1280&&r.y+r.height<=720);
 }
});
test('a short seated upper-body detection still permits the standing head above it',()=>{
 const detection={...source,persons:[{score:.9,box:[433,492,724,720]}]};
 const ordinary=peopleEditRegion(detection,1,{width:1280,height:720},'She smiles.')!.rectangles[0];
 const standing=peopleEditRegion(detection,1,{width:1280,height:720},'She stands up.')!.rectangles[0];
 assert.ok(ordinary.y>400);
 assert.deepEqual({x:standing.x,width:standing.width},{x:ordinary.x,width:ordinary.width});
 assert.equal(standing.y,0);assert.equal(standing.height,720);
});
test('invalid dimensions and out-of-frame boxes never create an oversized edit region',()=>{
 for(const size of [{width:0,height:720},{width:1280,height:NaN},{width:1280.5,height:720}])assert.equal(peopleEditRegion(source,1,size,'She stands up.'),undefined);
 for(const box of [[-10,20,120,200],[0,-1,120,200],[0,0,1281,720],[0,0,120,721],[10,10,5,200]])assert.equal(peopleEditRegion({...source,persons:[{score:.9,box}]},1,{width:1280,height:720},'She sits down.'),undefined);
});
test('a real low-confidence box corroborated by an independent head restores all original people',()=>{
 const detection={count:1,persons:[{score:.93,box:[0,371,290,718]}],candidates:[{score:.93,box:[0,371,290,718]},{score:.19,box:[967,431,1272,673]}],inferenceMs:60,elapsedMs:70};
 const heads:[number,number,number,number][]=[[0,500,140,750],[850,570,960,690]];
 const region=peopleEditRegion(detection,2,{width:1280,height:720},'The left person leans forward.',heads)!;
 assert.equal(region.sourceEvidence?.method,'cpu-head-corroborated');
 assert.equal(region.sourceEvidence?.originalStrongCount,1);
 assert.equal(region.rectangles.length,2);
 assert.ok(region.rectangles[0].x+region.rectangles[0].width<region.rectangles[1].x);
 assert.equal(peopleEditRegion(detection,2,{width:1280,height:720},'They walk across the room.',heads),undefined);
});
test('head observations never fabricate a body or resolve ambiguous candidate correspondence',()=>{
 const detection={count:1,persons:[{score:.93,box:[0,371,290,718]}],candidates:[{score:.99,box:[0,0,1280,720]}],inferenceMs:60,elapsedMs:70};
 const heads:[number,number,number,number][]=[[0,500,140,750],[850,570,960,690]];
 assert.equal(peopleEditRegion(detection,2,{width:1280,height:720},'They smile.',heads),undefined);
 assert.equal(peopleEditRegion({...detection,candidates:[{score:.19,box:[967,431,1272,673]}]},2,{width:1280,height:720},'They smile.',[heads[0],null]),undefined);
 assert.equal(peopleEditRegion({...detection,candidates:[]},2,{width:1280,height:720},'They smile.',heads),undefined);
});

test('explicit overhead and shoulder-height hands or cheering keep horizontal corridor and permit full-height motion',()=>{
 const size={width:1280,height:720};
 const baseline=peopleEditRegion(source,1,size,'She smiles.')!.rectangles[0];
 for(const action of ['The person is cheering.','She cheers.','He cheered.','She raises both hands overhead.','He lifts one arm above the head.','Her hands are held at shoulder height.','One hand is shoulder-high.','She raises a hand above shoulder level.']){
  const region=peopleEditRegion(source,1,size,action)!;const r=region.rectangles[0];
  assert.deepEqual({x:r.x,width:r.width},{x:baseline.x,width:baseline.width});assert.equal(r.y,0);assert.equal(r.height,720);
  const wf:any={'60':{inputs:{}},'80':{inputs:{}}};applyPeopleEditRegion(wf,region);
  assert.equal(wf['111'].inputs.top,0);assert.equal(wf['111'].inputs.bottom,0);
 }
});
test('cheerful expressions, low hand actions and nearby cups do not expand motion to full height',()=>{
 const size={width:1280,height:720};
 const baseline=peopleEditRegion(source,1,size,'She smiles.')!.rectangles[0];
 for(const action of ['She has a cheerful smile.','She raises one hand slightly.','She holds a cup near her face.','She places her hands on the desk.'])assert.deepEqual(peopleEditRegion(source,1,size,action)!.rectangles[0],baseline);
 assert.equal(peopleEditRegion(source,1,size,'She walks across the room with hands overhead.'),undefined);
});
test('cheering full-height corridors retain unedited gaps between separate source people',()=>{
 const detection={...source,count:2,persons:[{score:.9,box:[0,300,120,710]},{score:.9,box:[1100,300,1280,720]}]};
 const regions=peopleEditRegion(detection,2,{width:1280,height:720},'One person is cheering.')!.rectangles;
 assert.ok(regions[0].x+regions[0].width<regions[1].x);assert.ok(regions.every(r=>r.y===0&&r.height===720));
});
