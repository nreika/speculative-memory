import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { backendLabel, defaultBackends, resolveBackends, GEMINI_IMAGE_MODEL, GEMINI_VLM_MODEL } from './backends';
import { composeGeminiInstruction, generateImage, predictScenarios, setGeminiModuleForTests } from './orchestrator';
import { GenerationArchive } from '../archive/generationArchive';
import { crc32, readPngText } from '../archive/pngMetadata';

const KEY = { GEMINI_API_KEY: 'test-key-not-real' } as NodeJS.ProcessEnv;

test('defaults derive from GENERATION_BACKEND', () => {
  assert.deepEqual(defaultBackends('local'), { vlm: 'local', image: 'local' });
  assert.deepEqual(defaultBackends('hybrid'), { vlm: 'gemini', image: 'local' });
  assert.deepEqual(defaultBackends('gemini'), { vlm: 'gemini', image: 'gemini' });
  assert.deepEqual(defaultBackends(undefined), { vlm: 'local', image: 'local' });
});

test('request values override; invalid or missing fall back to the default', () => {
  const r = resolveBackends({ vlmBackend: 'gemini', imageBackend: 'local' }, 'local', KEY);
  assert.deepEqual([r.vlm, r.image], ['gemini', 'local']);
  const bad = resolveBackends({ vlmBackend: 'GPT', imageBackend: 42 }, 'hybrid', KEY);
  assert.deepEqual([bad.vlm, bad.image], ['gemini', 'local']);
  const none = resolveBackends(undefined, 'local', KEY);
  assert.deepEqual([none.vlm, none.image], ['local', 'local']);
  assert.equal(resolveBackends({ vlmBackend: ' Gemini ' }, 'local', KEY).vlm, 'gemini');
});

test('gemini requested without an API key falls back to local and says so', () => {
  const r = resolveBackends({ vlmBackend: 'gemini', imageBackend: 'gemini' }, 'local', {} as NodeJS.ProcessEnv);
  assert.deepEqual([r.vlm, r.image, r.fellBack], ['local', 'local', ['vlm', 'image']]);
  assert.equal(backendLabel({ vlm: 'gemini', image: 'local' }), 'hybrid');
  assert.equal(backendLabel({ vlm: 'local', image: 'local' }), 'local');
});

const scenarioJson = JSON.stringify({
  clock_visible: false,
  scene_description: 'An empty desk with a chair.',
  scenarios: [
    { prediction_prompt: 'The chair rotates slightly.', scenario_description: '30 seconds later, the chair turns.', label: 'A' },
    { prediction_prompt: 'The monitor dims.', scenario_description: '30 seconds later, the monitor dims.', label: 'B' },
    { prediction_prompt: 'The lamp brightens.', scenario_description: '30 seconds before, the lamp is dim.', label: 'C' },
  ],
});

test('vlmBackend=gemini routes planning through the injected Gemini module (no real call)', async () => {
  const calls: string[] = [];
  setGeminiModuleForTests({
    planWithGemini: async (prompt: string) => {
      calls.push('plan');
      assert.match(prompt, /scene_description/);
      return scenarioJson;
    },
    generateGeminiText: async () => {
      calls.push('text');
      return JSON.stringify({ scene: '机と椅子', items: ['30秒後、椅子が回る。', '30秒後、モニターが暗くなる。', '30秒前、ランプは暗い。'] });
    },
    generateImageFromInstruction: async () => 'data:image/png;base64,AAAA',
  } as any);
  // Ollama must not be touched on the gemini path.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('Ollama must not be called on the gemini path');
  }) as any;
  try {
    const trace: any = {};
    const out = await predictScenarios({
      imageDataUrl: 'data:image/jpeg;base64,AAAA',
      target: null,
      scenarioCount: 3,
      vlmBackend: 'gemini',
      trace,
      detector: { person: false, count: 0, elapsedMs: 1 },
      people: [],
      sceneDistances: [30, 30, -30],
    });
    assert.equal(out.length, 3);
    assert.deepEqual(calls, ['plan', 'text']);
    assert.equal(trace.model, GEMINI_VLM_MODEL);
    assert.match(out[0].scenario_description, /30秒後/);
    assert.ok(trace.guard, 'guard record exists on the gemini path as well');
  } finally {
    globalThis.fetch = realFetch;
    setGeminiModuleForTests(null);
  }
});

