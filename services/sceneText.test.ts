import test from 'node:test';
import assert from 'node:assert/strict';
import { nowContentText, scenarioContentText } from './promptBuilder.js';
import { parseScenarios } from '../server/generation/vlmClient.js';

test('scenarioContentText is the situation description only (no prompt text)', () => {
  const s = {
    prediction_prompt: 'A man stands behind the chair. Keep the camera fixed.',
    scenario_description: '  30秒後、立ち上がり、椅子の後ろに立っています。 ',
    label: 'Timeline 1',
  };
  assert.equal(scenarioContentText(s), '30秒後、立ち上がり、椅子の後ろに立っています。');
});

test('nowContentText takes the scene-level text and tolerates its absence', () => {
  assert.equal(nowContentText([{ scene_now: '' }, { scene_now: ' 机の前に人が座っている。' }]), '机の前に人が座っている。');
  assert.equal(nowContentText([{}, {}]), '');
  assert.equal(nowContentText([]), '');
});

test('parseScenarios copies scene_description onto every scenario as scene_now', () => {
  const raw = JSON.stringify({
    clock_visible: false,
    scene_description: '暗い部屋に椅子が3脚ある。',
    scenarios: [
      { prediction_prompt: 'p1', scenario_description: '30秒後、椅子が回る。', label: 'T1' },
      { prediction_prompt: 'p2', scenario_description: '30秒前、椅子が引かれていた。', label: 'T2' },
    ],
  });
  const out = parseScenarios(raw);
  assert.equal(out.length, 2);
  assert.ok(out.every((s) => s.scene_now === '暗い部屋に椅子が3脚ある。'));
  assert.equal(scenarioContentText(out[1]), '30秒前、椅子が引かれていた。');
  assert.equal(parseScenarios(JSON.stringify({ scenarios: [{ prediction_prompt: 'p', scenario_description: 'd' }] }))[0].scene_now, '');
});
