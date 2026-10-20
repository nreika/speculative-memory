import test from 'node:test';
import assert from 'node:assert/strict';
import {sceneBelongings,behindViewFreeSpotSentence,freeSpotSide,occupiedFurniture,isStandingAction,inspectionBelongings} from './behindViewPlacement';
import {behindViewSentence,composeEditInstruction} from './orchestrator';
import {parseSceneBelongings,parsePeople,DESCRIBE_SCHEMA,DESCRIBE_PROMPT} from './peopleDescribe';

const BAGS='A blue backpack and a black jacket hang on the chair at the right; a laptop sits on the desk.';
const TAIL=' If an empty chair with nothing on it stands nearby, the person may sit on that empty one instead; never stand or sit on, in front of or in place of the chair that holds belongings.';

test('G-14 v2 free spot: chair on the right -> the person stands to its LEFT, belongings stay visible to the right',()=>{
 assert.deepEqual(occupiedFurniture(BAGS,['blue backpack','black jacket','laptop']),{name:'chair',side:'right'});
 const s=behindViewFreeSpotSentence({scene:BAGS,objects:['blue backpack','black jacket','laptop'],position:'center'});
 assert.equal(s,'Free spot for the standing person: standing to the LEFT of the chair, in front of the empty part of the desk, not overlapping the chair; the chair with the blue backpack and the black jacket stays fully visible to the right of the person.'+TAIL);
});
test('G-14 v2 free spot: chair at left front / recent person on the left -> RIGHT of the chair',()=>{
 assert.match(behindViewFreeSpotSentence({scene:'A chair at left front holds a grey coat.',objects:['grey coat']}),/standing to the RIGHT of the chair, on the free floor, not overlapping the chair; the chair with the grey coat stays fully visible to the left of the person\./);
 assert.equal(freeSpotSide({scene:'An office with a chair.',position:'left front'}),'right');
 assert.equal(freeSpotSide({scene:'An office with a chair.',position:'center',headBox:[700,100,800,250]}),'left');
 assert.equal(freeSpotSide({scene:'An office with a chair.',position:'right',headBox:[100,100,200,250]}),'right','head box beats the position word');
});
test('G-14 v2 free spot: no horizontal hint -> the side farther from the image centre (F004 archive 17-52-16 reconstruction)',()=>{
 const scene='An office desk with a laptop, monitor, and chair. Transparent curtains divide the space. Exposed ceiling pipes and shelves with boxes are visible.';
 assert.equal(freeSpotSide({scene,position:'center'}),undefined);
 const s=behindViewFreeSpotSentence({scene,objects:sceneBelongings(scene),position:'center',headBox:null});
 assert.equal(s,'Free spot for the standing person: standing beside the chair on its side farther from the centre of the image, in front of the empty part of the desk, not overlapping the chair; the chair and everything on it stays fully visible next to the person.'+TAIL);
});
test('G-14 v2: the free spot is added for standing/walking actions only; the generic protection text stays',()=>{
 assert.equal(isStandingAction('The person stands quietly with their back to the camera.'),true);
 assert.equal(isStandingAction('The person walks slowly toward the shelf with their back to the camera.'),true);
 assert.equal(isStandingAction('The person sits quietly with their back to the camera.'),false);
 const look={clothes:'white shirt',position:'center',objects:['blue backpack'],scene:BAGS};
 const stand=behindViewSentence(look,'The person stands quietly with their back to the camera.');
 assert.match(stand,/BESIDE the existing furniture and objects/);assert.match(stand,/standing to the LEFT of the chair/);
 const sit=behindViewSentence(look,'The person sits quietly with their back to the camera.');
 assert.match(sit,/BESIDE the existing furniture and objects/);assert.doesNotMatch(sit,/Free spot/);
 const p=composeEditInstruction({predictionPrompt:'The person stands quietly with their back to the camera.',presence:0.7,referencePerson:true,behindView:look});
 assert.match(p,/Free spot for the standing person: standing to the LEFT of the chair/);
});
test('inspectionBelongings: singular scene objects only; moved/held objects are left out',()=>{
 assert.deepEqual(inspectionBelongings('A blue backpack and a black jacket hang on the chair; shelves with boxes.'),['blue backpack','black jacket']);
 assert.deepEqual(inspectionBelongings('A blue backpack and a black jacket hang on the chair.',{action:'The person picks up the backpack.'}),['black jacket']);
 assert.deepEqual(inspectionBelongings('A laptop and a white cup on the desk.',{people:[{holding:'white cup'}]}),['laptop']);
 assert.deepEqual(inspectionBelongings(undefined),[]);
});

