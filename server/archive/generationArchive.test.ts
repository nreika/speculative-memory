import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { temporalLabels, GenerationArchive, generationIdFromFilename, archiveRootDir, DEFAULT_ARCHIVE_DIR } from './generationArchive';
import { crc32, readPngText } from './pngMetadata';

function tinyPng() {
  const c = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    c('IHDR', ihdr),
    c('IDAT', zlib.deflateSync(Buffer.from([0, 1, 2, 3]))),
    c('IEND', Buffer.alloc(0)),
  ]);
}

const baseCtx = {
  generationId: '2026-10-15_06-08-12',
  captureId: 'cap1',
  source: 'td-native',
  capturedAt: '2026-10-15T06:08:12+09:00',
  backend: 'local',
  vlmModel: 'm',
  imageModel: 'qwen',
  params: { sceneDistancesSec: [30, -30], presence: 0.3, tone: 0.3, imageCount: 2 },
};

test('generation id parsing and root dir', () => {
  assert.equal(generationIdFromFilename('record_2026-10-15_06-08-12.jpg'), '2026-10-15_06-08-12');
  assert.equal(generationIdFromFilename('nothing.jpg'), null);
  assert.equal(archiveRootDir({}), DEFAULT_ARCHIVE_DIR);
  assert.equal(archiveRootDir({ GENERATION_ARCHIVE_DIR: 'X:\\a' }), 'X:\\a');
});

test('archive writes the folder layout, prompts.json, README and PNG metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genarch-'));
  const id = baseCtx.generationId;
  const a = new GenerationArchive(baseCtx, root);
  a.saveSource(Buffer.from('jpg'), 'jpg');
  a.setVlm({ promptFull: 'P', rawResponse: '{}', parsedScenarios: [] });
  a.addScene(
    0,
    {
      sceneKey: 'gen_a',
      distanceSec: 30,
      label: 'x',
      predictionPrompt: '立つ',
      scenarioDescription: '30秒後、立つ',
      imagePromptFull: 'stand',
      negativePrompt: 'neg',
      seed: 7,
      elapsedMs: 5,
    },
    tinyPng(),
    'png'
  );
  a.finish('completed');
  const dir = path.join(root, '2026-10-15', id);
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${id}_A.png`, `${id}_A_prompt.txt`, `${id}_NOW.jpg`, `${id}_README.txt`, `${id}_prompts.json`, `${id}_vlm.txt`]);
  const meta = readPngText(fs.readFileSync(path.join(dir, `${id}_A.png`)));
  assert.equal(meta.Scene, 'A');
  assert.equal(meta.ImagePrompt, 'stand');
  assert.equal(meta.PredictionPrompt, '立つ');
  assert.equal(meta.TemporalOffset, '+30s');
  assert.equal(meta.TemporalLabelJa, '30秒先の未来');
  assert.equal(meta.TemporalLabelEn, '30 seconds into the future');
  assert.match(fs.readFileSync(path.join(dir, `${id}_A_prompt.txt`), 'utf8'), /30秒先の未来[\s\S]*stand[\s\S]*neg/);
  const json = JSON.parse(fs.readFileSync(path.join(dir, `${id}_prompts.json`), 'utf8'));
  assert.equal(json.scenes[0].letter, 'A');
  assert.equal(json.status, 'completed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unusable root never throws', () => {
  const blocker = path.join(os.tmpdir(), `genarch-file-${Date.now()}`);
  fs.writeFileSync(blocker, 'x');
  const a = new GenerationArchive(baseCtx, path.join(blocker, 'sub'));
  a.saveSource(Buffer.from('x'), 'jpg');
  a.fail(new Error('boom'));
  fs.rmSync(blocker, { force: true });
});

test('temporal labels', () => {
  assert.deepEqual(temporalLabels(150), { temporalOffset: '+150s', temporalLabelJa: '2分30秒先の未来', temporalLabelEn: '2 minutes 30 seconds into the future' });
  assert.equal(temporalLabels(-30).temporalLabelJa, '30秒前の過去');
  assert.equal(temporalLabels(-60).temporalLabelEn, '1 minute into the past');
  assert.equal(temporalLabels(0).temporalLabelJa, '現在');
});
