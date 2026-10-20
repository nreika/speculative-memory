import test from 'node:test';import assert from 'node:assert/strict';
import {resolveLocalImageEngine,turboSourceContext,productionTurboSourceContext,selectSceneImageEngine,defaultLocalImageEngine} from './imageEngine';
test('legacy engine remains default and Turbo requires explicit isolated test contract',()=>{
 assert.equal(resolveLocalImageEngine({}),'qwen2511');
 assert.throws(()=>resolveLocalImageEngine({imageEngine:'bad'}));
 const b={imageEngine:'qwen21-turbo-candidate',test:true,recordHistory:false,imageBackend:'local'};
 assert.throws(()=>resolveLocalImageEngine(b,{}));
 assert.throws(()=>resolveLocalImageEngine({...b,test:false},{TURBO_CANDIDATE_ENABLED:'true'}));
 assert.throws(()=>resolveLocalImageEngine({...b,recordHistory:true},{TURBO_CANDIDATE_ENABLED:'true'}));
 assert.throws(()=>resolveLocalImageEngine({...b,imageBackend:'gemini'},{TURBO_CANDIDATE_ENABLED:'true'}));
 assert.equal(resolveLocalImageEngine(b,{TURBO_CANDIDATE_ENABLED:'true'}),'qwen21-turbo-candidate');
});
test('source body and observed head are passed, no static corridor limits movement',()=>{
 const p:any=[{clothes:'blue top',headBox:[700,200,900,500]}];
 const region:any={width:1000,height:500,rectangles:[],sourceEvidence:{method:'cpu',originalStrongCount:1,persons:[{box:[600,90,1000,500],score:.9}]}};
 const c=turboSourceContext(p,region,{width:1000,height:500},'The blue top person stands up');
 assert.deepEqual(c.sourceActors[0].box,[600,90,400,410]);assert.deepEqual(c.sourceActors[0].attached,[[700,100,200,150]]);assert.deepEqual(c.protectedBoxes,[]);
 assert.throws(()=>turboSourceContext(p,undefined,{width:1000,height:500},'stands up'));
 assert.throws(()=>turboSourceContext([{clothes:'blue top'}]as any,region,{width:1000,height:500},'stands up'));
});
test('multiple actors require unique action and protection; same clothes never guessed',()=>{
 const p:any=[{clothes:'red top',headBox:[0,0,100,200]},{clothes:'blue top',headBox:[700,0,800,200]}];
 const r:any={sourceEvidence:{persons:[{box:[0,0,200,500]},{box:[600,0,1000,500]}]}};
 const c=turboSourceContext(p,r,{width:1000,height:500},'The red top person cheers');
 assert.deepEqual(c.protectedBoxes,[[700,0,100,100]]);
 assert.throws(()=>turboSourceContext(p,r,{width:1000,height:500},'Both people cheer'));
 assert.throws(()=>turboSourceContext([p[0],{...p[1],clothes:'red top'}],r,{width:1000,height:500},'The red top person cheers'));
});

test('configured production default is reversible without impersonating a test capture',()=>{
 const env={LOCAL_IMAGE_ENGINE:'qwen21-turbo'};
 assert.equal(resolveLocalImageEngine({},env),'qwen21-turbo');
 assert.equal(resolveLocalImageEngine({test:false,recordHistory:true},env),'qwen21-turbo');
 assert.equal(resolveLocalImageEngine({imageEngine:'qwen2511'},env),'qwen2511');
 assert.equal(resolveLocalImageEngine({},{LOCAL_IMAGE_ENGINE:'qwen2511'}),'qwen2511');
 assert.throws(()=>resolveLocalImageEngine({imageEngine:'qwen21-turbo'},{}),/not configured/);
 assert.throws(()=>defaultLocalImageEngine({LOCAL_IMAGE_ENGINE:'typo'}),/Invalid/);
 assert.throws(()=>resolveLocalImageEngine({imageEngine:'qwen21-turbo-candidate',test:false,recordHistory:true},{...env,TURBO_CANDIDATE_ENABLED:'true'}),/explicit/);
});
test('production uses observed geometry without test flag; unsupported evidence uses same Turbo full-frame without a legacy fallback',()=>{
 const people:any=[{clothes:'blue top',headBox:[700,200,900,500]}];
 const region:any={sourceEvidence:{persons:[{box:[600,90,1000,500],score:.9}]}};
 const args:Parameters<typeof productionTurboSourceContext>=[people,region,{width:1000,height:500},'The blue top person stands up'];
 const selected=selectSceneImageEngine('qwen21-turbo',args);
 assert.equal(selected.engine,'qwen21-turbo');assert.ok(selected.context);assert.equal('test' in selected.context!,false);
 for(const bad of [ [[],region,args[2],args[3]],[[...people,...people,...people],region,args[2],args[3]],[people,undefined,args[2],args[3]],[[{clothes:'blue top'}],region,args[2],args[3]]] as Parameters<typeof productionTurboSourceContext>[]){
  const fallback=selectSceneImageEngine('qwen21-turbo',bad);assert.equal(fallback.engine,'qwen21-turbo');assert.ok(fallback.fullFrameReason);assert.equal(fallback.context,undefined);
  assert.throws(()=>selectSceneImageEngine('qwen21-turbo-candidate',bad));
 }
 assert.equal(selectSceneImageEngine('qwen21-turbo',args,'asset_only full-frame').engine,'qwen21-turbo');
 assert.throws(()=>selectSceneImageEngine('qwen21-turbo-candidate',args,'asset_only unsupported'));
 const ambiguous:any=[[{clothes:'same top',headBox:[0,0,100,100]},{clothes:'same top',headBox:[700,0,800,100]}],{sourceEvidence:{persons:[{box:[0,0,200,500]},{box:[600,0,1000,500]}]}},args[2],'The same top person stands'];
 assert.equal(selectSceneImageEngine('qwen21-turbo',ambiguous).engine,'qwen21-turbo');
});
