import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decideEmptyRoomScenes, sceneSkipPlan, emptyRoomActivityMin, emptyRoomObjectChance, emptyRoomRoll, minutesSince, resolveEmptyScene, type EmptyRoomSceneDecision } from './emptyRoomDecision';
import { planScenariosLocal } from './vlmClient';
import { isNoChangeSentence } from './scenarioGuard';

const KEYS = ['gen_a', 'gen_b', 'gen_c'];
const base = { sceneKeys: KEYS, activityWindowMin: 3, objectChance: 0.3 };

test('roll: first 32 bits of sha256(key) / 2^32, reproducible and per scene', () => {
  const expected = createHash('sha256').update('cap-1:gen_b').digest().readUInt32BE(0) / 2 ** 32;
  assert.equal(emptyRoomRoll('cap-1:gen_b'), expected);
  assert.equal(emptyRoomRoll('cap-1:gen_b'), emptyRoomRoll('cap-1:gen_b'));
  assert.notEqual(emptyRoomRoll('cap-1:gen_a'), emptyRoomRoll('cap-1:gen_b'));
  assert.notEqual(emptyRoomRoll('cap-1:gen_a'), emptyRoomRoll('cap-1:gen_a:object'));
  const r = emptyRoomRoll('cap-1:gen_a');
  assert.ok(r >= 0 && r < 1);
});

test('person threshold: drawn iff roll < chance (0 = never, 1 = always), decisions repeat for the same capture', () => {
  const d = decideEmptyRoomScenes({ ...base, captureId: 'cap-7', emptyRoomPersonChance: 0.5, recentPerson: true, activityMinutesAgo: 1 });
  for (const x of d) {
    assert.equal(x.roll, emptyRoomRoll(`cap-7:${x.sceneKey}`));
    assert.equal(x.personDrawn, x.roll < 0.5);
    assert.equal(x.reason, 'chance');
    assert.equal(x.emptyRoomPersonChance, 0.5);
  }
  assert.deepEqual(decideEmptyRoomScenes({ ...base, captureId: 'cap-7', emptyRoomPersonChance: 0.5, recentPerson: true, activityMinutesAgo: 1 }), d);
  assert.ok(decideEmptyRoomScenes({ ...base, captureId: 'cap-7', emptyRoomPersonChance: 0, recentPerson: true, activityMinutesAgo: 1 }).every((x) => !x.personDrawn));
  assert.ok(decideEmptyRoomScenes({ ...base, captureId: 'cap-7', emptyRoomPersonChance: 1, recentPerson: true, activityMinutesAgo: 1 }).every((x) => x.personDrawn));
  // Over many captures the share is close to the chance.
  let drawn = 0;
  for (let i = 0; i < 2000; i += 1) drawn += decideEmptyRoomScenes({ ...base, captureId: `c${i}`, emptyRoomPersonChance: 0.3, recentPerson: true, activityMinutesAgo: null }).filter((x) => x.personDrawn).length;
  assert.ok(Math.abs(drawn / 6000 - 0.3) < 0.03, String(drawn / 6000));
});

test('an operator instruction naming a person draws the recent person regardless of chance; no recent person never draws', () => {
  const d = decideEmptyRoomScenes({ ...base, captureId: 'cap-9', emptyRoomPersonChance: 0, recentPerson: true, activityMinutesAgo: null, extras: { gen_b: '人物が窓の方へ歩く', gen_c: 'The chair turns slightly' } });
  assert.deepEqual(d.map((x) => [x.personDrawn, x.reason]), [[false, 'chance'], [true, 'operator_mention'], [false, 'chance']]);
  const none = decideEmptyRoomScenes({ ...base, captureId: 'cap-9', emptyRoomPersonChance: 1, recentPerson: false, activityMinutesAgo: 0.5, extras: { gen_a: 'The person waves' } });
  assert.ok(none.every((x) => !x.personDrawn && x.reason === 'no_recent_person'));
});

