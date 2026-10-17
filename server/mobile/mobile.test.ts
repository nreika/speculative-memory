import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MobileQueue } from './queue';
import { isAllowedRemote, parseCidrList } from './access';
import { listArchive, purgeExpiredMobile, resolveArchiveImage, selectExpired, toMobileItem } from './archiveList';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('queue: runs one job at a time, in order', async () => {
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const q = new MobileQueue<string>({
    isVenueBusy: () => false,
    pollMs: 5,
    run: async (job) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(job.payload);
      await sleep(20);
      active -= 1;
      return job.payload;
    },
  });
  const jobs = ['a', 'b', 'c'].map((p) => q.enqueue(p));
  assert.equal(q.describe(jobs[2].id)!.ahead, 2);
  await sleep(150);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(maxActive, 1);
  assert.ok(jobs.every((j) => q.get(j.id)!.state === 'completed'));
});

test('queue: waits while the venue lane is busy; a running job is not interrupted by a venue start', async () => {
  let venueBusy = true;
  let finish!: () => void;
  const q = new MobileQueue<string>({
    isVenueBusy: () => venueBusy,
    pollMs: 5,
    run: () => new Promise((r) => { finish = () => r('done'); }),
  });
  const j = q.enqueue('x');
  await sleep(30);
  assert.equal(q.get(j.id)!.state, 'queued');
  assert.equal(q.describe(j.id)!.waitingForVenue, true);
  venueBusy = false;
  await sleep(30);
  assert.equal(q.get(j.id)!.state, 'running');
  venueBusy = true; // venue capture starts mid-run: the phone job keeps running to its end
  await sleep(20);
  assert.equal(q.get(j.id)!.state, 'running');
  finish();
  await sleep(10);
  assert.equal(q.get(j.id)!.state, 'completed');
});

test('queue: a failing job does not block the next; queued jobs can be cancelled', async () => {
  const q = new MobileQueue<string>({
    isVenueBusy: () => false,
    pollMs: 5,
    run: async (job) => {
      await sleep(10);
      if (job.payload === 'bad') throw new Error('boom');
      return 1;
    },
  });
  const a = q.enqueue('bad');
  const b = q.enqueue('drop');
  const c = q.enqueue('ok');
  assert.equal(q.cancel(b.id), true);
  await sleep(80);
  assert.equal(q.get(a.id)!.state, 'failed');
  assert.equal(q.get(a.id)!.error, 'boom');
  assert.equal(q.get(b.id)!.state, 'cancelled');
  assert.equal(q.get(c.id)!.state, 'completed');
});

test('queue: position and estimate', () => {
  let t = 0;
  const q = new MobileQueue<string>({ isVenueBusy: () => false, now: () => t, run: () => new Promise(() => undefined), jobEstimateSec: 100 });
  const a = q.enqueue('a');
  q.enqueue('b');
  const c = q.enqueue('c');
  t = 40_000;
  const d = q.describe(c.id)!;
  assert.equal(d.ahead, 2);
  assert.equal(d.etaStartSec, 60 + 100);
  assert.equal(q.describe(a.id)!.state, 'running');
});

test('CIDR: default allows Tailscale, loopback, 192.168; rejects others', () => {
  const c = parseCidrList('');
  for (const ok of ['100.66.171.99', '::ffff:100.64.0.1', '100.127.255.254', '127.0.0.1', '::1', '192.168.1.20']) {
    assert.equal(isAllowedRemote(ok, c), true, ok);
  }
  for (const bad of ['100.128.0.1', '100.63.255.255', '8.8.8.8', '10.0.0.5', '172.16.0.1', '', undefined, 'fe80::1', '1.2.3.4, 100.64.0.1']) {
    assert.equal(isAllowedRemote(bad as string | undefined, c), false, String(bad));
  }
});

test('CIDR: MOBILE_ALLOWED_CIDRS replaces the list; garbage falls back to the default', () => {
  const c = parseCidrList('10.0.0.0/8, 203.0.113.7');
  assert.equal(isAllowedRemote('10.9.9.9', c), true);
  assert.equal(isAllowedRemote('203.0.113.7', c), true);
  assert.equal(isAllowedRemote('100.66.0.1', c), false);
  assert.equal(isAllowedRemote('100.66.0.1', parseCidrList('nonsense')), true);
});

