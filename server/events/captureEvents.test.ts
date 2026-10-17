import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { CaptureEventStore, costForCapture, groupFailureRuns, parseDisplayLog, type CaptureEvent } from './captureEvents';
import { registerEventRoutes } from './routes';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'capture-events-'));
const iso = (h: number, m = 0, d = 16) => new Date(2026, 9, d, h, m, 0).toISOString();
const mk = (dir: string, nowIso = iso(12)) =>
  new CaptureEventStore(path.join(dir, 'capture-events.jsonl'), path.join(dir, 'display-log.jsonl'), path.join(dir, 'usage.jsonl'), () => new Date(nowIso));
const ev = (id: string, o: Partial<CaptureEvent> = {}): CaptureEvent => ({ captureId: id, startedAt: iso(9), result: 'completed', ...o });

test('started row then final row fold into one capture, newest first', () => {
  const dir = tmp();
  const s = mk(dir);
  s.write(ev('a', { result: 'running', startedAt: iso(9, 0) }));
  s.write(ev('b', { startedAt: iso(9, 5), totalMs: 100000 }));
  s.finish(ev('a', { startedAt: iso(9, 0), planMs: 1234, endedAt: iso(9, 2) }));
  const all = s.query();
  assert.deepEqual(all.map((e) => e.captureId), ['b', 'a']);
  assert.equal(all[1].result, 'completed');
  assert.equal(all[1].planMs, 1234);
  assert.equal(all[1].totalMs, 120000);
});

test('cost comes from usage.jsonl rows with the same captureId', () => {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, 'usage.jsonl'),
    [{ captureId: 'a', jpy: 1.5 }, { captureId: 'a', jpy: 2 }, { captureId: 'b', jpy: 9 }].map((r) => JSON.stringify(r)).join('\n') + '\n{torn'
  );
  assert.equal(costForCapture(path.join(dir, 'usage.jsonl'), 'a'), 3.5);
  assert.equal(costForCapture(path.join(dir, 'usage.jsonl'), 'zzz'), 0);
  const s = mk(dir);
  s.finish(ev('a', { vlmBackend: 'gemini' }));
  assert.equal(s.get('a')!.cost, 3.5);
});

test('filters: failedOnly / extras / people / gemini / before / limit', () => {
  const s = mk(tmp());
  s.write(ev('1', { startedAt: iso(8), result: 'failed' }));
  s.write(ev('2', { startedAt: iso(9), extras: { gen_a: { text: 'x', reflected: true, synthesized: false } } }));
  s.write(ev('3', { startedAt: iso(10), people: 2 }));
  s.write(ev('4', { startedAt: iso(11), imageBackend: 'gemini' }));
  assert.deepEqual(s.query({ failedOnly: true }).map((e) => e.captureId), ['1']);
  assert.deepEqual(s.query({ extras: true }).map((e) => e.captureId), ['2']);
  assert.deepEqual(s.query({ people: true }).map((e) => e.captureId), ['3']);
  assert.deepEqual(s.query({ gemini: true }).map((e) => e.captureId), ['4']);
  assert.deepEqual(s.query({ before: iso(10) }).map((e) => e.captureId), ['2', '1']);
  assert.deepEqual(s.query({ limit: 1 }).map((e) => e.captureId), ['4']);
});

test('a running row older than 15 min is shown as interrupted (failed)', () => {
  const s = mk(tmp(), iso(12));
  s.write(ev('old', { result: 'running', startedAt: iso(9) }));
  s.write(ev('fresh', { result: 'running', startedAt: iso(11, 55) }));
  assert.equal(s.get('old')!.result, 'failed');
  assert.equal(s.get('fresh')!.result, 'running');
});

test('summary: counts, cost, duration distribution, failures per hour, last capture; test captures excluded', () => {
  const s = mk(tmp(), iso(12));
  s.write(ev('ok1', { startedAt: iso(9), totalMs: 100000, cost: 2 }));
  s.write(ev('ok2', { startedAt: iso(10), totalMs: 110000, cost: 3 }));
  s.write(ev('ng1', { startedAt: iso(10, 30), result: 'failed' }));
  s.write(ev('ng2', { startedAt: iso(10, 40), result: 'failed' }));
  s.write(ev('ng3', { startedAt: iso(14), result: 'failed' }));
  s.write(ev('t', { startedAt: iso(10, 50), result: 'failed', test: true }));
  s.write(ev('yesterday', { startedAt: iso(10, 0, 15) }));
  const m = s.summary('2026-10-16');
  assert.equal(m.completed, 2);
  assert.equal(m.failed, 3);
  assert.equal(m.costJpy, 5);
  assert.equal(m.durationMs.min, 100000);
  assert.equal(m.durationMs.max, 110000);
  assert.equal(m.durationMs.avg, 105000);
  assert.equal(m.failedByHour[10], 2);
  assert.equal(m.failedByHour[14], 1);
  assert.equal(m.lastCaptureAt, iso(14));
});

