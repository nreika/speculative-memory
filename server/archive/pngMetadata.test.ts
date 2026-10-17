import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { crc32, embedPngText, readPngText } from './pngMetadata';

function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function tinyPng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('crc32 matches the known check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('embedded text is read back, Latin-1 as tEXt and Japanese as iTXt', () => {
  const png = tinyPng();
  const out = embedPngText(png, {
    GenerationId: '2026-10-15_12-34-56',
    Scene: 'A',
    DistanceSec: 30,
    ImagePrompt: 'The person stands up.\nSecond line.',
    PredictionPrompt: '30秒後、立ち上がる',
    Empty: '',
  });
  assert.ok(out.length > png.length);
  assert.ok(out.includes(Buffer.from('tEXtGenerationId')));
  const meta = readPngText(out);
  assert.equal(meta.GenerationId, '2026-10-15_12-34-56');
  assert.equal(meta.Scene, 'A');
  assert.equal(meta.DistanceSec, '30');
  assert.equal(meta.ImagePrompt, 'The person stands up.\nSecond line.');
  assert.equal(meta.PredictionPrompt, '30秒後、立ち上がる');
  assert.equal('Empty' in meta, false);
  // Image data is untouched and still a valid chunk sequence.
  assert.ok(out.subarray(out.length - 12).equals(png.subarray(png.length - 12)));
});

test('rejects non-PNG input', () => {
  assert.throws(() => embedPngText(Buffer.from('nope'), { A: 'b' }));
});
