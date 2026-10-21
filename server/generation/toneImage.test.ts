import test from 'node:test';
import assert from 'node:assert/strict';
import { composeEditInstruction } from './orchestrator';
import { toneBandIndex, toneImageRule } from './rulebook';
import { TONE_IMAGE_RULES, TONE_IMAGE_RULES_EMPTY } from './ruleTexts';
import { toneSentence } from './editPrompt';

test('tone band edges match the planner bands', () => {
  assert.deepEqual([0, 0.14, 0.15, 0.44, 0.45, 0.74, 0.75, 1].map(toneBandIndex), [0, 0, 1, 1, 2, 2, 3, 3]);
});

test('tone adds an "amount of change" sentence to the image edit, one per band', () => {
  const seen = new Set<string>();
  for (const tone of [0, 0.3, 0.6, 1]) {
    const text = composeEditInstruction({ predictionPrompt: 'The man turns his head.', presence: 0.5, tone });
    // 2026-10-21 rebuild: occupied scenes use editPrompt's toneSentence (never theatrical).
    assert.match(text, /Amount of movement:/);
    seen.add(toneSentence(tone));
    assert.ok(text.includes(toneSentence(tone)));
    assert.doesNotMatch(text, /energetic|dramatic|clearly different/);
  }
  assert.equal(seen.size, 4);
});

test('no tone given -> no tone sentence (old behaviour)', () => {
  assert.doesNotMatch(composeEditInstruction({ predictionPrompt: 'x', presence: 0.5 }), /Amount of (?:change|movement):/);
  assert.doesNotMatch(composeEditInstruction({ predictionPrompt: 'x', presence: 0 }), /Amount of change:/);
});

test('empty room: every tone preserves lighting and has no person words', () => {
  for (const tone of [0, 0.3, 0.6, 1]) {
    const text = composeEditInstruction({ predictionPrompt: 'The light on the curtain dims slightly.', presence: 0, tone });
    assert.ok(text.includes(toneImageRule(tone, true)));
    assert.doesNotMatch(text, /Change only the lighting|brightness jumps|becomes warmer|brighter or dimmer/);
  }
  for (const t of TONE_IMAGE_RULES_EMPTY) assert.doesNotMatch(t, /\b(person|people|figure|silhouette|hands?|arms?|nobody|no one|man|woman)\b/i);
});

test('people tone sentences avoid big arm gestures (G-11)', () => {
  for (const t of TONE_IMAGE_RULES) assert.doesNotMatch(t, /both arms|both hands|stretch|wav|raised/i);
});

test('G-01: high presence never switches to the "new person may enter" rule', () => {
  const high = composeEditInstruction({ predictionPrompt: 'He stands up.', presence: 1, tone: 1 });
  assert.match(high, /Exactly one person is in the image/);
  assert.doesNotMatch(high, /A new person may appear only if/);
});
