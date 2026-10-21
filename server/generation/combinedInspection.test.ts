import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectAndCaption,inspectAndCaptionWithReferences,withCpuHandCount,cpuHandLimit} from './combinedInspection';
import {handCounter} from '../handCount';
import {createHash} from 'node:crypto';
import {compactPeopleInstruction} from './compactPeople';
import {headCropFor,parseHeadBox} from './referenceCrop';
import {generateImage} from './orchestrator';

const img='data:image/png;base64,dGVzdA==';
const person=(index:number)=>({sourceIndex:index,posture:'seated',leftHand:{visibility:'visible',height:'shoulder_or_above',contact:'none',palm:'open'},rightHand:{visibility:'visible',height:'unclear',contact:'unclear',palm:'unclear'}});
test('one existing observation supplies both caption and duplicate rejection, with no second model request',async t=>{
 let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({response:JSON.stringify({people:[person(0),person(0)]}),done_reason:'stop'});});
 const verdict=await inspectAndCaption(img,img,1,15,[]);
 assert.equal(calls,1);assert.equal(verdict.ok,false);
 assert.match(verdict.caption!,/2人/);
});
test('matching total count cannot hide two copies of the same original person',async t=>{
 let body:any;
 t.mock.method(globalThis,'fetch',async(_input:unknown,init?:RequestInit)=>{body=JSON.parse(String(init?.body));return Response.json({response:JSON.stringify({people:[person(0),person(0)]}),done_reason:'stop'});});
 assert.equal((await inspectAndCaption(img,img,2,30,[])).ok,false);
 assert.equal(body.images.length,2);
});
test('single existing observation accepts a normal result and describes only the finished image',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({response:JSON.stringify({people:[person(0)]}),done_reason:'stop'}));
 const verdict=await inspectAndCaption(img,img,1,-25,[]);
 assert.equal(verdict.ok,true);assert.equal(verdict.caption,'25秒前、人物が片手を上げている。');
});
test('head references reject malformed boxes and keep their pixels inside the source',()=>{
 assert.equal(parseHeadBox([2,3,1,4]),undefined);
 assert.equal(parseHeadBox([0,0,Infinity,1000]),undefined);
 const crop=headCropFor([800,300,1000,720],1280,720)!;
 assert.equal(crop.x+crop.width,1280);assert.ok(crop.y+crop.height<=720);
 assert.equal(crop.width%8,0);assert.equal(crop.height%8,0);
});
test('short instructions preserve the requested action, individual location, face visibility and belongings',()=>{
 const prompt=compactPeopleInstruction([{position:'right front',clothes:'teal top',facing:'away',pose:'seated',holding:'white cup'}],1,'The person is cheering.');
 assert.match(prompt,/free hand/);assert.match(prompt,/same right front area/);assert.match(prompt,/Do not reveal more of the face than is visible in the input./);assert.doesNotMatch(prompt,/face hidden/);assert.match(prompt,/white cup/);assert.ok(prompt.length<2200);
});
test('two cropped head references, rather than two entire room photos, feed the encoder',async t=>{
 let workflow:any;
 t.mock.method(globalThis,'fetch',async(input:unknown,init?:RequestInit)=>{
  const url=String(input);
  if(url.includes('/upload/image'))return Response.json({name:'ref.png'});
  if(url.endsWith('/prompt')){workflow=JSON.parse(String(init?.body)).prompt;return Response.json({prompt_id:'heads-test'});}
  if(url.includes('/history/'))return Response.json({'heads-test':{status:{status_str:'success'},outputs:{'80':{images:[{filename:'test.png',type:'output',subfolder:''}]}}}});
  if(url.includes('/view?'))return new Response(new Uint8Array([1,2,3]));
  throw new Error('Unexpected '+url);
 });
 await generateImage({originalImageDataUrl:img,referenceImages:[img,img],referenceCrops:[{x:0,y:0,width:64,height:96},{x:128,y:64,width:64,height:96}],predictionPrompt:'The person waves.',personCount:2,presence:1,imageBackend:'local'});
 assert.deepEqual(workflow['30'].inputs.image2,['26',0]);assert.deepEqual(workflow['30'].inputs.image3,['27',0]);
 assert.deepEqual(workflow['26'].inputs.image,['22',0]);assert.deepEqual(workflow['27'].inputs.image,['23',0]);
 assert.equal(workflow['23'].inputs.x,128);
});

