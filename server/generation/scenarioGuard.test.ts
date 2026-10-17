import test from 'node:test';
import assert from 'node:assert/strict';
import { isUnoccupied, findFabricatedScenarios, safeScenario, extractObjects, guardOnce, mentionsPerson } from './scenarioGuard';
import type { ScenarioResult } from '../../services/promptBuilder';

const mk = (p: string, d = '30 seconds later, something.'): ScenarioResult =>
  ({ prediction_prompt: p, scenario_description: d, label: 'x', scene_now: '' } as ScenarioResult);
const SCENE = 'An office space with visible chairs, overhead ductwork, shelves, and a gray curtain.';

test('person words are detected, object words are not', () => {
  assert.ok(mentionsPerson('The person on the right leans back'));
  assert.ok(mentionsPerson('his right hand leaves the keyboard'));
  assert.ok(!mentionsPerson('overhead ductwork and headphones on a shelf'));
});

test('empty room: scenarios with people are fabricated', () => {
  assert.equal(isUnoccupied(SCENE), true);
  const s = [mk('The person on the right shifts.'), mk('The light dims slightly.'), mk('A chair rotates.', '2 minutes later, the man leaves.')];
  assert.deepEqual(findFabricatedScenarios(SCENE, s), [0, 2]);
});

test('occupied room: nothing is fabricated', () => {
  const scene = 'A man sits at a desk.';
  assert.equal(isUnoccupied(scene), false);
  assert.deepEqual(findFabricatedScenarios(scene, [mk('The man stands up.')]), []);
});

test('safe fallback names only scene objects and no person', () => {
  assert.deepEqual(extractObjects(SCENE).slice(0, 3), ['chairs', 'overhead ductwork', 'shelves']);
  const out = safeScenario(SCENE, mk('The person leaves.', '2 minutes 30 seconds later, the person leaves.'), 1);
  assert.ok(!mentionsPerson(out.prediction_prompt) && !mentionsPerson(out.scenario_description));
  assert.match(out.scenario_description, /^2 minutes 30 seconds later,/);
});

test('guardOnce replaces only the offending scenarios', () => {
  const s = [mk('The person leaves.'), mk('The light dims.')].map((x) => ({ ...x, scene_now: SCENE }));
  const { scenarios, record } = guardOnce(s);
  assert.deepEqual(record.replaced, [0]);
  assert.equal(scenarios[1].prediction_prompt, 'The light dims.');
  assert.ok(!mentionsPerson(scenarios[0].prediction_prompt));
});

import { findDuplicateScenarios, similarity } from './scenarioGuard';
import { buildNegativePrompt } from './comfyClient';
import { composeEditInstruction } from './orchestrator';

test('duplicates: identical or >=0.9 similar prompts after the first are flagged', () => {
  const a = mk('The light level remains unchanged, with no movement or interaction occurring in the frame.');
  const b = mk('The light level remains unchanged, with no movement or interaction occurring in the frame!');
  const c = mk('A chair rotates slightly to the left.');
  assert.deepEqual(findDuplicateScenarios([a, b, c]), [1]);
  assert.deepEqual(findDuplicateScenarios([a, c, mk('The shelf light dims.')]), []);
  assert.ok(similarity('abc def', 'ABC  def.') === 1);
});

test('negative prompt gets person words only for an empty room', () => {
  assert.match(buildNegativePrompt(false, true), /silhouette, shadow of a person/);
  assert.doesNotMatch(buildNegativePrompt(false), /silhouette/);
});

import { sanitizeEmptyRoomPrediction } from './scenarioGuard';

test('empty-room image prompt has no person words, even from a noisy prediction', () => {
  const noisy = 'Nobody enters the room; the overhead light dims slightly. The armrest of the chair turns, and the light gets warmer.';
  const clean = sanitizeEmptyRoomPrediction(noisy);
  assert.equal(clean, 'the overhead light dims slightly');
  const full = composeEditInstruction({ predictionPrompt: noisy, presence: 0, foregroundObject: 'the backrest of an ordinary office chair about 50 cm wide, right in front of the camera' });
  assert.doesNotMatch(full, /person|people|figure|silhouette|hand|arm|nobody|no one/i);
  assert.match(full, /Edit this exact photo according to: the overhead light dims slightly\./);
  assert.match(full, /pixel-identical/);
  assert.equal(sanitizeEmptyRoomPrediction('Nobody is here.'), 'the light on the furniture shifts slightly');
});
