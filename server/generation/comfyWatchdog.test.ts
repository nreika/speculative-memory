import test from 'node:test';
import assert from 'node:assert/strict';
import { ComfyWatchdog } from './comfyWatchdog';
import { createHealthChecker } from '../health/routes';

const fixedNow = () => new Date('2026-10-17T06:00:00Z');

test('first timeout raises an alert without restarting; success resets the count and the alert', () => {
  let restarts = 0;
  const w = new ComfyWatchdog({ threshold: 2, now: fixedNow, restart: async () => { restarts++; return true; } });
  w.noteTimeout();
  assert.equal(w.status().consecutiveTimeouts, 1);
  assert.equal(w.status().alert?.level, 'warn');
  assert.equal(w.status().lastTimeoutAt, '2026-10-17T06:00:00.000Z');
  assert.equal(restarts, 0);
  w.noteSuccess();
  assert.equal(w.status().consecutiveTimeouts, 0);
  assert.equal(w.status().alert, null);
  w.noteTimeout();
  assert.equal(w.status().consecutiveTimeouts, 1); // the earlier timeout does not count any more
  assert.equal(restarts, 0);
});

test('threshold consecutive timeouts run the restart once; whenReady waits for it; counters reset afterwards', async () => {
  let release!: (ok: boolean) => void;
  let restarts = 0;
  const changes: string[] = [];
  const w = new ComfyWatchdog({
    threshold: 2,
    now: fixedNow,
    restart: () => new Promise<boolean>((r) => { restarts++; release = r; }),
    onChange: (s) => changes.push(s.alert?.level ?? 'none'),
  });
  w.noteTimeout();
  w.noteTimeout();
  assert.equal(restarts, 1);
  assert.equal(w.status().restarting, true);
  assert.equal(w.status().alert?.level, 'restarting');
  w.noteTimeout(); // a late third timeout while restarting must not start a second restart
  assert.equal(restarts, 1);
  let ready = false;
  const waiting = w.whenReady().then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);
  release(true);
  await waiting;
  assert.equal(ready, true);
  assert.equal(w.status().autoRestarts, 1);
  assert.equal(w.status().consecutiveTimeouts, 0);
  assert.equal(w.status().alert, null);
  assert.equal(w.status().restarting, false);
  assert.ok(changes.includes('restarting'));
});

test('a failed restart keeps a restart-failed alert until a generation succeeds', async () => {
  const w = new ComfyWatchdog({ threshold: 1, now: fixedNow, restart: async () => false });
  w.noteTimeout();
  await w.whenReady();
  assert.equal(w.status().alert?.level, 'restart-failed');
  assert.equal(w.status().autoRestarts, 1);
  w.noteSuccess();
  assert.equal(w.status().alert, null);
});

test('autoRestart:false only alerts', () => {
  let restarts = 0;
  const w = new ComfyWatchdog({ threshold: 1, autoRestart: false, restart: async () => { restarts++; return true; } });
  w.noteTimeout();
  w.noteTimeout();
  assert.equal(restarts, 0);
  assert.equal(w.status().alert?.level, 'warn');
});

test('health adds comfyQueue {running, pending}', async () => {
  const fetchImpl = (async (url: string) =>
    url.endsWith('/queue')
      ? new Response(JSON.stringify({ queue_running: [[0, 'a']], queue_pending: [[1, 'b'], [2, 'c']] }), { status: 200 })
      : new Response('{}', { status: 200 })) as unknown as typeof fetch;
  const h = await createHealthChecker({ fetchImpl, comfyUrl: () => 'http://c', ollamaUrl: () => 'http://o' })();
  assert.deepEqual(h.comfyQueue, { running: 1, pending: 2 });
  const down = (async (url: string) => { if (url.endsWith('/queue')) throw new Error('down'); return new Response('{}'); }) as unknown as typeof fetch;
  assert.equal((await createHealthChecker({ fetchImpl: down, comfyUrl: () => 'http://c', ollamaUrl: () => 'http://o' })()).comfyQueue, null);
});
