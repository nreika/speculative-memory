import test from 'node:test';import assert from 'node:assert/strict';
import {generatingScene} from './timeline.mjs';
const capture={captureId:'test-1',phase:'generating'};
test('only active stage is highlighted',()=>{for(const letter of ['A','B','C'])assert.equal(generatingScene(capture,{captureId:'test-1',stage:'scene'+letter}),letter.toLowerCase());});
test('other capture cannot highlight these frames',()=>assert.equal(generatingScene(capture,{captureId:'other',stage:'sceneA'}),null));
test('detect/plan/empty stages never guess a scene',()=>{for(const stage of ['detect','plan','',null,'sceneD','sceneA extra'])assert.equal(generatingScene(capture,{captureId:'test-1',stage}),null);});
test('completion/disconnection clears the highlight',()=>{for(const phase of ['idle','failed','cancelled'])assert.equal(generatingScene({...capture,phase},{captureId:'test-1',stage:'sceneA'}),null);assert.equal(generatingScene(capture,null),null);});