test('object gate: activity within EMPTY_ROOM_ACTIVITY_MIN AND object roll < EMPTY_ROOM_OBJECT_CHANCE', () => {
  const all = (activity: number | null, chance: number) => decideEmptyRoomScenes({ ...base, objectChance: chance, captureId: 'cap-3', emptyRoomPersonChance: 0, recentPerson: false, activityMinutesAgo: activity });
  assert.ok(all(null, 1).every((x) => !x.objectAllowed && x.objectBlockedReason === 'no_recent_activity'));
  assert.ok(all(3.5, 1).every((x) => !x.objectAllowed && x.objectBlockedReason === 'no_recent_activity'));
  assert.ok(all(2.9, 1).every((x) => x.objectAllowed && x.objectBlockedReason === null));
  assert.ok(all(1, 0).every((x) => !x.objectAllowed && x.objectBlockedReason === 'chance'));
  for (const x of all(1, 0.3)) {
    assert.equal(x.objectRoll, emptyRoomRoll(`cap-3:${x.sceneKey}:object`));
    assert.equal(x.objectAllowed, x.objectRoll < 0.3);
  }
  const forced = decideEmptyRoomScenes({ ...base, captureId: 'cap-3', emptyRoomPersonChance: 0, recentPerson: false, activityMinutesAgo: null, forceKeep: new Set(['gen_a']) });
  assert.deepEqual(forced.map((x) => x.objectAllowed), [true, false, false]);
});

test('env constants default to 3 min / 0.3 and accept overrides', () => {
  assert.equal(emptyRoomActivityMin({}), 3);
  assert.equal(emptyRoomObjectChance({}), 0.3);
  assert.equal(emptyRoomActivityMin({ EMPTY_ROOM_ACTIVITY_MIN: '5' }), 5);
  assert.equal(emptyRoomObjectChance({ EMPTY_ROOM_OBJECT_CHANCE: '0.75' }), 0.75);
  assert.equal(emptyRoomObjectChance({ EMPTY_ROOM_OBJECT_CHANCE: 'x' }), 0.3);
  assert.equal(minutesSince('2026-10-19T10:00:00Z', Date.parse('2026-10-19T10:02:30Z')), 2.5);
  assert.equal(minutesSince(undefined), null);
});

const decision = (over: Partial<EmptyRoomSceneDecision>): EmptyRoomSceneDecision => ({ sceneKey: 'gen_a', emptyRoomPersonChance: 0.3, roll: 0.9, personDrawn: false, reason: 'chance', objectChance: 0.3, objectRoll: 0.1, activityMinutesAgo: 1, activityWindowMin: 3, objectAllowed: true, objectBlockedReason: null, ...over });

test('resolveEmptyScene: skip reasons and never a "remains the same" sentence', () => {
  const obj = () => 'The chair is turned a few degrees to the right.';
  assert.deepEqual(resolveEmptyScene({ decision: decision({ objectAllowed: false, objectBlockedReason: 'no_recent_activity' }), kept: 'The chair turns.', isNoChange: isNoChangeSentence, objectChange: obj }), { skipped: 'no_recent_activity' });
  assert.deepEqual(resolveEmptyScene({ decision: decision({ objectAllowed: false, objectBlockedReason: 'chance' }), kept: 'x', isNoChange: isNoChangeSentence, objectChange: obj }), { skipped: 'chance' });
  assert.deepEqual(resolveEmptyScene({ decision: decision({}), kept: 'The pipes remain exactly as in the input', isNoChange: isNoChangeSentence, objectChange: () => null }), { skipped: 'no_movable_object' });
  assert.deepEqual(resolveEmptyScene({ decision: decision({}), kept: 'The pipes remain exactly as in the input', isNoChange: isNoChangeSentence, objectChange: obj }), { text: obj() });
  assert.deepEqual(resolveEmptyScene({ decision: decision({}), kept: 'The person sits down', isNoChange: isNoChangeSentence, objectChange: obj }), { text: obj() });
  assert.deepEqual(resolveEmptyScene({ decision: decision({}), kept: 'The box slides a little', isNoChange: isNoChangeSentence, objectChange: obj }), { text: 'The box slides a little' });
});

const FRAME = 'An empty workshop with a wooden chair, a plastic bin and exposed pipes.';
function mockPlanner(t: any, frame: string, scenes: string[]) {
  t.mock.method(globalThis, 'fetch', async (_i: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (!body.images) return new Response(JSON.stringify({ response: '{}' }));
    const item = (p: string) => ({ prediction_prompt: p, scenario_description: '30 seconds later, x.', label: 'L' });
    return new Response(JSON.stringify({ response: JSON.stringify({ clock_visible: false, scene_description: frame, scenarios: scenes.map(item) }) }));
  });
}
const IMG = 'data:image/jpeg;base64,dGVzdA==';

