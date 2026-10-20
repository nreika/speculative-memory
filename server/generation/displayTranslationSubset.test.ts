import test from 'node:test';
import assert from 'node:assert/strict';
import {displayTranslationSubset} from './displayTranslationSubset';
import {translateDisplayTextToJapanese} from './vlmClient';
test('skip only fields whose final Japanese display is already fixed; preserve original order',()=>{
 const subset=displayTranslationSubset(['action A','action B','action C'],new Map([[1,'確定B'],[2,'確定C']]));
 assert.deepEqual(subset.items,['action A']);assert.deepEqual(subset.restore(['翻訳A']),['翻訳A','確定B','確定C']);assert.throws(()=>subset.restore([]));
});
test('all-extra scene keeps a valid scene-only translation with an empty items array',()=>{
 const subset=displayTranslationSubset(['A','B','C'],new Map([[0,'確定A'],[1,'確定B'],[2,'確定C']]));assert.deepEqual(subset.items,[]);assert.deepEqual(subset.restore([]),['確定A','確定B','確定C']);
});
test('actual translator sends one call, retains original English action and returns template overrides exactly',async(t)=>{
 const scenes=['A','B','C'].map((x,i)=>({prediction_prompt:'ACTION '+x,scenario_description:'TEMPORARY '+x,label:x,scene_now:'Original source observation.'}));
 let calls=0;
 t.mock.method(globalThis,'fetch',async(_url,init)=>{calls++;const request=JSON.parse(String(init?.body));const payload=JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n')+1));assert.deepEqual(payload,{scene:'Original source observation.',items:['TEMPORARY A']});assert.equal(request.think,false);return new Response(JSON.stringify({response:JSON.stringify({scene:'元の観察。',items:['翻訳A']})}));});
 const out=await translateDisplayTextToJapanese(scenes,undefined,undefined,new Map([[1,'確定B'],[2,'確定C']]));assert.equal(calls,1);assert.deepEqual(out.map(x=>x.prediction_prompt),scenes.map(x=>x.prediction_prompt));assert.deepEqual(out.map(x=>x.scenario_description),['翻訳A','確定B','確定C']);assert.ok(out.every(x=>x.scene_now==='元の観察。'));
});
