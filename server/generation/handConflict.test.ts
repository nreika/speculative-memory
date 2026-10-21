import test from 'node:test';
import assert from 'node:assert/strict';
import {actionNeedsHand,bothArmsHolding,handConflict,oneArmHoldingSentence,withoutHandCommitments,armsChangeAction} from './handConflict';
import {composeEditInstruction} from './orchestrator';
import {mainActionSentence} from './mainChange';
import {compactPeopleInstruction} from './compactPeople';
import {actionWithBelongings,identityConstraints} from './fidelity';
import {preserveActionConditions} from './sceneExtras';
import {extraHandPerson,withHandCount,inspectAndCaption} from './combinedInspection';
import type {PersonInfo} from './peopleDescribe';

const COMMIT=/in both hands|original hand grip|same hand|input hand grip/i;
const tablet:PersonInfo={position:'left front',pose:'standing',clothes:'dark shirt with buttons',facing:'toward',holding:'black tablet in both hands',worn:'smartwatch and bracelet'};
const raise='The existing person on the left side of the image wearing dark shirt with buttons raises one hand lightly.';

test('both-hands tablet + raise one hand: the holding is rewritten to one arm, no hand-commitment text remains (F010)',()=>{
 assert.equal(actionNeedsHand(raise),true);
 assert.deepEqual(bothArmsHolding(tablet),{item:'black tablet',rest:''});
 const pred=preserveActionConditions('片手を軽く上げる',raise,['left','right'],'black tablet');
 assert.match(pred,/the black tablet stays held against the body by the other arm only/);
 const prompt=compactPeopleInstruction([tablet],1,pred);
 assert.match(prompt,/The black tablet is now held against the body with one arm only; the other hand rises lightly\. Exactly two hands; no extra hand or arm\./);
 assert.match(prompt,/Keep the black tablet with this owner, held against the body with one arm only\./);
 assert.doesNotMatch(prompt,COMMIT);
 assert.match(prompt,/black tablet/);
 const ids=identityConstraints([tablet],1,pred);
 assert.doesNotMatch(ids,COMMIT);assert.match(ids,/black tablet, now held against the body with one arm only/);
});
test('one-hand cup + raise the other hand keeps today\'s text',()=>{
 const cup:PersonInfo={position:'right',pose:'seated',clothes:'teal top',facing:'side',holding:'white cup in right hand'};
 const pred='The person in the teal top raises the left hand lightly.';
 assert.equal(handConflict(cup,pred),null);
 assert.match(actionWithBelongings(pred,[cup]),/continuously keeps white cup in right hand, with the original hand grip\./);
 assert.match(compactPeopleInstruction([cup],1,pred),/Keep white cup in right hand with this owner, in the same hand;/);
 assert.equal(preserveActionConditions('左手を軽く上げる',pred,['right']),pred);
});
test('arms crossed holding a tablet + wave: one arm holds the tablet, the other hand waves',()=>{
 const crossed:PersonInfo={position:'left front',pose:'standing with arms crossed',clothes:'dark button-up shirt',facing:'side',holding:'black tablet'};
 const pred='The person in the dark button-up shirt waves.';
 assert.deepEqual(bothArmsHolding(crossed),{item:'black tablet',rest:''});
 const out=actionWithBelongings(pred,[crossed]);
 assert.match(out,/The black tablet is now held against the body with one arm only; the other hand waves\./);
 assert.doesNotMatch(out,COMMIT);
 assert.equal(oneArmHoldingSentence('black tablet','The person waves lightly.'),'The black tablet is now held against the body with one arm only; the other hand waves lightly. Exactly two hands; no extra hand or arm.');
});
test('lifting the both-hands object itself, or no hand action, is not a conflict',()=>{
 assert.equal(handConflict(tablet,'The person lifts the black tablet to chest height.'),null);
 assert.equal(handConflict(tablet,'The person turns the head toward the window.'),null);
 assert.equal(withoutHandCommitments('Keep it. A held object stays in the same hand.'),'Keep it. An object that needed both hands is now held against the body with one arm, so the other hand is free for the requested action; never add a hand or arm.');
 assert.equal(withoutHandCommitments('No hand words here.'),'No hand words here.');
});

