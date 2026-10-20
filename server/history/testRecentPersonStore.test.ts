import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { latestTestPerson } from './testRecentPerson';
import { TestRecentPersonStore, recoverTestPersonFromArchive, scopeHash, mergeReplayed } from './testRecentPersonStore';
import type { ReplayedOriginalObservation } from './historyDisplay';

const scope = 'test:TSC-003:7fce2181a56e4fb5a933239a0d8026ca:L4';
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
const t0 = Date.parse('2026-10-19T09:51:44.784Z');
const row = (n: number, replayedAt: string): ReplayedOriginalObservation => ({
  sceneId: 'TSC-003', frameId: `TSC-003-F00${n}`, sourceImageSha256: String(n).repeat(64), originalCaptureId: `td-17920693${n}-22${n}`,
  sourceObservedAt: null, observation: '人物が座っている', detectorPerson: true, replayedAt,
  people: [{ position: 'center', pose: 'seated in a chair', clothes: 'white shirt', facing: 'away', hair: 'short blue hair', headBox: [412, 633, 500, 750] } as never],
});
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('persistence round-trip: a new instance (restart) loads the occupied frame and latestTestPerson finds it', () => {
  const dir = tmp('test-recent-person-');
  try {
    const a = new TestRecentPersonStore({ dir, now: () => t0, log: () => {} });
    a.remember(scope, row(3, new Date(t0).toISOString()), dataUrl);
    const sub = path.join(dir, scopeHash(scope));
    assert.deepEqual(fs.readdirSync(sub).sort(), ['TSC-003-F003.jpg', 'TSC-003-F003.json']);
    const doc = JSON.parse(fs.readFileSync(path.join(sub, 'TSC-003-F003.json'), 'utf8'));
    assert.equal(doc.historyScope, scope);
    assert.deepEqual(doc.row.people[0].headBox, [412, 633, 500, 750]);

    const now = t0 + 90_000; // F004 replayed 1.5 min later, after a restart
    const b = new TestRecentPersonStore({ dir, now: () => now, log: () => {} });
    const found = latestTestPerson(b.observations(scope), { windowMin: 10, now, excludeFrameId: 'TSC-003-F004' });
    assert.ok(found);
    assert.equal(found.frameId, 'TSC-003-F003');
    assert.equal(found.minutesAgo, 2);
    assert.equal(found.entry.people?.[0].hair, 'short blue hair');
    assert.deepEqual(found.entry.people?.[0].headBox, [412, 633, 500, 750]);
    assert.equal(b.frame(scope, found.entry.captureId), dataUrl);
    assert.equal(b.observations('test:TSC-003:other:L1').length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('eviction by age (replayedAt window) on load and on access; <= 4 frames per scope, <= 12 scopes', () => {
  const dir = tmp('test-recent-person-');
  try {
    let now = t0;
    const a = new TestRecentPersonStore({ dir, now: () => now, log: () => {} });
    for (let n = 1; n <= 6; n += 1) a.remember(scope, row(n, new Date(t0 + n * 1000).toISOString()), dataUrl);
    assert.deepEqual(a.observations(scope).map(r => r.frameId), ['TSC-003-F003', 'TSC-003-F004', 'TSC-003-F005', 'TSC-003-F006']);
    assert.equal(fs.readdirSync(path.join(dir, scopeHash(scope))).length, 8);
    for (let s = 0; s < 13; s += 1) a.remember(`test:TSC-001:run:L${s}`, row(1, new Date(t0).toISOString()), dataUrl);
    assert.equal(a.observations(scope).length, 0, 'least recently touched scope evicted beyond 12');
    assert.equal(fs.readdirSync(dir).length, 12);
    now = t0 + 11 * 60_000;
    assert.equal(a.observations('test:TSC-001:run:L12').length, 0, 'older than 10 min');
    const b = new TestRecentPersonStore({ dir, now: () => now, log: () => {} });
    assert.equal(b.observations('test:TSC-001:run:L12').length, 0);
    assert.equal(fs.readdirSync(dir).length, 0, 'expired state removed on load');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unavailable dir -> in-memory only, logged once', () => {
  const dir = tmp('test-recent-person-');
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  const logs: string[] = [];
  try {
    const s = new TestRecentPersonStore({ dir: path.join(blocker, 'sub'), now: () => t0, log: m => logs.push(m) });
    s.remember(scope, row(1, new Date(t0).toISOString()), dataUrl);
    s.remember(scope, row(2, new Date(t0).toISOString()), dataUrl);
    assert.equal(s.persistent, false);
    assert.equal(s.observations(scope).length, 2);
    assert.equal(logs.filter(l => /unavailable/.test(l)).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mergeReplayed de-duplicates and orders by replayedAt', () => {
  const a = row(1, '2026-10-19T09:50:00Z'), b = row(2, '2026-10-19T09:49:00Z');
  assert.deepEqual(mergeReplayed([a], [b, a]).map(r => r.frameId), ['TSC-003-F002', 'TSC-003-F001']);
});

test('archive recovery: newest occupied capture of the same scope within 10 min (fixture folder, no model call)', () => {
  const root = tmp('archive-recovery-');
  const add = (name: string, capturedAt: string, opts: { scope?: string; person: boolean; frameId: string }) => {
    const d = path.join(root, '2026-10-19', name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${name}_NOW.jpg`), jpeg);
    fs.writeFileSync(path.join(d, `${name}_prompts.json`), JSON.stringify({
      captureId: `test-${opts.frameId}`, capturedAt, nowText: 'now',
      historyContext: { historyScope: opts.scope ?? scope, testSceneId: 'TSC-003', testFrameId: opts.frameId, cachedObservation: { status: 'hit', originalCaptureId: `orig-${opts.frameId}`, sourceImageSha256: 'a'.repeat(64), sourceObservedAt: '2026-10-15T13:02:52.371Z' } },
      vlm: { guard: { detector: { person: opts.person }, people: opts.person ? [{ position: 'center', pose: 'seated in a chair', clothes: 'white shirt', facing: 'away', hair: 'short blue hair', holding: '', headBox: [412, 633, 500, 750] }] : [] } },
    }));
  };
  try {
    add('2026-10-19_18-46-59', '2026-10-19T09:46:59.053Z', { person: true, frameId: 'TSC-003-F001' });
    add('2026-10-19_18-51-44', '2026-10-19T09:51:44.784Z', { person: true, frameId: 'TSC-003-F003' });
    add('2026-10-19_18-52-30', '2026-10-19T09:52:30.000Z', { person: true, frameId: 'TSC-001-F002', scope: 'test:TSC-001:x:L1' });
    add('2026-10-19_18-55-00', '2026-10-19T09:55:00.000Z', { person: false, frameId: 'TSC-003-F004' });
    const now = Date.parse('2026-10-19T09:56:00Z');
    const r = recoverTestPersonFromArchive({ archiveRoot: root, historyScope: scope, windowMin: 10, now });
    assert.ok(r);
    assert.equal(r.row.frameId, 'TSC-003-F003');
    assert.equal(r.row.originalCaptureId, 'orig-TSC-003-F003');
    assert.equal(r.minutesAgo, 4);
    assert.equal(r.imageDataUrl, dataUrl);
    const p = latestTestPerson([r.row], { windowMin: 10, now });
    assert.ok(p);
    assert.deepEqual(p.entry.people?.[0].headBox, [412, 633, 500, 750]);
    assert.equal(p.entry.people?.[0].clothes, 'white shirt');
    // Outside the window / other scope / current folder excluded -> nothing.
    assert.equal(recoverTestPersonFromArchive({ archiveRoot: root, historyScope: scope, windowMin: 10, now: Date.parse('2026-10-19T10:05:00Z') }), null);
    assert.equal(recoverTestPersonFromArchive({ archiveRoot: root, historyScope: 'test:TSC-002:y:L1', windowMin: 10, now }), null);
    assert.equal(recoverTestPersonFromArchive({ archiveRoot: root, historyScope: scope, windowMin: 10, now, excludeFrameId: 'TSC-003-F003' })?.row.frameId, 'TSC-003-F001');
    assert.equal(recoverTestPersonFromArchive({ archiveRoot: path.join(root, 'missing'), historyScope: scope, windowMin: 10, now }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
