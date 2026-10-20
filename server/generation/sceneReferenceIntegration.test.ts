import {buildTurboWorkflow} from './turboCandidate';
import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {buildSceneReferenceInputs,validateSceneReferenceRequest,sceneReferenceArchiveMetadata,sourceCastIdentityImages,usableHeadCrop,referencePlacement} from './sceneReferenceIntegration';
const id='00000000-0000-4000-8000-000000000001',source='data:image/png;base64,c291cmNl',refImage='data:image/png;base64,cmVm';
const person={position:'left',pose:'seated',clothes:'white shirt',facing:'away',hair:'long dark'};
const ref={contentId:id,role:'add-person' as const,sha256:createHash('sha256').update('ref').digest('hex'),imageDataUrl:refImage,people:[{...person,clothes:'blue shirt'}],width:10,height:10,imageUrl:'/captures/browser-output-assets/'+id+'.png',label:'person'};
const request={gen_c:[{contentId:id,role:'add-person'}]};
const args={sourceImage:source,sourcePeople:[person],sourceOk:true,references:[ref],identityImages:[{imageDataUrl:source,sourceIndexes:[0],crop:{x:1,y:1,width:2,height:3}}],predictionPrompt:'The original person turns their head.'};
test('request preflight rejects unsupported engines, asset-only and out-of-count before image model work',()=>{
 const base={count:3,imageBackend:'local',engine:'qwen21-turbo'};assert.deepEqual(validateSceneReferenceRequest(request,base),request);
 for(const patch of [{engine:'qwen2511'},{engine:'qwen21-turbo-candidate'},{imageBackend:'gemini'},{mobile:true},{count:2},{sceneModes:{gen_c:'asset_only'}}])assert.throws(()=>validateSceneReferenceRequest(request,{...base,...patch}));
 assert.deepEqual(validateSceneReferenceRequest(undefined,{...base,engine:'qwen2511'}),{});
});
test('dense original-head plus added-reference inputs preserve source facts and use dedicated cast prompt',()=>{
 const before=JSON.stringify(args);const result=buildSceneReferenceInputs(args)!;
 assert.equal(JSON.stringify(args),before);assert.equal(result.cast.originalSourceCount,1);assert.equal(result.cast.expectedSceneTotal,2);
 assert.deepEqual(result.referenceImages,[source,refImage]);assert.deepEqual(result.referenceCrops,[args.identityImages[0].crop,{x:0,y:0,width:10,height:10}]);
 assert.deepEqual(result.sourceIdentityImages,[{imageNumber:2,sourceIndexes:[0]}]);assert.equal(result.references[0].imageNumber,3);
 assert.match(result.instruction,/image2 supplies identity detail only for source:0/);assert.match(result.instruction,/image3, reference person/);
 assert.doesNotMatch(result.instruction,/Only one real person|SAME original person|No new person is allowed/);
});
test('unobserved source, duplicate source photo, missing cast people and aggregate limits fail closed',()=>{
 assert.throws(()=>buildSceneReferenceInputs({...args,sourceOk:false}),/unknown/);
 assert.throws(()=>buildSceneReferenceInputs({...args,references:[{...ref,imageDataUrl:source,sha256:createHash('sha256').update('source').digest('hex')}]}),/duplicates the source/);
 assert.throws(()=>buildSceneReferenceInputs({...args,references:[{...ref,people:[]}]}),/observed person/);
 assert.throws(()=>buildSceneReferenceInputs({...args,identityImages:Array(15).fill(args.identityImages[0])}),/sixteen/);
 assert.equal(buildSceneReferenceInputs({...args,references:[]}),undefined);
});
test('archive metadata exit omits image bytes/private free fields at every cast level',()=>{
 const result=buildSceneReferenceInputs(args)!,v:any=structuredClone(result.metadata);v.imageDataUrl=source;v.references[0].imageDataUrl=refImage;v.allowedInventory[1].private='hidden';
 const safe=sceneReferenceArchiveMetadata(v);assert.doesNotMatch(JSON.stringify(safe),/base64|imageDataUrl|hidden|private/);assert.equal(safe.references[0].sha256,ref.sha256);
});