const hand={visibility:'visible',height:'below_shoulder',contact:'held_object',palm:'not_open'};
const observed=(hands?:number)=>({sourceIndex:0,posture:'standing',leftHand:hand,rightHand:hand,...(hands===undefined?{}:{hands})});
test('inspection hand count: 3 hands rejects with extra_hand, 2 passes, missing passes',async t=>{
 assert.deepEqual(extraHandPerson([observed(2),observed(3)]),{index:1,hands:3});
 assert.equal(extraHandPerson([observed()]),null);
 assert.equal(withHandCount({ok:true,reason:'fine'},[observed(1)]).ok,true);
 let answer:unknown[]=[];let calls=0;let body:any;
 t.mock.method(globalThis,'fetch',async(_i:unknown,init?:RequestInit)=>{calls++;body=JSON.parse(String(init?.body));return Response.json({response:JSON.stringify({people:answer}),done_reason:'stop'});});
 answer=[observed(3)];
 const bad=await inspectAndCaption('data:image/png;base64,dGVzdA==','data:image/png;base64,dGVzdA==',1,30,[]);
 assert.equal(bad.ok,false);assert.equal(bad.defect,'extra_hand');assert.match(bad.reason,/^extra_hand/);
 assert.equal(body.format.properties.people.items.properties.hands.type,'integer');assert.match(body.prompt,/hands is raisedHands \+ objectHands \+ otherHands/);
 assert.deepEqual(Object.keys(body.format.properties.people.items.properties).slice(0,5),['raisedHands','objectHands','otherHands','handPositions','hands']);assert.deepEqual(body.format.properties.people.items.required.slice(0,5),['raisedHands','objectHands','otherHands','handPositions','hands']);
 assert.match(body.prompt,/when two hands hold the object AND a hand is raised, that is 3 hands/);
 answer=[observed(2)];
 const good=await inspectAndCaption('data:image/png;base64,dGVzdA==','data:image/png;base64,dGVzdA==',1,30,[]);
 assert.equal(good.ok,true);assert.equal(good.defect,undefined);assert.equal(good.observationFacts.people[0].hands,2);
 answer=[observed()];
 assert.equal((await inspectAndCaption('data:image/png;base64,dGVzdA==','data:image/png;base64,dGVzdA==',1,30,[])).ok,true);
 assert.equal(calls,3);
});
test('inspection hand positions: 3+ listed positions reject even when hands says 2; 2 positions pass',async t=>{
 const three=['raised beside left shoulder, waving','on tablet at chest','under tablet at chest'];
 assert.deepEqual(extraHandPerson([{...observed(2),handPositions:three}]),{index:0,hands:3});
 assert.deepEqual(extraHandPerson([{...observed(),handPositions:three}]),{index:0,hands:3});
 assert.equal(extraHandPerson([{...observed(2),handPositions:three.slice(1)}]),null);
 assert.equal(extraHandPerson([{...observed(2),handPositions:['a','',' ']}]),null);
 // the list is the evidence: 2 entries with hands=3 is a 2-hand person (regression B_new_s1); empty list falls back to hands
 assert.equal(extraHandPerson([{...observed(3),handPositions:three.slice(1)}]),null);
 assert.deepEqual(extraHandPerson([{...observed(3),handPositions:[]}]),{index:0,hands:3});
 t.mock.method(globalThis,'fetch',async()=>Response.json({response:JSON.stringify({people:[{...observed(2),handPositions:three}]}),done_reason:'stop'}));
 const r=await inspectAndCaption('data:image/png;base64,dGVzdA==','data:image/png;base64,dGVzdA==',1,30,[]);
 assert.equal(r.ok,false);assert.equal(r.defect,'extra_hand');assert.match(r.reason,/shows 3 hands/);
 assert.deepEqual(r.observationFacts.people[0].handPositions,three);assert.equal(r.observationFacts.people[0].hands,2);
});

test('arms crossed / hug + raise or wave: the action itself uncrosses the arms, and the Main-change line repeats it',()=>{
 const crossed:PersonInfo={position:'left front',pose:'standing with arms crossed',clothes:'dark button-up shirt',facing:'side',holding:'black tablet'};
 const hug:PersonInfo={...crossed,pose:'standing',holding:'black tablet hugged to the chest'};
 const raise1='The person in the dark button-up shirt raises one hand lightly.';
 const SENT='The person in the dark button-up shirt uncrosses the arms, keeps the black tablet against the body with one arm, and raises the other hand lightly; exactly two hands.';
 assert.equal(armsChangeAction(raise1,handConflict(crossed,raise1)),SENT);
 assert.equal(armsChangeAction(raise1,handConflict(hug,raise1)),SENT);
 assert.equal(armsChangeAction('The person waves lightly. Hand use: raises one existing hand lightly.',handConflict(crossed,'The person waves lightly.')),'The person uncrosses the arms, keeps the black tablet against the body with one arm, and raises the other hand to wave lightly; exactly two hands. Hand use: raises one existing hand lightly.');
 assert.equal(armsChangeAction(SENT,handConflict(crossed,SENT)),SENT);
 assert.equal(armsChangeAction(raise1,null),raise1);
 assert.equal(armsChangeAction('The person turns the head.',handConflict(crossed,'The person turns the head.')),'The person turns the head.');
 for(const compactPeople of [true,false]){
  const p=composeEditInstruction({predictionPrompt:raise1,presence:1,people:[crossed],personCount:1,compactPeople});
  // 2026-10-21 rebuild: the rewritten action is stated exactly once (no Main-change repeat).
  assert.match(p,/uncrosses the arms, keeps the black tablet against the body with one arm, and raises the other hand lightly; exactly two hands\./);
  assert.equal(p.split('uncrosses the arms').length-1,1);assert.doesNotMatch(p,/Main change/);
  assert.match(p,/[Ee]xactly two hands/);assert.doesNotMatch(p,COMMIT);
 }
 assert.equal(mainActionSentence(armsChangeAction(raise1+' Hand use: x.',handConflict(crossed,raise1))),SENT);
});
test('two-hand tablet grip + raise one hand (F010): the action releases one hand, keeps the tablet on one arm',()=>{
 const out=armsChangeAction(raise,handConflict(tablet,raise));
 assert.equal(out,'The existing person on the left side of the image wearing dark shirt with buttons takes one hand off the black tablet, keeps the black tablet against the body with one arm, and raises the other hand lightly; exactly two hands.');
 const p=composeEditInstruction({predictionPrompt:raise,presence:1,people:[tablet],personCount:1,compactPeople:true});
 assert.equal(p.split('takes one hand off').length-1,1);
 assert.match(p,/takes one hand off the black tablet, keeps the black tablet against the body with one arm, and raises the other hand lightly; exactly two hands\./);
 assert.doesNotMatch(p,COMMIT);
});
