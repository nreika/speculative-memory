import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleActionGeometry} from './actionGeometry';
test('standing from a seat states a visibly upright final body without picking up furniture-supported objects',()=>{
 const out=visibleActionGeometry('The person stands up from the chair.','seated in a chair');
 assert.match(out,/hips clear of the seat/);assert.match(out,/shoulders and head visibly higher/);
 assert.match(out,/previously empty hands remain empty/);assert.match(out,/Items supported by furniture keep their original support/);
 assert.doesNotMatch(out,/raise.*hand|lighting|exposure|hair colour/i);
});
test('explicit free-hand motion remains visible and preserves the occupied hand instruction',()=>{
 const input='The person lifts the free hand visibly to shoulder height with an open palm, while the occupied hand keeps the cup.';
 const out=visibleActionGeometry(input);
 assert.match(out,/empty open palm clearly visible/);assert.match(out,/occupied hand keeps the cup/);
});
test('generic or ambiguous excitement is not rewritten into a new bodily action',()=>{
 const out=visibleActionGeometry('The person is cheering.');
 assert.equal(out,'The person is cheering.');
 assert.doesNotMatch(out,/hand|arm/);
 assert.equal(visibleActionGeometry('The person tilts their head slightly.'),'The person tilts their head slightly.');
});


test('standing or unverified source never becomes a fabricated seated input or an unseen chair',()=>{
 for(const source of ['standing','upper body only','unclear','not seated','standing beside a seated person',undefined]){
  const out=visibleActionGeometry('The person stands up from the chair.',source);
  assert.match(out,/stands fully upright with the torso extended vertically/);
  assert.doesNotMatch(out,/seated input|hips clear of the seat|shoulders and head visibly higher|from the chair/);
  assert.match(out,/Already-gripped items stay in the same occupied hands/);
 }
});
test('seated-source geometry is applied only to the explicitly requested seat-to-standing action',()=>{
 assert.equal(visibleActionGeometry('The person is standing.','seated'),'The person is standing.');
 assert.equal(visibleActionGeometry('The person is cheering.','standing'),'The person is cheering.');
});
