import test from 'node:test';
import assert from 'node:assert/strict';
import type {PersonInfo} from './peopleDescribe';
import {composeCoherentEdit,backViewAction,FACE_WORDS,toneSentence,movedObjectSentence,behindViewPlacementByPresence,behindViewRetryAnchor,keepReferenceIndexes,referenceOwners,temporalSentence,presenceSentence} from './editPrompt';

const away:PersonInfo={position:'left front',pose:'seated in a chair',clothes:'grey striped shirt',facing:'away',hair:'short black hair'};
const toward:PersonInfo={position:'right back',pose:'standing',clothes:'blue hoodie',facing:'toward',holding:'white cup'};
const occurrences=(hay:string,needle:string)=>hay.split(needle).length-1;
/** Face words outside the sentences that forbid a face. */
const faceWordsOutsideNegations=(s:string)=>s.split(/(?<=[.;])\s+/).flatMap(x=>x.split(/;\s*/)).filter(x=>!/\b(?:never|no)\b/i.test(x)).filter(x=>FACE_WORDS.test(x));

test('away person: face/gaze action is rewritten, no face words, no face references',()=>{
 const action='The person looks at the monitor and smiles, then raises the right hand.';
 const p=composeCoherentEdit({action,people:[away],personCount:1,tone:.6,presence:.6,spanSec:30,references:[]});
 assert.deepEqual(faceWordsOutsideNegations(p),[]);
 assert.match(p,/seen from behind, back of head to camera, face never visible/);
 assert.match(p,/tilts the head toward the monitor/);
 assert.doesNotMatch(p,/image2/);
 assert.equal(backViewAction('The person smiles warmly.'),'The person shifts the shoulders and moves one arm slightly.');
 assert.match(backViewAction('The person drinks from the white cup.'),/raises the white cup in front of the body/);
});

test('the action appears exactly once and the prompt is short',()=>{
 const action='The person raises both arms above the head in a big stretch.';
 const p=composeCoherentEdit({action,people:[{...toward,holding:undefined}],personCount:1,tone:.9,presence:.8,spanSec:30});
 assert.equal(occurrences(p,'raises both arms above the head'),1);
 assert.doesNotMatch(p,/Main change|Main difference|clearly visible in the pose/);
 assert.ok(p.length<1200,`length ${p.length}`);
});

test('presence changes the text',()=>{
 const base={action:'The person raises one hand.',people:[toward],personCount:1,tone:.5,spanSec:30};
 const low=composeCoherentEdit({...base,presence:.1}),high=composeCoherentEdit({...base,presence:.9});
 assert.notEqual(low,high);
 assert.match(low,/barely there/);assert.match(high,/fully present/);
 assert.notEqual(presenceSentence(.3,1),presenceSentence(.6,1));
});

test('past lead never says undo',()=>{
 for(const c of [undefined,'ongoing','new','unknown'] as const){
  const t=temporalSentence(-30,c);
  assert.doesNotMatch(t,/undo/i);assert.match(t,/30 seconds before image1/);
  assert.doesNotMatch(composeCoherentEdit({action:'The person rests the hands on the desk.',people:[away],presence:.5,tone:.3,spanSec:-30,pastContinuity:c}),/undo/i);
 }
});

test('two people: the actor is named by clothes, references only for visible faces and named',()=>{
 const p=composeCoherentEdit({action:'The person in the blue hoodie lifts the white cup.',people:[away,toward],personCount:2,tone:.5,presence:.5,spanSec:30,references:[1]});
 assert.match(p,/image2 shows the face and hair of the person in the blue hoodie/);
 assert.match(p,/There are 2 people/);
 const generic=composeCoherentEdit({action:'The person lifts the white cup.',people:[{...away,holding:'white cup'},{...toward,holding:undefined}],personCount:2,presence:.5,spanSec:30});
 assert.match(generic,/The person in the grey striped shirt raises the white cup|The person in the grey striped shirt lifts the white cup/);
});

