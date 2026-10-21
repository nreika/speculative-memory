import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneExtras, buildSceneExtrasNote, personExtrasInEmptyRoom, lookupAction, buildExtraSentence,preserveActionConditions } from './sceneExtras';
import { composeEditInstruction } from './orchestrator';

test('parse: drops blanks and non-strings, trims, cuts at 200', () => {
  const e = parseSceneExtras({ gen_a: '   ', gen_b: '  a red umbrella  ', gen_c: 'x'.repeat(300), gen_d: 'no' });
  assert.deepEqual(Object.keys(e), ['gen_b', 'gen_c']);
  assert.equal(e.gen_b, 'a red umbrella');
  assert.equal(e.gen_c!.length, 200);
  assert.deepEqual(parseSceneExtras({ gen_a: 5, gen_b: null }), {});
  assert.deepEqual(parseSceneExtras('x'), {});
});

test('planning note only mentions scenes with an extra', () => {
  const note = buildSceneExtrasNote({ gen_b: 'a red umbrella leaning against the desk' });
  assert.match(note, /Scenario 2 \(gen_b\): the MAIN EVENT of this scenario is "a red umbrella/);
  assert.doesNotMatch(note, /gen_a|gen_c/);
  assert.equal(buildSceneExtrasNote({}), '');
});

test('planning note fixes the subject to the person already in the photo; image prompt gets no raw extra', () => {
  const note = buildSceneExtrasNote({ gen_c: '両手を上げて喜んでいる' });
  assert.match(note, /THE PERSON ALREADY VISIBLE IN THIS FRAME/);
  assert.match(note, /Scenario 3 \(gen_c\): the MAIN EVENT of this scenario is "両手を上げて喜んでいる"/);
  const img = composeEditInstruction({ predictionPrompt: 'The man raises both arms.' });
  assert.doesNotMatch(img, /Also:/);
  assert.match(img, /two arms and two hands/);
});

test('person extras in an empty room are flagged', () => {
  assert.deepEqual(personExtrasInEmptyRoom({ gen_a: 'a man in a red coat', gen_b: 'a red umbrella' }, true), ['gen_a']);
  assert.deepEqual(personExtrasInEmptyRoom({ gen_a: 'a man' }, false), []);
});


test('colloquial exuberance retains cheering instead of playing alone without inferring an arm action',()=>{
 for(const text of ['一人はしゃいでる','一人ではしゃいでる','はしゃいでいる','はしゃぐ','誰かがはしゃいでる','どちらかの人がはしゃいでる','大はしゃぎしてる。']){
  const action=lookupAction(text)!;assert.equal(action.en,'is cheering',text);
  const sentence=buildExtraSentence(action.en,'blue sweatshirt');
  assert.equal(sentence,'The person in the blue sweatshirt is cheering.');assert.doesNotMatch(sentence,/plays alone|raises|new person/);
 }
});
test('separate operator action clauses are preserved when one clause is colloquial cheering',()=>{
 const action=lookupAction('一人はしゃいでる / 手を振る')!;
 assert.equal(action.en,'is cheering and waves');
 assert.equal(lookupAction('一人はしゃいでる、片手を肩の高さに上げる'),null);
});
test('a lossy short translation cannot discard the operator-requested support surface and hand',()=>{
 const original='立ち上がってる / 人物が机に手をついて立ち上がろうとする。既存の人物以外は追加しない。';
 assert.equal(lookupAction(original),null);
 const repaired=preserveActionConditions(original,'The person stands up from the desk.');
 assert.match(repaired,/stands up from the desk/);assert.match(repaired,/Hand use: places one existing hand on the desk; exactly two hands/);assert.doesNotMatch(repaired,/both hands on the desk|free hand is available/);
 for(const [ja,en]of [['右手を','the existing right hand'],['左手を','the existing left hand'],['両手を','both existing hands']])assert.ok(preserveActionConditions('テーブルの端に'+ja+'置いて立つ','stands up').includes('places '+en+' on the edge of the table'));
});
test('occupied source grips never erase the action: the occupied hand keeps its object while making the contact',()=>{
 const source='人物が机に両手をついて立ち上がる。';
 const text=preserveActionConditions(source,'The person stands up, placing both hands on the desk as they rise.',['left','right']);
 assert.match(text,/^The person stands up, placing both hands on the desk as they rise\./);assert.doesNotMatch(text,/cannot use an occupied hand/);
 assert.match(text,/a hand that holds an object keeps holding it while resting on the desk \(or sets the object down on the desk first\); exactly two hands/);assert.match(text,/Never add an extra hand or arm/);
 assert.match(preserveActionConditions(source,'The person places both hands on the desk and stands up.',['left','right']),/places both hands on the desk and stands up/);
 assert.match(preserveActionConditions('机に右手をついて立つ','stands up',['right']),/places the existing right hand on the desk; if that hand holds an object, it keeps holding it/);
 assert.match(preserveActionConditions('椅子の背に左手をかけて立つ','stands up',['right']),/places the existing left hand on the back of the chair; exactly two hands/);
});
test('unknown compound grip conditions remain verbatim and simple legacy actions are unchanged',()=>{
 const source='右手で白いケースを握ったまま立ち上がる';const text=preserveActionConditions(source,'stands up');assert.ok(text.includes(source));assert.match(text,/compatible with original occupied-hand grips/);
 for(const ja of ['一人はしゃいでる','両手を上げて喜んでいる','立ち上がってる']){const en=lookupAction(ja)!.en;assert.equal(preserveActionConditions(ja,en),en);}
});
