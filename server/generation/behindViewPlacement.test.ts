import test from 'node:test';
import assert from 'node:assert/strict';
import {sceneBelongings,behindViewPlacementSentence,BEHIND_VIEW_OBJECTS_NEGATIVE} from './behindViewPlacement';
import {behindViewSentence,composeEditInstruction} from './orchestrator';
import {buildNegativePrompt} from './comfyClient';

test('sceneBelongings names the belongings of the scene description (colour kept, one entry per noun)',()=>{
 // guard.scene of 2026-10-19_17-27-37 (TSC-003 F006)
 assert.deepEqual(sceneBelongings('An open-plan workspace with desks, laptops, and grey curtains dividing areas. A blue water bottle and a backpack are visible on a desk.'),['laptop','blue water bottle','backpack']);
 assert.deepEqual(sceneBelongings('A blue backpack and a black jacket hang on the chair; another backpack lies on the floor.'),['blue backpack','black jacket']);
 assert.deepEqual(sceneBelongings('An empty room with that capacity.'),[]);
 assert.deepEqual(sceneBelongings(undefined),[]);
 assert.equal(sceneBelongings('bag, coat, cup, mug, book, box, phone').length,4);
});
test('placement sentence: beside the objects, never on top of / in place of them; occupied place -> nearest free floor spot',()=>{
 const s=behindViewPlacementSentence(['blue backpack','black jacket']);
 assert.match(s,/BESIDE the existing furniture and objects, never on top of, inside or in place of any object visible in the input image/);
 assert.match(s,/Every object in the input image stays exactly where it is and stays visible: bags, backpacks, jackets and coats, items on chairs and desks, in particular the blue backpack and the black jacket\./);
 assert.match(s,/nearest free floor spot next to it instead \(for example next to the chair\), leaving the blue backpack and the black jacket and every other object untouched\.$/);
 const g=behindViewPlacementSentence();
 assert.match(g,/leaving every bag, jacket and item on the chairs and desks untouched\.$/);
 assert.doesNotMatch(g,/in particular/);
});
test('behind-view sentence carries the placement text after the place/scale rule, with derived object names',()=>{
 const s=behindViewSentence({clothes:'white shirt',hair:'black hair with blue tips',position:'center',objects:['blue backpack','jacket']});
 assert.match(s,/at their original place \(center, e\.g\. at the far desk\) at the same scale as in the reference image: a full figure .*never filling the frame\. The person stands or sits BESIDE/);
 assert.match(s,/leaving the blue backpack and the jacket and every other object untouched\./);
 assert.match(behindViewSentence({clothes:'white shirt'}),/leaving every bag, jacket and item on the chairs and desks untouched\./);
 const p=composeEditInstruction({predictionPrompt:'The person stands quietly with their back to the camera.',presence:0.7,referencePerson:true,behindView:{clothes:'white shirt',objects:['backpack']}});
 assert.match(p,/backpack/);
});
test('behind-view negatives add the complementary object terms; other paths do not',()=>{
 assert.ok(buildNegativePrompt(false,false,true).includes(BEHIND_VIEW_OBJECTS_NEGATIVE));
 assert.ok(buildNegativePrompt(false,false,{hair:'short black hair'}).includes('missing backpack'));
 assert.doesNotMatch(buildNegativePrompt(false),/missing backpack/);
});