test('reference selection: all away -> none; mixed -> only visible faces; owners from head crops',()=>{
 assert.deepEqual(keepReferenceIndexes([away],[0]),[]);
 assert.deepEqual(keepReferenceIndexes([away,{...away,position:'right'}],[null,null]),[]);
 assert.deepEqual(keepReferenceIndexes([away,toward],[0,1]),[1]);
 assert.deepEqual(keepReferenceIndexes([away,toward],[null]),[]);
 assert.deepEqual(keepReferenceIndexes([toward],[null,null]),[0,1]);
 const owners=referenceOwners({people:[{...away,headBox:null},toward],refFrames:['S'],crops:[{}],sceneImage:'S',hasHeadBox:p=>p===toward});
 assert.deepEqual(owners,[1]);
});

test('seated actor does not stand up; edge-cropped actor does not walk away',()=>{
 const seated:PersonInfo={...toward,pose:'seated at the desk'};
 assert.doesNotMatch(composeCoherentEdit({action:'The person stands up from the chair.',people:[seated],presence:.5,spanSec:30}),/stands up/);
 const edge:PersonInfo={...toward,position:'right edge, partially visible'};
 assert.doesNotMatch(composeCoherentEdit({action:'The person walks away to the door.',people:[edge],presence:.5,spanSec:30}),/walks away/);
});

test('time distance: exact span and a clause that scales with it',()=>{
 const base={action:'The person types on the laptop.',people:[toward],personCount:1,tone:.5,presence:.5};
 const short=composeCoherentEdit({...base,spanSec:30}),long=composeCoherentEdit({...base,spanSec:600});
 assert.match(short,/This is 30 seconds later: the next moment of the same activity/);
 assert.match(long,/This is 10 minutes later: /);
 assert.doesNotMatch(long,/same activity/);
 assert.doesNotMatch(short,/elsewhere/);
 assert.match(long,/elsewhere in the room/);
 assert.notEqual(temporalSentence(-150,'unknown'),temporalSentence(-30,'unknown'));
 assert.match(temporalSentence(-150),/2 minutes 30 seconds before image1/);
 assert.doesNotMatch(temporalSentence(-900),/same activity/);
 // Long spans lift the seated limit (the person may have stood up 10 minutes later).
 const seated:PersonInfo={...toward,pose:'seated at the desk'};
 assert.match(composeCoherentEdit({action:'The person stands up from the chair.',people:[seated],presence:.5,spanSec:600}),/stands up/);
});

test('world rule: room objects allowed, held objects may be released, no same-hand/original-photo-only sentences',()=>{
 const p=composeCoherentEdit({action:'The person puts the white cup down on the desk.',people:[toward],personCount:1,presence:.5,spanSec:30});
 assert.match(p,/Objects seen earlier in this room may appear and held movable objects may be put down or moved/);
 assert.match(p,/nothing that was never in this room, and no duplicate copy of any person or object/);
 assert.doesNotMatch(p,/same hand|only with its original owner|not visible in the original photo|stays with its owner/);
 assert.match(composeCoherentEdit({action:'The person rests.',people:[away],presence:.5,spanSec:30}),/People seen from behind stay seen from behind/);
});

import {generateImage,composeEditInstruction,type ImageTrace} from './orchestrator';
import {compactPeopleInstruction} from './compactPeople';
const IMG='data:image/png;base64,dGVzdA==',REF='data:image/png;base64,cmVm';
async function run(t:any,people:PersonInfo[],refs:string[],crops?:any[]){
 let uploads=0;const trace:ImageTrace={};
 t.mock.method(globalThis,'fetch',async(input:unknown,init?:RequestInit)=>{
  const url=String(input);
  if(url.includes('/upload/image')){uploads++;return Response.json({name:'u'+Math.random()+'.png'});}
  if(url.endsWith('/prompt'))return Response.json({prompt_id:'ep-test'});
  if(url.includes('/history/'))return Response.json({'ep-test':{status:{status_str:'success'},outputs:{'80':{images:[{filename:'t.png',type:'output',subfolder:''}]}}}});
  if(url.includes('/view?'))return new Response(new Uint8Array([1,2,3]));
  throw new Error('Unexpected URL '+url);
 });
 await generateImage({originalImageDataUrl:IMG,referenceImages:refs,referenceCrops:crops,predictionPrompt:'The person raises one hand.',presence:.6,tone:.5,people,personCount:people.length,compactPeople:true,imageBackend:'local',localImageEngine:'qwen2511',trace});
 t.mock.restoreAll();
 return {uploads,prompt:String(trace.editInstruction)};
}

