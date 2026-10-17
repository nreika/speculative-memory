import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  QaQueue,
  classifyEvidence,
  judgeImage,
  normalizeDefectType,
  parsePairAnswer,
  parseSingleAnswer,
  patchPromptsJson,
  summarizeQa,
  type QaRow,
} from './localJudge';

const TINY = 'data:image/png;base64,iVBORw0KGgo=';

test('normalizeDefectType maps free text onto the fixed classes', () => {
  assert.equal(normalizeDefectType('fabricated_object'), 'fabricated_object');
  assert.equal(normalizeDefectType('Floating'), 'floating');
  assert.equal(normalizeDefectType('extra person added'), 'fabricated_person');
  assert.equal(normalizeDefectType('object disappeared'), 'missing_object');
  assert.equal(normalizeDefectType('hand deformed'), 'anatomy');
  assert.equal(normalizeDefectType('???'), 'other');
});

test('parse pair / single answers: strings or objects, junk tolerated', () => {
  assert.deepEqual(parsePairAnswer('{"added":["beige jacket",{"object_type":"laptop","where":"left"}],"removed":[]}'), {
    added: ['beige jacket', 'laptop left'],
    removed: [],
  });
  assert.deepEqual(parsePairAnswer('noise {"added":[],"removed":["white paper bag"]} tail'), { added: [], removed: ['white paper bag'] });
  assert.equal(parsePairAnswer('not json'), null);
  assert.equal(parsePairAnswer('{"foo":1}'), null);
  assert.deepEqual(parseSingleAnswer('{"defects":[{"type":"floating","where":"desk","note":"laptop in the air"},{"type":"mismatch","where":"x","note":"y"}]}'), [
    { type: 'floating', where: 'desk', note: 'laptop in the air' },
  ]);
  assert.deepEqual(parseSingleAnswer('{"defects":[]}'), []);
  assert.equal(parseSingleAnswer('{}'), null);
});

test('classification of a known bad frame (12-42-43 B): the vanished paper bag is found, the jacket and laptop the instruction asked for are not defects', () => {
  const instruction = 'A beige jacket is pulled from the back of the chair to the left, revealing a black laptop under it.';
  const defects = classifyEvidence(
    { a: { added: ['beige jacket', 'laptop'], removed: [] }, b: { added: ['white paper bag'], removed: [] }, single: [] },
    instruction
  );
  assert.deepEqual(defects.map((d) => [d.type, d.where]), [['missing_object', 'white paper bag']]);
});

test('classification: unrequested additions are fabricated objects / persons, requested persons are not', () => {
  const d1 = classifyEvidence({ a: { added: ['white tote bag on the chair'], removed: [] }, b: { added: [], removed: ['white tote bag on the chair'] }, single: [] }, 'The light dims slightly.');
  assert.deepEqual(d1.map((d) => d.type), ['fabricated_object']); // both passes agree: one entry, not two
  const d2 = classifyEvidence({ a: { added: ['a person'], removed: [] }, b: null, single: [] }, 'The light dims slightly.');
  assert.deepEqual(d2.map((d) => d.type), ['fabricated_person']);
  const d3 = classifyEvidence({ a: { added: ['woman'], removed: [] }, b: null, single: [] }, 'The person in the black t-shirt turns their head slightly.');
  assert.deepEqual(d3, []);
  const d4 = classifyEvidence({ a: { added: [], removed: [] }, b: { added: [], removed: [] }, single: [{ type: 'floating', where: 'laptop', note: 'hovers' }] }, 'x');
  assert.deepEqual(d4.map((d) => d.type), ['floating']);
});

function mockFetch(t: any, answers: string[]) {
  let n = 0;
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_u: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ response: answers[Math.min(n++, answers.length - 1)] }));
  });
  return bodies;
}

test('judgeImage: three calls (pair, swapped pair, single), 2 images for the pairs, json format, num_predict 256', async (t) => {
  const bodies = mockFetch(t, ['{"added":["white tote bag"],"removed":[]}', '{"added":[],"removed":["white tote bag"]}', '{"defects":[]}']);
  const r = await judgeImage({ nowImage: TINY, image: TINY, predictionPrompt: 'The light dims.' }, { ollamaUrl: 'http://x', model: 'm' });
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].images.length, 2);
  assert.equal(bodies[2].images.length, 1);
  assert.equal(bodies[0].format, 'json');
  assert.equal(bodies[0].options.num_predict, 256);
  assert.equal(bodies[0].options.num_ctx, 4096, "same ctx as the detect call, or Ollama reloads the runner");
  assert.equal(bodies[0].think, false);
  assert.equal(r.ok, false);
  assert.deepEqual(r.defects.map((d) => d.type), ['fabricated_object']);
  assert.equal(r.score, 0.75);
  assert.equal(r.model, 'm');
});

test('judgeImage: nothing found = ok; a failing or unparseable call = ok:null (unknown), never ok', async (t) => {
  mockFetch(t, ['{"added":[],"removed":[]}', '{"added":[],"removed":[]}', '{"defects":[]}']);
  const ok = await judgeImage({ nowImage: TINY, image: TINY, predictionPrompt: 'x' }, { ollamaUrl: 'http://x', model: 'm' });
  assert.equal(ok.ok, true);
  assert.equal(ok.score, 1);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('boom', { status: 500 }));
  const err = await judgeImage({ nowImage: TINY, image: TINY, predictionPrompt: 'x' }, { ollamaUrl: 'http://x', model: 'm' });
  assert.equal(err.ok, null);
  assert.match(String(err.error), /500/);
  t.mock.restoreAll();
  mockFetch(t, ['garbage', 'garbage', 'garbage']);
  const bad = await judgeImage({ nowImage: TINY, image: TINY, predictionPrompt: 'x' }, { ollamaUrl: 'http://x', model: 'm' });
  assert.equal(bad.ok, null);
  const noImg = await judgeImage({ nowImage: 'nope', image: TINY, predictionPrompt: 'x' }, {});
  assert.equal(noImg.ok, null);
});

