import test from 'node:test';
import assert from 'node:assert/strict';
import { planScenariosLocal } from './vlmClient';

test('local image planning disables thinking so the output budget reaches scenario JSON', async (t) => {
  const requestedBodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    assert.match(String(input), /\/api\/generate$/);
    const body = JSON.parse(String(init?.body));
    requestedBodies.push(body);

    // Model the observed failure: thinking consumes the output limit before
    // any answer is returned. No real Ollama or image generation is called.
    if (body.think !== false) {
      return new Response(JSON.stringify({ response: '', done_reason: 'length' }));
    }
    return new Response(JSON.stringify({
      done_reason: 'stop',
      response: JSON.stringify({
        clock_visible: false,
        scene_description: 'A person is sitting at a desk.',
        scenarios: [
          { prediction_prompt: 'The person stands up.', scenario_description: 'Standing.', label: 'A' },
          { prediction_prompt: 'The person turns left.', scenario_description: 'Turning.', label: 'B' },
          { prediction_prompt: 'The person rests both hands.', scenario_description: 'Resting.', label: 'C' },
        ],
      }),
    }));
  });

  const scenarios = await planScenariosLocal({
    imageDataUrl: 'data:image/jpeg;base64,dGVzdA==',
    prompt: 'Describe three possible scenes.',
    scenarioCount: 3, maxAttempts: 3,
  });

  assert.equal(requestedBodies.length, 3, 'one planning call (no retries), one short arm check (only the scene that names hands) and one translation call');
  assert.ok(requestedBodies.slice(1).every((b) => b.images === undefined), 'every other call is text-only');
  assert.equal(requestedBodies[0].think, false);
  assert.equal(requestedBodies[0].options.num_predict, 2048);
  assert.equal(requestedBodies[0].options.num_ctx, 8192);
  assert.deepEqual(requestedBodies[0].images, ['dGVzdA==']);
  assert.deepEqual(scenarios.map((scene) => scene.label), ['A', 'B', 'C']);
  assert.ok(scenarios.every((scene) => scene.scene_now === 'A person is sitting at a desk.'));
});

test('guard: retries when people are invented in an empty room, then returns clean scenarios', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (!body.images) return new Response(JSON.stringify({ response: '{}' })); // translation: fall back to English
    calls += 1;
    const bad = calls === 1;
    const item = (p: string) => ({ prediction_prompt: p, scenario_description: '30 seconds later, x.', label: 'L' });
    return new Response(JSON.stringify({
      done_reason: 'stop',
      response: JSON.stringify({
        clock_visible: false,
        scene_description: 'An empty office with chairs, shelves and a screen.',
        scenarios: bad
          ? [item('The person on the right leans back.'), item('A chair rotates.'), item('The light dims.')]
          : [item('A chair rotates.'), item('The light dims.'), item('A screen goes dark.')],
      }),
    }));
  });
  const trace: any = {};
  const out = await planScenariosLocal({
    imageDataUrl: 'data:image/jpeg;base64,dGVzdA==', prompt: 'p', scenarioCount: 3, maxAttempts: 3, trace,
  });
  assert.equal(calls, 2);
  assert.equal(out.length, 3);
  assert.equal(trace.guard.unoccupied, true);
  assert.deepEqual(trace.guard.replaced, []);
  assert.equal(trace.guard.attempts, 2);
});

function mockPlan(t: any, sceneFor: (call: number) => string, promptFor: (call: number) => string) {
  let calls = 0;
  const prompts: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_i: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (!body.images) return new Response(JSON.stringify({ response: '{}' }));
    calls += 1;
    prompts.push(body.prompt);
    const item = (p: string) => ({ prediction_prompt: p, scenario_description: '30 seconds later, x.', label: 'L' });
    return new Response(JSON.stringify({ response: JSON.stringify({
      clock_visible: false, scene_description: sceneFor(calls),
      scenarios: [item(promptFor(calls) + ' It happens quickly near the left monitor.'), item('A cable on the floor shifts slightly under the table.'), item('Overhead lamps brighten a little, reflecting on the shelf boxes.')],
    }) }));
  });
  return { calls: () => calls, prompts };
}

