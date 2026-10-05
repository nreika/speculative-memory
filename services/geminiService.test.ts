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

  assert.match(prompt, /Prompt variant: dramatic\./);
  assert.match(
    prompt,
    /Additional prompt controls: intensity=2, detail=3, growthBias=1\./
  );
});

test('buildScenarioPredictionPrompt omits variant section without options', () => {
  const prompt = buildScenarioPredictionPrompt(null, 3);

  assert.doesNotMatch(prompt, /Prompt variant:/);
  assert.doesNotMatch(prompt, /Additional prompt controls:/);
  assert.match(prompt, /Predict 3 DISTINCT/);
});
