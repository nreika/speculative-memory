import test from 'node:test';
import assert from 'node:assert/strict';
import { latestTestPerson, TestPersonFrames } from './testRecentPerson';
import { ScopedTestHistory, resolveCaptureHistoryScope, type CachedOriginalObservation } from './historyDisplay';

const now = Date.parse('2026-10-19T05:19:56Z');
const scope = resolveCaptureHistoryScope({ captureId: 'test-TSC-001-F003-L021-1', isTest: true, useLiveHistory: false, testScope: { sceneId: 'TSC-001', runId: 'r', loopId: '21' } });
const frame = (n: number, person: boolean): CachedOriginalObservation => ({
  sceneId: 'TSC-001', frameId: `TSC-001-F00${n}`, sourceImageSha256: String(n).repeat(64), originalCaptureId: `td-17921291${n}-8${n}`,
  sourceObservedAt: null, observation: person ? '人物が立っている' : '無人の部屋', detectorPerson: person,
  people: person ? [{ position: 'center', pose: 'standing', clothes: 'teal sweatshirt', facing: 'right', hair: 'black with pink tips' } as never] : [],
});

test('empty test frame finds the occupied frame replayed 1.5 min earlier in the same loop (G-01/G-02)', () => {
  const h = new ScopedTestHistory();
  h.observe(scope, frame(1, true), '2026-10-19T05:14:44Z');
  h.observe(scope, frame(2, true), '2026-10-19T05:18:28Z');
  h.observe(scope, frame(3, false), '2026-10-19T05:19:56Z');
  const r = latestTestPerson(h.snapshot(scope).observations, { windowMin: 10, now, excludeFrameId: 'TSC-001-F003' });
  assert.ok(r);
  assert.equal(r.frameId, 'TSC-001-F002');
  assert.equal(r.minutesAgo, 1);
  assert.equal(r.entry.captureId, 'td-179212912-82');
  assert.deepEqual({ ...r.entry.people![0] }, { position: 'center', pose: 'standing', clothes: 'teal sweatshirt', facing: 'right', hair: 'black with pink tips' });
  assert.match(r.entry.sceneDescription, /^A person in teal sweatshirt, standing, at the center of the frame\.$/);
});

test('outside the window, no detector hit, or only the current frame -> no recent person', () => {
  const h = new ScopedTestHistory();
  h.observe(scope, frame(1, true), '2026-10-19T05:05:00Z');   // 15 min before
  h.observe(scope, frame(3, false), '2026-10-19T05:19:00Z');
  assert.equal(latestTestPerson(h.snapshot(scope).observations, { windowMin: 10, now }), null);
  const h2 = new ScopedTestHistory();
  h2.observe(scope, frame(2, true), '2026-10-19T05:19:56Z');
  assert.equal(latestTestPerson(h2.snapshot(scope).observations, { windowMin: 10, now, excludeFrameId: 'TSC-001-F002' }), null);
});

test('another loop scope shares nothing', () => {
  const h = new ScopedTestHistory();
  h.observe(scope, frame(2, true), '2026-10-19T05:18:28Z');
  const other = resolveCaptureHistoryScope({ captureId: 'test-x', isTest: true, useLiveHistory: false, testScope: { sceneId: 'TSC-001', runId: 'r', loopId: '22' } });
  assert.equal(latestTestPerson(h.snapshot(other).observations, { windowMin: 10, now }), null);
});

test('TestPersonFrames keeps per-scope frames, bounded', () => {
  const f = new TestPersonFrames(2, 2);
  f.remember('a', 'c1', 'data:1'); f.remember('a', 'c2', 'data:2'); f.remember('a', 'c3', 'data:3');
  assert.equal(f.get('a', 'c1'), undefined);
  assert.equal(f.get('a', 'c3'), 'data:3');
  f.remember('b', 'c1', 'x'); f.remember('c', 'c1', 'y');
  assert.equal(f.get('a', 'c3'), undefined);
  assert.equal(f.get('c', 'c1'), 'y');
});
