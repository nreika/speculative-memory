import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CostTracker, computeCostUsd, priceFor, tokensFromMetadata, getUsdJpy } from './costTracker';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('thinking tokens bill as output; input and output priced per 1M', () => {
  const t = tokensFromMetadata({
    promptTokenCount: 2000,
    candidatesTokenCount: 500,
    thoughtsTokenCount: 1500,
    totalTokenCount: 4000,
  })!;
  // 2000*0.50/1M + (500+1500)*3.00/1M = 0.001 + 0.006
  near(computeCostUsd('gemini-3-flash-preview', t, {}), 0.007);
});

test('cached tokens use the cached price', () => {
  const t = tokensFromMetadata({ promptTokenCount: 1000, cachedContentTokenCount: 600, candidatesTokenCount: 0 })!;
  near(computeCostUsd('gemini-3-flash-preview', t, {}), (400 * 0.5 + 600 * 0.05) / 1e6);
});

test('env overrides and unknown models', () => {
  const env = { GEMINI_PRICE_INPUT_PER_M_USD: '1', GEMINI_PRICE_OUTPUT_PER_M_USD: '10' };
  const t = tokensFromMetadata({ promptTokenCount: 1_000_000, candidatesTokenCount: 100_000 })!;
  near(computeCostUsd('gemini-3-flash-preview', t, env), 2);
  assert.equal(priceFor('some-new-model', {}).known, false);
  assert.equal(priceFor('gemini-3-flash-preview', {}).known, true);
  assert.equal(getUsdJpy({ USD_JPY: '150' }), 150);
  assert.ok(getUsdJpy({}) > 100);
  assert.equal(tokensFromMetadata(undefined), null);
});

test('tracker appends lines, keeps totals, reloads all-time, rolls the day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const file = path.join(dir, 'logs', 'usage.jsonl');
  let now = new Date(2026, 9, 6, 12, 0, 0);
  const env = { USD_JPY: '100' };
  const sent: any[] = [];
  const tr = new CostTracker(file, () => now, env);
  tr.setNotifier((u) => sent.push(u));
  const meta = { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 100, totalTokenCount: 1200 };
  const rec = tr.record({
    purpose: 'scenario',
    model: 'gemini-3-flash-preview',
    usageMetadata: meta,
    captureId: 'c1',
    attempt: 1,
  })!;
  near(rec.usd, (1000 * 0.5 + 200 * 3) / 1e6);
  near(rec.jpy, rec.usd * 100);
  tr.record({ purpose: 'qa', model: 'gemini-3-flash-preview', usageMetadata: meta, captureId: 'c1' });
  const snap = tr.snapshot();
  assert.equal(snap.today.calls, 2);
  assert.equal(snap.sinceStart.calls, 2);
  assert.equal(snap.allTime.tokens, 2400);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].type, 'usage.updated');
  assert.equal(sent[1].todayCalls, 2);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);

  now = new Date(2026, 9, 7, 9, 0, 0); // next local day
  const tr2 = new CostTracker(file, () => now, env);
  assert.equal(tr2.snapshot().allTime.calls, 2);
  assert.equal(tr2.snapshot().sinceStart.calls, 0);
  assert.equal(tr2.snapshot().today.calls, 0);
  tr2.record({ purpose: 'other', model: 'x', usageMetadata: undefined });
  assert.equal(tr2.snapshot().today.calls, 1);
  assert.equal(tr2.snapshot().last?.usageMissing, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
