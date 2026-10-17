/**
 * One-off import of past captures into logs/capture-events.jsonl.
 *   - every archived capture (<archive>/<date>/<id>/<id>_prompts.json) from --since (default 2026-10-15)
 *   - "[capture] failed|cancelled <id>" lines of logs/server.log for ids the archive does not know
 * Captures already present in the events file are skipped, so a re-run adds nothing.
 *
 *   npx tsx scripts/backfill-capture-events.ts [--since 2026-10-15] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { CaptureEventStore, costForCapture, type CaptureEvent } from '../server/events/captureEvents';
import { archiveRootDir } from '../server/archive/generationArchive';

const args = process.argv.slice(2);
const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : '2026-10-15';
const dryRun = args.includes('--dry-run');
const logsDir = path.join(process.cwd(), 'logs');
const usagePath = path.join(logsDir, 'usage.jsonl');
const store = new CaptureEventStore(path.join(logsDir, 'capture-events.jsonl'), path.join(logsDir, 'display-log.jsonl'), usagePath);
const known = new Set(store.readAll().map((e) => e.captureId));

/** td-<epoch ms>-<n> -> ISO; null for other ids. */
const isoFromCaptureId = (id: string): string | null => {
  const m = /^td-(\d{12,14})-\d+$/.exec(id);
  return m ? new Date(Number(m[1])).toISOString() : null;
};
const isoFromGenerationId = (g: string): string | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(g);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString() : null;
};

const rows: CaptureEvent[] = [];
const counts = { completed: 0, failed: 0, cancelled: 0, running: 0, fromLog: 0, skippedKnown: 0, skippedTest: 0, unreadable: 0 };

const root = archiveRootDir();
for (const day of fs.existsSync(root) ? fs.readdirSync(root).sort() : []) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < since) continue;
  for (const gen of fs.readdirSync(path.join(root, day))) {
    const dir = path.join(root, day, gen);
    let doc: any;
    try {
      const file = fs.readdirSync(dir).find((f) => f.endsWith('_prompts.json'));
      if (!file) continue;
      doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      counts.unreadable++;
      continue;
    }
    const captureId: string = doc.captureId;
    if (!captureId) continue;
    if (known.has(captureId)) {
      counts.skippedKnown++;
      continue;
    }
    const isTest = doc.source === 'test' || /test/i.test(captureId);
    const startedAt = isoFromCaptureId(captureId) ?? isoFromGenerationId(doc.generationId) ?? new Date(doc.capturedAt).toISOString();
    const timings = doc.timings ?? {};
    const guard = doc.vlm?.guard;
    const scenes: any[] = doc.scenes ?? [];
    let result: CaptureEvent['result'] = doc.status === 'completed' || doc.status === 'failed' || doc.status === 'cancelled' ? doc.status : 'running';
    if (result === 'running') {
      if (Date.now() - Date.parse(startedAt) < 15 * 60 * 1000) continue; // probably still in flight; the live row will cover it
      result = 'failed';
    }
    const errors: string[] = doc.errors ?? [];
    const expected = doc.params?.imageCount ?? 3;
    let errorStage: string | null = null;
    if (result !== 'completed') {
      errorStage = !doc.vlm ? 'plan' : scenes.length < expected ? `scene${String.fromCharCode(65 + scenes.length)}` : 'unknown';
    }
    const extras: NonNullable<CaptureEvent['extras']> = {};
    for (const s of scenes) {
      if (!s.sceneExtra) continue;
      const g = guard?.extras?.[s.sceneKey];
      extras[s.sceneKey] = { text: s.sceneExtra, reflected: g ? g.reflected : s.sceneExtraReflected ?? null, synthesized: !!g?.synthesized };
    }
    const totalMs: number | undefined = timings.totalMs;
    const ev: CaptureEvent = {
      captureId,
      source: isTest ? 'test' : doc.source,
      test: isTest || undefined,
      startedAt,
      endedAt: totalMs !== undefined ? new Date(Date.parse(startedAt) + totalMs).toISOString() : undefined,
      result,
      detectDescribeMs: guard?.detector?.elapsedMs ?? null,
      planMs: guard?.planMs ?? timings.vlmMs ?? null,
      planCalls: guard?.planCalls ?? null,
      sceneAMs: timings.sceneAMs ?? null,
      sceneBMs: timings.sceneBMs ?? null,
      sceneCMs: timings.sceneCMs ?? null,
      totalMs: totalMs ?? null,
      occupied: guard ? guard.unoccupied === false : null,
      occupancySource: guard?.occupancySource ?? null,
      people: Array.isArray(guard?.people) ? guard.people.length : null,
      guard: guard ? { synthesized: !!guard.synthesized, replaced: guard.replaced?.length ?? 0, duplicateRetried: !!guard.duplicateRetried } : undefined,
      extras: Object.keys(extras).length ? extras : undefined,
      vlmBackend: doc.vlmBackend ?? null,
      vlmModel: doc.vlmModel ?? null,
      imageBackend: doc.imageBackend ?? null,
      imageModel: doc.imageModel ?? null,
      cost: costForCapture(usagePath, captureId),
      errorStage,
      errorMessage: result === 'completed' ? null : errors.join(' / ') || null,
      archiveDir: dir,
      images: {},
      backfilled: true,
    };
    rows.push(ev);
    known.add(captureId);
    counts[result]++;
  }
}

// Failures/cancellations only in logs/server.log (no archive folder). The log has no timestamps: the id carries the time.
try {
  const log = fs.readFileSync(path.join(logsDir, 'server.log'), 'utf8');
  for (const line of log.split(/\r?\n/)) {
    const m = /^\[capture\] (failed|cancelled) (\S+?)(?::| \()(.*)$/.exec(line);
    if (!m || known.has(m[2]) || /test/i.test(m[2])) continue;
    const startedAt = isoFromCaptureId(m[2]);
    if (!startedAt || startedAt.slice(0, 10) < since) continue;
    const secs = /after ([\d.]+)s/.exec(m[3]);
    rows.push({
      captureId: m[2],
      source: 'td-native',
      startedAt,
      result: m[1] as 'failed' | 'cancelled',
      totalMs: secs ? Math.round(Number(secs[1]) * 1000) : null,
      errorStage: 'unknown',
      errorMessage: m[3].trim(),
      cost: 0,
      backfilled: true,
    });
    known.add(m[2]);
    counts.fromLog++;
  }
} catch {
  /* no server.log */
}

console.log(JSON.stringify({ since, dryRun, toWrite: rows.length, ...counts }, null, 2));
if (!dryRun) {
  for (const r of rows) store.write(r);
  console.log(`wrote ${rows.length} rows to ${store.filePath}`);
}