test('(1) every original person facing away: no reference image is passed',async t=>{
 const a=await run(t,[away],[REF]),b=await run(t,[toward],[REF]);
 assert.ok(a.uploads<b.uploads,`uploads away ${a.uploads} vs toward ${b.uploads}`);
 assert.doesNotMatch(a.prompt,/image2/);
 assert.match(b.prompt,/image2 shows the face and hair of the person in the blue hoodie/);
});

test('(2) two people: only the side/toward person keeps a reference, and the text names whose it is',async t=>{
 const people=[{...away,headBox:[300,100,400,200] as [number,number,number,number]},{...toward,headBox:[600,100,700,200] as [number,number,number,number]}];
 const r=await run(t,people,[IMG,IMG],[{x:0,y:0,width:64,height:64},{x:100,y:0,width:64,height:64}]);
 assert.match(r.prompt,/image2 shows the face and hair of the person in the blue hoodie\./);
 assert.doesNotMatch(r.prompt,/image3|grey striped shirt[^;.]*image|face and hair of the person in the grey/);
});

test('(3) the Image2/image3 identity sentence appears only when references are passed',()=>{
 assert.doesNotMatch(compactPeopleInstruction([toward],1,'The person raises one hand.'),/Image2\/image3/);
 assert.match(compactPeopleInstruction([toward],1,'The person raises one hand.',false,true),/Image2\/image3 are identity references/);
 assert.doesNotMatch(composeEditInstruction({predictionPrompt:'The person raises one hand.',people:[toward],personCount:1,compactPeople:true,presence:.5}),/image2|Image2/);
 assert.doesNotMatch(composeEditInstruction({predictionPrompt:'The person raises one hand.',people:[away],personCount:1,compactPeople:true,presence:.5,referenceFrames:true}),/image2|Image2/);
});

test('retry correction: the action is not restated, the fix goes after the constraints',()=>{
 const action='The person raises the right hand.';
 const p=composeCoherentEdit({action:action+' The requested action must be clearly visible in the pose: '+action+' Each person has exactly two hands and two arms; no extra hand, arm or finger anywhere.',people:[{...toward,holding:undefined}],presence:.5,spanSec:30});
 assert.equal(occurrences(p,'raises the right hand'),1);
 assert.match(p,/Fix from the previous attempt: Each person has exactly two hands and two arms/);
});

test('tone never reads theatrical; no "set down" clause when nobody holds anything',()=>{
 const hi=composeCoherentEdit({action:'The person stretches.',people:[{...toward,holding:undefined}],presence:.9,tone:1,spanSec:30});
 assert.match(hi,/a big but ordinary everyday movement, as a real person would do in this room/);
 assert.doesNotMatch(hi,/energetic|dramatic|clearly different pose|set down/);
 assert.match(composeCoherentEdit({action:'The person stretches.',people:[toward],presence:.5,tone:.1,spanSec:30}),/a small natural movement/);
 assert.match(hi,/fully present, the centre of attention/);
 assert.match(presenceSentence(.4,1),/present but subdued/);
});

test('back view keeps "with their back to the camera" whole; moved objects leave their old place',()=>{
 assert.match(backViewAction('The person rolls the shoulders, with their back to the camera.'),/with their back to the camera/);
 assert.doesNotMatch(backViewAction('The person turns toward the camera and waves.'),/camera/);
 assert.match(composeCoherentEdit({action:'The person picks up the blue bottle.',people:[toward],presence:.5,spanSec:30}),/a held or moved object is the existing one \(desk to hand, hand to desk\) and is gone from its old place/);
});

test('two people and a generic "The person" action: the actor is named by clothes',()=>{
 const p=composeCoherentEdit({action:'The person stretches both arms forward.',people:[away,{...toward,holding:undefined}],personCount:2,presence:.5,spanSec:30});
 assert.match(p,/The person in the grey striped shirt stretches both arms forward\./);
});

test('high Tone names concrete in-place posture changes, never face words',()=>{
 const t=toneSentence(1);
 assert.match(t,/whole posture clearly changes in place/);assert.match(t,/leaning far back in the chair/);
 assert.doesNotMatch(t,FACE_WORDS);assert.doesNotMatch(toneSentence(.6),FACE_WORDS);
 assert.notEqual(toneSentence(.1),toneSentence(1));
});

