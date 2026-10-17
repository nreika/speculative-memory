import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fallbackSummary, summarizeHistory, loadSummary, saveSummary, clearSummary, SUMMARY_PROMPT_HEAD, stripDurations, stateSentence, presentState, composeWithState, composeSummary } from './historySummary';

const now = Date.now();
const at = (min: number, has: boolean, d: string) => ({
  time: new Date(now - min * 60_000).toISOString(), captureId: `c${min}`, sceneDescription: d, observation: d, hasPerson: has,
});
const ENTRIES = [at(30, false, 'An empty room.'), at(20, true, 'A man sits at a desk.'), at(8, false, 'An empty room again.')];

test('persist, reuse after reload, and reset empties it', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sum-')), 'logs', 'history-summary.json');
  assert.equal(loadSummary(f).summary, '');
  saveSummary({ summary: '前回のまとめ', updatedAt: 't', captureId: 'td-1' }, f);
  assert.equal(loadSummary(f).summary, '前回のまとめ');
  clearSummary(f);
  const l = loadSummary(f);
  assert.deepEqual([l.summary, l.updatedAt, l.captureId, l.body], ['', null, null, undefined]);
});

test('stripDurations removes invented elapsed phrases', () => {
  assert.equal(stripDurations('11:58以降、部屋は空となり、27分間空室を保つ。'), '11:58以降、部屋は空となり、空室を保つ。');
  assert.equal(stripDurations('10:09に人物が座る。現在は無人（10分経過）。'), '10:09に人物が座る。現在は無人。');
  assert.doesNotMatch(stripDurations('約3時間、人物が在室した。'), /時間/);
});

import { parseSummaryText } from './historySummary';
test('a reply cut off by num_predict is salvaged up to its last sentence', () => {
  assert.equal(parseSummaryText('{"summary":"10:09に人物が座る。10:11に立つ。10:13に"}'), '10:09に人物が座る。10:11に立つ。10:13に');
  assert.equal(parseSummaryText('{\n  "summary": "10:09に人物が座る。10:11に立つ。10:13に複数の人'), '10:09に人物が座る。10:11に立つ。');
  assert.equal(parseSummaryText('garbage'), null);
});

import { extractIntervals, compressIntervals, intervalJa, presentStateOf, presentStateSentence, clothesLabelJa, placeJa } from './changePoints';
import { isSupportedByList, summarizeHistory as summarize2 } from './historySummary';

const now2 = Date.now();
const P = (clothes: string, pose: string, position = 'center background') => ({ position, pose, clothes, facing: 'away' });
const ev = (minAgo: number, people: any[] | null, obs = 'x', extra: any = {}) => ({
  time: new Date(now2 - minAgo * 60_000).toISOString(), captureId: `c${minAgo}`, sceneDescription: obs, observation: obs,
  hasPerson: !!people && people.length > 0, people: people && people.length ? people : undefined, ...extra,
});
const seq = (from: number, to: number, step: number, mk: () => any[] | null) => {
  const out = [];
  for (let m = from; m >= to; m -= step) out.push(ev(m, mk()));
  return out;
};

test('clothes and place are translated to Japanese labels', () => {
  assert.equal(clothesLabelJa('white shirt'), '白シャツ');
  assert.equal(clothesLabelJa('striped black shirt'), 'ストライプ黒シャツ');
  assert.equal(clothesLabelJa('blue top'), '青トップス');
  assert.equal(clothesLabelJa('teal long-sleeve shirt'), '青緑シャツ');
  assert.equal(clothesLabelJa('sparkly cape'), '');
  assert.equal(placeJa('left front'), '左手前');
  assert.equal(placeJa('center background'), '中央奥');
});

test('unknown clothes/posture inherit while the head count is unchanged (19:16-25 / 19:30-44 case): one interval', () => {
  const H = [
    ...seq(40, 30, 2, () => [P('black shirt', 'seated')]),
    ...seq(28, 20, 2, () => [P('', 'unknown')]),
    ev(18, null, 'x', { hasPerson: true }),
    ...seq(16, 10, 2, () => [P('black shirt', 'seated')]),
  ];
  const iv = extractIntervals(H);
  assert.equal(iv.length, 1);
  assert.deepEqual([iv[0].count, iv[0].clothes, iv[0].labels, iv[0].posture], [1, ['black'], ['黒シャツ'], 'seated']);
});

