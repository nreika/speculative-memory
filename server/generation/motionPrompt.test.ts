import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {lookupAction,resolveActionPhrase,adaptActionToPosture,preserveActionConditions,buildExtraSentence,type ActionTranslator} from './sceneExtras';
import {operatorActorPosition,positionedActorSubject,translatedOperatorAction} from './operatorActionTranslation';
import {isNoChangeAction} from './vlmClient';
import {mainActionSentence,mainChangeLine} from './mainChange';
import {composeEditInstruction} from './orchestrator';
import {composeSceneReferenceCastInstruction,type ScenePersonReference} from './sceneReferenceCast';
import type {PersonInfo} from './peopleDescribe';

/** Stubbed meaning-preserving translator (no Ollama call): records what it was asked. */
const stub=(table:Record<string,string>)=>{
 const calls:Array<{text:string;pose?:string}>=[];
 const fn:ActionTranslator=async(text,pose)=>{calls.push({text,pose});return table[text]??null;};
 return {fn,calls};
};
const TABLE={
 '椅子に座ったまま机を見る。':'stays seated on the chair and looks down at the desk',
 '立ったまま窓の外を見る':'keeps standing and looks out of the window',
 '机を見る':'looks at the desk',
 '机に片手を置く。':'places one hand on the desk',
 '片手を軽く上げる。':'raises one hand lightly',
};

test('dictionary only on an exact whole phrase: a keyword inside a longer phrase never matches',()=>{
 assert.equal(lookupAction('座る')?.en,'sits down');
 assert.equal(lookupAction('座ってる')?.en,'sits down');
 assert.equal(lookupAction('手を上げる')?.en,'raises one hand');
 for(const text of ['椅子に座ったまま机を見る','座ったまま','立ったまま窓の外を見る','机を見る','机に片手を置く','片手を軽く上げる','笑いながら手を振る','座らずに立つ'])assert.equal(lookupAction(text),null,text);
});

test('座ったまま: translated verbatim for a seated person, adapted for a standing person (never "sits down" alone)',async()=>{
 const {fn,calls}=stub(TABLE);
 const seated=await resolveActionPhrase('椅子に座ったまま机を見る。',fn,'seated');
 assert.deepEqual(seated,{en:'stays seated on the chair and looks down at the desk',source:'translation'});
 const standing=await resolveActionPhrase('椅子に座ったまま机を見る。',fn,'standing or leaning');
 assert.equal(standing.en,'sits on the chair and looks at the desk');
 assert.equal(calls.length,2);assert.equal(calls[1].pose,'standing or leaning');
});

test('立ったまま: keeps standing when standing, stands up when seated',async()=>{
 const {fn}=stub(TABLE);
 assert.equal((await resolveActionPhrase('立ったまま窓の外を見る',fn,'standing')).en,'keeps standing and looks out of the window');
 assert.equal((await resolveActionPhrase('立ったまま窓の外を見る',fn,'seated')).en,'stands up and looks out of the window');
 assert.equal(adaptActionToPosture('stays seated',undefined),'stays seated');
});

test('見る: a phrase outside the dictionary goes to the translation call and is used verbatim',async()=>{
 const {fn,calls}=stub(TABLE);
 const r=await resolveActionPhrase('机を見る',fn,'seated');
 assert.equal(r.en,'looks at the desk');assert.equal(r.source,'translation');assert.equal(r.ja,undefined);assert.equal(calls.length,1);
 const none=await resolveActionPhrase('ふしぎな踊り',fn);assert.deepEqual(none,{en:null,source:'none'});
});

/** The vlmClient extras pipeline, offline. */
async function extraSentence(ja:string,occupied:Array<'left'|'right'>,pose='seated',clothes?:string){
 const {fn}=stub(TABLE);const located=operatorActorPosition(ja);
 const r=await resolveActionPhrase(located.actionText,fn,pose);
 const action=translatedOperatorAction(ja,r.en!,located.position);
 const base=buildExtraSentence(action).replace('The person already in the photo',positionedActorSubject(located.position!,clothes));
 return preserveActionConditions(ja,base,occupied);
}