test('combined caption observes both hand grips in the same request without copying source belongings', async t=>{
 let body:any;let calls=0;
 t.mock.method(globalThis,'fetch',async(_input:unknown,init?:RequestInit)=>{calls++;body=JSON.parse(String(init?.body));return Response.json({response:JSON.stringify({people:[{sourceIndex:0,posture:'seated',leftHand:{visibility:'visible',height:'shoulder_or_above',contact:'held_object',palm:'not_open'},rightHand:{visibility:'visible',height:'unclear',contact:'unclear',palm:'unclear'}}]}),done_reason:'stop'});});
 const verdict=await inspectAndCaption(img,img,1,15,[]);
 assert.equal(verdict.caption,'15秒後、人物が物を持つ手が肩以上の高さにある。');
 assert.equal(calls,1);
 assert.match(body.prompt,/A cup\/tablet\/phone grip is held_object/);
 assert.deepEqual(body.format.properties.people.items.required,['raisedHands','objectHands','otherHands','handPositions','hands','sourceIndex','posture','leftHand','rightHand','bodyCoherent']);
});

test('combined inspection uses the finished hands for each mapped person even when source order reverses',async t=>{
 let calls=0;
 const unknown={visibility:'visible',height:'unclear',contact:'unclear',palm:'unclear'};
 const observed=[
  {sourceIndex:1,posture:'upper_body_only',leftHand:{visibility:'visible',height:'shoulder_or_above',contact:'body_or_clothing',palm:'not_open'},rightHand:{visibility:'visible',height:'shoulder_or_above',contact:'held_object',palm:'not_open'}},
  {sourceIndex:0,posture:'upper_body_only',leftHand:{visibility:'visible',height:'below_shoulder',contact:'held_object',palm:'not_open'},rightHand:unknown},
 ];
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({response:JSON.stringify({people:observed}),done_reason:'stop'});});
 const verdict=await inspectAndCaption(img,img,2,15,[{position:'left',pose:'standing',clothes:'black shirt',facing:'right',holding:'tablet'},{position:'right',pose:'seated',clothes:'teal top',facing:'left',holding:'cup'}]);
 assert.equal(calls,1);assert.equal(verdict.ok,true);
 assert.equal(verdict.caption,'15秒後、2人の人物が写っている。1人目は片手を体に添え、物を持つもう片方の手が肩以上の高さにある。2人目は物を持っている。');
});

test('inspection can still report a duplicate crowd beyond the original eight-person limit',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({response:JSON.stringify({people:Array.from({length:9},()=>person(0))}),done_reason:'stop'}));
 const verdict=await inspectAndCaption(img,img,1,15,[]);
 assert.equal(verdict.ok,false);assert.match(verdict.caption!,/9人の人物/);
});

test('combined inspection rejects incomplete hands without requesting a second observation',async t=>{
 let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({response:JSON.stringify({people:[{sourceIndex:0,posture:'seated',leftHand:{visibility:'visible',height:'unclear',contact:'unclear',palm:'unclear'}}]}),done_reason:'stop'});});
 await assert.rejects(inspectAndCaption(img,img,1,15,[]),/hand evidence/);
 assert.equal(calls,1);
});