test('behind view (recent person in an empty room): Presence sets size and depth, never close to the camera',()=>{
 const at=(presence:number)=>composeEditInstruction({predictionPrompt:'The person sits quietly with their back to the camera.',presence,referencePerson:true,behindView:{clothes:'striped shirt',position:'left front'}});
 assert.match(at(.28),/Place them against the back wall of the room, small in the distance and partly out of view, back to the camera; the chair at the near desk stays empty/);
 assert.match(at(.5),/at mid-distance by the far desk, normal size/);
 assert.match(at(.9),/near the front desk, fully in view, back to the camera/);
 for(const p of [.28,.5,.9]){assert.match(at(p),/never close to the camera and never filling the frame/);assert.match(at(p),/on the left side, seen from behind/);assert.doesNotMatch(at(p),/at the left front/);}
});

test('short spans pin the frame position; a person cut off by the edge stays cut off',()=>{
 const edge:PersonInfo={...toward,position:'left front',headBox:[0,300,120,450]};
 const p=composeCoherentEdit({action:'The person blinks slowly.',people:[edge],presence:.5,spanSec:30});
 assert.match(p,/The person keeps the exact same position and size in the frame, still cut off by the image edge as in image1; only the described body parts move\./);
 assert.match(composeCoherentEdit({action:'The person nods.',people:[toward],presence:.5,spanSec:30}),/The person keeps the same place in the frame/);
 assert.doesNotMatch(composeCoherentEdit({action:'The person walks to the shelf.',people:[toward],presence:.5,spanSec:600}),/keeps the same place in the frame/);
});

test('2 people, one at the edge: only that person is named as cut off; tone examples follow posture',()=>{
 const edge:PersonInfo={...toward,position:'left front',pose:'standing',headBox:[0,300,120,450]};
 const p=composeCoherentEdit({action:'The person in the blue hoodie opens the cup lid.',people:[edge,away],personCount:2,presence:.5,tone:1,spanSec:30});
 assert.match(p,/Each person keeps the exact same position and size in the frame; the person in the blue hoodie stays cut off by the image edge as in image1; only the described body parts move\./);
 assert.doesNotMatch(p,/chair/);
 assert.match(toneSentence(1,'seated'),/leaning far back in the chair/);
});

test('empty scene: no person image, no person words from a retry correction, no "activity" wording',async t=>{
 const empty=composeEditInstruction({predictionPrompt:'The room stays empty; nothing in it has been moved. Draw each person as ONE coherent body: the face on the front of the head, never a face on the back of the head.',presence:0,distanceSec:-30});
 assert.doesNotMatch(empty,/\b(?:face|person|people|activity)\b/i);
 assert.match(empty,/This is 30 seconds before image1: a slightly earlier moment of the same room\./);
 let uploads=0;
 t.mock.method(globalThis,'fetch',async(input:unknown)=>{
  const url=String(input);
  if(url.includes('/upload/image')){uploads++;return Response.json({name:'u'+Math.random()+'.png'});}
  if(url.endsWith('/prompt'))return Response.json({prompt_id:'ep-empty'});
  if(url.includes('/history/'))return Response.json({'ep-empty':{status:{status_str:'success'},outputs:{'80':{images:[{filename:'t.png',type:'output',subfolder:''}]}}}});
  if(url.includes('/view?'))return new Response(new Uint8Array([1,2,3]));
  throw new Error('Unexpected URL '+url);
 });
 const trace:ImageTrace={};
 await generateImage({originalImageDataUrl:IMG,faceImageDataUrl:REF,referenceImages:[REF],predictionPrompt:'The curtain sways slightly.',presence:0,imageBackend:'local',localImageEngine:'qwen2511',trace});
 t.mock.restoreAll();
 assert.equal(trace.referenceImage,'none');
 assert.equal(uploads,1,'only the scene image is uploaded');
});