test('planner: per-scene person (behind view only where chosen), object change where the gate allows, skip otherwise', async (t) => {
  mockPlanner(t, FRAME, ['The person walks to the desk.', 'The pipes remain exactly as in the input.', 'The person sits down.']);
  const decisions = [
    decision({ sceneKey: 'gen_a', personDrawn: true, roll: 0.1 }),
    decision({ sceneKey: 'gen_b', personDrawn: false, objectAllowed: true }),
    decision({ sceneKey: 'gen_c', personDrawn: false, objectAllowed: false, objectBlockedReason: 'no_recent_activity' }),
  ];
  const trace: any = {};
  const out = await planScenariosLocal({ imageDataUrl: IMG, prompt: 'p', scenarioCount: 3, trace, allowPerson: true, emptyRoomScenes: decisions,
    detector: { person: false, count: 0, elapsedMs: 0 }, sceneDistances: [30, 30, -30] });
  assert.match(out[0].prediction_prompt, /^The person\b/);
  assert.equal(out[0].skipped, undefined);
  assert.doesNotMatch(out[1].prediction_prompt, /person|remain/i);
  assert.match(out[1].prediction_prompt, /chair|bin/);
  assert.equal(out[2].skipped, 'no_recent_activity');
  assert.equal(out[2].prediction_prompt, '');
  assert.equal(out[2].scenario_description, '');
  assert.deepEqual(trace.guard.emptyRoom.map((d: any) => [d.sceneKey, d.personDrawn, d.skipped ?? null, d.skipReason ?? null]), [['gen_a', true, null, null], ['gen_b', false, false, null], ['gen_c', false, true, 'no_recent_activity']]);
});

test('planner: no recent person and no recent activity -> every empty scene is skipped (no "remains the same")', async (t) => {
  mockPlanner(t, FRAME, ['The chair turns slightly.', 'The pipes remain exactly as in the input.', 'The bin shifts.']);
  const decisions = decideEmptyRoomScenes({ ...base, captureId: 'cap-x', emptyRoomPersonChance: 1, recentPerson: false, activityMinutesAgo: null });
  const out = await planScenariosLocal({ imageDataUrl: IMG, prompt: 'p', scenarioCount: 3, allowPerson: false, emptyRoomScenes: decisions, detector: { person: false, count: 0, elapsedMs: 0 } });
  assert.deepEqual(out.map((s) => s.skipped), ['no_recent_activity', 'no_recent_activity', 'no_recent_activity']);
});

test('planner: an occupied frame ignores the empty-room decisions (nothing skipped)', async (t) => {
  mockPlanner(t, 'A man in a black shirt sits at a desk.', ['The man looks left.', 'The man types.', 'The man leans back.']);
  const decisions = decideEmptyRoomScenes({ ...base, captureId: 'cap-y', emptyRoomPersonChance: 0, recentPerson: false, activityMinutesAgo: null });
  const trace: any = {};
  const out = await planScenariosLocal({ imageDataUrl: IMG, prompt: 'p', scenarioCount: 3, trace, emptyRoomScenes: decisions, detector: { person: true, count: 1, elapsedMs: 0 },
    people: [{ position: 'center', pose: 'sitting', clothes: 'black shirt', facing: 'toward' }] as any });
  assert.ok(out.every((s) => !s.skipped));
  assert.equal(trace.guard.emptyRoom, undefined);
});

test('skip plan: only generated scenes are published; expectedImageCount = generated count', () => {
  const plan = sceneSkipPlan([{}, { skipped: 'chance' }, {}]);
  assert.deepEqual(plan.generated, ['gen_a', 'gen_c']);
  assert.deepEqual(plan.skippedScenes, [{ sceneKey: 'gen_b', reason: 'chance' }]);
  assert.deepEqual(sceneSkipPlan([{ skipped: 'no_recent_activity' }, { skipped: 'no_movable_object' }, { skipped: 'chance' }]).generated, []);
  assert.deepEqual(sceneSkipPlan([{}, {}, {}]).skippedScenes, []);
});

import { activityMinutesFromRecent, resolveRecentPersonScene } from './emptyRoomDecision';
import { recentPersonPhrase } from './peopleDescribe';

test('activity source = recent person: minutes since its occupied frame (number), null only without a recent person', () => {
  const now = Date.parse('2026-10-19T06:22:04Z');
  assert.equal(activityMinutesFromRecent({ entry: { time: '2026-10-19T06:17:04Z' }, minutesAgo: 5 }, now), 5);
  assert.equal(activityMinutesFromRecent({ entry: { time: 'bad' }, minutesAgo: 4 }, now), 4);
  assert.equal(activityMinutesFromRecent(null, now), null);
});