test('one combined observation distinguishes a supported surface from a grip and retains an independent raised hand',async t=>{
 let calls=0;let body:any;
 t.mock.method(globalThis,'fetch',async(_input:unknown,init?:RequestInit)=>{
  calls++;body=JSON.parse(String(init?.body));
  return Response.json({response:JSON.stringify({people:[{sourceIndex:0,posture:'seated',leftHand:{visibility:'visible',height:'below_shoulder',contact:'surface_contact',palm:'not_open'},rightHand:{visibility:'visible',height:'shoulder_or_above',contact:'none',palm:'unclear'}}]}),done_reason:'stop'});
 });
 const verdict=await inspectAndCaption(img,img,1,-25,[]);
 assert.equal(calls,1);
 assert.equal(verdict.ok,true);
 assert.equal(verdict.caption,'25秒前、人物が片手を上げ、もう片方の手を物に添えている。');
 assert.match(body.prompt,/Touching or using a keyboard is NOT holding it/);
 assert.match(body.prompt,/one hand on a keyboard or holding a cup says NOTHING about the other hand/);
 for(const side of ['leftHand','rightHand'])assert.ok(body.format.properties.people.items.properties[side].properties.contact.enum.includes('surface_contact'));
 assert.equal(body.options.num_predict,1024);
});

test('single finished-image caption shares the surface distinction without copying original holdings',async t=>{
 let calls=0;
 const surface={visibility:'visible',height:'below_shoulder',contact:'surface_contact',palm:'open'};
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({response:JSON.stringify({people:[{sourceIndex:0,posture:'seated',leftHand:surface,rightHand:surface}]}),done_reason:'stop'});});
 const verdict=await inspectAndCaption(img,img,1,15,[{position:'center',pose:'seated',clothes:'plain top',facing:'away',holding:'original source item'}]);
 assert.equal(calls,1);
 assert.equal(verdict.caption,'15秒後、人物が両手を物に添えている。');
 assert.doesNotMatch(verdict.caption!,/持って|original/);
});


test('the exact caption observation is returned as bounded image-free facts without a second request',async t=>{
  let calls=0;
  const facts={sourceIndex:0,posture:'upper_body_only',leftHand:{visibility:'visible',height:'shoulder_or_above',contact:'unclear',palm:'unclear'},rightHand:{visibility:'visible',height:'below_shoulder',contact:'held_object',palm:'not_open'}};
  t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({response:JSON.stringify({people:[{...facts,image:'data:image/png;base64,not-evidence',leftHand:{...facts.leftHand,image:'hidden-extra'}}],image:'unbounded unwanted field'}),done_reason:'stop'});});
  const result=await inspectAndCaption(img,img,1,15,[]);
  assert.equal(calls,1);
  // the dummy bytes are not an image, so the CPU hand detector reports error (VLM-only fallback) without spawning
  assert.deepEqual(result.observationFacts,{version:2,people:[facts],cpuHands:{status:'error',count:0,limit:2,boxes:[]},framing:{status:'error'}});
  assert.equal(result.caption,'15秒後、人物が物を持っている。片手が肩以上の高さにある。');
  const serialized=JSON.stringify({...result,attempts:1});
  assert.doesNotMatch(serialized,/base64|not-evidence|hidden-extra|unbounded unwanted/);
  assert.deepEqual(JSON.parse(serialized).observationFacts,result.observationFacts);
});

test('saved observation facts preserve finished-image order and unmatched indices',async t=>{
  const observed=[person(1),person(-1),person(0)];
  t.mock.method(globalThis,'fetch',async()=>Response.json({response:JSON.stringify({people:observed}),done_reason:'stop'}));
  const result=await inspectAndCaption(img,img,2,15,[]);
  assert.equal(result.ok,false);
  assert.deepEqual(result.observationFacts.people,observed);
});


