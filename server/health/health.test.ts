import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthChecker, probe } from './routes.js';

const mk = (calls: string[], failUrl?: string, hang?: string) =>
  (async (url: string, init?: { signal?: AbortSignal }) => {
    calls.push(url);
    if (hang && url.includes(hang)) {
      return new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('abort'))));
    }
    if (failUrl && url.includes(failUrl)) throw new Error('down');
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;

test('both up, cached for 5 s then refreshed', async () => {
  const calls: string[] = [];
  let t = 1_000_000;
  const check = createHealthChecker({ fetchImpl: mk(calls), now: () => t, comfyUrl: () => 'http://c', ollamaUrl: () => 'http://o' });
  const a = await check();
  assert.deepEqual([a.ok, a.comfyui, a.ollama], [true, true, true]);
  assert.deepEqual(calls.sort(), ['http://c/system_stats', 'http://o/api/tags']);
  t += 4900;
  await check();
  assert.equal(calls.length, 2);
  t += 200;
  await check();
  assert.equal(calls.length, 4);
});

test('errors give false flags, ok stays true', async () => {
  const check = createHealthChecker({ fetchImpl: mk([], 'system_stats'), comfyUrl: () => 'http://c', ollamaUrl: () => 'http://o' });
  const r = await check();
  assert.deepEqual([r.ok, r.comfyui, r.ollama], [true, false, true]);
});

test('non-2xx is false; timeout is false', async () => {
  const f = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
  assert.equal(await probe(f, 'http://x', 100), false);
  const start = Date.now();
  assert.equal(await probe(mk([], undefined, 'hang'), 'http://hang', 50), false);
  assert.ok(Date.now() - start < 1000);
});
