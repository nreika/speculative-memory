import test from 'node:test';
import assert from 'node:assert/strict';
import { findFabricatedObjects, inventedObjects, mentionedObjects } from './objectGuard';
import { planScenariosLocal } from './vlmClient';
import { composeEditInstruction } from './orchestrator';
import { synthesizeEmptyRoom } from './peopleDescribe';

const FRAME = 'An empty office with a monitor, a white paper bag, a black laptop and a blue laptop on a desk, ceiling pipes and a curtain.';

test('invented objects: groups named by the scenario but not by the frame', () => {
  assert.deepEqual(inventedObjects('A beige jacket is pulled from the chair, exposing the black laptop.', FRAME).sort(), ['chair', 'jacket']);
  assert.deepEqual(inventedObjects('The light dims slightly and the screen flickers.', FRAME), []); // monitor ~ screen, "light" never triggers
  assert.deepEqual(inventedObjects('The drape sways a little.', FRAME), []); // curtain ~ drape
  assert.ok(mentionedObjects('ceiling lights and a shelf').includes('shelf'));
  const f = findFabricatedObjects(FRAME, [{ prediction_prompt: 'The curtain sways.' }, { prediction_prompt: 'A cup tips over.' }]);
  assert.deepEqual(f, [{ index: 1, words: ['cup'] }]);
});

function mockEmpty(t: any, scenes: string[][]) {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_i: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (!body.images) return new Response(JSON.stringify({ response: '{}' }));
    const set = scenes[Math.min(calls, scenes.length - 1)];
    calls += 1;
    const item = (p: string) => ({ prediction_prompt: p, scenario_description: '30 seconds later, x.', label: 'L' });
    return new Response(JSON.stringify({ response: JSON.stringify({ clock_visible: false, scene_description: FRAME, scenarios: set.map(item) }) }));
  });
  return () => calls;
}
const IMG = 'data:image/jpeg;base64,dGVzdA==';

test('empty room: invented objects are replaced by environmental templates (single planner call)', async (t) => {
  const calls = mockEmpty(t, [['A beige jacket is pulled from the chair.', 'The light on the curtain dims slightly.', 'The curtain sways in the draft.']]);
  const trace: any = {};
  const out = await planScenariosLocal({ imageDataUrl: IMG, prompt: 'p', scenarioCount: 3, trace, sceneDistances: [30, 30, -150] });
  assert.equal(calls(), 1);
  assert.doesNotMatch(out[0].prediction_prompt, /jacket|chair/);
  // A lighting-only sentence is removed; in an empty room it becomes a small change of a movable frame object (never "exactly as in the input").
  assert.equal(out[1].prediction_prompt, 'The white paper bag sits a few centimetres further to the left.');
  assert.deepEqual(trace.guard.fabricatedObjects.map((f: any) => f.index), [0]);
});

test('with planner retries allowed: one re-ask with the visible-objects reminder, kept if clean', async (t) => {
  let prompts: string[] = [];
  const calls = mockEmpty(t, [['A cup tips over.', 'The light dims.', 'The curtain sways.'], ['The light dims a bit.', 'The curtain sways.', 'The monitor screen flickers.']]);
  t.mock.method(globalThis, 'fetch', (globalThis.fetch as any), {});
  const out = await planScenariosLocal({ imageDataUrl: IMG, prompt: 'p', scenarioCount: 3, maxAttempts: 3 });
  assert.equal(calls(), 2);
  assert.equal(out[0].prediction_prompt, 'The white paper bag sits a few centimetres further to the right.');
  void prompts;
});

test('empty-room image prompt: no person words, no object additions, no hand-moved changes in templates', () => {
  const full = composeEditInstruction({ predictionPrompt: 'The light on the curtain dims slightly.', presence: 0 });
  assert.doesNotMatch(full, /person|people|figure|silhouette|hand|arm|nobody|no one/i);
  assert.match(full, /Do not add any object that is not in the photo; every object stays exactly where it is\./);
  for (const s of synthesizeEmptyRoom({ distances: [30, 30, 150], count: 3 })) {
    assert.doesNotMatch(s.prediction_prompt, /chair|rotate|move|open|bag|jacket|person|people|hand/i);
  }
});

import { buildNegativePrompt } from './comfyClient';
test('physics rule is in both templates; negative prompt names floating / hanging objects', () => {
  const rule = /Objects rest on surfaces in physically plausible positions .*gravity and support stay realistic\./;
  assert.match(composeEditInstruction({ predictionPrompt: 'A chair rotates.', presence: 0 }), rule);
  assert.match(composeEditInstruction({ predictionPrompt: 'The man stands.', presence: 0.5 }), rule);
  assert.doesNotMatch(composeEditInstruction({ predictionPrompt: 'x', presence: 0 }), /person|people|figure|silhouette|hand|arm|nobody|no one/i);
  assert.match(buildNegativePrompt(false), /floating object, object hanging on chair back, levitating laptop/);
});