test('visibility is required in the same call and archived facts suppress contradictory hidden-hand claims',async t=>{
  let calls=0;let body:any;
  const leftHand={visibility:'not_visible',height:'shoulder_or_above',contact:'none',palm:'open'};
  const rightHand={visibility:'visible',height:'below_shoulder',contact:'held_object',palm:'not_open'};
  t.mock.method(globalThis,'fetch',async(_input:unknown,init?:RequestInit)=>{calls++;body=JSON.parse(String(init?.body));return Response.json({response:JSON.stringify({people:[{sourceIndex:0,posture:'upper_body_only',leftHand,rightHand}]}),done_reason:'stop'});});
  const result=await inspectAndCaption(img,img,1,15,[]);
  assert.equal(calls,1);assert.equal(result.caption,'15秒後、人物が物を持っている。');
  assert.equal(result.observationFacts.version,2);
  assert.deepEqual(result.observationFacts.people[0].leftHand,{visibility:'not_visible',height:'unclear',contact:'unclear',palm:'unclear'});
  for(const side of ['leftHand','rightHand'])assert.deepEqual(body.format.properties.people.items.properties[side].required,['visibility','height','contact','palm']);
  assert.match(body.prompt,/identifiable hand\/palm\/fingers\/fist pixels/);
  assert.match(body.prompt,/an upright chest or high head alone is upper_body_only/);
  assert.equal(body.options.num_predict,1024);
});

test('new combined observations reject missing visibility without a fallback request',async t=>{
  let calls=0;
  const hand={height:'unclear',contact:'unclear',palm:'unclear'};
  t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({response:JSON.stringify({people:[{sourceIndex:0,posture:'seated',leftHand:hand,rightHand:hand}]}),done_reason:'stop'});});
  await assert.rejects(inspectAndCaption(img,img,1,15,[]),/hand visibility/);
  assert.equal(calls,1);
});

const castOriginal={position:'left',pose:'seated',clothes:'blue shirt',facing:'away'};
const castReference={contentId:'uploaded-ref',imageDataUrl:'data:image/png;base64,'+Buffer.from('reference').toString('base64'),sha256:createHash('sha256').update('reference').digest('hex'),people:[{position:'center',pose:'standing',clothes:'red jacket',facing:'front'}]};
const castPerson=(inventoryId:string)=>({inventoryId,posture:'upper_body_only',leftHand:{visibility:'not_visible',height:'unclear',contact:'unclear',palm:'unclear'},rightHand:{visibility:'visible',height:'below_shoulder',contact:'held_object',palm:'not_open'}});
test('reference branch uses one source/reference/output request and keeps legacy source count meaning',async t=>{
 let calls=0,body:any;
 t.mock.method(globalThis,'fetch',async(_input:unknown,init?:RequestInit)=>{calls++;body=JSON.parse(String(init?.body));return Response.json({response:JSON.stringify({originalSourceCount:1,people:[castPerson('ref:uploaded-ref:0'),castPerson('source:0')]}),done_reason:'stop'});});
 const v=await inspectAndCaptionWithReferences(img,img,[castOriginal],[castReference],15);
 assert.equal(calls,1);assert.equal(body.images.length,3);assert.equal(body.images[0],Buffer.from('test').toString('base64'));assert.equal(body.images[1],Buffer.from('reference').toString('base64'));assert.equal(body.images[2],body.images[0]);
 assert.equal(v.ok,true);assert.equal(v.sourceCount,1);assert.equal(v.originalSourceCount,1);assert.equal(v.expectedInventoryCount,2);assert.deepEqual(v.outputToSource,[-1,0]);
 assert.equal(body.options.num_predict,1024);assert.match(body.prompt,/Inspect ONLY IMAGE 3/);assert.match(body.prompt,/two reference photos/);assert.match(body.prompt,/Never split one human identity across source\/ref IDs/);
 assert.deepEqual(body.format.properties.people.items.properties.inventoryId.enum,['source:0','ref:uploaded-ref:0','unknown']);
 assert.equal(v.observationFacts.version,3);assert.doesNotMatch(JSON.stringify(v),/base64|imageDataUrl/);
});
test('reference branch rejects duplicated source despite correct total and never retries',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({response:JSON.stringify({originalSourceCount:1,people:[castPerson('source:0'),castPerson('source:0')]}),done_reason:'stop'});});
 const v=await inspectAndCaptionWithReferences(img,img,[castOriginal],[castReference],15);assert.equal(v.ok,false);assert.equal(calls,1);
});
test('reference inspection unknown/missing identities remain rejected, not permission to publish',async t=>{
 for(const ids of [['source:0','unknown'],['ref:uploaded-ref:0']]){
  const fetchMock=t.mock.method(globalThis,'fetch',async()=>Response.json({response:JSON.stringify({originalSourceCount:1,people:ids.map(castPerson)}),done_reason:'stop'}));
  assert.equal((await inspectAndCaptionWithReferences(img,img,[castOriginal],[castReference],15)).ok,false);fetchMock.mock.restore();
 }
});
test('reference observation retains only normalized, whitelisted finished-image facts',async t=>{
 const p=castPerson('ref:uploaded-ref:0');p.leftHand={visibility:'not_visible',height:'shoulder_or_above',contact:'none',palm:'open'};
 t.mock.method(globalThis,'fetch',async()=>Response.json({response:JSON.stringify({originalSourceCount:1,people:[{...p,image:'data:image/png;base64,private'},castPerson('source:0')],image:'secret'}),done_reason:'stop'}));
 const v=await inspectAndCaptionWithReferences(img,img,[castOriginal],[castReference],15);assert.equal(v.ok,true);assert.equal(v.observationFacts.people[0].leftHand.height,'unclear');assert.doesNotMatch(JSON.stringify(v),/base64|private|secret/);
});
test('reference truncation fails after one request, and identical source reference fails before a request',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({response:'{}',done_reason:'length'});});
 await assert.rejects(inspectAndCaptionWithReferences(img,img,[castOriginal],[castReference],15),/truncated/);assert.equal(calls,1);
 const duplicate={...castReference,imageDataUrl:img,sha256:createHash('sha256').update('test').digest('hex')};
 await assert.rejects(inspectAndCaptionWithReferences(img,img,[castOriginal],[duplicate],15),/duplicates the original source/);assert.equal(calls,1);
});

