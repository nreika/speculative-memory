import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneExtras, buildSceneExtrasNote, personExtrasInEmptyRoom } from './sceneExtras';
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
  assert.match(img, /Do not add disembodied body parts/);
});

test('person extras in an empty room are flagged', () => {
  assert.deepEqual(personExtrasInEmptyRoom({ gen_a: 'a man in a red coat', gen_b: 'a red umbrella' }, true), ['gen_a']);
  assert.deepEqual(personExtrasInEmptyRoom({ gen_a: 'a man' }, false), []);
});
