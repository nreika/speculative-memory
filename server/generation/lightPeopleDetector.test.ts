import test from 'node:test';
import assert from 'node:assert/strict';
import {extraPeopleVerdict,classifySingleActorPartOverlap,classifySingleActorNearDuplicateOverlap,classifySingleActorCountAmbiguity} from './lightPeopleDetector';
const detection=(count:number)=>({count,persons:[],inferenceMs:60,elapsedMs:70});
test('independent count rejects two bodies even if VLM claims one',()=>{
 assert.equal(extraPeopleVerdict(detection(2),1)?.ok,false);
});
test('equal counts do not certify distinct identities',()=>{
 assert.equal(extraPeopleVerdict(detection(2),2),null);
});
test('missed small background person does not falsely reject the image',()=>{
 assert.equal(extraPeopleVerdict(detection(1),2),null);
});
test('empty scene with a generated person is rejected',()=>{
 assert.equal(extraPeopleVerdict(detection(1),0)?.ok,false);
});

const source=[{box:[100,100,200,200]}];
const overlapDetection=()=>({count:2,persons:[{score:.93,box:[100,100,300,300]},{score:.53,box:[90,120,170,250]}],inferenceMs:1,elapsedMs:2});
test('partial overlapping detections remain uncertain with honest raw count and strict evidence',()=>{
 const d=overlapDetection(),before=JSON.stringify(d),e=classifySingleActorPartOverlap(d,1,source);
 assert.ok(e);assert.equal(e.rawDetectorCount,2);assert.equal(e.countUncertain,true);assert.equal(e.identityProof,false);assert.equal(e.requiresInventoryConfirmation,true);
 assert.equal(JSON.stringify(d),before);assert.equal(extraPeopleVerdict(d,1)?.ok,false);
});
test('well separated people, equal-sized duplicate boxes and confident second person keep hard rejection',()=>{
 for(const secondary of [{score:.53,box:[400,100,500,300]},{score:.53,box:[100,100,300,300]},{score:.86,box:[90,120,170,250]}]){
  const d=overlapDetection();d.persons[1]=secondary;assert.equal(classifySingleActorPartOverlap(d,1,source),null);assert.equal(extraPeopleVerdict(d,1)?.ok,false);
 }
});
test('missing/multiple sources and unknown expected population cannot defer inventory',()=>{
 for(const [expected,actors] of [[0,source],[2,source],[1,[]],[1,[...source,...source]]] as const)assert.equal(classifySingleActorPartOverlap(overlapDetection(),expected,actors),null);
 assert.equal(classifySingleActorPartOverlap(overlapDetection(),1,[{box:[900,100,200,200]}]),null);
});
test('score, count, malformed dimensions, area/containment and center bounds fail closed',()=>{
 for(const mutate of [
  (d:any)=>d.persons[0].score=.849,(d:any)=>d.persons[1].score=.651,(d:any)=>d.persons[1].score=.499,
  (d:any)=>d.persons[1].score=NaN,(d:any)=>d.persons[1].box=[1,2],(d:any)=>d.persons[1].box=[90,120,80,250],
  (d:any)=>d.count=3,(d:any)=>d.count=1,(d:any)=>d.persons.push({...d.persons[1]}),
  (d:any)=>d.persons[1].box=[80,100,240,280],(d:any)=>d.persons[1].box=[30,120,130,250]
 ]){const d=overlapDetection();mutate(d);assert.equal(classifySingleActorPartOverlap(d,1,source),null);}
});
test('classification is independent of detector order and does not infer a confirmed count',()=>{
 const a=overlapDetection(),b=overlapDetection();b.persons.reverse();assert.deepEqual(classifySingleActorPartOverlap(a,1,source),classifySingleActorPartOverlap(b,1,source));
});

