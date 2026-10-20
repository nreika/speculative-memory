import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildSceneReferenceCast,parseSceneReferenceCastIntegrity,composeSceneReferenceCastInstruction,type ScenePersonReference} from './sceneReferenceCast';
const original={position:'left front',pose:'seated',clothes:'blue shirt',facing:'away',hair:'short black',holding:'cup in left hand'};
const newcomer={position:'center',pose:'standing',clothes:'red jacket',facing:'front',hair:'long brown'};
const ref=(id='upload-1',bytes='reference'):ScenePersonReference=>({contentId:id,imageDataUrl:'data:image/png;base64,'+Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),people:[newcomer]});
const answer=(ids:string[],count=1)=>({originalSourceCount:count,people:ids.map(inventoryId=>({inventoryId}))});
test('finite roster preserves source identities and explicitly appends every person in a reference',()=>{
 const r=ref();r.people=[newcomer,{...newcomer,clothes:'green top'}];const cast=buildSceneReferenceCast([original], [r]);
 assert.equal(cast.originalSourceCount,1);assert.equal(cast.expectedSceneTotal,3);
 assert.deepEqual(cast.allowedInventory.map(x=>x.id),['source:0','ref:upload-1:0','ref:upload-1:1']);
 assert.ok(Object.isFrozen(cast.allowedInventory));assert.doesNotMatch(JSON.stringify(cast),/base64|imageDataUrl/);
});
test('reordered complete identities are accepted with source index and explicit reference -1 preserved',()=>{
 const cast=buildSceneReferenceCast([original],[ref()]);const v=parseSceneReferenceCastIntegrity(answer(['ref:upload-1:0','source:0']),cast);
 assert.equal(v.ok,true);assert.equal(v.sourceCount,1);assert.equal(v.expectedInventoryCount,2);assert.deepEqual(v.outputToSource,[-1,0]);
 assert.deepEqual(v.outputToInventoryIds,['ref:upload-1:0','source:0']);
});
test('matching total cannot hide copied source, copied reference, unknown person or missing original',()=>{
 const cast=buildSceneReferenceCast([original],[ref()]);
 for(const ids of [['source:0','source:0'],['ref:upload-1:0','ref:upload-1:0'],['source:0','unknown'],['source:0','unrequested'],['ref:upload-1:0'],['source:0','ref:upload-1:0','unknown']])assert.equal(parseSceneReferenceCastIntegrity(answer(ids),cast).ok,false);
 assert.equal(parseSceneReferenceCastIntegrity(answer(['source:0','ref:upload-1:0'],0),cast).ok,false);
});
test('malformed/truncated inventory is unknown, never accepted',()=>{
 const cast=buildSceneReferenceCast([original],[ref()]);
 for(const value of ['{',{}, {originalSourceCount:1,people:[{}]}, {originalSourceCount:1,people:[{inventoryId:99}]},{originalSourceCount:1,people:Array(13).fill({inventoryId:'source:0'})}])assert.equal(parseSceneReferenceCastIntegrity(value,cast).ok,null);
});
test('duplicate IDs, duplicate image bytes and changed hashes are rejected before model work',()=>{
 assert.throws(()=>buildSceneReferenceCast([original],[ref(),ref()]),/duplicate|collision/);
 assert.throws(()=>buildSceneReferenceCast([original],[ref(),ref('other')]),/duplicate image/);
 assert.throws(()=>buildSceneReferenceCast([original],[{...ref(),sha256:'0'.repeat(64)}]),/hash/);
 assert.throws(()=>buildSceneReferenceCast([original],[{...ref(),contentId:'../private'}]),/contentId/);
 assert.throws(()=>buildSceneReferenceCast([original],[{...ref(),people:[]}]),/observed person/);
});
test('source identity references keep their full slots and added refs use free slots',()=>{
 const cast=buildSceneReferenceCast([original],[ref()], [{imageNumber:2,sourceIndexes:[0]},{imageNumber:3,sourceIndexes:[0]}]);
 assert.equal(cast.allowedInventory[1].imageNumber,4);assert.deepEqual(cast.imageBindings.map(x=>x.imageNumber),[1,2,3,4]);
 assert.throws(()=>buildSceneReferenceCast([original],[{...ref(),imageNumber:2}],[{imageNumber:2,sourceIndexes:[0]}]),/collision/);
});
test('explicit slots are reserved before implicit assignment without mutating references',()=>{
 const refs=[ref(),{...ref('second','second-image'),imageNumber:2}];const before=JSON.stringify(refs);const cast=buildSceneReferenceCast([original],refs);
 assert.equal(JSON.stringify(refs),before);assert.deepEqual(cast.allowedInventory.slice(1).map(x=>x.imageNumber),[3,2]);
});
test('explicit roster count is not the legacy eight-person cap, while invalid original bindings still fail',()=>{
 assert.equal(buildSceneReferenceCast(Array(8).fill(original),[ref()]).expectedSceneTotal,9);
 assert.throws(()=>buildSceneReferenceCast([original],[ref()],[{imageNumber:2,sourceIndexes:[1]}]),/binding/);
 assert.throws(()=>parseSceneReferenceCastIntegrity(answer(['x']),{originalSourceCount:1,expectedSceneTotal:1,allowedInventory:[{id:'x',origin:'source',personIndex:0,imageNumber:1}],imageBindings:[]}),/roster/);
});
test('sparse image slots cannot mislabel the encoder ordered image list',()=>{
 assert.throws(()=>buildSceneReferenceCast([original],[{...ref(),imageNumber:5}]),/contiguous/);
 const cast=buildSceneReferenceCast([original],[ref()],[{imageNumber:3,sourceIndexes:[0]}]);
 assert.deepEqual(cast.imageBindings.map(b=>b.imageNumber),[1,2,3]);assert.equal(cast.allowedInventory[1].imageNumber,2);
});
test('dedicated instruction permits only the added cast without conflicting old-original clauses',()=>{
 const text=composeSceneReferenceCastInstruction({sourcePeople:[original],references:[ref()],sourceIdentityImages:[{imageNumber:2,sourceIndexes:[0]}],predictionPrompt:'The original person and reference person talk to each other. Change the white balance.'});
 assert.match(text,/Exactly 2 people are permitted/);assert.match(text,/retain all 1 source people once/);assert.match(text,/image2 supplies identity detail only for source:0/);assert.match(text,/image3, reference person 1/);
 assert.match(text,/Do not paste a rectangular photo/);assert.match(text,/cup in left hand/);assert.match(text,/white balance, shadows/);
 assert.doesNotMatch(text,/Change the white balance|SAME original people|image1 alone determines the people count|Exactly 1 original/);
});