const F004_SCENE='An office desk with a laptop, monitor, and chair. Transparent curtains divide the space. Exposed ceiling pipes and shelves with boxes are visible.';
const F004_BELONGINGS=parseSceneBelongings(JSON.stringify({people:[],belongings:[{name:'blue backpack',on:'chair',position:'left'},{name:'black jacket',on:'chair',position:'left'}]}));
test('guard.belongings (describe call) feed the free spot when the scene names none: F004 reconstruction',()=>{
 const s=behindViewFreeSpotSentence({scene:F004_SCENE,objects:sceneBelongings(F004_SCENE),position:'center',headBox:null,belongings:F004_BELONGINGS});
 assert.equal(s,'Free spot for the standing person: standing to the RIGHT of the chair, in front of the empty part of the desk, not overlapping the chair; the chair with the blue backpack and the black jacket stays fully visible to the left of the person.'+TAIL);
 assert.equal(freeSpotSide({scene:F004_SCENE,position:'center',belongings:[{name:'grey coat',on:'chair at right',position:'right'}]}),'left');
 assert.equal(freeSpotSide({scene:'A chair at the left.',belongings:[{name:'grey coat',on:'chair',position:'right'}]}),'right','scene position wins');
});
test('objectsVisible list: guard.belongings first, then singular scene objects, deduped by noun, max 6, moving items left out',()=>{
 assert.deepEqual(inspectionBelongings(F004_SCENE,{belongings:F004_BELONGINGS}),['blue backpack','black jacket','laptop']);
 assert.deepEqual(inspectionBelongings('A backpack on the chair and a white cup.',{belongings:F004_BELONGINGS,action:'The person picks up the jacket.'}),['blue backpack','white cup']);
 const many=['a','b','c','d','e','f','g'].map(x=>({name:`item ${x}`,on:'desk',position:'center' as const}));
 assert.equal(inspectionBelongings('A laptop.',{belongings:many.map((b,i)=>({...b,name:`thing${i}`}))}).length,6);
 assert.deepEqual(inspectionBelongings(undefined,{belongings:F004_BELONGINGS}),['blue backpack','black jacket']);
});
test('parseSceneBelongings is tolerant: missing -> [], invalid entries dropped, position from "on" when missing, max 6',()=>{
 assert.deepEqual(parseSceneBelongings('{"people":[]}'),[]);
 assert.deepEqual(parseSceneBelongings('not json'),[]);
 assert.deepEqual(parseSceneBelongings({belongings:[{name:''},{on:'chair'},{name:'Blue  Backpack',on:'Chair at left'},{name:'blue backpack',on:'x',position:'right'}]}),[{name:'blue backpack',on:'chair at left',position:'left'}]);
 assert.equal(parseSceneBelongings({belongings:Array.from({length:9},(_,i)=>({name:`bag ${i}`,on:'floor',position:'center'}))}).length,6);
});
test('describe schema/prompt require belongings for every capture (also empty rooms); parsePeople ignores it',()=>{
 assert.ok(DESCRIBE_SCHEMA.required.includes('belongings'));
 assert.equal((DESCRIBE_SCHEMA.properties as any).belongings.maxItems,6);
 assert.match(DESCRIBE_PROMPT,/whether or not a person is present/);
 assert.deepEqual(parsePeople('{"people":[],"obstructed":false,"obstructedBy":"","belongings":[{"name":"blue backpack","on":"chair","position":"left"}]}'),[]);
});