test('a single odd observation is absorbed; a change lasting 2 observations counts; entering/leaving counts even once', () => {
  const spike = extractIntervals([...seq(30, 20, 2, () => [P('black shirt', 'seated')]), ev(18, [P('black shirt', 'seated'), P('white shirt', 'seated')]), ...seq(16, 10, 2, () => [P('black shirt', 'seated')])]);
  assert.equal(spike.length, 1);
  const real = extractIntervals([...seq(30, 20, 2, () => [P('black shirt', 'seated')]), ...seq(18, 14, 2, () => [P('black shirt', 'seated'), P('white shirt', 'seated')])]);
  assert.deepEqual(real.map((i) => i.count), [1, 2]);
  const inOut = extractIntervals([ev(20, null), ev(18, [P('black shirt', 'seated')]), ev(16, null), ev(14, null)]);
  assert.deepEqual(inOut.map((i) => i.count), [0, 1, 0]);
  const colour = extractIntervals([...seq(30, 24, 2, () => [P('white shirt', 'seated')]), ...seq(22, 16, 2, () => [P('black shirt', 'seated')])]);
  assert.equal(colour.length, 2);
  assert.match(intervalJa(colour[1]), /^\d\d:\d\d〜\d\d:\d\d、黒シャツの人物1人、着席、中央奥$/);
});

test('head count: detector record first; detector says nobody -> 0 even if the text names a person', () => {
  const seen: string[] = [];
  const iv = extractIntervals([
    ev(10, [P('black shirt', 'seated'), P('white shirt', 'seated')]),
    ev(8, null, 'A person is here.', { hasPerson: true, detectorPerson: false }),
    ev(6, null, 'A person is here.', { hasPerson: true, detectorPerson: false }),
  ], (e) => seen.push(e.captureId));
  assert.deepEqual(iv.map((i) => i.count), [2, 0]);   // the detector's verdict wins over the text
  assert.deepEqual(seen, ['c8', 'c6']);
  const textOnly = extractIntervals([ev(8, null, 'A person is here.', { hasPerson: true })]);
  assert.equal(textOnly[0].count, 1);
});

test('compression: last 30 min in full, 30-60 min presence only, older only the head count', () => {
  const long = [...seq(120, 116, 2, () => null), ...seq(114, 110, 2, () => [P('white shirt', 'seated')]), ...seq(108, 104, 2, () => [P('white shirt', 'standing')]),
    ...seq(100, 96, 2, () => [P('blue shirt', 'seated'), P('black shirt', 'seated')]), ...seq(50, 46, 2, () => [P('blue shirt', 'seated')]), ...seq(44, 40, 2, () => [P('blue shirt', 'standing')]),
    ...seq(10, 6, 2, () => [P('black shirt', 'seated')])];
  const c = compressIntervals(extractIntervals(long), now2);
  assert.deepEqual(c.map((i) => i.count), [0, 1, 2, 1, 1]);
  assert.ok(c.slice(0, 3).every((i) => i.clothes.length === 0 && i.posture === 'unknown'));
  assert.equal(c[c.length - 1].posture, 'seated');
});

test('present state: starts at the beginning of the CURRENT continuous interval; minutes are computed at send time', () => {
  const H = [...seq(60, 44, 2, () => [P('white shirt', 'seated')]), ...seq(42, 4, 2, () => [P('black shirt', 'seated')])];
  const st = presentStateOf(extractIntervals(H))!;
  assert.match(presentStateSentence(st, now2), /^\d\d:\d\d以降、黒シャツの人物が1人で着席している（42分）。$/);
  assert.match(presentStateSentence(st, now2 + 6 * 60_000), /（48分）。$/);
  const empty = presentStateOf(extractIntervals([ev(20, null), ev(18, null)]))!;
  assert.match(presentStateSentence(empty, now2), /から現在まで20分間、無人。$/);
});

