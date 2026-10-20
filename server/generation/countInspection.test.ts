import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectCountedImage} from './countInspection';
const d={count:2,persons:[{score:.9237,box:[386.8,446.2,812.8,717.5]},{score:.5315,box:[343.8,456.6,508.9,667]}],inferenceMs:119,elapsedMs:130};
const sourceActors=[{box:[380,440,440,280] as [number,number,number,number]}];
const good={ok:true,sourceCount:1,outputToSource:[0],reason:'One visible human'};
test('part-overlap retains raw count and requires exactly one existing inventory call',async()=>{
 let calls=0;const r=await inspectCountedImage({detection:d,expectedPeople:1,sourceActors,allowPartOverlap:true,inspect:async()=>{calls++;return good;}});
 assert.equal(calls,1);assert.equal(r.ok,true);assert.ok('detector' in r);if(!('detector' in r))throw Error('Missing raw detector evidence');assert.equal(r.detector.count,2);assert.equal(d.count,2);assert.equal(r.detector.vetoDeferredToExistingInventory,true);
});
test('negative, unknown, duplicate and unmatched inventory never become successful',async()=>{
 for(const verdict of [{...good,ok:false},{...good,ok:null,sourceCount:null},{...good,outputToSource:[0,0]},{...good,outputToSource:[-1]},{...good,sourceCount:2}]){
  let calls=0;const r=await inspectCountedImage({detection:d,expectedPeople:1,sourceActors,allowPartOverlap:true,inspect:async()=>{calls++;return verdict;}});assert.equal(calls,1);assert.notEqual(r.ok,true);
 }
});
test('inventory failure propagates to the existing unknown/rejection path',async()=>{
 await assert.rejects(inspectCountedImage({detection:d,expectedPeople:1,sourceActors,allowPartOverlap:true,inspect:async()=>{throw Error('truncated or unavailable');}}),/truncated/);
});
test('separate people, absent source proof and other engines retain the independent count veto',async()=>{
 for(const overrides of [{allowPartOverlap:false},{sourceActors:undefined},{sourceActors:[...sourceActors,...sourceActors]},{expectedPeople:0},{detection:{...d,persons:[d.persons[0],{score:.5315,box:[0,0,180,250]}]}}]){
  let calls=0;const r=await inspectCountedImage({detection:d,expectedPeople:1,sourceActors,allowPartOverlap:true,...overrides,inspect:async()=>{calls++;return good;}});assert.equal(calls,0);assert.notEqual(r.ok,true);
 }
});
