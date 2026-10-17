/**
 * Glue for the continuous local QA: the queue (between captures only), the log files, prompts.json / capture-events
 * patches, the automatic rulebook improvement and the HTTP routes (/api/qa, /api/qa/summary, /api/qa/proposals, /api/rulebook).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import type { CaptureEventStore } from '../events/captureEvents';
import { getRulebook, listVersions, readActive } from '../generation/rulebook';
import { configFromEnv, defaultPaths, listProposals, ollamaTextLlm, readChanges, readState, runCycle, type ImproverPaths } from './improver';
import { parseGuidelines } from './guidelines';
import { QaQueue, appendQaRow, judgeImage, patchPromptsJson, readQaRows, summarizeQa, type QaRow } from './localJudge';

export interface QaSceneJob {
  captureId: string;
  sceneKey: string;
  /** Absolute paths of the source frame and the generated image. */
  nowPath: string;
  imagePath: string;
  predictionPrompt: string;
  archiveDir?: string | null;
  rulebookVersion: number;
  /** Scenes of this capture (the capture summary is written when all of them are judged). */
  sceneCount: number;
  test?: boolean;
}

export interface QaServiceOptions {
  isBusy: () => boolean;
  events?: CaptureEventStore;
  paths?: ImproverPaths;
  enabled?: boolean;
  autoImprove?: boolean;
  /** Test hooks. */
  judge?: typeof judgeImage;
}

const mime = (f: string) => (/\.png$/i.test(f) ? 'image/png' : 'image/jpeg');
const dataUrl = (f: string) => `data:${mime(f)};base64,${fs.readFileSync(f).toString('base64')}`;

export class QaService {
  readonly queue: QaQueue;
  private readonly paths: ImproverPaths;
  private readonly perCapture = new Map<string, QaRow[]>();
  readonly enabled: boolean;
  private readonly autoImprove: boolean;
  private readonly judge: typeof judgeImage;

  constructor(private readonly opts: QaServiceOptions) {
    this.paths = opts.paths ?? defaultPaths();
    this.enabled = opts.enabled ?? (process.env.QA_LOCAL_ENABLED ?? 'true').toLowerCase() !== 'false';
    this.autoImprove = opts.autoImprove ?? (process.env.QA_AUTO_IMPROVE ?? 'true').toLowerCase() !== 'false';
    this.judge = opts.judge ?? judgeImage;
    this.queue = new QaQueue(opts.isBusy, { canStart: () => this.windowOpen() });
  }

  private starts: number[] = [];
  /** A job (3 short calls, ~10 s) must fit before the next capture is expected: captures follow the TD timer evenly. */
  private static readonly JOB_MARGIN_MS = 12_000;

  /** Expected start of the next venue capture (epoch ms), from the last start-to-start intervals; null when they are irregular. */
  nextStartEstimate(): number | null {
    if (this.starts.length < 4) return null;
    const iv = this.starts.slice(1).map((t, i) => t - this.starts[i]);
    const sorted = [...iv].sort((a, b) => a - b);
    if (sorted[sorted.length - 1] > sorted[0] * 1.3) return null;
    return this.starts[this.starts.length - 1] + sorted[Math.floor(sorted.length / 2)];
  }

  private windowOpen(now = Date.now()): boolean {
    const est = this.nextStartEstimate();
    if (est === null) return true;
    // overdue by more than 30 s = the timer stopped: no prediction
    return now > est + 30_000 || now + QaService.JOB_MARGIN_MS < est;
  }

  /** Whether QA tools outside the server (backfill) may run a ~10 s job right now. */
  idleWindow(): boolean {
    return !this.opts.isBusy() && this.windowOpen();
  }

  /** Call when a capture starts: the running QA call is aborted and the rest waits. */
  interruptForCapture(venue = true): void {
    this.queue.interrupt();
    if (venue) {
      this.starts.push(Date.now());
      if (this.starts.length > 6) this.starts.shift();
    }
  }

  enqueueScene(job: QaSceneJob): void {
    if (!this.enabled || job.test) return;
    const dropped = this.queue.trim(12);
    if (dropped > 0) console.error(`[qa] backlog: dropped ${dropped} old job(s)`);
    this.queue.enqueue({
      captureId: job.captureId,
      sceneKey: job.sceneKey,
      run: async (signal) => {
        const result = await this.judge({ nowImage: dataUrl(job.nowPath), image: dataUrl(job.imagePath), predictionPrompt: job.predictionPrompt }, { signal });
        if (signal.aborted) return; // interrupted by a capture: the queue puts the job back
        const row: QaRow = {
          time: new Date().toISOString(),
          captureId: job.captureId,
          sceneKey: job.sceneKey,
          file: path.basename(job.imagePath),
          ...result,
          rulebookVersion: job.rulebookVersion,
        };
        this.record(row, job);
      },
    });
  }