test('the model gets ONLY the change list (with clothes, posture, place); extras / scenario text never reach the summary', async () => {
  const H = [...seq(29, 21, 2, () => [P('white shirt', 'seated')]), ...seq(19, 3, 2, () => [P('black shirt', 'seated')])].map((e, i) =>
    i === 8 ? { ...e, observation: 'Extra B 立ち上がってる: The person stands up and waves', sceneDescription: 'Extra B 立ち上がってる: The person stands up and waves' } : e);
  let body: any;
  const r = await summarize2(H, now2, {
    fetchImpl: (async (_u: any, init: any) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ response: JSON.stringify({ summary: '白シャツの人物が着席していたが、黒シャツの人物に交代した。' }) })); }) as any,
  });
  assert.equal(body.images, undefined);
  assert.equal(body.options.num_predict, 256);
  assert.ok(body.prompt.startsWith(SUMMARY_PROMPT_HEAD));
  assert.match(SUMMARY_PROMPT_HEAD, /服装や姿勢が前の行から変わったとき/);
  for (const bad of ['立ち上がってる', 'stands up', 'waves', 'Extra B']) assert.ok(!body.prompt.includes(bad), bad);
  assert.match(body.prompt, /白シャツの人物1人、着席、中央奥/);
  assert.match(body.prompt, /黒シャツの人物1人、着席、中央奥/);
  assert.equal(r.source, 'model');
  assert.equal(r.changePoints.length, 2);
});

test('a model text that invents actions or times is rejected -> template from the change list', async () => {
  const lines = ['10:00、無人', '10:05〜10:20、白シャツの人物1人、着席、中央奥'];
  assert.equal(isSupportedByList('10:05〜10:20に白シャツの人物が着席していた。', lines), true);
  assert.equal(isSupportedByList('10:22に白シャツの人物が立ち上がった。', lines), false);
  assert.equal(isSupportedByList('10:05に人物が立ち上がり手を振った。', lines), false);
  assert.equal(isSupportedByList('10:05に人物が起立した。', lines), false);
  const H = [...seq(40, 30, 2, () => [P('white shirt', 'seated')]), ...seq(28, 20, 2, () => [P('black shirt', 'seated')])];
  const r = await summarize2(H, now2, { fetchImpl: (async () => new Response(JSON.stringify({ response: '{"summary":"18:22以降、白シャツ人物は立ち上がり、手を振っていた。"}' }))) as any });
  assert.equal(r.source, 'fallback');
  assert.match(r.summary, /黒シャツの人物1人、着席/);
  assert.doesNotMatch(r.summary, /立ち上がり|手を振/);
  const bad = await summarize2(H, now2, { fetchImpl: (async () => new Response('{}', { status: 500 })) as any });
  assert.equal(bad.source, 'fallback');
});

test('200 characters: the OLDEST sentences are dropped first; the state sentence is always kept', () => {
  const body = Array.from({ length: 30 }, (_, i) => `10:${String(i).padStart(2, '0')}、無人。`).join('');
  const state = '11:58以降、黒シャツの人物が1人で着席している（14分）。';
  const out = composeWithState(body, state);
  assert.ok(out.length <= 200);
  assert.ok(out.endsWith(state));
  assert.ok(out.includes('10:29、無人。') && !out.includes('10:00、無人。'));
});

import { appendHistory as appendH, readHistory as readH } from './sceneHistory';
test('history hasPerson: the detector verdict wins over the planner text; the text decides only without a verdict', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hp-')), 'h.jsonl');
  const base = { time: new Date().toISOString(), captureId: 'c', observation: 'Two people stand in an office.', sceneDescription: 'Two people stand in an office.' };
  appendH({ ...base, hasPerson: true, detectorPerson: false } as any, f);
  appendH({ ...base, captureId: 'd', hasPerson: false, detectorPerson: true } as any, f);
  appendH({ ...base, captureId: 'e', hasPerson: false } as any, f);
  assert.deepEqual(readH(f).map((e) => e.hasPerson), [false, true, true]);
});

