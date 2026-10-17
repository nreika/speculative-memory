import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EDITABLE_PATHS,
  buildV1,
  ensureRulebookFiles,
  getRulebook,
  guardRetries,
  loadRulebook,
  negativePrompt,
  qualitySuffix,
  readActive,
  setActive,
  timeBudgetMs,
  validateRulebook,
  withVlmExtras,
  writeRulebook,
} from './rulebook';
import { composeEditInstruction } from './orchestrator';
import { buildNegativePrompt, buildQualitySuffix, DEFAULT_NEGATIVE_PROMPT, QUALITY_SUFFIX } from './comfyClient';
import { inventedObjects } from './objectGuard';
import { sanitizeEmptyRoomPrediction } from './scenarioGuard';

function withDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rulebook-'));
  const prev = process.env.RULEBOOK_DIR;
  process.env.RULEBOOK_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.RULEBOOK_DIR;
    else process.env.RULEBOOK_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('rulebook v1: the repository file equals the built-in wording and is valid', () => {
  const file = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'rulebook', 'rulebook.v1.json'), 'utf8'));
  assert.deepEqual(validateRulebook(file), []);
  assert.deepEqual(file, buildV1());
  assert.equal(file.parent, null);
});

test('v1 reproduces the pre-rulebook empty-room prompt word for word', () => {
  withDir((dir) => {
    ensureRulebookFiles(dir);
    const got = composeEditInstruction({ predictionPrompt: 'The light on the desk shifts slightly.', presence: 0 });
    const expected =
      'Edit this exact photo according to: The light on the desk shifts slightly. ' +
      'Change only the lighting and small in-place details of the objects named. Everything else - the room, walls, floor, ceiling, background, furniture, camera, lighting, the number of monitors and what each monitor displays - stays pixel-identical to the input. ' +
      'Keep every object, the furniture, the camera and the framing identical to the input. ' +
      'Preserve the empty floor and the empty chairs exactly as they are. ' +
      'Do not add any object that is not in the photo; every object stays exactly where it is. ' +
      'Keep the number of monitors, screens and furniture, and what each screen displays, identical.' +
      '\n\n' +
      'Near-camera foreground objects keep their real-world scale, outline, position and texture exactly as in the input (e.g. the dark mesh in the foreground is the backrest of an ordinary office chair very close to the camera); do not enlarge, bend, inflate or turn them into a wall, sail or sculpture.' +
      '\n\n' +
      'Objects rest on surfaces in physically plausible positions (laptops and cups on desks, bags on the floor or a chair seat); nothing hangs on a chair back or floats in the air; gravity and support stay realistic.' +
      '\n\nSharp, crisp, high-detail photo, in focus edge to edge. Do not add any new object; every object appears exactly once.';
    assert.equal(got, expected);
  });
});

test('v1 negative prompt and quality suffix are the old constants', () => {
  assert.equal(buildNegativePrompt(false), DEFAULT_NEGATIVE_PROMPT);
  assert.equal(buildNegativePrompt(true), `${DEFAULT_NEGATIVE_PROMPT}, single-digit clock number, missing leading zero, garbled digits, distorted numbers`);
  assert.equal(buildQualitySuffix(false, false, false), QUALITY_SUFFIX);
  assert.match(buildQualitySuffix(false, true, true), /a new person may appear only if the instruction says someone enters/);
  assert.match(buildQualitySuffix(false, true, true), /Do not zoom, shift or re-compose the view\.$/);
});

test('occupied template carries the rulebook sentences (physics, hair, disembodied parts) in the old order', () => {
  withDir((dir) => {
    ensureRulebookFiles(dir);
    const text = composeEditInstruction({ predictionPrompt: 'A person turns their head.', presence: 0.8, distanceSec: 30 });
    const i = (s: string) => text.indexOf(s);
    assert.ok(i('Near-camera foreground objects') > 0);
    assert.ok(i('Objects rest on surfaces') > i('Near-camera foreground objects'));
    assert.ok(i("Keep each person's hairstyle") > i('Objects rest on surfaces'));
    assert.ok(i('Do not add disembodied body parts') > i("Keep each person's hairstyle"));
    assert.ok(i('Sharp, crisp, high-detail photo') > i('Do not add disembodied body parts'));
  });
});

