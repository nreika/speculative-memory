import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildV1, framingAnchor, qualitySuffix, setActive, withFramingAnchor, writeRulebook } from './rulebook';
import { FRAMING_ANCHOR_RULE, LONG_SPAN_QUALITY_SUFFIX } from './ruleTexts';
import { composeEditInstruction } from './orchestrator';

test('framing anchor: the next version adds the sentence and merges the long-span camera sentences', () => {
  const v1 = buildV1();
  const next = withFramingAnchor(v1, 2, new Date('2026-10-20T00:00:00Z'));
  assert.equal(next.parent, 1);
  assert.equal(next.imagePrompt.framingAnchorRule, FRAMING_ANCHOR_RULE);
  assert.equal(framingAnchor(v1), '', 'older versions have no anchor');
  assert.equal(framingAnchor(next), FRAMING_ANCHOR_RULE + '\n\n');
  assert.equal(v1.quality.longSpan, LONG_SPAN_QUALITY_SUFFIX);
  assert.doesNotMatch(qualitySuffix(false, false, true, next), /zoom|re-compose|camera position/i);
  assert.match(qualitySuffix(false, false, true, next), /only the person's pose and position change/);
});

test('framing anchor: every template carries it once, after the obstruction lead (which stays first)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rulebook-anchor-'));
  const prev = process.env.RULEBOOK_DIR;
  process.env.RULEBOOK_DIR = dir;
  try {
    const base = { ...buildV1(), imagePrompt: { ...buildV1().imagePrompt, obstructedLeadRule: 'The {by} is the frontmost layer; {through} {pattern}.' } };
    writeRulebook(base, dir);
    writeRulebook(withFramingAnchor(base, 2), dir);
    setActive(2, {}, dir);
    const people = [{ position: 'center', clothes: 'grey shirt', hair: 'short black hair' }] as any;
    const cases = {
      full: composeEditInstruction({ predictionPrompt: 'She looks up.', presence: 0.5, tone: 0.3, distanceSec: 300 }),
      empty: composeEditInstruction({ predictionPrompt: 'The light dims.', presence: 0, tone: 0.3 }),
      compact: composeEditInstruction({ predictionPrompt: 'She looks up.', presence: 0.5, tone: 0.3, people, personCount: 1, compactPeople: true }),
      obstructed: composeEditInstruction({ predictionPrompt: 'She looks up.', presence: 0.5, obstructed: true, obstructedBy: 'mesh chair backrest' }),
    };
    for (const [name, text] of Object.entries(cases)) {
      assert.equal(text.split(FRAMING_ANCHOR_RULE).length - 1, 1, `${name}: exactly one anchor sentence`);
      assert.doesNotMatch(text, /Do not zoom, shift or re-compose the view/, `${name}: no duplicate camera sentence`);
    }
    assert.ok(cases.full.startsWith(FRAMING_ANCHOR_RULE));
    assert.ok(cases.obstructed.startsWith('The mesh chair backrest is the frontmost layer'), 'obstruction lead stays first');
    assert.ok(cases.obstructed.indexOf(FRAMING_ANCHOR_RULE) > cases.obstructed.indexOf('frontmost layer'));
  } finally {
    if (prev === undefined) delete process.env.RULEBOOK_DIR;
    else process.env.RULEBOOK_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
