import test from 'node:test';
import assert from 'node:assert/strict';
import {lookupAction,buildExtraSentence,bilateralHandAction} from './sceneExtras';
import {planScenariosLocal} from './vlmClient';
test('shoulder raise and opposite keyboard contact both survive dictionary resolution',()=>{
 const text='片手を肩の高さへ上げ、反対の手はキーボードに置いたまま。',out=lookupAction(text)!;
 assert.equal(out.en,'raises one hand to shoulder height while keeping the opposite hand on the keyboard');assert.equal(out.ja,text.slice(0,-1));
 assert.match(buildExtraSentence(out.en,'white shirt'),/raises one hand.*shoulder height.*opposite hand.*keyboard/);assert.doesNotMatch(out.en,/types/);
});
test('left/right assignments and reversed clause order remain explicit',()=>{
 assert.equal(lookupAction('右手を肩の高さまで上げる、左手はキーボードに置く')?.en,'raises the right hand to shoulder height while keeping the left hand on the keyboard');
 assert.equal(lookupAction('右手をキーボードに残す。左手を肩の位置へ挙げる。')?.en,'raises the left hand to shoulder height while keeping the right hand on the keyboard');
 assert.equal(lookupAction('左手を肩の高さに上げる、反対の手はキーボードに置いたまま')?.en,'raises the left hand to shoulder height while keeping the right hand on the keyboard');
});
test('contradictory hands and unsupported compound constraints do not silently become typing',()=>{
 for(const text of ['右手を肩の高さに上げる、右手はキーボードに置く','片手を肩より高く上げ、反対の手はキーボードに置く','片手を肩の高さへ上げ、反対の手でカップを持つ','立ち上がり、手を振る','片手を肩の高さへ上げ、反対の手はキーボードに置いたまま、画面を消す'])assert.equal(lookupAction(text),null,text);
 assert.equal(bilateralHandAction('片手を肩の高さへ上げる、片手をキーボードに置く'),null);
});
test('single actions and slash-separated actions retain legacy behavior',()=>{
 assert.equal(lookupAction('キーボードを打つ')?.en,'types on the keyboard');assert.equal(lookupAction('立ち上がってる')?.en,'stands up from the chair');assert.equal(lookupAction('立ち上がる / 手を振る')?.en,'stands up from the chair and waves');
});
test('shared planner preserves the complete two-hand operator action without an extra translation call',async(t)=>{
 let planCalls=0,textCalls=0;
 t.mock.method(globalThis,'fetch',async(_url,init)=>{const body=JSON.parse(String(init?.body));if(!body.images){textCalls++;return new Response(JSON.stringify({response:JSON.stringify({scene:'机の人物。',items:['肩へ上げる。','向く。','前傾する。']})}));}planCalls++;return new Response(JSON.stringify({response:JSON.stringify({clock_visible:false,scene_description:'A person in a white shirt sits at a desk with a keyboard.',scenarios:['The person raises one hand to shoulder height.','The person turns their head left.','The person leans forward.'].map(prediction_prompt=>({prediction_prompt,scenario_description:'temporary'}))}),done_reason:'stop'}));});
 const trace:any={},people=[{position:'center',pose:'seated',clothes:'white shirt',facing:'away'}];
 const result=await planScenariosLocal({imageDataUrl:'data:image/jpeg;base64,dGVzdA==',prompt:'p',scenarioCount:3,people,detector:{person:true,count:1,elapsedMs:0},sceneExtras:{gen_a:'片手を肩の高さへ上げ、反対の手はキーボードに置いたまま。'},sceneDistances:[15,30,-25],trace});
 assert.equal(planCalls,1);assert.equal(textCalls,1,'only the existing Japanese display call; no action translation added');
 assert.match(result[0].prediction_prompt,/^The person in the white shirt raises one hand to shoulder height while keeping the opposite hand on the keyboard\./);
 assert.doesNotMatch(result[0].prediction_prompt,/types on|raises both hands/);assert.equal(trace.guard.extras.gen_a.english,result[0].prediction_prompt);
 assert.match(result[0].scenario_description,/肩の高さ.*反対の手.*キーボード/);assert.equal(trace.guard.extras.gen_a.synthesized,true);
});