test('finite coordinates whose derived geometry overflows cannot defer count veto',()=>{
 const d={count:2,persons:[{score:.93,box:[0,0,1e200,1e200]},{score:.53,box:[4.5e199,4.5e199,5.5e199,5.5e199]}],inferenceMs:1,elapsedMs:2};
 assert.equal(classifySingleActorPartOverlap(d,1,[{box:[0,0,1e200,1e200]}]),null);
});

const nearDetection=()=>({count:2,persons:[{score:.72,box:[100,100,300,500]},{score:.62,box:[60,104,240,504]}],inferenceMs:1,elapsedMs:2});
const nearSource=[{box:[100,250,150,250]}];
test('aligned body overlap is only uncertainty, with raw count and normal veto unchanged',()=>{
 const d=nearDetection(),before=JSON.stringify(d),e=classifySingleActorNearDuplicateOverlap(d,1,nearSource);
 assert.ok(e);assert.equal(e.kind,'near-duplicate-body-overlap-uncertain');assert.equal(e.rawDetectorCount,2);assert.equal(e.countUncertain,true);assert.equal(e.identityProof,false);assert.equal(e.requiresInventoryConfirmation,true);
 assert.equal(JSON.stringify(d),before);assert.equal(extraPeopleVerdict(d,1)?.ok,false);assert.equal(classifySingleActorCountAmbiguity(d,1,nearSource)?.kind,e.kind);
});
test('near-body classification rejects boundary violations without changing small-part policy',()=>{
 for(const mutate of [
  (d:any)=>d.persons[0].score=.6999,(d:any)=>d.persons[1].score=.5999,
  (d:any)=>d.persons[1].box=[60,141,240,541],(d:any)=>d.persons[1].box=[60,100,240,550],
  (d:any)=>d.persons[1].box=[60,100,120,500],(d:any)=>d.persons[1].box=[30,100,300,500],
  (d:any)=>d.persons[1].box=[-100,100,100,500],(d:any)=>d.persons[1].score=NaN,
  (d:any)=>d.persons[1].box=[0,0,1e200,1e200],(d:any)=>d.count=3,(d:any)=>d.persons.push({...d.persons[1]})
 ]){const d=nearDetection();mutate(d);assert.equal(classifySingleActorNearDuplicateOverlap(d,1,nearSource),null);}
 assert.equal(classifySingleActorNearDuplicateOverlap(nearDetection(),2,nearSource),null);
 assert.equal(classifySingleActorNearDuplicateOverlap(nearDetection(),1,[...nearSource,...nearSource]),null);
 assert.equal(classifySingleActorNearDuplicateOverlap(nearDetection(),1,[{box:[900,250,150,250]}]),null);
 assert.equal(classifySingleActorPartOverlap(nearDetection(),1,nearSource),null);
});
test('separate real-person layouts and dissimilar overlapping bodies retain count rejection',()=>{
 for(const box of [[310,100,510,500],[230,100,430,500],[160,210,280,500],[100,350,180,500]]){
  const d=nearDetection();d.persons[1].box=box;assert.equal(classifySingleActorNearDuplicateOverlap(d,1,nearSource),null);assert.equal(extraPeopleVerdict(d,1)?.ok,false);
 }
});
test('geometry cannot certify one person even for heavily overlapping two-person shapes',()=>{
 const d=nearDetection();d.persons[1].box=[130,100,290,500];
 const e=classifySingleActorNearDuplicateOverlap(d,1,nearSource);assert.ok(e);assert.equal(e.identityProof,false);assert.equal(e.countUncertain,true);assert.equal(e.requiresInventoryConfirmation,true);assert.equal(extraPeopleVerdict(d,1)?.ok,false);
});
test('near-body finite inputs with overflowing derived metrics fail closed',()=>{
 const d={count:2,persons:[{score:.72,box:[0,0,1e200,1e200]},{score:.62,box:[0,0,9e199,1e200]}],inferenceMs:1,elapsedMs:2};
 assert.equal(classifySingleActorNearDuplicateOverlap(d,1,[{box:[0,0,1e200,1e200]}]),null);
});