test('a new version is used on the next call without a restart; rollback switches back', () => {
  withDir((dir) => {
    ensureRulebookFiles(dir);
    assert.equal(getRulebook().version, 1);
    const v2 = buildV1();
    v2.version = 2;
    v2.parent = 1;
    v2.negative.added = ['added objects'];
    v2.imagePrompt.extraConstraints = ['Every object has visible support.'];
    v2.vlm.extraInstructions = ['Name only visible objects.'];
    writeRulebook(v2, dir);
    setActive(2, { by: 'test' }, dir);
    assert.equal(getRulebook().version, 2);
    assert.match(buildNegativePrompt(false), /, added objects$/);
    const empty = composeEditInstruction({ predictionPrompt: 'The light dims.', presence: 0 });
    assert.ok(empty.includes('nothing hangs on a chair back or floats in the air; gravity and support stay realistic. Every object has visible support.'));
    const occupied = composeEditInstruction({ predictionPrompt: 'A person sits.', presence: 0.8, distanceSec: 30 });
    assert.ok(occupied.includes('Every object has visible support.'));
    assert.match(withVlmExtras('x\nReturn ONLY a JSON object of the form {}'), /x\nName only visible objects\.\nReturn ONLY a JSON object/);
    setActive(1, { by: 'test' }, dir);
    assert.equal(getRulebook().version, 1);
    assert.equal(buildNegativePrompt(false), DEFAULT_NEGATIVE_PROMPT);
    assert.equal(readActive(dir)?.version, 1);
  });
});

test('guard vocabulary from the rulebook: extra object groups and empty-room banned words', () => {
  withDir((dir) => {
    ensureRulebookFiles(dir);
    assert.deepEqual(inventedObjects('A tote slides off.', 'An office with a desk.'), []);
    const v2 = buildV1();
    v2.version = 2;
    v2.parent = 1;
    v2.guard.extraObjectGroups = [['tote', 'totes']];
    v2.guard.extraEmptyRoomBannedWords = ['sticker'];
    writeRulebook(v2, dir);
    setActive(2, {}, dir);
    assert.deepEqual(inventedObjects('A tote slides off.', 'An office with a desk.'), ['tote']);
    assert.equal(sanitizeEmptyRoomPrediction('A sticker peels; the light dims'), 'the light dims');
  });
});

test('guard numbers: rulebook value, environment overrides it', () => {
  const rb = buildV1();
  const keep = { r: process.env.VLM_GUARD_RETRIES, b: process.env.VLM_TIME_BUDGET_MS };
  delete process.env.VLM_GUARD_RETRIES;
  delete process.env.VLM_TIME_BUDGET_MS;
  assert.equal(guardRetries(rb), 3);
  assert.equal(timeBudgetMs(rb), 25000);
  process.env.VLM_GUARD_RETRIES = '1';
  process.env.VLM_TIME_BUDGET_MS = '5000';
  assert.equal(guardRetries(rb), 1);
  assert.equal(timeBudgetMs(rb), 5000);
  if (keep.r === undefined) delete process.env.VLM_GUARD_RETRIES;
  else process.env.VLM_GUARD_RETRIES = keep.r;
  if (keep.b === undefined) delete process.env.VLM_TIME_BUDGET_MS;
  else process.env.VLM_TIME_BUDGET_MS = keep.b;
});

test('invalid rulebook files are ignored (falls back to v1) and the editable paths are additive lists only', () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, 'rulebook.v3.json'), '{"version":3}');
    fs.writeFileSync(path.join(dir, 'active.json'), JSON.stringify({ version: 3, appliedAt: 'x' }));
    assert.equal(loadRulebook(3, dir), null);
    assert.equal(getRulebook().version, 1);
  });
  for (const p of Object.keys(EDITABLE_PATHS)) assert.ok(!/hairRule|behindView|onePerson|emptyRoom\.|foreground|disembodied|physicsRule/.test(p), p);
  const hair = negativePrompt(false, false, { hair: 'long brown hair' }, buildV1());
  assert.match(hair, /short hair, bob haircut, cropped hair$/);
  assert.equal(qualitySuffix(true, false, false, buildV1()).endsWith('same size and position as the input.'), true);
});

test('G-14 / G-15 sentences appear in the occupied template only when the active version has them; QA classes exist', () => {
  withDir((dir) => {
    ensureRulebookFiles(dir);
    const base = composeEditInstruction({ predictionPrompt: 'A person sits.', presence: 0.8, distanceSec: 30 });
    assert.ok(!base.includes('Items a person holds'));
    const v2 = buildV1();
    v2.version = 2;
    v2.parent = 1;
    v2.imagePrompt.holdingsRule = 'Items a person holds stay.';
    v2.imagePrompt.noNewFaceRule = 'No new face.';
    writeRulebook(v2, dir);
    setActive(2, {}, dir);
    const t = composeEditInstruction({ predictionPrompt: 'A person sits.', presence: 0.8, distanceSec: 30 });
    assert.ok(t.includes("hair colour exactly as in the input (and the reference image).\n\nItems a person holds stay.\n\nNo new face.\n\nDo not add disembodied"));
    assert.ok(!composeEditInstruction({ predictionPrompt: 'The light dims.', presence: 0 }).includes('No new face.'));
  });
});