  private record(row: QaRow, job: QaSceneJob): void {
    appendQaRow(this.paths.qaFile, row);
    patchPromptsJson(job.archiveDir, row.sceneKey, {
      ok: row.ok,
      score: row.score,
      defects: row.defects,
      model: row.model,
      elapsedMs: row.elapsedMs,
      rulebookVersion: row.rulebookVersion,
      error: row.error,
      at: row.time,
    });
    console.log(
      `[qa] ${row.captureId} ${row.sceneKey}: ${row.ok === null ? `unknown (${row.error})` : row.ok ? 'ok' : `defects ${row.defects.map((d) => d.type).join(',')}`} score=${row.score ?? '-'} ${(row.elapsedMs / 1000).toFixed(1)}s`
    );
    const list = this.perCapture.get(row.captureId) ?? [];
    list.push(row);
    this.perCapture.set(row.captureId, list);
    if (list.length >= job.sceneCount) {
      this.perCapture.delete(row.captureId);
      const defects: Record<string, number> = {};
      for (const r of list) for (const t of new Set(r.defects.map((d) => d.type))) defects[t] = (defects[t] ?? 0) + 1;
      try {
        this.opts.events?.patch(row.captureId, {
          qa: {
            judged: list.filter((r) => r.ok !== null).length,
            defective: list.filter((r) => r.ok === false).length,
            defects,
            elapsedMs: list.reduce((s, r) => s + r.elapsedMs, 0),
            at: new Date().toISOString(),
          },
        });
      } catch {
        /* the log must never stop QA */
      }
      if (this.autoImprove) this.scheduleImprove();
    }
    while (this.perCapture.size > 50) this.perCapture.delete(this.perCapture.keys().next().value as string);
  }

  /** One improvement check after a capture's QA finished (cheap unless N captures were reached). */
  private scheduleImprove(): void {
    this.queue.enqueue({
      captureId: 'improver',
      sceneKey: 'cycle',
      run: async () => {
        try {
          const llm = (process.env.QA_IMPROVE_LLM ?? 'true').toLowerCase() !== 'false' ? ollamaTextLlm() : null;
          const r = await runCycle({ paths: this.paths, config: configFromEnv(), llm });
          if (r.action !== 'wait') console.error(`[improver] ${r.action} v${r.version}: ${r.detail}`);
        } catch (error) {
          console.error('[improver] cycle failed:', error);
        }
      },
    });
  }

  registerRoutes(app: Express): void {
    const paths = this.paths;
    const nonTest = (rows: QaRow[]) => rows.filter((r) => !r.test);
    app.get('/api/qa', (req, res) => {
      const limit = Math.min(Math.max(Math.floor(Number(req.query.limit)) || 100, 1), 2000);
      const rows = readQaRows(paths.qaFile);
      const est = this.nextStartEstimate();
      res.json({ enabled: this.enabled, queue: this.queue.length, nextCaptureEstimate: est ? new Date(est).toISOString() : null, idleWindow: this.idleWindow(), rows: rows.slice(-limit).reverse() });
    });
    app.get('/api/qa/summary', (req, res) => {
      const day = typeof req.query.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day) ? req.query.day : null;
      const by = req.query.by === 'rulebookVersion' ? 'rulebookVersion' : req.query.by === 'day' ? 'day' : 'none';
      // The "day" of a row is its local day (rows hold UTC ISO times).
      const local = (iso: string) => {
        const d = new Date(iso);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      };
      const rows = nonTest(readQaRows(paths.qaFile)).filter((r) => !day || local(r.time) === day);
      res.json({ day, by, groups: summarizeQa(rows, by) });
    });
    // rulebook/USER_GUIDELINES.md (G-xx, fixed: the automatic improvement never edits it): list + addition history for /logs.
    app.get('/api/guidelines', (_req, res) => {
      try {
        res.json(parseGuidelines(fs.readFileSync(path.join(process.cwd(), 'rulebook', 'USER_GUIDELINES.md'), 'utf8')));
      } catch {
        res.status(404).json({ error: 'USER_GUIDELINES.md not found' });
      }
    });
    app.get('/api/qa/proposals', (_req, res) => {
      res.json({ proposals: listProposals(paths), pending: readState(paths).pending });
    });
    app.get('/api/rulebook', (req, res) => {
      const rb = getRulebook();
      const state = readState(paths);
      res.json({
        active: readActive() ?? { version: rb.version },
        versions: listVersions(),
        rejected: state.rejected,
        validated: state.validated,
        changes: readChanges(paths, Math.min(Math.max(Number(req.query.limit) || 50, 1), 500)),
        config: configFromEnv(),
        rulebook: req.query.full === '1' ? rb : undefined,
      });
    });
  }
}