test('new cast inspection schema follows nine allowed IDs without changing the legacy inspector or adding calls',async t=>{
 const refs=Array.from({length:9},(_,i)=>({...castReference,contentId:'ref-'+i,imageDataUrl:'data:image/png;base64,'+Buffer.from('unique-ref-'+i).toString('base64'),sha256:createHash('sha256').update('unique-ref-'+i).digest('hex')}));let calls=0,request:any;
 t.mock.method(globalThis,'fetch',async(_input:unknown,init?:RequestInit)=>{calls++;request=JSON.parse(String(init?.body));return Response.json({response:JSON.stringify({originalSourceCount:0,people:refs.map(r=>castPerson('ref:'+r.contentId+':0'))}),done_reason:'stop'});});
 const verdict=await inspectAndCaptionWithReferences(img,img,[],refs,15);assert.equal(verdict.ok,true);assert.equal(verdict.expectedInventoryCount,9);assert.equal(verdict.sourceCount,0);assert.equal(request.format.properties.people.maxItems,10);assert.equal(request.options.num_predict,1024);assert.equal(calls,1);assert.equal(request.images.length,11);
});

test('extra_hand OR rule: CPU detector alone, VLM alone, both, and unavailable CPU falls back to the VLM',async t=>{
 const vlmHands=(n:number)=>({...person(0),handPositions:Array.from({length:n},(_,i)=>'hand '+i),hands:n});
 const box=(i:number)=>({x:i*.1,y:.1,w:.05,h:.05,score:.9});
 const cpu=(n:number,status:'detected'|'no-hands'|'unavailable'='detected')=>({status,count:status==='detected'?n:0,hands:status==='detected'?Array.from({length:n},(_,i)=>box(i)):[]});
 const run=async(vlm:number,c:ReturnType<typeof cpu>,expected=1,people=1)=>{
  t.mock.restoreAll();
  t.mock.method(globalThis,'fetch',async()=>Response.json({response:JSON.stringify({people:Array.from({length:people},(_,i)=>({...vlmHands(vlm),sourceIndex:i}))}),done_reason:'stop'}));
  t.mock.method(handCounter,'count',async()=>c);
  return inspectAndCaption(img,img,expected,15,[]);
 };
 let v=await run(2,cpu(3));assert.equal(v.ok,false);assert.equal(v.defect,'extra_hand');assert.match(v.reason,/CPU hand detector found 3/);
 assert.equal(v.observationFacts.cpuHands?.count,3);assert.equal(v.observationFacts.cpuHands?.limit,2);assert.equal(v.observationFacts.cpuHands?.boxes.length,3);
 v=await run(3,cpu(2));assert.equal(v.ok,false);assert.equal(v.defect,'extra_hand');assert.doesNotMatch(v.reason,/CPU/);
 v=await run(3,cpu(4));assert.equal(v.defect,'extra_hand');assert.match(v.reason,/shows 3 hands.*CPU hand detector found 4/);
 v=await run(2,cpu(2));assert.equal(v.ok,true);assert.equal(v.defect,undefined);
 v=await run(2,cpu(0,'unavailable'));assert.equal(v.ok,true);assert.equal(v.observationFacts.cpuHands?.status,'unavailable');
 v=await run(3,cpu(0,'unavailable'));assert.equal(v.defect,'extra_hand');
 // two expected people: up to 4 detected hands is fine, 5 is extra
 v=await run(2,cpu(4),2,2);assert.equal(v.ok,true);
 v=await run(2,cpu(5),2,2);assert.equal(v.ok,false);assert.equal(v.defect,'extra_hand');
});
test('withCpuHandCount leaves the verdict untouched for error, no-hands and within-limit counts',()=>{
 const base={ok:true as boolean|null,reason:'ok'};
 assert.equal(withCpuHandCount(base,{status:'error',count:0,hands:[]},1),base);
 assert.equal(withCpuHandCount(base,{status:'no-hands',count:0,hands:[]},1),base);
 assert.equal(cpuHandLimit(0),2);assert.equal(cpuHandLimit(3),6);
});