test('queue: one job at a time, in order', async () => {
  const q = new QaQueue(() => false, { pollMs: 5 });
  let running = 0;
  let maxRunning = 0;
  const order: string[] = [];
  for (const id of ['a', 'b', 'c']) {
    q.enqueue({
      captureId: id,
      sceneKey: 's',
      run: async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 10));
        order.push(id);
        running -= 1;
      },
    });
  }
  await q.idle();
  assert.equal(maxRunning, 1);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('queue: nothing runs while a capture is busy; an interrupt aborts the running job and it is retried later', async () => {
  let busy = true;
  const q = new QaQueue(() => busy, { pollMs: 5 });
  const log: string[] = [];
  let attempt = 0;
  q.enqueue({
    captureId: 'a',
    sceneKey: 's',
    run: async (signal) => {
      attempt += 1;
      log.push(`start${attempt}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, attempt === 1 ? 500 : 5);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        });
      });
      if (!signal.aborted) log.push('done');
    },
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(log, [], 'busy: not started');
  busy = false;
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(log, ['start1']);
  busy = true;
  q.interrupt(); // a capture starts
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(log, ['start1'], 'aborted job waits while busy');
  busy = false;
  await q.idle();
  assert.deepEqual(log, ['start1', 'start2', 'done']);
});

test('queue: trim drops the oldest waiting jobs', async () => {
  const q = new QaQueue(() => true, { pollMs: 1000 });
  for (let i = 0; i < 5; i++) q.enqueue({ captureId: String(i), sceneKey: 's', run: async () => {} });
  assert.equal(q.trim(3), 2);
  assert.equal(q.length, 3);
  q.stop();
});

function row(over: Partial<QaRow>): QaRow {
  return { time: '2026-10-16T10:00:00.000Z', captureId: 'c', sceneKey: 'gen_a', file: 'f', ok: true, score: 1, defects: [], model: 'm', elapsedMs: 1000, rulebookVersion: 1, ...over };
}

test('summary: defect rate by rulebook version, per type, unknowns counted apart', () => {
  const rows = [
    row({}),
    row({ ok: false, score: 0.75, defects: [{ type: 'fabricated_object', where: 'a', note: 'n' }] }),
    row({ ok: false, score: 0.5, defects: [{ type: 'fabricated_object', where: 'a', note: 'n' }, { type: 'floating', where: 'b', note: 'n' }] }),
    row({ ok: null, score: null, error: 'timeout' }),
    row({ rulebookVersion: 2 }),
    row({ rulebookVersion: 2 }),
  ];
  const g = summarizeQa(rows, 'rulebookVersion');
  assert.deepEqual(g.map((x) => x.key), ['1', '2']);
  const v1 = g[0];
  assert.equal(v1.images, 4);
  assert.equal(v1.judged, 3);
  assert.equal(v1.unknown, 1);
  assert.equal(v1.defective, 2);
  assert.equal(v1.defectRate, 0.667);
  assert.deepEqual(v1.byType.fabricated_object, { count: 2, rate: 0.667 });
  assert.deepEqual(v1.byType.floating, { count: 1, rate: 0.333 });
  assert.equal(g[1].defectRate, 0);
});

test('patchPromptsJson adds qaLocal to the right scene of the archive file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-arch-'));
  fs.writeFileSync(path.join(dir, '2026-10-16_00-00-00_prompts.json'), JSON.stringify({ scenes: [{ sceneKey: 'gen_a' }, { sceneKey: 'gen_b' }] }));
  assert.equal(patchPromptsJson(dir, 'gen_b', { ok: false }), true);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, '2026-10-16_00-00-00_prompts.json'), 'utf8'));
  assert.equal(doc.scenes[0].qaLocal, undefined);
  assert.deepEqual(doc.scenes[1].qaLocal, { ok: false });
  assert.equal(patchPromptsJson(dir, 'gen_z', {}), false);
  assert.equal(patchPromptsJson(null, 'gen_a', {}), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('G-14 / G-15 classes: held items that vanish are lost_belongings, free text maps to new_face', () => {
  const d = classifyEvidence({ a: { added: [], removed: ['microphone in the right hand'] }, b: null, single: [] }, 'The person turns their head.');
  assert.deepEqual(d.map((x) => x.type), ['lost_belongings']);
  assert.equal(normalizeDefectType('new face drawn'), 'new_face');
  assert.equal(normalizeDefectType('lost belongings'), 'lost_belongings');
});

test('G-16 / obstruction classes: new text or clock, vanished obstruction', () => {
  const t = classifyEvidence({ a: { added: ['clock text on the laptop screens'], removed: ['black chair backrest in the foreground'] }, b: null, single: [] }, 'The light dims slightly.');
  assert.deepEqual(t.map((x) => x.type).sort(), ['new_text_or_clock', 'obstruction_removed']);
  assert.equal(normalizeDefectType('garbled clock'), 'new_text_or_clock');
  assert.equal(normalizeDefectType('obstruction removed'), 'obstruction_removed');
});

test('depth_order_broken class', () => {
  assert.equal(normalizeDefectType('depth order broken'), 'depth_order_broken');
  assert.equal(normalizeDefectType('monitors pasted in front of the mesh'), 'depth_order_broken');
});

test('light_artifact class', () => {
  assert.equal(normalizeDefectType('rainbow light streaks'), 'light_artifact');
  assert.equal(normalizeDefectType('lens flare'), 'light_artifact');
});