test('groupFailureRuns merges consecutive same stage + same 40-char message head', () => {
  const f = (id: string, msg: string, stage = 'plan') => ({ captureId: id, startedAt: iso(9), result: 'failed', errorStage: stage, errorMessage: msg });
  const ok = { captureId: 'ok', startedAt: iso(9), result: 'completed' };
  const items = groupFailureRuns([f('1', 'fetch failed'), f('2', 'fetch failed'), f('3', 'fetch failed'), ok, f('4', 'fetch failed'), f('5', 'other'), f('6', 'other', 'sceneA')]);
  assert.equal(items.length, 5);
  assert.equal(items[0].kind, 'run');
  assert.equal((items[0] as any).events.length, 3);
  assert.deepEqual(items.slice(1).map((i) => i.kind), ['event', 'event', 'event', 'event']);
  assert.equal(groupFailureRuns([f('1', 'x'.repeat(40) + 'A'), f('2', 'x'.repeat(40) + 'B')])[0].kind, 'run');
});

test('parseDisplayLog validates captureId and assignments', () => {
  const assignments = [{ display: 1, window: 'window1', source: 'display_b', scene: 'gen_b', open: true }];
  assert.equal(parseDisplayLog({ assignments }), null);
  assert.equal(parseDisplayLog({ captureId: '../x', assignments }), null);
  assert.equal(parseDisplayLog({ captureId: 'td-1-2' }), null);
  const ok = parseDisplayLog({ captureId: 'td-1-2', at: '2026-10-16T13:00:00+09:00', reason: 'batch', assignments })!;
  assert.equal(ok.entry.assignments[0].scene, 'gen_b');
  assert.equal(ok.entry.at, '2026-10-16T13:00:00+09:00');
});

test('display-log is joined to the capture and kept for unknown captureIds; HTTP API works', async () => {
  const dir = tmp();
  const store = mk(dir);
  const viewer = path.join(dir, 'viewer.html');
  fs.writeFileSync(viewer, '<html>ok</html>');
  const app = express();
  app.use(express.json());
  registerEventRoutes(app, store, { viewerPath: viewer });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown) =>
    fetch(`${base}/api/display-log`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    store.write(ev('td-1-1', { result: 'running', startedAt: new Date().toISOString() }));
    const assignments = [
      { display: 1, window: 'window1', source: 'display_b', scene: 'gen_b', open: true },
      { display: 4, window: 'window4', source: 'display_a', scene: 'gen_a', open: false },
    ];
    assert.equal((await post({ assignments })).status, 400);
    assert.equal((await post({ captureId: 'td-1-1', at: iso(13), reason: 'batch', assignments })).status, 200);
    assert.equal((await post({ captureId: 'td-1-1', at: iso(13, 1), reason: 'layout', assignments })).status, 200);
    assert.equal((await post({ captureId: 'ghost', at: iso(13), reason: 'batch', assignments })).status, 200);
    store.finish(ev('td-1-1', { startedAt: new Date().toISOString() })); // the final row must not drop the displays
    const one = await (await fetch(`${base}/api/events/td-1-1`)).json();
    assert.equal(one.displays.length, 2);
    assert.equal(one.displays[1].reason, 'layout');
    assert.equal(one.result, 'completed');
    assert.equal(one.prompts, null);
    assert.equal((await fetch(`${base}/api/events/ghost`)).status, 404);
    const rawLog = fs.readFileSync(path.join(dir, 'display-log.jsonl'), 'utf8').trim().split('\n');
    assert.equal(rawLog.length, 3);
    assert.ok(rawLog.some((l) => JSON.parse(l).captureId === 'ghost'));
    const list = await (await fetch(`${base}/api/events?limit=10`)).json();
    assert.deepEqual(list.map((e: any) => e.captureId), ['td-1-1']);
    const sum = await (await fetch(`${base}/api/events/summary`)).json();
    assert.equal(typeof sum.completed, 'number');
    assert.equal(await (await fetch(`${base}/logs`)).text(), '<html>ok</html>');
  } finally {
    server.close();
  }
});

test('display rows that arrive before the capture exists do not create a capture', () => {
  const s = mk(tmp());
  s.addDisplay('late', { at: iso(9), reason: 'batch', assignments: [] });
  assert.equal(s.get('late'), null);
});
