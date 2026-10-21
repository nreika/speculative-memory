import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { classifyOrientation, selectRefFrames, resizeToMaxPx, saveRefFrame, resetRefFrames, refFramesEnabled, refFramesMax, refFramesMaxPx } from './refFrames';
import { imageSize } from '../generation/referenceCrop';
import { composeEditInstruction, REFERENCE_FRAMES_SENTENCE } from '../generation/orchestrator';
import type { SceneHistoryEntry } from './sceneHistory';

const now = Date.parse('2026-10-16T12:00:00');
const entry = (minAgo: number, id: string, extra: Partial<SceneHistoryEntry> = {}): SceneHistoryEntry => ({
  time: new Date(now - minAgo * 60_000).toISOString(), captureId: id, sceneDescription: 'Someone sits.', observation: 'Someone sits.',
  hasPerson: true, refFrameFile: `d/${id}.jpg`, ...extra,
});

// minimal valid RGB PNG
function png(w: number, h: number): Buffer {
  const crc = (b: Buffer) => {
    let r = ~0;
    for (const x of b) {
      let c = (r ^ x) & 255;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      r = (r >>> 8) ^ c;
    }
    return ~r >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const tb = Buffer.concat([Buffer.from(t), d]);
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(tb));
    return Buffer.concat([len, tb, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 128);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const person = (position: string, facing: string) => [{ position, pose: '', clothes: '', facing }];

test('orientation: people facing/position first, text keywords second', () => {
  assert.equal(classifyOrientation({ people: person('left front', 'away') }).label, 'away@left');
  assert.equal(classifyOrientation({ people: person('right', 'camera') }).label, 'front@right');
  assert.equal(classifyOrientation({ people: person('center', 'left') }).facing, 'left');
  assert.equal(classifyOrientation({ sceneDescription: 'Two people stand at desks, facing away from the camera.' }).facing, 'away');
  assert.equal(classifyOrientation({ sceneDescription: 'A woman looking at the camera.' }).facing, 'front');
  assert.equal(classifyOrientation({ sceneDescription: 'A man in profile, turned left.' }).facing, 'left');
  assert.equal(classifyOrientation({ sceneDescription: 'A person sits.' }).label, 'unknown');
});

test('selection: other orientation first, excludes self / no-person / out of window / no file', () => {
  const cur = { captureId: 'now', orientation: classifyOrientation({ people: person('left', 'away') }) };
  const entries = [
    entry(2, 'a', { people: person('left', 'away') }),
    entry(4, 'b', { people: person('right', 'camera') }),
    entry(6, 'c', { people: person('left', 'right') }),
    entry(1, 'now'),
    entry(3, 'x', { hasPerson: false }),
    entry(30, 'old'),
    entry(5, 'nofile', { refFrameFile: undefined }),
  ];
  const sel = selectRefFrames(entries, cur, { max: 2, windowMin: 10, now });
  assert.deepEqual(sel.map((s) => s.captureId), ['b', 'c']);
  assert.match(sel[0].reason, /differs from now/);
  assert.equal(sel[0].orientation, 'front@right');
  assert.equal(selectRefFrames(entries, cur, { max: 1, windowMin: 10, now }).length, 1);
  assert.equal(selectRefFrames([entry(1, 'now')], cur, { max: 2, windowMin: 10, now }).length, 0);
});

test('selection: same orientation falls back to the older frame; one candidate gives one frame', () => {
  const o = classifyOrientation({ people: person('left', 'away') });
  const same = (m: number, id: string) => entry(m, id, { people: person('left', 'away') });
  assert.deepEqual(selectRefFrames([same(2, 'new'), same(8, 'old')], { captureId: 'n', orientation: o }, { max: 1, windowMin: 10, now }).map((s) => s.captureId), ['old']);
  assert.equal(selectRefFrames([same(2, 'only')], { captureId: 'n', orientation: o }, { max: 2, windowMin: 10, now }).length, 1);
});

test('env defaults', () => {
  assert.equal(refFramesEnabled({}), false);
  assert.equal(refFramesEnabled({ REF_FRAMES_ENABLED: 'true' }), true);
  assert.equal(refFramesMax({}), 2);
  assert.equal(refFramesMax({ REF_FRAMES_MAX: '9' }), 2);
  assert.equal(refFramesMaxPx({}), 768);
});

test('resize: small image untouched, large image shrunk to the long side', { skip: process.platform !== 'win32' }, async () => {
  const small = png(100, 50);
  assert.equal(await resizeToMaxPx(small, 768), small);
  const out = await resizeToMaxPx(png(400, 200), 100);
  const s = imageSize(out)!;
  assert.deepEqual([s.width, s.height], [100, 50]);
});

test('save + reset: frame is stored under the date and reset moves it into _archive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-'));
  const rel = await saveRefFrame(png(40, 20), 'td-1/x', '2026-10-16T12:00:00', { dir, maxPx: 768 });
  assert.equal(rel, '2026-10-16/td-1_x.jpg');
  assert.ok(fs.existsSync(path.join(dir, rel!)));
  const dest = resetRefFrames(dir, new Date('2026-10-16T03:00:00Z'))!;
  assert.match(dest, /_archive[\\/]2026-10-16-12-00-00_JST$/);
  assert.ok(fs.existsSync(path.join(dest, '2026-10-16', 'td-1_x.jpg')));
  assert.deepEqual(fs.readdirSync(dir), ['_archive']);
  assert.equal(resetRefFrames(dir), null);
});

test('prompt: the same-person sentence appears only with reference frames', () => {
  const a = composeEditInstruction({ predictionPrompt: 'A person types.', presence: 0.7, referenceFrames: true });
  const b = composeEditInstruction({ predictionPrompt: 'A person types.', presence: 0.7 });
  void REFERENCE_FRAMES_SENTENCE;
  assert.match(a, /image2 shows the same people at another moment, only for their face and hair/);
  assert.ok(!/image2|image3/.test(b));
});
