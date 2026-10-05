import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeEditInstruction,
  parseClockEditMode,
  shouldEditClock,
} from './orchestrator';
import { buildNegativePrompt, QUALITY_SUFFIX } from './comfyClient';
import { buildFutureImagePrompt, parseClockVisible, scenarioDirection } from '../../services/promptBuilder';
import { parseScenarios } from './vlmClient';

const SCENE_TIME = '2026-07-13T14:07:37';
const clock = (visible?: boolean) => ({ direction: 'future' as const, sceneTime: SCENE_TIME, visible });
const compose = (mode: 'auto' | 'on' | 'off', visible?: boolean, withClock = true) =>
  composeEditInstruction({
    predictionPrompt: 'The person stands up.',
    clock: withClock ? clock(visible) : undefined,
    mode,
  });

const CLOCKY = /flip|sign|clock|digit|number card/i;

test('auto + visible: deterministic clock instruction present (14:07:37 + 30s = 14:08)', () => {
  const p = compose('auto', true);
  assert.match(p, /flip-number sign/);
  assert.match(p, /14 \(one-four\)/);
  assert.match(p, /08 \(zero-eight\)/);
  assert.match(p, /leading zero/);
});

test('auto + not visible / unknown: no clock wording anywhere in the prompt', () => {
  for (const visible of [false, undefined]) {
    const p = compose('auto', visible);
    assert.doesNotMatch(p, CLOCKY, `visible=${visible}`);
  }
});

test('auto without a clock request at all: no clock wording', () => {
  assert.doesNotMatch(compose('auto', true, false), CLOCKY);
});

test('on = old behaviour (instruction even if not visible); off = never', () => {
  assert.match(compose('on', false), /flip-number sign/);
  assert.match(compose('on', undefined), /flip-number sign/);
  assert.doesNotMatch(compose('off', true), CLOCKY);
  assert.doesNotMatch(compose('off', undefined), CLOCKY);
});

test('shouldEditClock truth table', () => {
  assert.equal(shouldEditClock(true, 'auto'), true);
  assert.equal(shouldEditClock(false, 'auto'), false);
  assert.equal(shouldEditClock(undefined, 'auto'), false);
  assert.equal(shouldEditClock(false, 'on'), true);
  assert.equal(shouldEditClock(true, 'off'), false);
});

test('parseClockEditMode defaults to auto', () => {
  assert.equal(parseClockEditMode(undefined), 'auto');
  assert.equal(parseClockEditMode(''), 'auto');
  assert.equal(parseClockEditMode('garbage'), 'auto');
  assert.equal(parseClockEditMode('ON'), 'on');
  assert.equal(parseClockEditMode('off'), 'off');
});

test('base prompt pieces carry no clock wording; clock pieces appear only on request', () => {
  assert.doesNotMatch(buildFutureImagePrompt('x'), CLOCKY);
  assert.doesNotMatch(QUALITY_SUFFIX, CLOCKY);
  assert.doesNotMatch(buildNegativePrompt(false), CLOCKY);
  assert.match(buildFutureImagePrompt('x', undefined, true), /number sign/);
  assert.match(buildNegativePrompt(true), /clock/);
});

test('parseClockVisible is strict: only true / "true"', () => {
  assert.equal(parseClockVisible(true), true);
  assert.equal(parseClockVisible('true'), true);
  for (const v of [false, 'false', 'yes', 1, null, undefined, {}, 'unknown']) {
    assert.equal(parseClockVisible(v), false, String(v));
  }
});

test('local VLM parsing copies clock_visible onto every scenario; missing -> false', () => {
  const s = (extra: string) =>
    `{${extra}"scenarios":[{"prediction_prompt":"a","scenario_description":"b","label":"c"},` +
    `{"prediction_prompt":"d","scenario_description":"e","label":"f"}]}`;
  assert.deepEqual(parseScenarios(s('"clock_visible":true,')).map((x) => x.clock_visible), [true, true]);
  assert.deepEqual(parseScenarios(s('"clock_visible":false,')).map((x) => x.clock_visible), [false, false]);
  assert.deepEqual(parseScenarios(s('')).map((x) => x.clock_visible), [false, false]);
  assert.deepEqual(parseScenarios(s('"clock_visible":"maybe",')).map((x) => x.clock_visible), [false, false]);
});

test('scenarioDirection: Japanese time phrases with false-matching words', () => {
  // "30秒後の世界です。女性が手前に歩いてきます。" - contains 後 but as part of 秒後
  const scenario1 = {
    prediction_prompt: 'test',
    scenario_description: '30秒後の世界です。女性が手前に歩いてきます。',
    label: 'Timeline 1'
  };
  assert.equal(scenarioDirection(scenario1, 0), 'future', '30秒後 with 手前 should be future');

  // "30秒後。男性が後ろを振り返る" - contains 後 but as part of 秒後
  const scenario2 = {
    prediction_prompt: 'test',
    scenario_description: '30秒後。男性が後ろを振り返る',
    label: 'Timeline 1'
  };
  assert.equal(scenarioDirection(scenario2, 1), 'future', '30秒後 with 後ろ should be future');

  // "30秒前の世界です。男性は手前のデスクにいる" - 前 is part of 秒前, not 手前
  const scenario3 = {
    prediction_prompt: 'test',
    scenario_description: '30秒前の世界です。男性は手前のデスクにいる',
    label: 'Timeline'
  };
  assert.equal(scenarioDirection(scenario3, 2), 'past', '30秒前 should be past');
});

test('scenarioDirection: English time phrases without false-matching words', () => {
  // "Thirty seconds later, she moves next to the desk" - contains "next" but as "next to"
  const scenario = {
    prediction_prompt: 'test',
    scenario_description: 'Thirty seconds later, she moves next to the desk',
    label: 'Timeline 1'
  };
  assert.equal(scenarioDirection(scenario, 0), 'future', 'seconds later should be future despite next to');
});

test('scenarioDirection: no time words falls back to index convention', () => {
  const scenarioNoTime = {
    prediction_prompt: 'test',
    scenario_description: 'Person walks in room',
    label: 'Timeline'
  };
  assert.equal(scenarioDirection(scenarioNoTime, 0), 'future', 'index 0 without time words should be future');
  assert.equal(scenarioDirection(scenarioNoTime, 2), 'past', 'index 2 without time words should be past');
});
