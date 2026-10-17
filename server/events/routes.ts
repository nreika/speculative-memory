import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import { CaptureEventStore, groupFailureRuns, parseDisplayLog } from './captureEvents';

export interface EventRoutesOptions {
  /** Directory holding generation archives (<root>/<date>/<generationId>/...), for thumbnails of old captures. */
  archiveRoot?: string;
  viewerPath?: string;
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

  app.get('/api/events/:captureId', (req, res) => {
    const event = store.get(req.params.captureId);
    if (!event) return res.status(404).json({ error: 'unknown captureId' });
    res.json({ ...event, prompts: readPrompts(event.archiveDir) });
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