const mkArchive = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mobarch-'));
const put = (root: string, id: string, doc: object, extra: string[] = []) => {
  const dir = path.join(root, id.slice(0, 10), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}_prompts.json`), JSON.stringify({ generationId: id, ...doc }));
  for (const f of extra) fs.writeFileSync(path.join(dir, `${id}_${f}`), 'x');
  return dir;
};

test('archive-image path check: only strict names inside the archive root', () => {
  const root = mkArchive();
  const id = '2026-10-16_12-00-00';
  put(root, id, {}, ['A.png', 'NOW.jpg']);
  assert.ok(resolveArchiveImage(root, id, `${id}_A.png`));
  assert.ok(resolveArchiveImage(root, id, `${id}_NOW.jpg`));
  const bad: Array<[string, string]> = [
    [id, '../x.png'],
    [id, `..\\${id}_A.png`],
    [id, `${id}_prompts.json`],
    [id, `${id}_A.png/../../x`],
    ['..', `${id}_A.png`],
    [`${id}/..`, `${id}_A.png`],
    [id, '2026-10-16_13-00-00_A.png'],
    [id, 'C:\\Windows\\win.ini'],
    [id, `${id}_A.png%00.png`],
    [id, `${id}_vlm.txt`],
  ];
  for (const [g, f] of bad) assert.equal(resolveArchiveImage(root, g, f), null, `${g} ${f}`);
});

test('toMobileItem / listArchive: source filter, newest first, texts and urls', () => {
  const root = mkArchive();
  const mk = (id: string, source: string) => ({
    generationId: id,
    captureId: 'c' + id,
    source,
    capturedAt: '2026-10-16T12:00:00',
    status: 'completed',
    sourceFile: `${id}_NOW.jpg`,
    vlm: { parsedScenarios: [{ scene_now: '机に人がいる' }] },
    scenes: [{ sceneKey: 'gen_a', letter: 'A', distanceSec: 30, file: `${id}_A.png`, scenarioDescription: '立ち上がる' }],
  });
  put(root, '2026-10-16_10-00-00', mk('2026-10-16_10-00-00', 'td-native'));
  put(root, '2026-10-16_11-00-00', mk('2026-10-16_11-00-00', 'mobile'));
  put(root, '2026-10-15_09-00-00', mk('2026-10-15_09-00-00', 'browser'));
  put(root, '2026-10-16_12-00-00', { ...mk('2026-10-16_12-00-00', 'td-native'), status: 'failed' });
  const venue = listArchive(root, { source: 'venue' });
  assert.deepEqual(venue.map((i) => i.generationId), ['2026-10-16_10-00-00', '2026-10-15_09-00-00']);
  assert.deepEqual(listArchive(root, { source: 'mobile' }).map((i) => i.source), ['mobile']);
  assert.equal(listArchive(root, { source: 'all', limit: 2 }).length, 2);
  assert.equal(listArchive(root, { source: 'all', captureId: 'c2026-10-16_11-00-00' }).length, 1);
  const it = toMobileItem(mk('2026-10-16_10-00-00', 'td-native'))!;
  assert.equal(it.nowText, '机に人がいる');
  assert.equal(it.scenes[0].sceneText, '立ち上がる');
  assert.match(it.scenes[0].imageUrl!, /^\/api\/archive-image\/2026-10-16_10-00-00\/2026-10-16_10-00-00_A\.png$/);
});

test('retention: only source=mobile older than the limit; 0 keeps everything', () => {
  const H = 3600_000;
  const now = 1_000 * H;
  const e = (source: string, ageH: number) => ({ dir: `/d/${source}${ageH}`, generationId: 'g', source, mtimeMs: now - ageH * H });
  const all = [e('mobile', 25), e('mobile', 23), e('td-native', 100), e('browser', 100), e('test', 100), e('mobile', 24.01)];
  assert.deepEqual(selectExpired(all, now, 24).map((x) => x.dir), ['/d/mobile25', '/d/mobile24.01']);
  assert.deepEqual(selectExpired(all, now, 0), []);
  assert.deepEqual(selectExpired(all, now, -1), []);
});

test('purgeExpiredMobile: deletes old phone folders (and listed captures files), leaves venue ones', () => {
  const root = mkArchive();
  const caps = fs.mkdtempSync(path.join(os.tmpdir(), 'mobcap-'));
  const old = '2026-10-10_10-00-00';
  const venue = '2026-10-10_11-00-00';
  const recent = '2026-10-16_10-00-00';
  const dOld = put(root, old, { source: 'mobile' }, ['A.png']);
  fs.writeFileSync(path.join(dOld, `${old}_mobile.json`), JSON.stringify({ captureFiles: ['record_2026-10-10_10-00-00.jpg', '../evil.txt'] }));
  fs.writeFileSync(path.join(caps, 'record_2026-10-10_10-00-00.jpg'), 'x');
  fs.writeFileSync(path.join(path.dirname(caps), 'evil.txt'), 'x');
  const dVenue = put(root, venue, { source: 'td-native' });
  const dRecent = put(root, recent, { source: 'mobile' });
  const past = new Date(Date.now() - 48 * 3600_000);
  for (const d of [dOld, dVenue]) fs.utimesSync(path.join(d, `${path.basename(d)}_prompts.json`), past, past);
  assert.equal(purgeExpiredMobile(root, caps, 24), 1);
  assert.equal(fs.existsSync(dOld), false);
  assert.equal(fs.existsSync(path.join(caps, 'record_2026-10-10_10-00-00.jpg')), false);
  assert.equal(fs.existsSync(path.join(path.dirname(caps), 'evil.txt')), true);
  assert.equal(fs.existsSync(dVenue), true);
  assert.equal(fs.existsSync(dRecent), true);
  assert.equal(purgeExpiredMobile(root, caps, 0), 0);
});
