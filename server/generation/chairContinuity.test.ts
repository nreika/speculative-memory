import test from 'node:test';import assert from 'node:assert/strict';
import {composeEditInstruction} from './orchestrator';
import {buildPlanRequestBody} from './vlmClient';
import {sanitizeEmptyRoomPrediction,findFabricatedScenarios} from './scenarioGuard';
import {getRulebook,validateRulebook} from './rulebook';
import path from 'node:path';
process.env.RULEBOOK_DIR=path.resolve('rulebook');

test('G20 empty-room swivel survives image instructions without freezing all objects',()=>{
 const p=composeEditInstruction({predictionPrompt:'The existing chair swivels slightly on its base.',presence:0,tone:.4,foregroundObject:'the backrest of an office chair'});
 assert.match(p,/chair swivels slightly/);assert.match(p,/identity, count/);assert.match(p,/continuous structure/);
 assert.doesNotMatch(p,/scene and all lighting pixel-identical|every object stays exactly where|empty chairs exactly|outline, position and texture exactly|Keep the unoccupied scene exactly/);
 assert.match(p,/exposure|lighting colour/);assert.match(p,/never erase, replace, duplicate or invent objects/i);
});
test('G20 visible furniture part names do not erase a whole valid object-motion clause',()=>{
 assert.equal(sanitizeEmptyRoomPrediction('The armchair turns slightly, with both armrests intact.'),'The upholstered chair turns slightly, with both side supports intact');
 assert.equal(sanitizeEmptyRoomPrediction('Nobody enters. The chair rotates slightly.'),'The chair rotates slightly');
});
test('G18 lighting edits removed while chair movement remains',()=>{
 const p=composeEditInstruction({predictionPrompt:'The chair rotates slightly and the room lighting becomes warmer.',presence:0});
 assert.match(p,/chair rotates slightly/);assert.doesNotMatch(p,/lighting becomes warmer/);assert.match(p,/Keep the exact input exposure, brightness, lighting colour, white balance/);
});
test('G18 empty-room person additions still rejected',()=>{
 const scenarios=[{prediction_prompt:'A man enters and pushes the chair.',scenario_description:'A man appears.',label:'x'}]as any;
 assert.deepEqual(findFabricatedScenarios('An empty office with chairs.',scenarios),[0]);
 assert.equal(sanitizeEmptyRoomPrediction('A man enters and moves the chair.'),'Keep the scene exactly as in the input');
});
test('planner permits context-supported movement while keeping physical, light and unknown-object constraints',()=>{
 const p=buildPlanRequestBody('test','data:image/jpeg;base64,AA==').prompt;
 assert.match(p,/existing movable object may move or rotate naturally/);assert.match(p,/never make it vanish or replace it/);assert.match(p,/Do not invent an invisible mover/);
 assert.doesNotMatch(p,/NEVER move, rotate, open or remove any object|changes of objects or light there|a monitor off/);
 assert.match(p,/Do not add, duplicate or remove objects/);assert.match(p,/all screen contents and lighting stay unchanged/);
});
test('obstruction is not erased or frozen by contradictory foreground text',()=>{
 const p=composeEditInstruction({predictionPrompt:'The foreground chair swivels slightly.',presence:0,obstructed:true,obstructedBy:'mesh chair',foregroundObject:'mesh chair backrest'});
 assert.match(p,/may move naturally only when required/);assert.match(p,/correct foreground\/background occlusion/);
 assert.doesNotMatch(p,/keep that object and the whole composition exactly/);
});
test('existing person actions preserved for cup, cheer and desk regressions',()=>{
 for(const action of ['The person stands up while holding the cup.','The left person cheers while the other person stays seated.','The person raises the right hand to shoulder height while the left stays on the keyboard.']){
  const p=composeEditInstruction({predictionPrompt:action,presence:.7,personCount:action.includes('left person')?2:1});
  assert.ok(p.includes(action));assert.match(p,/exact input exposure/);
 }
});
test('active rulebook (>=v18) validates without scene-specific object count or coordinate constants',()=>{
 const r=getRulebook();assert.ok(r.version>=18);assert.deepEqual(validateRulebook(r),[]);
 const p=JSON.stringify(r.imagePrompt);assert.doesNotMatch(p,/TSC-|two black mesh|lower left|center-right|11027/);
});

test('final planner and image prompts include active rulebook extras without empty-scene freezing',()=>{
 const planner=buildPlanRequestBody('Existing movable furniture follows the requested scenario.','data:image/jpeg;base64,AA==').prompt;
 const image=composeEditInstruction({predictionPrompt:'The existing chair swivels slightly.',presence:0,tone:.4});
 for(const p of [planner,image]){
  assert.doesNotMatch(p,/If empty, keep the scene unchanged|NEVER move, rotate, open or remove any object|every object stays exactly where it is|room, objects, screens and lighting stay unchanged|Keep the unoccupied scene exactly as in the input|scene and all lighting pixel-identical/);
  assert.match(p,/identity, count|identities, counts/);assert.match(p,/continuity|continuous structure/);
 }
 assert.match(planner,/In an empty scene, existing movable objects may move naturally/);
});

test('presence-mode person motion instructions are unchanged from the baseline configuration',async()=>{
 const fs=await import('node:fs');
 const candidate=JSON.parse(fs.readFileSync('gemini-prompts.json','utf8'));
 const texts=(x:any):string[]=>typeof x==='string'?[x]:Array.isArray(x)?x.flatMap(texts):x&&typeof x==='object'?Object.values(x).flatMap(texts):[];
 const oldPeople=[
  'People: nobody who is not already visible appears, not even partly at a frame edge. People who are visible stay almost still and stay in the frame: only minimal motion (a slight shift of posture, a head turn). ',
  'People: nobody new appears. People who are visible move slightly and naturally (small posture changes, a head turn, a small hand movement) and stay where they are in the frame. ',
  'People: nobody new appears. People who are visible move naturally for the time span (changing posture, using their hands, shifting position a little, turning to look elsewhere) and stay in the frame. ',
  'People: nobody new appears. People who are visible may move a lot: stand up, turn around, walk to another spot, or leave the frame through an edge or doorway (the frame is then empty of that person). '
 ];
 const newPeople=texts(candidate).filter(t=>t.startsWith('People:'));
 assert.equal(oldPeople.length,newPeople.length);
 for(let i=0;i<oldPeople.length;i++)assert.equal(newPeople[i].split('If nobody is visible,')[0],oldPeople[i].split('If nobody is visible,')[0]);
});