test('A: 「椅子に座ったまま机を見る」 keeps both the state and the gaze target as the main action',async()=>{
 const text=await extraSentence('画面左の人物が、椅子に座ったまま机を見る。',[]);
 assert.match(text,/^The existing person on the left side of the image stays seated on the chair and looks down at the desk\. /);
 assert.doesNotMatch(text,/sits down/);
 assert.match(text,/Additional operator hand\/object constraints \(.*\): "画面左の人物が、椅子に座ったまま机を見る。"/);
 assert.equal(mainActionSentence(text),'The existing person on the left side of the image stays seated on the chair and looks down at the desk.');
});

test('置く: an occupied hand keeps the action and states how the hand is used; no extra hand',async()=>{
 const both=await extraSentence('画面左の人物が、机に片手を置く。',['left','right']);
 assert.match(both,/^The existing person on the left side of the image places one hand on the desk\. /);
 assert.match(both,/Hand use: places one existing hand on the desk; if that hand holds an object, it keeps holding it while resting on the desk \(or sets the object down on the desk first\); exactly two hands\. Never add an extra hand or arm\./);
 assert.doesNotMatch(both,/cannot use an occupied hand|only if that hand is originally unoccupied/);
 const one=await extraSentence('画面左の人物が、机に片手を置く。',['right']);
 assert.match(one,/Hand use: places the free left hand on the desk; the right hand keeps holding its object; exactly two hands/);
 const free=await extraSentence('画面左の人物が、机に片手を置く。',[]);
 assert.match(free,/Hand use: places one existing hand on the desk; exactly two hands/);
 // A translation that lost the contact gets it back in the action sentence.
 assert.match(preserveActionConditions('机に片手を置く','The person leans forward.',['left','right']),/^The person leans forward, and places one hand on the desk\. Hand use:/);
});

test('上げる: raising a hand while both hands hold objects moves the object with that hand, never a third hand',async()=>{
 const text=await extraSentence('画面左の人物が、片手を軽く上げる。',['left','right']);
 assert.match(text,/^The existing person on the left side of the image raises one hand lightly\. Hand use: raises one existing hand lightly; if it holds an object, the object rises together with that same hand; the other hand stays where it is; exactly two hands\. Never add an extra hand or arm\.$/);
 assert.equal(await extraSentence('画面左の人物が、片手を軽く上げる。',[]),'The existing person on the left side of the image raises one hand lightly.');
 assert.match(preserveActionConditions('右手を上げる','raises the right hand',['right']),/raises the existing right hand; it keeps holding its object, and the object rises together with that same hand/);
 assert.equal(preserveActionConditions('両手を上げて喜んでいる','raises both arms above their head, smiling',['left','right']),'raises both arms above their head, smiling');
});

test('a state-keeping clause joined to a real action is not a "no change" translation',()=>{
 assert.equal(isNoChangeAction('stays seated on the chair and looks down at the desk'),false);
 assert.equal(isNoChangeAction('keeps standing and looks out of the window'),false);
 assert.equal(isNoChangeAction('remains seated'),true);
 assert.equal(isNoChangeAction('stays still, does not move'),true);
});

test('main change sentence: first sentence only, quotes respected, no line for a keep-everything fallback',()=>{
 assert.equal(mainActionSentence('The person waves. Hand use: x.'),'The person waves.');
 assert.equal(mainActionSentence('The person nods. Note: "a. B." more.'),'The person nods.');
 assert.equal(mainActionSentence('The person looks up'),'The person looks up.');
 assert.equal(mainChangeLine('Keep the scene exactly as in the input.'),'');
});

