import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SCENE_PARAMS,
  clampSignedDistanceSec,
  describeSceneParams,
  formatDistanceEn,
  formatDistanceJa,
  formatSignedDistanceEn,
  formatSignedDistanceJa,
  normalizeSceneParams,
  parseSceneDistances,
  presenceAllowsNewPerson,
  resolveSceneDistances,
  sceneDistanceAt,
} from './sceneParams';
import {
  buildDistanceScaleSentence,
  buildFutureImagePrompt,
  buildPresenceSentence,
  buildScenarioPredictionPrompt,
  buildToneSentence,
  scenarioDirection,
} from './promptBuilder';
import { buildClockInstruction, clockForSignedDistance, composeEditInstruction, readSceneParams } from '../server/generation/orchestrator';
import { LONG_SPAN_QUALITY_SUFFIX, QUALITY_SUFFIX } from '../server/generation/comfyClient';

test('normalizeSceneParams: defaults when missing, so old clients keep working', () => {
  assert.deepEqual(normalizeSceneParams(undefined), DEFAULT_SCENE_PARAMS);
  assert.deepEqual(normalizeSceneParams({ image: 'x', imageCount: 3 }), DEFAULT_SCENE_PARAMS);
  assert.deepEqual(normalizeSceneParams({ futureDistanceSec: null, presence: '', tone: 'abc' }), DEFAULT_SCENE_PARAMS);
  assert.deepEqual(DEFAULT_SCENE_PARAMS, { futureDistanceSec: 30, sceneDistancesSec: [30, 30, -30], presence: 0.3, tone: 0.3, emptyRoomPersonChance: 0.3 });
});

test('normalizeSceneParams: clamps (5-300 s, integer; 0-1) and accepts numeric strings', () => {
  assert.deepEqual(normalizeSceneParams({ futureDistanceSec: 1, presence: -2, tone: 7 }), {
    futureDistanceSec: 5,
    sceneDistancesSec: [5, 5, -5],
    presence: 0,
    tone: 1,
    emptyRoomPersonChance: 0.3,
  });
  assert.equal(normalizeSceneParams({ futureDistanceSec: 9999 }).futureDistanceSec, 300);
  assert.equal(normalizeSceneParams({ futureDistanceSec: 12.6 }).futureDistanceSec, 13);
  assert.equal(normalizeSceneParams({ futureDistanceSec: '120', presence: '0.5' }).futureDistanceSec, 120);
  assert.equal(normalizeSceneParams({ presence: '0.5' }).presence, 0.5);
  // server-provided defaults apply to missing fields only
  assert.equal(normalizeSceneParams({}, { futureDistanceSec: 45 }).futureDistanceSec, 45);
  assert.equal(normalizeSceneParams({ futureDistanceSec: 10 }, { futureDistanceSec: 45 }).futureDistanceSec, 10);
});

test('distance formatting (English prompt text, Japanese description phrase)', () => {
  assert.equal(formatDistanceEn(30), '30 seconds');
  assert.equal(formatDistanceEn(60), '1 minute');
  assert.equal(formatDistanceEn(90), '1 minute 30 seconds');
  assert.equal(formatDistanceEn(120), '2 minutes');
  assert.equal(formatDistanceJa(10), '10秒');
  assert.equal(formatDistanceJa(120), '2分');
  assert.equal(formatDistanceJa(90), '1分30秒');
});

test('presence sentence is chosen by range', () => {
  const none = buildPresenceSentence(0);
  const low = buildPresenceSentence(0.3);
  const mid = buildPresenceSentence(0.5);
  const high = buildPresenceSentence(1);
  assert.equal(new Set([none, low, mid, high]).size, 4);
  assert.match(none, /nobody who is not already visible appears/);
  assert.match(none, /minimal motion/);
  assert.match(low, /nobody new appears/);
  assert.match(mid, /stay in the frame/);
  assert.match(high, /leave the frame through an edge or doorway/);
  // G-01: no band ever lets an unknown new person in
  for (const t of [none, low, mid, high]) assert.doesNotMatch(t, /walk into|partly enter|may appear/);
  // band edges
  assert.equal(buildPresenceSentence(0.14), none);
  assert.equal(buildPresenceSentence(0.15), low);
  assert.equal(buildPresenceSentence(0.45), mid);
  assert.equal(buildPresenceSentence(0.75), high);
  // presence never lets a new person in (G-01), however high
  assert.equal(presenceAllowsNewPerson(0.3), false);
  assert.equal(presenceAllowsNewPerson(1), false);
});