test('imageBackend=gemini: empty-room template + negatives folded in; reference attached only with a person', async () => {
  const seen: any[] = [];
  setGeminiModuleForTests({
    generateImageFromInstruction: async (_src: string, instruction: string, ref?: string) => {
      seen.push({ instruction, ref });
      return 'data:image/png;base64,BBBB';
    },
  } as any);
  try {
    const t1: any = {};
    const img = await generateImage({
      originalImageDataUrl: 'data:image/jpeg;base64,AAAA',
      predictionPrompt: 'The chair rotates.',
      presence: 0,
      imageBackend: 'gemini',
      trace: t1,
      clock: { direction: 'future', distanceSec: 30, visible: false },
    });
    assert.equal(img, 'data:image/png;base64,BBBB');
    assert.equal(seen[0].ref, undefined);
    assert.match(seen[0].instruction, /pixel-identical/);
    assert.match(seen[0].instruction, /real-world scale/);
    assert.match(seen[0].instruction, /must be free of:/);
    assert.equal(t1.referenceImage, 'none');
    assert.equal(t1.seed, null);

    const t2: any = {};
    await generateImage({
      originalImageDataUrl: 'data:image/jpeg;base64,AAAA',
      predictionPrompt: 'The person waves.',
      presence: 0.3,
      faceImageDataUrl: 'data:image/jpeg;base64,CCCC',
      referencePerson: true,
      imageBackend: 'gemini',
      trace: t2,
    });
    assert.equal(seen[1].ref, 'data:image/jpeg;base64,CCCC');
    assert.equal(t2.referenceImage, 'attached');
    assert.match(seen[1].instruction, /second reference image/);
  } finally {
    setGeminiModuleForTests(null);
  }
  assert.equal(composeGeminiInstruction('X', ''), 'X');
  assert.equal(GEMINI_IMAGE_MODEL, 'gemini-2.5-flash-image');
});

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

test('archive embeds VlmBackend / ImageBackend in prompts.json, README and PNG tEXt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-be-'));
  try {
    const a = new GenerationArchive(
      {
        generationId: '2026-10-16_10-00-00',
        captureId: 'cap',
        source: 'td-native',
        capturedAt: '2026-10-16T10:00:00+09:00',
        backend: 'hybrid',
        vlmBackend: 'gemini',
        vlmModel: GEMINI_VLM_MODEL,
        imageBackend: 'local',
        imageModel: 'qwen-image-edit (x)',
        params: { sceneDistancesSec: [30], presence: 0.3, tone: 0.3, imageCount: 1 },
      },
      root
    );
    a.addScene(
      0,
      {
        sceneKey: 'gen_a', distanceSec: 30, label: 'A', predictionPrompt: 'p', scenarioDescription: 'd',
        imagePromptFull: 'i', negativePrompt: 'n', seed: 1, elapsedMs: 5,
        imageBackend: 'local', imageModel: 'qwen-image-edit (x)', referenceImage: 'none',
      },
      tinyPng(),
      'png'
    );
    a.finish('completed');
    const dir = path.join(root, '2026-10-16', '2026-10-16_10-00-00');
    const files = fs.readdirSync(dir);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, files.find((f) => f.endsWith('prompts.json'))!), 'utf8'));
    assert.equal(doc.vlmBackend, 'gemini');
    assert.equal(doc.imageBackend, 'local');
    assert.equal(doc.scenes[0].imageBackend, 'local');
    assert.equal(doc.scenes[0].referenceImage, 'none');
    const readme = fs.readFileSync(path.join(dir, files.find((f) => f.endsWith('README.txt'))!), 'utf8');
    assert.match(readme, /認識\(VLM\): gemini gemini-3-flash-preview/);
    const png = fs.readFileSync(path.join(dir, files.find((f) => /a\.png$/i.test(f))!));
    const text = readPngText(png) as Record<string, string>;
    assert.equal(text.VlmBackend, 'gemini');
    assert.equal(text.ImageBackend, 'local');
    assert.equal(text.VlmModel, GEMINI_VLM_MODEL);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
