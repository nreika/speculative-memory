import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodePng, gridScore } from './gridDetect';
import { normalizeDefectType } from './localJudge';

function crc(buf: Buffer): number {
  return zlib.crc32(buf) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
/** Skin-coloured RGB PNG whose luma gets +-amp on a 2 px checker (grid) or a slow ramp (smooth). */
function skinPng(w: number, h: number, amp: number, mode: 'grid' | 'smooth'): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const d = mode === 'grid' ? ((x + y) % 2 ? amp : -amp) : Math.round(30 * Math.sin(x / 6) + 25 * Math.sin(y / 8));
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 200 + d;
      raw[o + 1] = 150 + d;
      raw[o + 2] = 120 + d;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('png decode round trip', () => {
  const px = decodePng(skinPng(40, 8, 5, 'smooth'))!;
  assert.equal(px.width, 40);
  assert.equal(px.data[0], 200);
  assert.equal(decodePng(Buffer.from('nope')), null);
});

test('a 2 px grid on skin is suspected, a smooth skin patch is not, too few skin tiles give no verdict', () => {
  const grid = gridScore(skinPng(128, 128, 12, 'grid'))!;
  assert.ok(grid.tiles >= 3);
  assert.equal(grid.suspected, true);
  const smooth = gridScore(skinPng(128, 128, 0, 'smooth'))!;
  assert.equal(smooth.suspected, false);
  assert.ok((smooth.score ?? -9) < (grid.score ?? 9));
  const tiny = gridScore(skinPng(64, 32, 12, 'grid'))!;
  assert.equal(tiny.score, null);
  assert.equal(tiny.suspected, false);
  // face rectangle: stricter threshold
  const face = gridScore(skinPng(128, 128, 12, 'grid'), { x: 0, y: 0, width: 96, height: 96 })!;
  assert.equal(face.suspected, true);
});

test('new classes map from free text', () => {
  assert.equal(normalizeDefectType('skin grid noise'), 'grid');
  assert.equal(normalizeDefectType('hair length changed'), 'hair_mismatch');
  assert.equal(normalizeDefectType('arms raised overhead'), 'arms_raised');
});
