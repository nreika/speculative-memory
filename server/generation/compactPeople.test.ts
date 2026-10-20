import test from 'node:test';
import assert from 'node:assert/strict';
import {compactPeopleInstruction,isRelocationAction} from './compactPeople';
import {peopleEditRegion} from './peopleEditRegion';

const people = [{position:'left',pose:'standing',clothes:'red top',facing:'right',holding:'tablet'}];
const detection = {count:1,persons:[{score:.95,box:[100,100,300,700]}],inferenceMs:1,elapsedMs:1};

test('walking, leaving and other movement inflections remove the conflicting original-area constraint', () => {
  for (const action of ['She walks left.','He leaves the frame.','She is walking toward the door.','She crosses the room.','He runs to the table.','She is running.','He steps aside.','She is stepping toward the exit.','She moves to the table.','She is moving across the room.','She moves toward the door.']) {
    const prompt = compactPeopleInstruction(people,1,action);
    assert.equal(isRelocationAction(action),true,action);
    assert.equal(peopleEditRegion(detection,1,{width:1280,height:720},action),undefined,action);
    assert.match(prompt,/Replace their old body completely at the new position/);
    assert.doesNotMatch(prompt,/Keep this individual in the same/);
    assert.ok(prompt.includes(action));
  }
});

test('local gestures and vertical posture changes keep the corridor and their original action', () => {
  for (const action of ['She stands up.','He sits down.','She raises her free hand.','She smiles.']) {
    const prompt = compactPeopleInstruction(people,1,action);
    assert.equal(isRelocationAction(action),false,action);
    assert.ok(peopleEditRegion(detection,1,{width:1280,height:720},action),action);
    assert.match(prompt,/Keep this individual in the same left area/);
    assert.doesNotMatch(prompt,/Replace their old body completely at the new position/);
    assert.ok(prompt.includes(action));
  }
});

test('ambiguous actor selection leaves the action intact while preserving each person’s belongings', () => {
  const pair = [people[0],{position:'right',pose:'seated',clothes:'red long-sleeved top',facing:'left',holding:'cup'}];
  const action = 'The person in the red top is cheering.';
  const prompt = compactPeopleInstruction(pair,2,action);
  assert.ok(prompt.includes(action));
  assert.match(prompt,/Keep tablet with this owner/);
  assert.match(prompt,/Keep cup with this owner/);
  assert.doesNotMatch(prompt,/only the named actor|free hand visibly/);
  assert.match(prompt,/Exactly 2 original people remain/);
});


test('compact action geometry uses the selected actor source pose rather than inventing a seated source',()=>{
 const action='The person in the red top stands up from the chair.';
 const standing=compactPeopleInstruction(people,1,action);
 assert.doesNotMatch(standing,/seated input|hips clear of the seat/);
 const seated=compactPeopleInstruction([{...people[0],pose:'seated'}],1,action);
 assert.match(seated,/hips clear of the seat/);
 const ambiguous=compactPeopleInstruction([{...people[0],pose:'standing'},{...people[0],position:'right',pose:'seated'}],2,action);
 assert.doesNotMatch(ambiguous,/seated input|hips clear of the seat/);
});
test('both-hand cable grip stays occupied while cheering remains a visible torso action',()=>{
 const source=[{position:'center',pose:'standing',clothes:'blue sweatshirt',facing:'left',holding:'black cable in both hands'}];
 const prompt=compactPeopleInstruction(source,1,'The person in the blue sweatshirt is cheering.');
 assert.match(prompt,/upper torso sideways into a clearly visible diagonal/);assert.match(prompt,/one shoulder distinctly higher than the other/);assert.match(prompt,/Both elbows, gripping hands and the original held belongings move together/);
 assert.match(prompt,/both occupied hands keep their original grips/);
 assert.doesNotMatch(prompt,/lifts the free hand|empty open palm/);
 assert.match(prompt,/Exactly 1 original person remains/);
});
test('G20 permits a physically justified chair movement without demanding it or changing fixed scene controls',()=>{
 const prompt=compactPeopleInstruction(people,1,'The person stands up from the chair.');
 assert.match(prompt,/chairs, may move or rotate naturally/);assert.match(prompt,/otherwise leave it in place/);
 assert.match(prompt,/Preserve unrelated objects/);assert.match(prompt,/fixed camera, room architecture and screen contents exactly unchanged/);
 assert.match(prompt,/exact input exposure, brightness/);
 assert.doesNotMatch(prompt,/room, furniture, screen contents and every other object exactly unchanged|supported by furniture keep their original support and location/);
});
test('source-confirmed PC contact makes plain cheering visibly different without changing identity, chairs or lighting rules',()=>{
 const source=[{position:'center front',pose:'seated in a chair',clothes:'white shirt',facing:'away',holding:'',holdingFacts:[{item:'laptop',hand:'both' as const,evidence:'surface_contact' as const}]}];
 const prompt=compactPeopleInstruction(source,1,'The person in the white shirt is cheering.');
 assert.match(prompt,/one empty hand away from its original surface contact to shoulder height/);assert.match(prompt,/upper torso leans sideways/);assert.match(prompt,/Exactly 1 original person remains/);assert.match(prompt,/Do not reveal more of the face than is visible in the input./);assert.doesNotMatch(prompt,/Their back remains/);assert.match(prompt,/chairs, may move or rotate naturally/);assert.match(prompt,/white balance/);assert.doesNotMatch(prompt,/smil|jump|both arms raised|remains seated/i);
});

test('back-facing freeze only on the behind-view path; ordinary away scenes get the weak face rule; unknown facing emits no facing sentence',()=>{
 const away=[{position:'right front',pose:'seated at a desk',clothes:'white shirt',facing:'away'}];
 const hard=compactPeopleInstruction(away,1,'The person places a hand on the desk.',true);
 assert.match(hard,/Their back remains toward the camera, with their face hidden\./);assert.doesNotMatch(hard,/Do not reveal more of the face/);
 const weak=compactPeopleInstruction(away,1,'The person places a hand on the desk.');
 assert.match(weak,/Do not reveal more of the face than is visible in the input\./);assert.doesNotMatch(weak,/Their back remains|face hidden/);
 const unknown=compactPeopleInstruction([{...away[0],facing:'unknown'}],1,'The person places a hand on the desk.',true);
 assert.doesNotMatch(unknown,/facing|Their back remains|Do not reveal more of the face/);assert.match(unknown,/white shirt, right front\./);
 const side=compactPeopleInstruction([{...away[0],facing:'side'}],1,'The person places a hand on the desk.');
 assert.match(side,/facing side\./);assert.doesNotMatch(side,/Their back remains|Do not reveal more of the face/);
});