import { composeSummary as composeS, clearSummary as clearS, loadSummary as loadS, saveSummary as saveS } from './historySummary';

test('only-empty window and no history before it: the summary is the single closing sentence (no body, no doubled text)', async () => {
  const H = seq(100, 4, 2, () => null);
  const r = await summarize2(H, now2, { fetchImpl: (async () => { throw new Error('model must not be called'); }) as any });
  assert.equal(r.summary, '');
  assert.equal(r.source, 'carry');
  const text = composeS({ summary: '', body: r.summary, state: r.state!, updatedAt: null, captureId: null }, now2);
  assert.match(text, /^\d\d:\d\dから現在まで\d+分間、無人。$/);
  assert.doesNotMatch(text, /無人\d\d:\d\d/);
});

test('a body without a final period gets one before the state sentence', () => {
  assert.equal(composeWithState('18:10、白シャツの人物1人、着席', '19:57から現在まで10分間、無人。'), '18:10、白シャツの人物1人、着席。19:57から現在まで10分間、無人。');
});

test('the window slid past the last occupancy: the carried-over interval and the original "empty since" survive', async () => {
  const lastOcc = { start: new Date(now2 - 200 * 60_000).toISOString(), end: new Date(now2 - 185 * 60_000).toISOString(), count: 2, clothes: ['blue', 'white'], labels: ['青トップス', '白シャツ'], posture: 'seated' as const, place: '左手前' };
  const emptySince = new Date(now2 - 184 * 60_000).toISOString();
  const prior = { lastOccupied: lastOcc, state: { since: emptySince, count: 0, clothes: [], posture: 'unknown' as const } };
  const H = seq(100, 4, 2, () => null);   // the window only holds empty observations
  const r = await summarize2(H, now2, { prior, fetchImpl: (async () => { throw new Error('model must not be called'); }) as any });
  assert.match(r.summary, /青トップス・白シャツの人物2人、着席、左手前。$/);
  assert.equal(r.state?.since, emptySince);                         // "empty since" is not reset to the window start
  assert.deepEqual(r.lastOccupied, lastOcc);
  const text = composeS({ summary: '', body: r.summary, state: r.state!, updatedAt: null, captureId: null }, now2);
  assert.match(text, /人物2人、着席、左手前。\d\d:\d\dから現在まで184分間、無人。$/);
});

test('when the window contains someone, lastOccupied is taken from the window; reset-history clears the carried interval', async () => {
  const H = [...seq(40, 30, 2, () => [P('black shirt', 'seated')]), ...seq(28, 4, 2, () => null)];
  const r = await summarize2(H, now2, { prior: { lastOccupied: { start: 'x', end: 'x', count: 9, clothes: [], labels: [], posture: 'unknown', place: '' } }, fetchImpl: (async () => new Response('{}', { status: 500 })) as any });
  assert.equal(r.lastOccupied?.count, 1);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lo-')), 'logs', 'history-summary.json');
  saveS({ summary: 'x', updatedAt: 't', captureId: 'c', lastOccupied: r.lastOccupied }, f);
  assert.equal(loadS(f).lastOccupied?.count, 1);
  clearS(f);
  assert.equal(loadS(f).lastOccupied, undefined);
});

test('nothing carried over yet and the window is empty: the last occupancy is recovered from the full history', async () => {
  const older = [...seq(300, 280, 2, () => [P('white shirt', 'seated')]), ...seq(278, 4, 2, () => null)];
  const window = seq(100, 4, 2, () => null);
  const r = await summarize2(window, now2, { older, fetchImpl: (async () => { throw new Error('model must not be called'); }) as any });
  assert.match(r.summary, /白シャツの人物1人、着席、中央奥。$/);
  assert.equal(r.lastOccupied?.count, 1);
  assert.ok(r.state && r.state.count === 0 && Date.parse(r.state.since) < now2 - 270 * 60_000);   // empty since right after the person left
});