test('body coherence and planned-action checks reject only otherwise acceptable images and keep other defects', async () => {
  const {withBodyCoherence,withPlannedAction}=await import('./combinedInspection');
  const ok={ok:true as boolean|null,reason:'ok'};
  assert.equal(withBodyCoherence(ok,[{bodyCoherent:true},{}]).ok,true);
  const bad=withBodyCoherence(ok,[{bodyCoherent:false}]);assert.equal(bad.ok,false);assert.equal((bad as any).defect,'incoherent_body');
  assert.equal(withBodyCoherence({ok:null as boolean|null,reason:'x'},[{bodyCoherent:false}]).ok,null);
  assert.equal(withPlannedAction(ok,false,'turns around').ok,true);assert.equal((withPlannedAction(ok,false,'turns around') as any).actionNotShown,true);
  assert.equal(withPlannedAction(ok,true,'turns around').ok,true);
  assert.equal(withPlannedAction(ok,false,undefined).ok,true);
  const other={ok:false as boolean|null,reason:'extra_hand',defect:'extra_hand' as const};
  assert.equal((withPlannedAction(other,false,'x') as any).defect,'extra_hand');
});

test('a duplicated object rejects an otherwise acceptable image and keeps other defects', async () => {
  const {withDuplicateObject}=await import('./combinedInspection');
  const ok={ok:true as boolean|null,reason:'ok'};
  const bad=withDuplicateObject(ok,true);assert.equal(bad.ok,false);assert.equal((bad as any).defect,'duplicate_object');
  assert.equal(withDuplicateObject(ok,false).ok,true);
  assert.equal((withDuplicateObject({ok:false as boolean|null,reason:'x',defect:'extra_hand' as const},true) as any).defect,'extra_hand');
});