test('tone sentence: four distinct bands (0 / 0.3 / 0.6 / 1.0), high one overrides "small changes" and keeps the safety limits', () => {
  const calm = buildToneSentence(0);
  const quiet = buildToneSentence(0.3);
  const lively = buildToneSentence(0.6);
  const dramatic = buildToneSentence(1, 120);
  assert.equal(new Set([calm, quiet, lively, dramatic]).size, 4);
  assert.match(calm, /TONE 0 = CALM/);
  assert.match(calm, /Almost nothing happens/);
  assert.match(quiet, /TONE LOW = QUIET/);
  assert.match(lively, /TONE MEDIUM = LIVELY/);
  assert.match(dramatic, /TONE HIGH = DRAMATIC/);
  // band edges
  assert.equal(buildToneSentence(0.14), calm);
  assert.equal(buildToneSentence(0.15), quiet);
  assert.equal(buildToneSentence(0.45), lively);
  assert.equal(buildToneSentence(0.75, 120), dramatic);
  // high tone beats the "small changes" wording of distance / presence, uses the distance, stays physical
  assert.match(dramatic, /OVERRIDES/);
  assert.match(dramatic, /physically possible within 2 minutes/);
  assert.match(dramatic, /no fantasy/);
  // G-11: no big arm gestures in the examples
  for (const t of [lively, dramatic]) assert.doesNotMatch(t, /both arms up|both hands thrown up|stretching with|waving? (a|the) hand/);
  assert.match(dramatic, /never from new people, new objects or a changed room/);
  // it applies to the "before" scenario too
  for (const t of [calm, quiet, lively, dramatic]) assert.match(t, /ALL scenarios, including the one before/);
});

test('scenario prompt: visible-only rule and tone-aware movement rule are always present', () => {
  for (const tone of [0, 0.3, 0.6, 1]) {
    const p = buildScenarioPredictionPrompt(null, 3, undefined, { futureDistanceSec: 30, presence: 0.3, tone });
    assert.match(p, /Use only what is visible inside this frame/);
    assert.match(p, /cut off by the frame edge or not shown/);
    assert.match(p, /follows the Tone instruction below/);
    assert.match(p, /exactly two arms and two hands/);
    assert.match(p, /do not add or remove monitors, screens, chairs, tables or other objects/);
  }
});

test('distance scale sentence: short N -> small changes, long N -> larger changes', () => {
  assert.match(buildDistanceScaleSentence(10), /^10 seconds is a very short time/);
  assert.match(buildDistanceScaleSentence(30), /^30 seconds is a short time/);
  assert.match(buildDistanceScaleSentence(120), /^2 minutes is a moderate time/);
  assert.match(buildDistanceScaleSentence(299), /^4 minutes 59 seconds is a fairly long time/);
  assert.match(buildDistanceScaleSentence(300), /^5 minutes is a long time/);
  assert.match(buildDistanceScaleSentence(300), /no fantasy/);
  assert.match(buildDistanceScaleSentence(600), /^10 minutes is a very long time/);
  assert.match(buildDistanceScaleSentence(600), /completely different/);
  // the sign does not matter: the time span is |d|
  assert.equal(buildDistanceScaleSentence(-600), buildDistanceScaleSentence(600));
  // long spans: the fixed camera / room / no-invention rules still bind
  for (const s of [buildDistanceScaleSentence(300), buildDistanceScaleSentence(600)]) {
    assert.match(s, /fixed camera, the room layout, the furniture and (all )?(every )?objects? stay exactly the same/);
    assert.match(s, /nothing that is not visible in this frame may be invented|Nothing may be invented/);
    assert.match(s, /nobody who is not in this frame appears/);
  }
});