test('reference-image capacity is separate from inventory count: empty original plus eight single-person refs is valid',()=>{
 const refs=Array.from({length:8},(_,i)=>ref('new-'+i,'unique-image-'+i));const cast=buildSceneReferenceCast([],refs);
 assert.equal(cast.originalSourceCount,0);assert.equal(cast.expectedSceneTotal,8);assert.equal(cast.imageBindings.length,9);assert.equal(cast.imageBindings.at(-1)!.imageNumber,9);
 const nine=buildSceneReferenceCast([original],refs);assert.equal(nine.expectedSceneTotal,9);const ids=nine.allowedInventory.map(p=>p.id);assert.equal(parseSceneReferenceCastIntegrity(answer(ids),nine).ok,true);assert.equal(parseSceneReferenceCastIntegrity(answer([...ids.slice(0,-1),ids[0]]),nine).ok,false);
 assert.throws(()=>buildSceneReferenceCast([],Array.from({length:16},(_,i)=>ref('n-'+i,'b-'+i))),/Invalid cast references/);
});

test('fifteen single-person references use the model input slots without a total-people eight cap',()=>{
 const refs=Array.from({length:15},(_,i)=>ref('ref-'+i,'different-'+i));const roster=buildSceneReferenceCast([],refs);assert.equal(roster.expectedSceneTotal,15);assert.equal(roster.imageBindings.length,16);
 const ids=roster.allowedInventory.map(p=>p.id);assert.equal(parseSceneReferenceCastIntegrity(answer(ids,0),roster).ok,true);assert.equal(parseSceneReferenceCastIntegrity(answer(ids.slice(1),0),roster).ok,false);
});

const placementText=(placement?:'same-camera'|'appearance-only')=>composeSceneReferenceCastInstruction({sourcePeople:[original],references:[{...ref(),placement}],predictionPrompt:'They talk.'});
test('same-camera placement instruction puts the person at the observed position at real scale',()=>{
 const text=placementText('same-camera');
 assert.match(text,/full frame from this same fixed camera at another time/);assert.match(text,/real size, as a separate full body/);
 assert.doesNotMatch(text,/appearance only, not a room position/);
});
test('appearance-only placement instruction uses a free spot away from source people',()=>{
 const text=placementText('appearance-only');
 assert.match(text,/appearance only, not a room position/);assert.match(text,/free floor or seat area/);assert.match(text,/must not overlap, replace or merge/);
 assert.doesNotMatch(text,/same fixed camera at another time/);
});
test('source person keeps only its own face, hair and clothing in both placements',()=>{
 for(const p of ['same-camera','appearance-only'] as const)assert.match(placementText(p),/source:0 keeps only image1's own face, hair and clothing; never give source:0 a face, hairstyle, headwear, clothing or belongings from any reference image/);
});
