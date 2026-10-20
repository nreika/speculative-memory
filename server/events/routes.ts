import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import { CaptureEventStore, groupFailureRuns, parseDisplayLog } from './captureEvents';

export interface EventRoutesOptions {
  /** Directory holding generation archives (<root>/<date>/<generationId>/...), for thumbnails of old captures. */
  archiveRoot?: string;
  viewerPath?: string;
  /** History thumbnails: known thumbs become `thumbUrls`; missing ones are queued in the background. */
  thumbs?: { thumbUrl(imageUrl: unknown): string | null; requestMissing(imageUrl: unknown): void };
  /** G-27 scenario CSV runs; the timeline response carries `scenarioRuns` so History can draw each run's range. */
  scenarioRuns?: { list(): Array<{runId:string;scenarioId:string;file:string;sha256:string;startedAt:string;endedAt:string|null;endReason:string|null;cuesApplied:number}> };
}

/** Compact run rows for the timeline (sidecar details come from /api/scenario-runs/:runId). */
export function timelineScenarioRuns(source: EventRoutesOptions['scenarioRuns']) {
  if (!source) return [];
  try {
    return source.list().slice(-500).map((r) => ({ runId: r.runId, scenarioId: r.scenarioId, file: r.file, sha256: r.sha256, startedAt: r.startedAt, endedAt: r.endedAt ?? null, endReason: r.endReason ?? null, cuesApplied: r.cuesApplied ?? 0 }));
  } catch {
    return [];
  }
}

/** Adds `thumbUrls` ({now,a,b,c} -> '/captures/thumbs/<name>.jpg' | null) next to each event's `images`. */
export function withThumbUrls<T extends { images?: unknown }>(events: T[], thumbs: EventRoutesOptions['thumbs']): Array<T & { thumbUrls?: Record<string, string | null> }> {
  if (!thumbs) return events;
  return events.map((event) => {
    const images = event.images;
    if (!images || typeof images !== 'object') return event;
    const thumbUrls: Record<string, string | null> = {};
    for (const [key, url] of Object.entries(images as Record<string, unknown>)) {
      if (typeof url !== 'string') continue;
      const thumb = thumbs.thumbUrl(url);
      if (!thumb) thumbs.requestMissing(url);
      thumbUrls[key] = thumb;
    }
    return { ...event, thumbUrls };
  });
}

const flag = (v: unknown) => v !== undefined && v !== '0' && v !== 'false';

function readPrompts(dir: string | null | undefined): unknown {
  if (!dir) return null;
  try {
    const name = fs.readdirSync(dir).find((f) => f.endsWith('_prompts.json'));
    return name ? JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) : null;
  } catch {
    return null;
  }
}

const ARCHIVE_IMAGE = { now: /_NOW\.(jpg|jpeg|png)$/i, a: /_A\.png$/i, b: /_B\.png$/i, c: /_C\.png$/i } as const;

export function registerEventRoutes(app: Express, store: CaptureEventStore, opts: EventRoutesOptions = {}): void {
  const viewerPath = opts.viewerPath ?? path.join(process.cwd(), 'server', 'events', 'viewer.html');

  app.get('/logs', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(viewerPath, (err) => {
      if (err && !res.headersSent) res.status(404).send('viewer.html not found');
    });
  });

  app.get('/api/events/summary', (req, res) => {
    res.json(store.summary(typeof req.query.day === 'string' ? req.query.day : undefined));
  });

  app.get('/api/events', (req, res) => {
    const q = req.query;
    const events = store.query({
      limit: q.limit !== undefined ? Number(q.limit) : undefined,
      before: typeof q.before === 'string' ? q.before : undefined,
      failedOnly: flag(q.failedOnly),
      extras: flag(q.extras),
      people: flag(q.people),
      gemini: flag(q.gemini),
    });
    res.json(flag(q.group) ? groupFailureRuns(events) : events);
  });

  app.get('/api/events/timeline', (req, res) => {
    res.setHeader('Cache-Control','no-store');
    const q=req.query;
    if(Object.keys(q).some(k=>!['limit','cursor'].includes(k))||q.limit!==undefined&&(typeof q.limit!=='string'||!/^\d+$/.test(q.limit))||q.cursor!==undefined&&typeof q.cursor!=='string')return res.status(400).json({error:'Invalid timeline query'});
    try {const page=store.timeline({...(q.limit!==undefined?{limit:Number(q.limit)}:{}),...(q.cursor!==undefined?{cursor:q.cursor as string}:{})});const body=opts.thumbs?{...page,events:withThumbUrls(page.events,opts.thumbs)}:page;res.json(opts.scenarioRuns?{...body,scenarioRuns:timelineScenarioRuns(opts.scenarioRuns)}:body);}
    catch(error){if((error as any)?.status===400)return res.status(400).json({error:(error as Error).message});res.status(500).json({error:'Timeline unavailable'});}
  });

  app.get('/api/events/:captureId', (req, res) => {
    const event = store.get(req.params.captureId);
    if (!event) return res.status(404).json({ error: 'unknown captureId' });
    res.json({ ...withThumbUrls([event], opts.thumbs)[0], prompts: readPrompts(event.archiveDir) });
  });

  // Thumbnail fallback for captures whose /captures image is gone or never recorded (backfilled rows).
  app.get('/api/events/:captureId/image/:which', (req, res) => {
    const which = req.params.which as keyof typeof ARCHIVE_IMAGE;
    const event = store.get(req.params.captureId);
    const re = ARCHIVE_IMAGE[which];
    if (!event?.archiveDir || !re) return res.status(404).end();
    try {
      const root = path.resolve(opts.archiveRoot ?? path.dirname(path.dirname(event.archiveDir)));
      const dir = path.resolve(event.archiveDir);
      if (!dir.startsWith(root + path.sep)) return res.status(404).end();
      const file = fs.readdirSync(dir).find((f) => re.test(f));
      if (!file) return res.status(404).end();
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(path.join(dir, file));
    } catch {
      res.status(404).end();
    }
  });

  app.post('/api/display-log', (req, res) => {
    const parsed = parseDisplayLog(req.body);
    if (!parsed) return res.status(400).json({ error: 'captureId and assignments[] are required' });
    store.addDisplay(parsed.captureId, parsed.entry);
    res.json({ ok: true });
  });
}
