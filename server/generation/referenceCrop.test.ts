import test from 'node:test';
import assert from 'node:assert/strict';
import { cropRectFor, imageSize, parsePosition } from './referenceCrop';
import { composeEditInstruction, behindViewSentence, BEHIND_VIEW_RULE, ONE_PERSON_RULE } from './orchestrator';
import { buildNegativePrompt, hairNegative } from './comfyClient';

test('position label -> crop rectangle (third of the frame + padding, multiples of 8)', () => {
  assert.deepEqual(parsePosition('left front'), { col: 0, row: 'front' });
  assert.deepEqual(parsePosition('center background'), { col: 1, row: 'back' });
  const left = cropRectFor('left front', 1920, 1080);
  assert.equal(left.x, 0);
  assert.ok(left.width > 640 && left.width < 900 && left.width % 8 === 0);
  assert.ok(left.y >= 300 && left.y + left.height <= 1080);
  const right = cropRectFor('right', 1920, 1080);
  assert.ok(right.x > 1100 && right.x + right.width <= 1920);
  assert.deepEqual(cropRectFor('somewhere', 1920, 1080), { x: 0, y: 0, width: 1920, height: 1080 });
});

test('image size from PNG and JPEG headers', () => {
  const png = Buffer.alloc(32); png[0] = 0x89; png[1] = 0x50; png.writeUInt32BE(640, 16); png.writeUInt32BE(360, 20);
  assert.deepEqual(imageSize(png), { width: 640, height: 360 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg), { width: 1280, height: 720 });
});

test('behind-view: sentence, insertion condition, negative prompt', () => {
  const s = behindViewSentence({ clothes: 'grey striped shirt', hair: 'short black hair' });
  assert.ok(s.startsWith(ONE_PERSON_RULE));
  assert.ok(s.includes(BEHIND_VIEW_RULE));
  assert.match(s, /Same clothes: grey striped shirt, same hair: short black hair \(keep the hair length exactly; never shorten or lengthen it\)\./);
  const withBehind = composeEditInstruction({ predictionPrompt: 'x', presence: 0.3, referencePerson: true, behindView: { clothes: 'grey striped shirt', hair: 'short black hair' } });
  assert.match(withBehind, /seen from behind with their back turned to the camera; the face is not visible\. Same clothes: grey striped shirt/);
  assert.doesNotMatch(composeEditInstruction({ predictionPrompt: 'x', presence: 0.3, referencePerson: true }), /from behind/);
  assert.match(buildNegativePrompt(false, false, true), /face visible, looking at camera, frontal face/);
  assert.doesNotMatch(buildNegativePrompt(false), /frontal face/);
});

import { HAIR_RULE } from './orchestrator';
test('G-13: hair rule is in the occupied template and the behind-view sentence; negative prompt names hair changes', () => {
  assert.match(HAIR_RULE, /hairstyle, hair length and hair colour exactly as in the input/);
  assert.ok(composeEditInstruction({ predictionPrompt: 'The man stands.', presence: 0.5 }).includes(HAIR_RULE));
  assert.ok(behindViewSentence({ clothes: 'teal shirt' }).includes(HAIR_RULE));
  assert.match(buildNegativePrompt(false), /hair color change, different hairstyle, changed hair length/);
});

test('behind-view sentence (with place, scale, hair) leads the whole image prompt', () => {
  const p = composeEditInstruction({ predictionPrompt: 'The person stands up.', presence: 0.3, referencePerson: true, behindView: { clothes: 'teal shirt', hair: 'long straight black hair with pink tips', position: 'right' } });
  assert.ok(p.startsWith(ONE_PERSON_RULE));
  assert.match(p.slice(0, 700), /same hair: long straight black hair with pink tips/);
  assert.match(p.slice(0, 700), /original place \(right/);
});

test('-89: one person only (sentence + negatives) and hair length (negative depends on the recorded hair)', () => {
  const s = behindViewSentence({ clothes: 'black shirt', hair: 'long light brown hair, below the shoulders', position: 'left front' });
  assert.match(s, /^Exactly one person appears in the whole image, and no second person or duplicate\./);
  assert.match(buildNegativePrompt(false, false, true), /two people, second person, duplicate person, extra person/);
  assert.equal(hairNegative('long light brown hair'), 'short hair, bob haircut, cropped hair');
  assert.equal(hairNegative('short black hair'), 'long hair');
  assert.equal(hairNegative('pink-tipped'), '');
  assert.match(buildNegativePrompt(false, false, { hair: 'long light brown hair' }), /short hair, bob haircut, cropped hair/);
  assert.doesNotMatch(buildNegativePrompt(false, false, { hair: 'short black hair' }), /bob haircut/);
});