test('scenario prompt carries the distance everywhere and no leftover 30 seconds / placeholders', () => {
  const p = buildScenarioPredictionPrompt(null, 3, undefined, { futureDistanceSec: 120, presence: 1, tone: 1 });
  assert.doesNotMatch(p, /30 seconds/);
  assert.doesNotMatch(p, /\{\{/);
  assert.match(p, /exactly about 2 minutes AFTER/);
  assert.match(p, /exactly about 2 minutes BEFORE/);
  assert.match(p, /2分後/);
  assert.match(p, /leave the frame through an edge or doorway/);
  assert.match(p, /TONE HIGH = DRAMATIC/);
  // the always-on rules stay, whatever the controls say
  assert.match(p, /exactly two arms and two hands/);
  assert.match(p, /Never duplicate any person or object/);
  assert.match(p, /keep the exact same count of everything/);
});

test('scenario prompt for the targeted variant also uses the distance', () => {
  const p = buildScenarioPredictionPrompt({ x: 0.5, y: 0.5 }, 3, undefined, {
    futureDistanceSec: 45,
    presence: 0,
    tone: 0,
  });
  assert.match(p, /exactly its own time span from now/);
  assert.match(p, /Scenario 3: exactly about 45 seconds BEFORE this frame/);
  assert.doesNotMatch(p, /\{\{/);
  assert.match(p, /nobody who is not already visible appears/);
});

test('scenario prompt defaults (no params) = 30 seconds, presence 0.3, tone 0.3', () => {
  const p = buildScenarioPredictionPrompt(null, 3);
  assert.match(p, /exactly about 30 seconds AFTER/);
  assert.match(p, /30秒後/);
  assert.match(p, /People: nobody new appears\./);
  assert.match(p, /TONE LOW = QUIET/);
});

test('clock digits follow the future distance (14:07:37)', () => {
  const t = '2026-07-13T14:07:37';
  const digits = (s: string) => [...s.matchAll(/the two digits (\d\d) /g)].map((m) => m[1]).join(':');
  assert.equal(digits(buildClockInstruction('future', t, 30)), '14:08');
  assert.equal(digits(buildClockInstruction('past', t, 30)), '14:07');
  assert.equal(digits(buildClockInstruction('future', t, 10)), '14:07');
  assert.equal(digits(buildClockInstruction('future', t, 120)), '14:09');
  assert.equal(digits(buildClockInstruction('past', t, 120)), '14:05');
  assert.equal(digits(buildClockInstruction('future', t, 300)), '14:12');
  assert.equal(digits(buildClockInstruction('future', '2026-07-13T23:58:10', 300)), '00:03'); // crosses midnight
  const composed = composeEditInstruction({
    predictionPrompt: 'The person stands up.',
    clock: { direction: 'future', sceneTime: t, visible: true, distanceSec: 120 },
    mode: 'auto',
  });
  assert.equal(digits(composed), '14:09');
});

test('scenarioDirection works for any distance, in minutes too', () => {
  const sc = (d: string) => ({ prediction_prompt: '', scenario_description: d, label: 'Timeline 1' });
  assert.equal(scenarioDirection(sc('10秒後、男性が立ち上がる'), 0), 'future');
  assert.equal(scenarioDirection(sc('10秒前、男性は座っていた'), 2), 'past');
  assert.equal(scenarioDirection(sc('2分後、女性が奥へ歩いていく'), 1), 'future');
  assert.equal(scenarioDirection(sc('2分前、女性は手前のデスクにいた'), 2), 'past');
  assert.equal(scenarioDirection(sc('1分30秒後に男性が戻ってくる'), 0), 'future');
  assert.equal(scenarioDirection(sc('1分30秒前、後ろの席が空いていた'), 2), 'past');
  assert.equal(scenarioDirection(sc('5分後'), 2), 'future'); // text beats the index fallback
  assert.equal(scenarioDirection(sc('2 minutes before, he sat down'), 0), 'past');
  assert.equal(scenarioDirection(sc('2 minutes after, he stands'), 2), 'future');
});

test('image edit prompt: a new person is never allowed, whatever the presence (G-01)', () => {
  const low = buildFutureImagePrompt('x', undefined, false, 0.3);
  const high = buildFutureImagePrompt('x', undefined, false, 0.8);
  assert.match(low, /Do not add any new person that is not in the input/);
  assert.match(high, /Do not add any new person that is not in the input/);
  const composedLow = composeEditInstruction({ predictionPrompt: 'x', presence: 0.3 });
  const composedHigh = composeEditInstruction({ predictionPrompt: 'x', presence: 1 });
  // The quality suffix is followed only by the single main-change sentence (2026-10-19 motion fix).
  assert.ok(composedLow.endsWith(QUALITY_SUFFIX + '\n\nMain change that must be clearly visible: x.'));
  assert.ok(composedHigh.endsWith(QUALITY_SUFFIX + '\n\nMain change that must be clearly visible: x.'));
  // anatomy / no-duplicate rules are in both
  for (const c of [composedLow, composedHigh]) {
    assert.match(c, /exactly two arms and two hands/);
    assert.match(c, /No duplicated limbs, hands or people/);
    assert.match(c, /appears only once/);
  }
});

// ---------------------------------------------------------------------------
// Per-scene temporal distance (sceneDistancesSec, signed seconds, -600..+600)
// ---------------------------------------------------------------------------

test('sceneDistancesSec: parsed per scene, signed, in gen_a / gen_b / gen_c order', () => {
  assert.deepEqual(normalizeSceneParams({ sceneDistancesSec: [30, 120, -600] }).sceneDistancesSec, [30, 120, -600]);
  assert.deepEqual(normalizeSceneParams({ sceneDistancesSec: [-10, -20, -30] }).sceneDistancesSec, [-10, -20, -30]);
  assert.deepEqual(normalizeSceneParams({ sceneDistancesSec: ['45', '-90', ' 600 '] }).sceneDistancesSec, [45, -90, 600]);
  // the other controls are untouched by it
  const p = normalizeSceneParams({ sceneDistancesSec: [5, 60, 600], presence: 0.8, tone: 0.2 });
  assert.equal(p.presence, 0.8);
  assert.equal(p.tone, 0.2);
});

test('sceneDistancesSec: |d| is clamped to 5..600, the sign is kept, 0 becomes +5', () => {
  assert.equal(clampSignedDistanceSec(0), 5);
  assert.equal(clampSignedDistanceSec(-0), 5);
  assert.equal(clampSignedDistanceSec(1), 5);
  assert.equal(clampSignedDistanceSec(-1), -5);
  assert.equal(clampSignedDistanceSec(4.4), 5);
  assert.equal(clampSignedDistanceSec(-4), -5);
  assert.equal(clampSignedDistanceSec(601), 600);
  assert.equal(clampSignedDistanceSec(-99999), -600);
  assert.equal(clampSignedDistanceSec(12.6), 13);
  assert.equal(clampSignedDistanceSec(-12.4), -12);
  assert.deepEqual(normalizeSceneParams({ sceneDistancesSec: [0, -1, 9999] }).sceneDistancesSec, [5, -5, 600]);
  assert.deepEqual(normalizeSceneParams({ sceneDistancesSec: [-0.2, 3, -700] }).sceneDistancesSec, [5, 5, -600]);
});

test('sceneDistancesSec: absent or invalid -> old futureDistanceSec N as [+N, +N, -N] (default N = 30)', () => {
  const fb = (raw: unknown, defaults = {}) => normalizeSceneParams(raw, defaults).sceneDistancesSec;
  assert.deepEqual(fb(undefined), [30, 30, -30]);
  assert.deepEqual(fb({}), [30, 30, -30]);
  assert.deepEqual(fb({ futureDistanceSec: 120 }), [120, 120, -120]);
  assert.deepEqual(fb({ futureDistanceSec: 9999 }), [300, 300, -300]); // old 5..300 clamp still applies to N
  assert.deepEqual(fb({ futureDistanceSec: 1 }), [5, 5, -5]);
  // invalid arrays fall back as a whole (never partly), to N when given, else to the default
  assert.deepEqual(fb({ sceneDistancesSec: [10, 20] }), [30, 30, -30]); // too short
  assert.deepEqual(fb({ sceneDistancesSec: [10, 20, 30, 40] }), [30, 30, -30]); // too long
  assert.deepEqual(fb({ sceneDistancesSec: [10, 'x', 30] }), [30, 30, -30]); // non-numeric item
  assert.deepEqual(fb({ sceneDistancesSec: [10, null, 30] }), [30, 30, -30]);
  assert.deepEqual(fb({ sceneDistancesSec: '10,20,30' }), [30, 30, -30]); // not an array
  assert.deepEqual(fb({ sceneDistancesSec: [10, NaN, 30] }), [30, 30, -30]);
  assert.deepEqual(fb({ sceneDistancesSec: 'oops', futureDistanceSec: 60 }), [60, 60, -60]);
  // a valid array wins over futureDistanceSec
  assert.deepEqual(fb({ sceneDistancesSec: [10, 20, 30], futureDistanceSec: 60 }), [10, 20, 30]);
  assert.equal(normalizeSceneParams({ sceneDistancesSec: [10, 20, 30], futureDistanceSec: 60 }).futureDistanceSec, 60);
  // server default N (env SCENE_TIME_DELTA_SEC) applies to old clients; a client N beats it
  assert.deepEqual(fb({}, { futureDistanceSec: 45 }), [45, 45, -45]);
  assert.deepEqual(fb({ futureDistanceSec: 10 }, { futureDistanceSec: 45 }), [10, 10, -10]);
  assert.equal(parseSceneDistances(undefined), undefined);
});

test('readSceneParams (server entry point): old request == [+N,+N,-N], new request carries signed distances', () => {
  assert.deepEqual(readSceneParams({ image: 'x' }).sceneDistancesSec, [30, 30, -30]);
  assert.deepEqual(readSceneParams({ futureDistanceSec: 90 }).sceneDistancesSec, [90, 90, -90]);
  assert.deepEqual(readSceneParams({ sceneDistancesSec: [30, 30, 30] }).sceneDistancesSec, [30, 30, 30]);
  assert.deepEqual(readSceneParams({ sceneDistancesSec: [-30, -120, -600] }).sceneDistancesSec, [-30, -120, -600]);
});

test('resolveSceneDistances / sceneDistanceAt: per scene, old params still work, extra scenes reuse the last', () => {
  assert.deepEqual(resolveSceneDistances({ futureDistanceSec: 30 }), [30, 30, -30]);
  assert.deepEqual(resolveSceneDistances({ futureDistanceSec: 30, sceneDistancesSec: [5, 60, 600] }), [5, 60, 600]);
  assert.deepEqual(resolveSceneDistances({ futureDistanceSec: 30, sceneDistancesSec: [5, 60, -600] }, 5), [5, 60, -600, -600, -600]);
  assert.deepEqual(resolveSceneDistances({ futureDistanceSec: 30, sceneDistancesSec: [5, 60, -600] }, 2), [5, 60]);
  assert.equal(sceneDistanceAt({ futureDistanceSec: 30, sceneDistancesSec: [5, 60, -600] }, 1), 60);
  assert.equal(sceneDistanceAt({ futureDistanceSec: 30 }, 2), -30);
});

test('signed distance formatting and the capture log line', () => {
  assert.equal(formatSignedDistanceEn(30), '30 seconds after');
  assert.equal(formatSignedDistanceEn(-120), '2 minutes before');
  assert.equal(formatSignedDistanceEn(-600), '10 minutes before');
  assert.equal(formatSignedDistanceEn(90), '1 minute 30 seconds after');
  assert.equal(formatSignedDistanceJa(30), '30秒後');
  assert.equal(formatSignedDistanceJa(-120), '2分前');
  assert.equal(formatSignedDistanceJa(600), '10分後');
  assert.equal(formatSignedDistanceJa(-90), '1分30秒前');
  assert.equal(formatDistanceEn(600), '10 minutes');
  assert.equal(formatDistanceJa(600), '10分');
  assert.match(
    describeSceneParams(normalizeSceneParams({ sceneDistancesSec: [30, 120, -600] })),
    /^distances=\[\+30s, \+2m, -10m\] \(gen_a, gen_b, gen_c\) presence=0\.30 tone=0\.30$/
  );
  assert.match(describeSceneParams(normalizeSceneParams({})), /distances=\[\+30s, \+30s, -30s\]/);
});

const scenarioPrompt = (d: number[] | undefined, extra: object = {}) =>
  buildScenarioPredictionPrompt(null, 3, undefined, normalizeSceneParams({ sceneDistancesSec: d, ...extra }));

test('scenario prompt, default [+30,+30,-30]: same scenario instructions as the old two-futures + one-past wording', () => {
  const p = scenarioPrompt(undefined);
  assert.equal(p, buildScenarioPredictionPrompt(null, 3)); // no params == default
  assert.equal(p, buildScenarioPredictionPrompt(null, 3, undefined, { futureDistanceSec: 30, presence: 0.3, tone: 0.3 })); // old-style params
  assert.match(
    p,
    /Scenario 1: exactly about 30 seconds AFTER this frame\nScenario 2: exactly about 30 seconds AFTER this frame\nScenario 3: exactly about 30 seconds BEFORE this frame/
  );
  // single time-span sentence, as before (no per-scenario prefix)
  assert.match(p, /\n30 seconds is a short time: small to modest changes/);
  assert.doesNotMatch(p, /\nFor Scenario/);
  // as before: A/B must differ, C is a rewind
  assert.match(p, /Scenario 2 must be clearly different from Scenario 1: a different person moving/);
  assert.match(p, /Never make Scenario 2 a reworded copy of Scenario 1\./);
  assert.match(p, /Make Scenario 3 an unmistakable rewind \(a state that plausibly led into this frame\), never another forward branch\./);
  assert.match(p, /Scenario 1: "30秒後、\.\.\."; Scenario 2: "30秒後、\.\.\."; Scenario 3: "30秒前、\.\.\."/);
  assert.doesNotMatch(p, /\{\{/);
});

test('scenario prompt keeps the Tone rework intact (4 bands, high overrides, visible-only rule, tone-aware movement rule)', () => {
  const names = ['TONE 0 = CALM', 'TONE LOW = QUIET', 'TONE MEDIUM = LIVELY', 'TONE HIGH = DRAMATIC'];
  [0, 0.3, 0.6, 1].forEach((tone, i) => {
    const p = scenarioPrompt([-30, -120, -600], { tone });
    assert.match(p, /Use only what is visible inside this frame/);
    assert.match(p, /follows the Tone instruction below/);
    assert.ok(p.includes(names[i]));
    assert.match(p, /ALL scenarios, including the one before this frame/);
  });
  const high = scenarioPrompt([5, 60, 600], { tone: 1 });
  assert.match(high, /OVERRIDES any "small changes"/);
  // spans differ -> the tone sentence must not name one wrong number
  assert.match(high, /physically possible within the time span of its scenario/);
  assert.doesNotMatch(high, /physically possible within 5 seconds|physically possible within 10 minutes/);
  // all spans equal -> the number, as before
  assert.match(scenarioPrompt([120, -120, 120], { tone: 1 }), /physically possible within 2 minutes/);
});

test('scenario prompt [-30,-120,-600]: three pasts, each with its own span and its own Japanese phrase', () => {
  const p = scenarioPrompt([-30, -120, -600]);
  assert.match(
    p,
    /Scenario 1: exactly about 30 seconds BEFORE this frame\nScenario 2: exactly about 2 minutes BEFORE this frame\nScenario 3: exactly about 10 minutes BEFORE this frame/
  );
  assert.match(p, /\nFor Scenario 1: 30 seconds is a short time/);
  assert.match(p, /\nFor Scenario 2: 2 minutes is a moderate time/);
  assert.match(p, /\nFor Scenario 3: 10 minutes is a very long time/);
  assert.match(p, /Scenario 1: "30秒前、\.\.\."; Scenario 2: "2分前、\.\.\."; Scenario 3: "10分前、\.\.\."/);
  assert.match(p, /Scenarios 1, 2 and 3 are all BEFORE this frame but at different time spans: the longer the time span, the larger the difference/);
  assert.match(p, /Make Scenarios 1, 2 and 3 each an unmistakable rewind/);
  assert.doesNotMatch(p, /Scenario 3 must be clearly different/); // different spans: no "same moment" rule
  assert.doesNotMatch(p, /Scenario [0-9]: exactly about .* AFTER this frame/);
  assert.doesNotMatch(p, /\{\{/);
});

test('scenario prompt [+5,+60,+600]: three futures at different scales, no rewind sentence', () => {
  const p = scenarioPrompt([5, 60, 600]);
  assert.match(
    p,
    /Scenario 1: exactly about 5 seconds AFTER this frame\nScenario 2: exactly about 1 minute AFTER this frame\nScenario 3: exactly about 10 minutes AFTER this frame/
  );
  assert.match(p, /\nFor Scenario 1: 5 seconds is a very short time/);
  assert.match(p, /\nFor Scenario 3: 10 minutes is a very long time/);
  assert.match(p, /"5秒後、\.\.\."; Scenario 2: "1分後、\.\.\."; Scenario 3: "10分後、\.\.\."/);
  assert.doesNotMatch(p, /unmistakable rewind/);
  assert.doesNotMatch(p, /Scenario [0-9]: exactly about .* BEFORE this frame/); // no BEFORE scenario line
  assert.doesNotMatch(p, /\{\{/);
});

test('scenario prompt [+30,+30,+30]: three futures at the same moment must be distinct alternatives', () => {
  const p = scenarioPrompt([30, 30, 30]);
  assert.match(p, /Scenarios 1, 2 and 3 happen at exactly the same moment, so they must be clearly different alternatives of each other/);
  assert.doesNotMatch(p, /unmistakable rewind/);
  assert.match(p, /\n30 seconds is a short time/);
  assert.doesNotMatch(p, /\nFor Scenario/);
  // mixed: two pasts at the same span + one future
  const q = scenarioPrompt([-120, 30, -120]);
  assert.match(q, /Scenario 3 must be clearly different from Scenario 1/);
  assert.match(q, /Make Scenarios 1 and 3 each an unmistakable rewind/);
  assert.match(q, /Scenario 1: "2分前、\.\.\."; Scenario 2: "30秒後、\.\.\."; Scenario 3: "2分前、\.\.\."/);
  assert.match(q, /\nFor Scenarios 1 and 3: 2 minutes is a moderate time/);
});

test('long-span distance bands: 5+ minutes allow big changes but keep camera, room and no-invention rules; Presence behaviour unchanged', () => {
  const p = scenarioPrompt([300, 450, 600]);
  assert.match(p, /\nFor Scenario 1: 5 minutes is a long time/);
  assert.match(p, /\nFor Scenario 3: 10 minutes is a very long time/);
  assert.match(p, /a screen that is on keeps showing what it shows now/);
  // presence sentence is exactly the old band text, whatever the distances
  for (const presence of [0, 0.3, 0.5, 1]) {
    assert.ok(scenarioPrompt([600, 600, -600], { presence }).includes(buildPresenceSentence(presence)));
  }
});

test('image prompt: spans of 2+ minutes (either direction) add the "keep the background identical" clause, shorter ones do not', () => {
  const short = buildFutureImagePrompt('x', undefined, false, 0.3, 30);
  const noSpan = buildFutureImagePrompt('x', undefined, false, 0.3);
  assert.equal(short, noSpan);
  for (const d of [120, -120, 600, -600]) {
    const long = buildFutureImagePrompt('x', undefined, false, 0.3, d);
    assert.match(long, /same photograph from the same fixed camera: keep the whole background/);
    assert.match(long, /identical to the input, pixel for pixel/);
    assert.ok(long.startsWith(short.split('\n\n')[0]));
  }
  assert.doesNotMatch(buildFutureImagePrompt('x', undefined, false, 0.3, -119), /same photograph from the same fixed camera/);
  // composeEditInstruction takes it from the explicit distance or from the clock request
  assert.match(composeEditInstruction({ predictionPrompt: 'x', distanceSec: -600 }), /same photograph from the same fixed camera/);
  assert.match(
    composeEditInstruction({ predictionPrompt: 'x', clock: { direction: 'past', distanceSec: 300 } }),
    /same photograph from the same fixed camera/
  );
  assert.doesNotMatch(composeEditInstruction({ predictionPrompt: 'x', distanceSec: 30 }), /same photograph from the same fixed camera/);
  assert.doesNotMatch(composeEditInstruction({ predictionPrompt: 'x' }), /same photograph from the same fixed camera/);
  // the rules that always apply are still there for a long span
  const c = composeEditInstruction({ predictionPrompt: 'x', distanceSec: 600 });
  assert.ok(c.endsWith(LONG_SPAN_QUALITY_SUFFIX + '\n\nMain change that must be clearly visible: x.'));
  assert.ok(!composeEditInstruction({ predictionPrompt: "x", distanceSec: 30 }).includes(LONG_SPAN_QUALITY_SUFFIX));
  assert.match(c, /exactly two arms and two hands/);
  assert.match(c, /Do not add any new person that is not in the input/);
});

test("clock digits use each scene's own signed offset (14:07:37)", () => {
  const t = '2026-07-13T14:07:37';
  const digits = (s: string) => [...s.matchAll(/the two digits (\d\d) /g)].map((m) => m[1]).join(':');
  const clockFor = (signed: number, base = t) =>
    digits(composeEditInstruction({ predictionPrompt: 'x', clock: clockForSignedDistance(signed, base, true), mode: 'auto' }));
  assert.deepEqual(clockForSignedDistance(-120, t, true), { direction: 'past', distanceSec: 120, sceneTime: t, visible: true });
  assert.deepEqual(clockForSignedDistance(30, t, false), { direction: 'future', distanceSec: 30, sceneTime: t, visible: false });
  assert.equal(clockFor(30), '14:08'); // +30 s
  assert.equal(clockFor(-30), '14:07'); // -30 s
  assert.equal(clockFor(-120), '14:05');
  assert.equal(clockFor(600), '14:17'); // +10 min
  assert.equal(clockFor(-600), '13:57'); // -10 min
  assert.equal(clockFor(-480), '13:59');
  assert.equal(clockFor(-600, '2026-07-13T00:03:00'), '23:53'); // crosses midnight backwards
  // clockGate: no clock visible -> no clock text at all, whatever the distance
  assert.doesNotMatch(
    composeEditInstruction({ predictionPrompt: 'x', clock: clockForSignedDistance(-600, t, false), mode: 'auto' }),
    /digits|flip-number/
  );
});

test('normalizeSceneParams: emptyRoomPersonChance clamps to 0..1 like presence/tone, default 0.3', () => {
  assert.equal(normalizeSceneParams({}).emptyRoomPersonChance, 0.3);
  assert.equal(normalizeSceneParams({ emptyRoomPersonChance: 1.7 }).emptyRoomPersonChance, 1);
  assert.equal(normalizeSceneParams({ emptyRoomPersonChance: -1 }).emptyRoomPersonChance, 0);
  assert.equal(normalizeSceneParams({ emptyRoomPersonChance: '0.5' }).emptyRoomPersonChance, 0.5);
  assert.equal(normalizeSceneParams({ emptyRoomPersonChance: 'x' }).emptyRoomPersonChance, 0.3);
});

test('per-scene presence/tone: map or array overrides, missing scenes inherit the global value, clamped', async () => {
  const { presenceAt, toneAt, resolveScenePresence, resolveSceneTone, parseSceneUnitMap } = await import('./sceneParams');
  const p = normalizeSceneParams({ presence: 0.3, tone: 0.6, scenePresence: { gen_b: 0.8 }, sceneTone: [null, 2, '0.1'] });
  assert.deepEqual(p.scenePresence, [0.3, 0.8, 0.3]);
  assert.deepEqual(p.sceneTone, [0.6, 1, 0.1]);
  assert.equal(presenceAt(p, 1), 0.8);
  assert.equal(toneAt(p, 2), 0.1);
  assert.equal(toneAt(p, 5), 0.1, 'index beyond the third reuses the third');
  // No map in the request: no override fields, every scene = global.
  const g = normalizeSceneParams({ presence: 0.4, tone: 0.2 });
  assert.equal(g.scenePresence, undefined);
  assert.deepEqual(resolveScenePresence(g), [0.4, 0.4, 0.4]);
  assert.deepEqual(resolveSceneTone(g, 2), [0.2, 0.2]);
  assert.deepEqual(parseSceneUnitMap({ gen_a: 'x', gen_c: -1 }, 0.5), [0.5, 0.5, 0]);
  assert.match(describeSceneParams(p), /presence\[A,B,C\]=0\.30\/0\.80\/0\.30 tone\[A,B,C\]=0\.60\/1\.00\/0\.10/);
  assert.doesNotMatch(describeSceneParams(g), /\[A,B,C\]/);
});

test('planner prompt: per-scene presence/tone become one sentence per band, naming the scenarios', () => {
  const same = buildScenarioPredictionPrompt(null, 3, undefined, { futureDistanceSec: 30, presence: 0.3, tone: 0.3, scenePresence: [0.3, 0.3, 0.3], sceneTone: [0.3, 0.35, 0.3] });
  const plain = buildScenarioPredictionPrompt(null, 3, undefined, { futureDistanceSec: 30, presence: 0.3, tone: 0.3 });
  assert.equal(same, plain, 'scenes on the same band keep the old single sentences');
  const p = buildScenarioPredictionPrompt(null, 3, undefined, {
    futureDistanceSec: 30, sceneDistancesSec: [30, 30, -30], presence: 0.3, tone: 0.3, scenePresence: [0.3, 0.9, 0.3], sceneTone: [0, 0.3, 1],
  });
  assert.match(p, /For Scenarios 1 and 3: People: nobody new appears\. People who are visible move slightly/);
  assert.match(p, /For Scenario 2: People: nobody new appears\. People who are visible may move a lot/);
  assert.match(p, /For Scenario 1: Tone \(applies ONLY to Scenario 1; the other scenarios follow their own Tone sentence/);
  assert.match(p, /For Scenario 2: Tone \(applies ONLY to Scenario 2;[^\n]*TONE LOW = QUIET/);
  assert.match(p, /For Scenario 3: Tone \(applies ONLY to Scenario 3;[^\n]*DRAMATIC/);
  assert.doesNotMatch(p, /applies to ALL scenarios/);
});

test('image edit: per-scene presence/tone reach composeEditInstruction for each scene', () => {
  const params = readSceneParams({ presence: 0.3, tone: 0.3, sceneTone: { gen_c: 1 } });
  const calmC = composeEditInstruction({ predictionPrompt: 'She looks up.', presence: 0.3, tone: params.sceneTone![0] });
  const dramaticC = composeEditInstruction({ predictionPrompt: 'She looks up.', presence: 0.3, tone: params.sceneTone![2] });
  assert.notEqual(calmC, dramaticC);
});