test('occupancy: detector true + no person in text -> one retry with the detector note, then occupied', async (t) => {
  const m = mockPlan(t, (c) => (c === 1 ? 'An office with chairs.' : 'A woman sits at the left desk with a monitor, a cable, a table, lamps, a shelf and boxes.'), () => 'The woman turns her head.');
  const trace: any = {};
  await planScenariosLocal({ imageDataUrl: 'data:image/jpeg;base64,dGVzdA==', prompt: 'p', scenarioCount: 3, maxAttempts: 3, trace, detector: { person: true, count: 1, elapsedMs: 900 } });
  assert.equal(m.calls(), 2);
  assert.match(m.prompts[1], /A person detector found at least one person/);
  assert.equal(trace.guard.unoccupied, false);
  assert.equal(trace.guard.occupancySource, 'both');
  assert.equal(trace.guard.detector.count, 1);
});

test('occupancy: detector true but the text never names a person -> still occupied, no empty-room scenario replacement', async (t) => {
  mockPlan(t, () => 'An office with chairs, a monitor, a cable, a table, lamps, a shelf and boxes.', () => 'The woman turns her head.');
  const trace: any = {};
  const out = await planScenariosLocal({ imageDataUrl: 'data:image/jpeg;base64,dGVzdA==', prompt: 'p', scenarioCount: 3, maxAttempts: 3, trace, detector: { person: true, elapsedMs: 5 } });
  assert.equal(trace.guard.unoccupied, false);
  assert.equal(trace.guard.occupancySource, 'detector');
  assert.deepEqual(trace.guard.replaced, []);
  assert.match(out[0].prediction_prompt, /woman/);
});

test('occupancy: detector null + no person in text -> unoccupied (text only)', async (t) => {
  mockPlan(t, () => 'An empty office with chairs.', () => 'The light dims.');
  const trace: any = {};
  await planScenariosLocal({ imageDataUrl: 'data:image/jpeg;base64,dGVzdA==', prompt: 'p', scenarioCount: 3, maxAttempts: 3, trace, detector: { person: null, elapsedMs: 5 } });
  assert.equal(trace.guard.unoccupied, true);
  assert.equal(trace.guard.occupancySource, 'none');
});

test('occupancy: detector false (people 0) and the text names a person -> the detector wins: unoccupied, person scenes replaced, text cleaned', async (t) => {
  mockPlan(t, () => 'An office with desks and a monitor. Two people stand near a desk.', () => 'The man stands.');
  const trace: any = {};
  const out = await planScenariosLocal({ imageDataUrl: 'data:image/jpeg;base64,dGVzdA==', prompt: 'p', scenarioCount: 3, trace, maxAttempts: 1, detector: { person: false, count: 0, elapsedMs: 5 }, sceneDistances: [30, 30, 150] });
  assert.equal(trace.guard.unoccupied, true);
  assert.equal(trace.guard.occupancySource, 'none');        // 'text' never decides occupancy
  assert.equal(trace.guard.detectorDisagree, true);
  assert.equal(trace.guard.scene, 'An office with desks and a monitor.');
  assert.deepEqual(trace.guard.replaced, [0]);
  assert.ok(out.every((s) => !/man/.test(s.prediction_prompt)));
});

test('occupancy: detector false + a past detector hit (allowPerson) -> recent-person path, still unoccupied for the frame', async (t) => {
  mockPlan(t, () => 'An office with desks.', () => 'The light dims.');
  const trace: any = {};
  await planScenariosLocal({ imageDataUrl: 'data:image/jpeg;base64,dGVzdA==', prompt: 'p', scenarioCount: 3, trace, maxAttempts: 1, allowPerson: true, detector: { person: false, count: 0, elapsedMs: 5 }, sceneDistances: [30, 30, 150] });
  assert.equal(trace.guard.unoccupied, true);
  assert.equal(trace.guard.recentPersonAllowed, true);
});
