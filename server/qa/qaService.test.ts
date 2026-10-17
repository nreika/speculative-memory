import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QaService } from './qaService';
import type { ImproverPaths } from './improver';
import type { LocalJudgeResult } from './localJudge';

function tmpPaths(): { paths: ImproverPaths; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qasvc-'));
  return {
    paths: { rulebookDir: path.join(root, 'rulebook'), logsDir: path.join(root, 'logs'), qaFile: path.join(root, 'logs', 'qa-local.jsonl') },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('QA only starts when the next capture is not expected within the job margin (timer captures are evenly spaced)', (t) => {
  const { paths, cleanup } = tmpPaths();
  const svc = new QaService({ isBusy: () => false, paths, autoImprove: false });
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  assert.equal(svc.idleWindow(), true, 'no history: only the busy gate applies');
  for (let i = 0; i < 4; i++) {
    now = 1_000_000 + i * 140_000;
    svc.interruptForCapture(true);
  }
  assert.equal(svc.nextStartEstimate(), 1_000_000 + 3 * 140_000 + 140_000);
  now = 1_000_000 + 3 * 140_000 + 40_000; // 100 s before the next one
  assert.equal(svc.idleWindow(), true);
  now = 1_000_000 + 3 * 140_000 + 140_000 - 11_000; // 11 s before: a 12 s job would collide
  assert.equal(svc.idleWindow(), false);
  now = 1_000_000 + 3 * 140_000 + 140_000 + 35_000; // timer stopped: overdue, no prediction
  assert.equal(svc.idleWindow(), true);
  // phone-lane captures do not count for the timer
  svc.interruptForCapture(false);
  assert.equal(svc.nextStartEstimate(), 1_000_000 + 3 * 140_000 + 140_000);
  // irregular starts = no estimate
  const svc2 = new QaService({ isBusy: () => false, paths, autoImprove: false });
  for (const t0 of [0, 30_000, 200_000, 230_000]) {
    now = 2_000_000 + t0;
    svc2.interruptForCapture(true);
  }
  assert.equal(svc2.nextStartEstimate(), null);
  cleanup();
});

test('a busy venue blocks QA even without a timer estimate', () => {
  const { paths, cleanup } = tmpPaths();
  let busy = true;
  const svc = new QaService({ isBusy: () => busy, paths, autoImprove: false });
  assert.equal(svc.idleWindow(), false);
  busy = false;
  assert.equal(svc.idleWindow(), true);
  cleanup();
});

test('a judged scene is logged (qa-local.jsonl), patched into prompts.json, and summarised on the capture event', async () => {
  const { paths, cleanup } = tmpPaths();
  const arch = fs.mkdtempSync(path.join(os.tmpdir(), 'qasvc-arch-'));
  fs.writeFileSync(path.join(arch, 'g_prompts.json'), JSON.stringify({ scenes: [{ sceneKey: 'gen_a' }, { sceneKey: 'gen_b' }] }));
  const imgA = path.join(arch, 'a.png');
  fs.writeFileSync(imgA, Buffer.from('iVBORw0KGgo=', 'base64'));
  const patches: any[] = [];
  const judge = async (): Promise<LocalJudgeResult> => ({ ok: false, score: 0.75, defects: [{ type: 'floating', where: 'desk', note: 'n' }], model: 'm', elapsedMs: 5000 });
  const svc = new QaService({
    isBusy: () => false,
    paths,
    autoImprove: false,
    judge: judge as any,
    events: { patch: (id: string, f: any) => patches.push([id, f]) } as any,
  });
  for (const sceneKey of ['gen_a', 'gen_b']) {
    svc.enqueueScene({ captureId: 'td-1', sceneKey, nowPath: imgA, imagePath: imgA, predictionPrompt: 'p', archiveDir: arch, rulebookVersion: 3, sceneCount: 2 });
  }
  await svc.queue.idle();
  const rows = fs.readFileSync(paths.qaFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].rulebookVersion, 3);
  assert.equal(rows[0].ok, false);
  const doc = JSON.parse(fs.readFileSync(path.join(arch, 'g_prompts.json'), 'utf8'));
  assert.equal(doc.scenes[0].qaLocal.ok, false);
  assert.equal(doc.scenes[1].qaLocal.rulebookVersion, 3);
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0][1].qa.defects, { floating: 2 });
  assert.equal(patches[0][1].qa.defective, 2);
  // test captures are never judged
  svc.enqueueScene({ captureId: 'extras-test-1', sceneKey: 'gen_a', nowPath: imgA, imagePath: imgA, predictionPrompt: 'p', rulebookVersion: 3, sceneCount: 1, test: true });
  await svc.queue.idle();
  assert.equal(fs.readFileSync(paths.qaFile, 'utf8').trim().split('\n').length, 2);
  fs.rmSync(arch, { recursive: true, force: true });
  cleanup();
});
