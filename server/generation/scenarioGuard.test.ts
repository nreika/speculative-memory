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
  assert.match(full, /Edit this exact photo according to: The side support of the chair turns\./);
  assert.doesNotMatch(full, /dims slightly|gets warmer/);
  assert.match(full, /exposure, brightness, lighting colour, white balance/);
  assert.equal(sanitizeEmptyRoomPrediction('Nobody is here.'), 'Keep the scene exactly as in the input');
});

import { emptyRoomObjectChange, isNoChangeSentence, movableObjects, applySafeFallback } from './scenarioGuard';
import { withoutLightingChanges } from './fidelity';
import { synthesizeEmptyRoom } from './peopleDescribe';
import { planScenariosLocal } from './vlmClient';

// Archived 2026-10-19_14-09-13 / 14-08-21 (empty workshop; planner invented a person in every scenario).
const WORKSHOP = 'An industrial-style workshop with exposed ductwork, fluorescent lighting, and translucent curtains dividing workspaces. A large green plastic storage bin is prominent in the foreground, next to a black office chair with a beige tote bag hanging from its backrest. Behind, shelves hold various boxes and containers, with a metal-framed workbench visible.';
const WORKSHOP_FG = 'the top of a large green plastic storage bin, about 45 cm wide, positioned directly in front of the camera';

test('empty room: movable objects come from the frame, never the near-camera object, shelf items or hanging bags', () => {
  assert.deepEqual(movableObjects(WORKSHOP, WORKSHOP_FG).map((o) => o.phrase), ['black office chair']);
  assert.deepEqual(movableObjects(WORKSHOP).map((o) => o.phrase), ['black office chair', 'green plastic storage bin']);
  // The backrest in front of the camera pins that chair; other chairs (plural) may still turn.
  assert.deepEqual(movableObjects('An office with desks, chairs and monitors. A backpack rests on one desk.', 'the backrest of an ordinary office chair about 50 cm wide').map((o) => o.phrase),
    ['chairs further from the camera', 'backpack']);
  assert.deepEqual(movableObjects('A workshop with exposed pipes and fluorescent lights.', null), []);
  assert.deepEqual(movableObjects('A large green plastic storage bin is in the foreground.', 'a green plastic storage bin, in front of the camera'), []);
});

test('empty room: one small object change scaled by distance, no lighting / person / no-change words', () => {
  const a = emptyRoomObjectChange(WORKSHOP, WORKSHOP_FG, 15, 0)!;
  const b = emptyRoomObjectChange(WORKSHOP, WORKSHOP_FG, 30, 1)!;
  const c = emptyRoomObjectChange(WORKSHOP, WORKSHOP_FG, -30, 2)!;
  assert.equal(a, 'The black office chair is turned a few degrees to the right.');
  assert.equal(new Set([a, b, c]).size, 3);
  assert.match(emptyRoomObjectChange(WORKSHOP, WORKSHOP_FG, 150, 0)!, /about fifteen degrees/);
  assert.match(emptyRoomObjectChange(WORKSHOP, WORKSHOP_FG, -600, 0)!, /about thirty degrees .* about twenty centimetres/);
  for (const d of [15, 30, -30, 150, 600]) for (let i = 0; i < 3; i += 1) {
    const s = emptyRoomObjectChange(WORKSHOP, undefined, d, i)!;
    assert.equal(withoutLightingChanges(s), s);
    assert.equal(sanitizeEmptyRoomPrediction(s), s.replace(/\.$/, ''));
    assert.ok(!mentionsPerson(s) && !isNoChangeSentence(s), s);
  }
  assert.equal(emptyRoomObjectChange('A workshop with exposed pipes.', null, 30, 0), null);
});

test('empty room: the fallbacks write an object change instead of "remains exactly as in the input"', () => {
  assert.ok(isNoChangeSentence('The exposed pipes remains exactly as in the input.'));
  assert.ok(isNoChangeSentence('Keep the scene exactly as in the input.'));
  const s = [mk('The person leans forward.'), mk('The person turns.'), mk('The person sits back.')].map((x) => ({ ...x, scene_now: WORKSHOP, foreground_object: WORKSHOP_FG }));
  const out = applySafeFallback(s, [0, 1, 2], [15, 30, -30]);
  for (const x of out) assert.match(x.prediction_prompt, /^The black office chair (?:is turned|sits|is still turned|still sits) /); // G-26: the past scene is the reverse change
  for (const x of synthesizeEmptyRoom({ distances: [15, 30, -30], count: 3, scene: WORKSHOP, foregroundObject: WORKSHOP_FG })) {
    assert.ok(!isNoChangeSentence(x.prediction_prompt), x.prediction_prompt);
  }
  // No movable object at all: the old text stays (the scene is a skip candidate, see docs/empty-room-prompt-diff-2026-10-19.md).
  assert.ok(isNoChangeSentence(applySafeFallback([{ ...mk('The person leaves.'), scene_now: 'A workshop with exposed pipes.' }], [0])[0].prediction_prompt));
});

test('empty room end to end: invented people are replaced by object changes in prompt and display text', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_i: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (!body.images) return new Response(JSON.stringify({ response: '{}' }));
    const item = (p: string) => ({ prediction_prompt: p, scenario_description: '30 seconds later, x.', label: 'L' });
    return new Response(JSON.stringify({ response: JSON.stringify({
      clock_visible: false, scene_description: WORKSHOP, foreground_object: WORKSHOP_FG,
      scenarios: [item('The person seated in the black office chair leans forward.'), item('The person turns their head.'), item('The fluorescent lighting gets dimmer.')],
    }) }));
  });
  const out = await planScenariosLocal({
    imageDataUrl: 'data:image/jpeg;base64,dGVzdA==', prompt: 'p', scenarioCount: 3,
    detector: { person: false, count: 0, elapsedMs: 5 }, people: [], sceneDistances: [15, 30, -30],
  });
  for (const x of out) {
    assert.match(x.prediction_prompt, /^The black office chair /);
    assert.doesNotMatch(x.prediction_prompt + x.scenario_description, /exactly as in the input|remains/);
  }
});
