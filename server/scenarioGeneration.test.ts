import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeScenarioEditRegion,validateScenarioSceneCount,prepareScenarioInputs,validateScenarioModes,assertAssetOnlyTargets,assetOnlyEditInstruction,scenarioPeoplePolicy,scenarioNeedsFullFrame} from './scenarioGeneration';
import type {ValidatedScenarioControl} from './scenarioControl';
const control={version:1,scenarioId:'s',runId:'r',elapsedSec:0,cycle:0,cueIds:[],sceneElements:{gen_a:[{image:'data:image/png;base64,eA==',imageSha256:'x'}]},stage:'validation-only'} as unknown as ValidatedScenarioControl;

test('scenario asset geometry is local to the scene, including empty or unapplied assets',()=>{
 const asset={editRectangles:[{x:25,y:568,width:63,height:95}]};
 assert.equal(scenarioNeedsFullFrame('asset_only',asset),true);
 assert.equal(scenarioNeedsFullFrame('people_and_assets',asset),true);
 assert.equal(scenarioNeedsFullFrame(undefined,undefined),false);
 assert.equal(scenarioNeedsFullFrame(undefined,{editRectangles:[]}),false);
 assert.equal(scenarioNeedsFullFrame('people_and_assets',{editRectangles:[]}),false);
});
test('one-image requests accept gen_a and reject silently omitted later scenes',()=>{
 assert.doesNotThrow(()=>validateScenarioSceneCount(control,1));
 assert.throws(()=>validateScenarioSceneCount({...control,sceneElements:{gen_b:[]}},1),/outside imageCount/);
});
test('asset target joins both sampler and final region while unknown people stay unrestricted',()=>{
 const target={x:20,y:600,width:100,height:90},size={width:1280,height:720};
 assert.deepEqual(mergeScenarioEditRegion(undefined,[target],size,0)?.rectangles,[target]);
 assert.equal(mergeScenarioEditRegion(undefined,[target],size,1),undefined);
 const person={...size,rectangles:[{x:900,y:0,width:380,height:720}]};
 assert.deepEqual(mergeScenarioEditRegion(person,[target],size,1)?.rectangles,[...person.rectangles,target]);
 assert.throws(()=>mergeScenarioEditRegion(person,[{...target,x:1270}],size,1),/Invalid scenario/);
});
test('person-positive assets are rejected before composition and identical hashes are checked once',async()=>{
 let composed=0,checked=0;
 const compose:any=async()=>{composed++;return {width:1,height:1,sourceSha256:'x',scenes:{}}};
 const detection=(count:number)=>({count,persons:[],elapsedMs:60,inferenceMs:50});
 await assert.rejects(()=>prepareScenarioInputs('raw',control,undefined,{compose,detectAsset:async()=>detection(1)}),/person-containing/);
 assert.equal(composed,0);
 const duplicate={...control,sceneElements:{gen_a:control.sceneElements.gen_a,gen_b:control.sceneElements.gen_a}};
 const result=await prepareScenarioInputs('raw',duplicate,undefined,{compose,detectAsset:async()=>{checked++;return detection(0)}});
 assert.equal(checked,1);assert.equal(composed,1);assert.match(result.assetChecks[0].evidence,/not proof/);
});

test('mask metadata excludes composition images and other unknown fields', () => {
 const composition={width:20,height:10,sourceSha256:'raw',scenes:{gen_a:{imageDataUrl:'secret pixels'}}};
 const region=mergeScenarioEditRegion(undefined,[{x:1,y:2,width:3,height:4}],composition,0);
 assert.deepEqual(region,{width:20,height:10,rectangles:[{x:1,y:2,width:3,height:4}]});
});

test('asset-only validates only its own action extra and preserves other-scene movement',()=>{
 const c={...control,sceneModes:{gen_a:'asset_only' as const}};
 assert.doesNotThrow(()=>validateScenarioModes(c,{gen_b:'stands up',gen_c:'cheers'}));
 assert.throws(()=>validateScenarioModes(c,{gen_a:'stands up'}),/people_and_assets/);
 assert.doesNotThrow(()=>validateScenarioModes({...c,sceneModes:{gen_a:'people_and_assets'}},{gen_a:'stands up'}));
 assert.throws(()=>validateScenarioSceneCount({...control,sceneModes:{gen_b:'people_and_assets'}},1),/outside imageCount/);
});
test('asset-only has target-only mask even when people region is unknown, and no-op never falls back',()=>{
 const target={x:0,y:0,width:10,height:10},person={width:100,height:100,rectangles:[{x:40,y:0,width:60,height:100}]};
 assert.deepEqual(mergeScenarioEditRegion(person,[target],person,1,'asset_only')!.rectangles,[target]);
 assert.deepEqual(mergeScenarioEditRegion(undefined,[target],person,1,'asset_only')!.rectangles,[target]);
 assert.throws(()=>mergeScenarioEditRegion(undefined,[],person,0,'asset_only'),/applied asset/);
 assert.match(assetOnlyEditInstruction(),/Keep every original person/);assert.doesNotMatch(assetOnlyEditInstruction(),/energetic|erase each moved|Replace the original pose/);
});
test('asset-only protects detected person and hand areas before raster composition',()=>{
 const c={...control,sceneModes:{gen_a:'asset_only' as const},sceneElements:{gen_a:[{...control.sceneElements.gen_a![0],opacity:1,targetRect:[.05,.8,.1,.1]as const}]}};
 const detection={count:1,persons:[{score:1,box:[40,10,90,95]}],candidates:[],inferenceMs:50,elapsedMs:60};
 assert.doesNotThrow(()=>assertAssetOnlyTargets(c,{width:100,height:100},detection));
 assert.throws(()=>assertAssetOnlyTargets({...c,sceneElements:{gen_a:[{...c.sceneElements.gen_a[0],targetRect:[.35,.5,.2,.2]}]}},{width:100,height:100},detection),/overlaps/);
});
test('asset-only never revives a recent person; normal movement behavior remains compatible',()=>{
 assert.deepEqual(scenarioPeoplePolicy('asset_only',0,true,true),{drawFromBehind:false,expectedPeople:0});
 assert.deepEqual(scenarioPeoplePolicy('asset_only',2,false,false),{drawFromBehind:false,expectedPeople:2});
 for(const mode of [undefined,'people_and_assets']as const)assert.deepEqual(scenarioPeoplePolicy(mode,0,true,true),{drawFromBehind:true,expectedPeople:1});
});
