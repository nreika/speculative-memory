import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScenarioPredictionPrompt } from './geminiService.js';

test('buildScenarioPredictionPrompt applies prompt variant and numeric parameters', () => {
  const prompt = buildScenarioPredictionPrompt(null, 3, {
    variant: 'dramatic',
    params: {
      intensity: 2,
      detail: 3,
      growthBias: 1
    }
  });

  assert.match(prompt, /dramatic/i);
  assert.match(prompt, /high/i);
  assert.match(prompt, /detailed/i);
  assert.match(prompt, /growth/i);
});
