import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBelongings,withBelongings,belongingsList,inspectAndCaption,inspectionDefectType} from './combinedInspection';

const img='data:image/png;base64,dGVzdA==';
const hand={visibility:'visible',height:'below_shoulder',contact:'none',palm:'not_open'};
const person={sourceIndex:0,posture:'standing',leftHand:hand,rightHand:hand,raisedHands:0,objectHands:0,otherHands:2,handPositions:['side','side'],hands:2};
const names=['blue backpack','black jacket'];

test('missing_belongings parsing: all true passes, one false rejects, no list skips, missing answer is unknown',()=>{
 const all=parseBelongings({objectsVisible:{'blue backpack':true,'black jacket':true}},names)!;
 assert.deepEqual(all.missing,[]);assert.equal(withBelongings({ok:true,reason:'fine'},all).ok,true);
 const one=parseBelongings({objectsVisible:{'blue backpack':false,'black jacket':true}},names)!;
 assert.deepEqual(one,{checked:names,visible:{'blue backpack':false,'black jacket':true},missing:['blue backpack']});
 const r=withBelongings({ok:true as boolean|null,reason:'fine'},one);
 assert.equal(r.ok,true);assert.equal((r as {defect?:string}).defect,undefined);
 assert.equal(parseBelongings({objectsVisible:{a:false}},[]),undefined);
 assert.equal(withBelongings({ok:true,reason:'fine'},undefined).ok,true);
 assert.deepEqual(parseBelongings({},names)!.missing,[]);
 const earlier=withBelongings({ok:false as boolean|null,reason:'extra_hand: x',defect:'extra_hand' as const},one);
 assert.equal(earlier.defect,'extra_hand');assert.equal(earlier.ok,false);
 assert.deepEqual(belongingsList(['Blue backpack','blue backpack','blue water bottle','laptop','red bag','black jacket','green coat','umbrella','grey hoodie','scarf']),['blue backpack','red bag','black jacket','green coat','umbrella','grey hoodie']);
 assert.equal(inspectionDefectType('missing_belongings'),'missing_belongings');assert.equal(inspectionDefectType(undefined),'fabricated_person');assert.equal(inspectionDefectType('count'),'fabricated_person');
});

test('missing_belongings in the single inspection call: schema + instruction only with a list; one false rejects; facts recorded',async t=>{
 let body:any;let answer:any={people:[person]};let calls=0;
 t.mock.method(globalThis,'fetch',async(_i:unknown,init?:RequestInit)=>{calls++;body=JSON.parse(String(init?.body));return Response.json({response:JSON.stringify(answer),done_reason:'stop'});});
 const skip=await inspectAndCaption(img,img,1,15,[]);
 assert.equal(skip.ok,true);assert.equal(body.format.properties.objectsVisible,undefined);assert.doesNotMatch(body.prompt,/objectsVisible/);assert.equal(skip.observationFacts.belongings,undefined);
 answer={people:[person],objectsVisible:{'blue backpack':true,'black jacket':true}};
 const ok=await inspectAndCaption(img,img,1,15,[],undefined,img,names);
 assert.equal(ok.ok,true);
 assert.deepEqual(body.format.required,['people','duplicateObject','objectsVisible']);assert.deepEqual(body.format.properties.objectsVisible.required,names);
 assert.match(body.prompt,/for each listed object say whether it is still visible in the OUTPUT image \(the finished photo\) at roughly the same place; hidden by a person or removed = false\./);
 assert.deepEqual(ok.observationFacts.belongings,{checked:names,visible:{'blue backpack':true,'black jacket':true},missing:[]});
 answer={people:[person],objectsVisible:{'blue backpack':false,'black jacket':true}};
 const bad=await inspectAndCaption(img,img,1,15,[],undefined,img,names);
 assert.equal(bad.ok,true);assert.equal(bad.defect,undefined);assert.deepEqual(bad.observationFacts.belongings!.missing,['blue backpack']);
 assert.equal(calls,3);
});

test('mechanical duplicate check: objects named in the action are counted in the original and the output; more in the output rejects',async t=>{
 let body:any;let answer:any;
 t.mock.method(globalThis,'fetch',async(_i:unknown,init?:RequestInit)=>{body=JSON.parse(String(init?.body));return Response.json({response:JSON.stringify(answer),done_reason:'stop'});});
 answer={people:[person],duplicateObject:false,objectCounts:{bottle:{original:1,output:2}}};
 const bad=await inspectAndCaption(img,img,1,15,[],undefined,img,[],'The person picks up the blue bottle and holds it.',false);
 assert.equal(body.images.length,2);assert.deepEqual(body.format.properties.objectCounts.required,['bottle']);assert.ok(body.format.required.includes('objectCounts'));
 assert.match(body.prompt,/OBJECT COUNTS/);
 assert.equal(bad.ok,false);assert.equal(bad.defect,'duplicate_object');assert.match(bad.reason,/bottle: 1 -> 2/);
 answer={people:[person],duplicateObject:false,objectCounts:{bottle:{original:1,output:1}}};
 assert.equal((await inspectAndCaption(img,img,1,15,[],undefined,img,[],'The person picks up the blue bottle and holds it.',false)).ok,true);
 answer={people:[person],duplicateObject:false};
 const none=await inspectAndCaption(img,img,1,15,[],undefined,img,[],'The person stretches both arms forward.',true);
 assert.equal(body.images.length,1);assert.equal(body.format.properties.objectCounts,undefined);assert.equal(none.ok,true);
});
