import test from 'node:test';
import assert from 'node:assert/strict';
import {observedObjectContext,findFabricatedObjects} from './objectGuard';
import {planScenariosLocal} from './vlmClient';
import type {PersonInfo} from './peopleDescribe';
const people:PersonInfo[]=[{position:'right front',pose:'seated at a desk',clothes:'teal shirt',facing:'left',holdingFacts:[{item:'white cup',hand:'right',evidence:'hand_supported'},{item:'laptop',hand:'left',evidence:'surface_contact'}],wornFacts:[{item:'black backpack',attachment:'furniture_supported'},{item:'tote bag',attachment:'nearby_only'}]}];
const scene='A person in a teal top is at a desk.',foreground='the backrest of a black mesh office chair in front of the camera';
test('visible cup/bag and foreground chair stop being falsely fabricated without assigning ownership',()=>{
 const scenarios=[{prediction_prompt:'The person stands up from the chair holding the cup.'},{prediction_prompt:'The person turns toward the bag.'}];
 assert.ok(findFabricatedObjects(scene,scenarios).length>0);
 const context=observedObjectContext(scene,people,foreground);assert.deepEqual(findFabricatedObjects(context,scenarios),[]);assert.doesNotMatch(context,/wear|carries|moves|stands up/);
});
test('a genuinely absent umbrella/phone remains rejected; prediction text never supplies its own evidence',()=>{
 const context=observedObjectContext(scene,people,foreground);
 assert.deepEqual(findFabricatedObjects(context,[{prediction_prompt:'The person picks up the umbrella and phone.'}]),[{index:0,words:['phone','umbrella']}]);
});
test('unclear unsupported facts and explicitly absent foreground do not whitelist missing items',()=>{
 const unclear:PersonInfo[]=[{position:'center',pose:'seated',clothes:'shirt',facing:'away',holdingFacts:[{item:'phone',hand:'unclear',evidence:'unclear'}],wornFacts:[{item:'umbrella',attachment:'unclear'}]}];
 for(const near of ['no chair is visible','unknown',undefined]){const context=observedObjectContext('A person.',unclear,near);assert.deepEqual(findFabricatedObjects(context,[{prediction_prompt:'The person moves the chair and phone.'}]),[{index:0,words:['chair','phone']}]);}
});
test('shared planner keeps original standing/cup action with no false retry or fallback',async(t)=>{
 const predictions=['The person stands up from the chair holding the cup.','The person turns toward the bag.','The person shifts posture beside the laptop.'];let plans=0;
 t.mock.method(globalThis,'fetch',async(_url,init)=>{const body=JSON.parse(String(init?.body));if(!body.images)return new Response(JSON.stringify({response:JSON.stringify({scene:'机の人物。',items:['立つ。','向く。','姿勢を変える。']})}));plans++;return new Response(JSON.stringify({response:JSON.stringify({clock_visible:false,scene_description:scene,foreground_object:foreground,scenarios:predictions.map((prediction_prompt,i)=>({prediction_prompt,scenario_description:'temporary',label:'Timeline '+i}))}),done_reason:'stop'}));});
 const trace:any={};const out=await planScenariosLocal({imageDataUrl:'data:image/jpeg;base64,dGVzdA==',prompt:'p',scenarioCount:3,people,detector:{person:true,count:1,elapsedMs:0},sceneDistances:[15,30,-25],maxAttempts:2,trace});
 assert.equal(plans,1);assert.deepEqual(out.map(x=>x.prediction_prompt),predictions);assert.deepEqual(trace.guard.fabricatedObjects,[]);assert.equal(trace.guard.objectRetried,false);assert.equal(trace.guard.synthesized,false);
});