test('mixed original head/full-photo slots and added full-photo crops stay dense without guessed dimensions',()=>{
 const png=Buffer.alloc(33);png[0]=0x89;png[1]=0x50;png.writeUInt32BE(32,16);png.writeUInt32BE(48,20);const whole='data:image/png;base64,'+png.toString('base64');
 const result=buildSceneReferenceInputs({...args,sourcePeople:[person,{...person,position:'right'}],identityImages:[args.identityImages[0],{imageDataUrl:whole,sourceIndexes:[1]}]})!;
 assert.deepEqual(result.referenceCrops,[args.identityImages[0].crop,{x:0,y:0,width:32,height:48},{x:0,y:0,width:10,height:10}]);assert.equal(result.referenceCrops.length,result.referenceImages.length);
 const graph=buildTurboWorkflow({sceneImage:source,prompt:result.instruction},'source.png',result.referenceCrops.map((crop,i)=>({name:'r'+i+'.png',crop})),1,'synthetic');
 for(const node of ['22','25','28'])assert.equal(graph[node].inputs.height,768);
 assert.deepEqual(graph['21'].inputs,{image:['20',0],...args.identityImages[0].crop});assert.equal(graph['24'].inputs.width,32);assert.equal(graph['27'].inputs.width,10);
 assert.throws(()=>buildSceneReferenceInputs({...args,identityImages:[{imageDataUrl:source,sourceIndexes:[0]}]}),/dimensions unknown/);
 assert.throws(()=>buildSceneReferenceInputs({...args,references:[{...ref,width:0}]}),/dimensions unknown/);
});

test('two explicit portraits of one source bind to source:0 twice, never to a fabricated source:1',()=>{
 const header=Buffer.alloc(33);header[0]=0x89;header[1]=0x50;header.writeUInt32BE(320,16);header.writeUInt32BE(480,20);const portrait='data:image/png;base64,'+header.toString('base64');
 const identities=sourceCastIdentityImages(source,[person],[portrait,portrait],null);assert.deepEqual(identities.map(p=>p.sourceIndexes),[[0],[0]]);
 const result=buildSceneReferenceInputs({...args,identityImages:identities})!;assert.equal(result.cast.originalSourceCount,1);assert.equal(result.cast.expectedSceneTotal,2);assert.equal(result.referenceImages.length,3);assert.equal(result.references[0].imageNumber,4);assert.deepEqual(result.sourceIdentityImages.map(p=>p.sourceIndexes),[[0],[0]]);assert.deepEqual(result.referenceCrops.slice(0,2),[{x:0,y:0,width:320,height:480},{x:0,y:0,width:320,height:480}]);
 assert.throws(()=>sourceCastIdentityImages(source,[person,{...person,position:'right'}],[portrait,portrait],null),/verified per-person bindings/);
});

const frame={width:1280,height:720};
test('usableHeadCrop rejects a head box touching the frame edge',()=>{
 assert.equal(usableHeadCrop([400,0,480,200],frame),undefined);
 assert.equal(usableHeadCrop([400,200,480,400],frame)!==undefined,true);
 assert.equal(usableHeadCrop([920,200,1000,400],frame),undefined);
});
test('usableHeadCrop returns a crop of at least 96px for a normal head box',()=>{
 const crop=usableHeadCrop([400,200,480,400],frame)!;
 assert.ok(crop);assert.ok(crop.width>=96&&crop.height>=96);
});
test('usableHeadCrop rejects a tiny head box',()=>{
 assert.equal(usableHeadCrop([400,200,430,240],frame),undefined);
});
test('usableHeadCrop rejects a very flat head box',()=>{
 assert.equal(usableHeadCrop([300,300,700,340],frame),undefined);
});
test('referencePlacement classifies same-camera frames versus appearance-only crops',()=>{
 const src={width:1280,height:720};
 assert.equal(referencePlacement({width:1280,height:720},src),'same-camera');
 assert.equal(referencePlacement({width:132,height:132},src),'appearance-only');
 assert.equal(referencePlacement({width:640,height:360},src),'same-camera');
 assert.equal(referencePlacement({width:600,height:360},src),'appearance-only');
});