test('resolveRecentPersonScene: objectAllowed=false drops the planner object change (person-only motion)', () => {
  const kept = 'The person stands quietly with their back to the camera, while the bin is slightly shifted to the right.';
  assert.equal(resolveRecentPersonScene({ decision: decision({ personDrawn: true, objectAllowed: false, objectBlockedReason: 'no_recent_activity' }), kept, personOnly: 'The person stands.' }), 'The person stands.');
  assert.equal(resolveRecentPersonScene({ decision: decision({ personDrawn: true }), kept, personOnly: 'The person stands.' }), kept);
});

// Offline reconstruction of the 2026-10-19 06:22:04Z archive (test-TSC-001-F004-L023-1792390925035): empty frame,
// recent person 5 min ago, operator extras naming a person; planner output copied from the archived rawResponse.
const ARCHIVE_0622 = {
  captureId: 'test-TSC-001-F004-L023-1792390925035',
  frame: 'An empty workshop with overhead fluorescent lights, metal ductwork, and translucent curtains dividing spaces. A large green and clear plastic storage bin is in the foreground.',
  scenes: [
    'The green and clear plastic storage bin is slightly shifted to the right, its lid tilted upward slightly.',
    'The storage bin is now fully open, with its lid lifted to the side, revealing the empty interior.',
    'The storage bin remains closed, with no visible movement, and the lid is flat and closed.',
  ],
  extras: { gen_a: '画面左の人物が、椅子に座ったまま机を見る。', gen_b: '画面左の人物が、片手を軽く上げる。', gen_c: '画面左の人物が、机に片手を置く。' },
};
const now0622 = Date.parse('2026-10-19T06:22:04.314Z');
const recent0622 = { entry: { time: new Date(now0622 - 5 * 60_000).toISOString() }, minutesAgo: 5 };

test('06:22 reconstructed: objectAllowed=false -> person-only motion in operator-mention scenes, no bin change; activityMinutesAgo is a number', async (t) => {
  mockPlanner(t, ARCHIVE_0622.frame, ARCHIVE_0622.scenes);
  const activity = activityMinutesFromRecent(recent0622, now0622);
  assert.equal(typeof activity, 'number');
  const decisions = decideEmptyRoomScenes({ ...base, captureId: ARCHIVE_0622.captureId, emptyRoomPersonChance: 0.3, recentPerson: true, extras: ARCHIVE_0622.extras, activityMinutesAgo: activity });
  assert.deepEqual(decisions.map((d) => [d.personDrawn, d.reason, d.objectAllowed, d.objectBlockedReason, d.activityMinutesAgo]), [0, 1, 2].map(() => [true, 'operator_mention', false, 'no_recent_activity', 5]));
  const out = await planScenariosLocal({ imageDataUrl: IMG, prompt: 'p', scenarioCount: 3, allowPerson: true, emptyRoomScenes: decisions, sceneExtras: ARCHIVE_0622.extras,
    detector: { person: false, count: 0, elapsedMs: 0 }, people: [], sceneDistances: [15, 30, -30] });
  out.forEach((s, i) => {
    assert.equal(s.prediction_prompt, `The person ${recentPersonPhrase(i)}.`);
    assert.doesNotMatch(`${s.prediction_prompt} ${s.scenario_description}`, /bin|lid|収納|蓋/i);
    assert.equal(s.skipped, undefined);
  });
});

test('06:22 reconstructed without the operator mention: roll-only person (rolls >= 0.3) + objectAllowed=false -> every scene skipped', async (t) => {
  mockPlanner(t, ARCHIVE_0622.frame, ARCHIVE_0622.scenes);
  const decisions = decideEmptyRoomScenes({ ...base, captureId: ARCHIVE_0622.captureId, emptyRoomPersonChance: 0.3, recentPerson: true, activityMinutesAgo: activityMinutesFromRecent(recent0622, now0622) });
  assert.ok(decisions.every((d) => !d.personDrawn && !d.objectAllowed));
  const out = await planScenariosLocal({ imageDataUrl: IMG, prompt: 'p', scenarioCount: 3, allowPerson: true, emptyRoomScenes: decisions,
    detector: { person: false, count: 0, elapsedMs: 0 }, people: [], sceneDistances: [15, 30, -30] });
  assert.deepEqual(out.map((s) => [s.skipped, s.prediction_prompt]), [0, 1, 2].map(() => ['no_recent_activity', '']));
});