test('G-16 / obstructed supplement: sentences in both templates, obstruction only when flagged, negative terms only without a clock edit', () => {
  withDir((dir) => {
    ensureRulebookFiles(dir);
    const v2 = buildV1();
    v2.version = 2;
    v2.parent = 1;
    v2.imagePrompt.noNewTextRule = 'No new text.';
    v2.imagePrompt.obstructedRule = 'Keep the obstruction.';
    v2.negative.noNewText = 'clock, digits, text on screen';
    writeRulebook(v2, dir);
    setActive(2, {}, dir);
    for (const presence of [0, 0.8]) {
      const t = composeEditInstruction({ predictionPrompt: 'The light dims.', presence, distanceSec: 30 });
      assert.ok(t.includes('No new text.'), `presence ${presence}`);
      assert.ok(!t.includes('Keep the obstruction.'));
      assert.ok(composeEditInstruction({ predictionPrompt: 'The light dims.', presence, distanceSec: 30, obstructed: true }).includes('Keep the obstruction.'));
    }
    assert.match(buildNegativePrompt(false), /, clock, digits, text on screen$/);
    assert.doesNotMatch(buildNegativePrompt(true), /text on screen/);
    assert.ok(!composeEditInstruction({ predictionPrompt: 'The light dims.', presence: 0 }).includes('person'));
  });
});

test('G-07 supplement 2: obstructed-only negative terms', () => {
  const rb = buildV1();
  rb.negative.obstructed = 'sharp monitor in front of the mesh';
  assert.match(negativePrompt(false, false, false, rb, true), /, sharp monitor in front of the mesh$/);
  assert.doesNotMatch(negativePrompt(false, false, false, rb, false), /sharp monitor/);
  assert.doesNotMatch(buildNegativePrompt(false, false, false, false), /in front of the mesh/);
});

test('G-07 supplement 3: obstruction lead sentence is first, obstructed only, names the obstruction', () => {
  withDir((dir) => {
    ensureRulebookFiles(dir);
    const v2 = buildV1();
    v2.version = 2;
    v2.parent = 1;
    v2.imagePrompt.obstructedLeadRule = 'The {by} is the frontmost layer; seen through {through} stays dim, hidden by {pattern}.';
    writeRulebook(v2, dir);
    setActive(2, {}, dir);
    for (const presence of [0, 0.8]) {
      const mesh = composeEditInstruction({ predictionPrompt: 'The light dims.', presence, distanceSec: 30, obstructed: true, obstructedBy: 'mesh chair backrest' });
      assert.ok(mesh.startsWith('The mesh chair backrest is the frontmost layer; seen through the mesh stays dim, hidden by the mesh pattern.\n\n'), `presence ${presence}`);
      const other = composeEditInstruction({ predictionPrompt: 'The light dims.', presence, distanceSec: 30, obstructed: true, obstructedBy: 'curtain' });
      assert.ok(other.startsWith('The curtain is the frontmost layer; seen through it stays dim, hidden by its pattern.'));
      const unknown = composeEditInstruction({ predictionPrompt: 'The light dims.', presence, distanceSec: 30, obstructed: true });
      assert.ok(unknown.startsWith('The near-camera obstruction is the frontmost layer'));
      assert.ok(!composeEditInstruction({ predictionPrompt: 'The light dims.', presence, distanceSec: 30 }).includes('frontmost layer'));
    }
  });
});

test('obstructed denoise: default 0.6, env override, off for 1 / invalid', async () => {
  const { obstructedDenoise } = await import('./orchestrator');
  assert.equal(obstructedDenoise({}), 0.6);
  assert.equal(obstructedDenoise({ COMFYUI_OBSTRUCTED_DENOISE: '0.5' }), 0.5);
  assert.equal(obstructedDenoise({ COMFYUI_OBSTRUCTED_DENOISE: '1' }), null);
  assert.equal(obstructedDenoise({ COMFYUI_OBSTRUCTED_DENOISE: 'x' }), null);
});