test('picked-up object is named as the same one; head near the edge counts as edge-cropped',()=>{
 const p=composeCoherentEdit({action:'The person reaches forward with both arms to grasp the blue water bottle on the desk.',people:[away],presence:.5,spanSec:-30});
 assert.match(p,/The blue water bottle in the hand is the same one that was on the desk; its old spot is now empty\./);
 assert.equal(movedObjectSentence('The person raises one hand.'),'');
 const edge:PersonInfo={...away,headBox:[75,520,215,750]};
 assert.match(composeCoherentEdit({action:'The person nods.',people:[edge],presence:.5,spanSec:30}),/still cut off by the image edge as in image1/);
 assert.doesNotMatch(composeCoherentEdit({action:'The person nods.',people:[{...away,headBox:[450,300,550,450]}],presence:.5,spanSec:30}),/cut off/);
});

test('behind view: a hair description without "hair" reads as an adjective',()=>{
 const p=composeEditInstruction({predictionPrompt:'The person sits quietly.',presence:.5,referencePerson:true,behindView:{clothes:'dark grey t-shirt',hair:'bald',position:'center'}});
 assert.match(p,/wearing dark grey t-shirt, bald, in the middle, seen from behind/);
 assert.doesNotMatch(p,/with bald/);
});

test('face-only action pins the pose (hands behind head stay), and no big-movement sentence contradicts it',()=>{
 const man:PersonInfo={position:'center',pose:'seated, hands behind head',clothes:'black t-shirt',facing:'toward'};
 const p=composeCoherentEdit({action:'The person blinks slowly, gaze fixed, expression neutral.',people:[man],presence:.5,tone:1,spanSec:30});
 assert.match(p,/in image1 hands behind head/);
 assert.match(p,/holds exactly the same pose as in image1; the hands and arms stay where they are/);
 assert.match(p,/a small natural movement/);assert.doesNotMatch(p,/big but ordinary/);
 const moving=composeCoherentEdit({action:'The person pulls the white cup closer.',people:[man],presence:.5,tone:1,spanSec:30});
 assert.doesNotMatch(moving,/holds exactly the same pose/);assert.match(moving,/big but ordinary/);
});

test('low Presence behind view: concrete far anchor from the scene text (Japanese too), same words in the retry line',()=>{
 const p=composeEditInstruction({predictionPrompt:'The person sits quietly.',presence:.28,referencePerson:true,behindView:{clothes:'dark grey t-shirt',scene:'オフィスの机に二つのモニター。左側にはグレーのカーテンが吊り下がっている。'}});
 assert.match(p,/Place them half hidden behind the curtain at the back of the room, small in the distance and partly out of view, back to the camera; the chair at the near desk stays empty/);
 assert.match(behindViewPlacementByPresence(.2,'metal shelves along the back wall'),/by the far shelves at the back of the room/);
 assert.match(behindViewRetryAnchor(.2,'metal shelves'),/^The person was drawn too large or too close\. Place them by the far shelves at the back of the room/);
});

test('edge-cropped person: no face reference; a generic "visible object" is not invented',()=>{
 const edge:PersonInfo={...toward,headBox:[0,0,200,500]};
 assert.deepEqual(keepReferenceIndexes([edge],[0]),[]);
 assert.deepEqual(keepReferenceIndexes([edge,{...toward,position:'right',headBox:[600,100,700,200]}],[0,1]),[1]);
 const p=composeCoherentEdit({action:'The person reaches to the side with one arm and takes a visible object.',people:[edge],presence:.5,spanSec:30});
 assert.match(p,/The person reaches to the side with one arm\./);assert.doesNotMatch(p,/visible object/);
});

import {isEmptyRoomNoChange} from './editPrompt';
test('empty room where nothing changes: no model call, the NOW frame is returned',async t=>{
 assert.equal(isEmptyRoomNoChange('The room stays empty; nothing in it has been moved.'),true);
 assert.equal(isEmptyRoomNoChange('The room stays empty; the chair rotates slightly.'),false);
 assert.equal(isEmptyRoomNoChange('The curtain sways slightly.'),false);
 assert.equal(isEmptyRoomNoChange('The room stays empty and nothing in it has been moved; only the light changes slightly.'),true);
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('no model call expected');});
 const trace:ImageTrace={};
 const out=await generateImage({originalImageDataUrl:IMG,predictionPrompt:'The room stays empty; nothing in it has been moved.',presence:0,imageBackend:'local',localImageEngine:'qwen2511',trace});
 t.mock.restoreAll();
 assert.equal(out,IMG);assert.equal(calls,0);assert.match(String(trace.editInstruction),/no edit/);
});