const seatedCup:PersonInfo={position:'right front',pose:'seated',clothes:'blue long-sleeved top',facing:'right',hair:'dark',holding:'white cup in right hand',worn:'',holdingFacts:[{item:'white cup',hand:'right',evidence:'hand_supported'}]} as PersonInfo;
const ACTION_A='The existing person on the left side of the image stays seated on the chair and looks down at the desk. Additional operator hand/object constraints (apply only where compatible with original occupied-hand grips; never invent extra hands): "画面左の人物が、椅子に座ったまま机を見る。".';

function withRulebook<T>(version:number,fn:()=>T):T{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'motion-rb-'));
 fs.copyFileSync(path.join(process.cwd(),'rulebook',`rulebook.v${version}.json`),path.join(dir,`rulebook.v${version}.json`));
 fs.writeFileSync(path.join(dir,'active.json'),JSON.stringify({version,appliedAt:new Date().toISOString()}));
 const prev=process.env.RULEBOOK_DIR;process.env.RULEBOOK_DIR=dir;
 try{return fn();}finally{if(prev===undefined)delete process.env.RULEBOOK_DIR;else process.env.RULEBOOK_DIR=prev;fs.rmSync(dir,{recursive:true,force:true});}
}

test('compact people instruction (rulebook v19): one object sentence, head/gaze may move, the action closes the prompt once',()=>{
 const text=withRulebook(19,()=>composeEditInstruction({predictionPrompt:ACTION_A,people:[seatedCup],personCount:1,compactPeople:true,presence:0.73,tone:0.7}));
 assert.ok(text.endsWith('\n\nMain change that must be clearly visible: The existing person on the left side of the image stays seated on the chair and looks down at the desk.'));
 assert.equal(text.split('Main change that must be clearly visible').length,2);
 assert.doesNotMatch(text,/side profile stays a side profile|Preserve the original head direction|Preserve the original grip during the requested movement/);
 assert.match(text,/head and gaze may move as the requested action needs/);assert.match(text,/never reveal a face that is not visible in the input/);
 assert.match(text,/head cut by the frame edge remains cut by the frame/);
 assert.equal((text.match(/(?:never add|do not (?:add|introduce)) (?:new |unseen )?(?:objects|ones|items)/gi)??[]).length,1);
 // Lighting, white balance, person count, identity and belongings constraints are unchanged.
 assert.match(text,/Keep the exact input exposure, brightness, lighting colour, white balance, shadows and screen contents/);
 assert.match(text,/Exactly 1 original person remains/);assert.match(text,/Keep white cup in right hand with this owner/);
 assert.match(text,/Each held or worn belonging stays with its original owner/);
});

test('full people template also closes with the single main change sentence',()=>{
 const text=composeEditInstruction({predictionPrompt:'The person in the blue top raises one hand lightly.',people:[seatedCup],personCount:1,presence:0.73});
 assert.ok(text.endsWith('\n\nMain change that must be clearly visible: The person in the blue top raises one hand lightly.'));
 assert.doesNotMatch(text,/only a free hand can gesture/);
 const empty=composeEditInstruction({predictionPrompt:'The chair rotates.',presence:0});
 assert.doesNotMatch(empty,/Main change/);
});

test('reference cast instruction: no "occupied hands remain occupied" freeze, the action closes the prompt',()=>{
 const original={position:'left front',pose:'seated',clothes:'blue shirt',facing:'away',hair:'short black',holding:'cup in left hand'} as PersonInfo;
 const bytes='reference';
 const ref:ScenePersonReference={contentId:'upload-1',imageDataUrl:'data:image/png;base64,'+Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),people:[{position:'center',pose:'standing',clothes:'red jacket',facing:'front',hair:'long brown'} as PersonInfo]};
 const text=composeSceneReferenceCastInstruction({sourcePeople:[original],references:[ref],predictionPrompt:'The person in the blue shirt raises one hand lightly. Hand use: x.'});
 assert.doesNotMatch(text,/occupied hands remain occupied/);assert.match(text,/never add a hand/);
 assert.ok(text.endsWith('Main change that must be clearly visible: The person in the blue shirt raises one hand lightly.'));
});
