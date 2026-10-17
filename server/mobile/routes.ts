/**
 * Phone page (/m) and its API. Everything here is behind mobileAccessGuard (Tailscale/LAN/loopback only).
 *   GET  /m                                  the page (server/mobile/index.html)
 *   GET  /api/mobile/captures?limit&source=venue|mobile|all&captureId=   newest first, from the generation archive
 *   GET  /api/archive-image/:generationId/:file                           archive images only (strict names)
 *   POST /api/mobile/generate                body like /api/generate -> { jobId }
 *   GET  /api/mobile/job/:id                 state, queue position, estimated wait, result
 *   POST /api/mobile/job/:id/cancel          cancels a queued job
 *   GET  /api/mobile/status                  venue lane + phone queue
 */
import path from 'node:path';
import type { Express, RequestHandler } from 'express';
import { listArchive, resolveArchiveImage, type MobileSourceFilter } from './archiveList';
import type { MobileQueue } from './queue';

export interface MobilePayload {
  body: Record<string, unknown>;
  remoteAddress: string | undefined;
}

export interface MobileRouteDeps {
  guard: RequestHandler;
  archiveRoot: string;
  queue: MobileQueue<MobilePayload>;
  venueSnapshot: () => unknown;
  pagePath?: string;
}

const SOURCES = new Set(['venue', 'mobile', 'all']);
const DATA_URL = /^data:image\/(jpeg|png|webp);base64,/i;

export function registerMobileRoutes(app: Express, deps: MobileRouteDeps): void {
  const page = deps.pagePath ?? path.join(process.cwd(), 'server', 'mobile', 'index.html');

  app.get('/m', deps.guard, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(page, (err) => {
      if (err && !res.headersSent) res.status(404).send('index.html not found');
    });
  });

  app.get('/api/mobile/captures', deps.guard, (req, res) => {
    const source = SOURCES.has(String(req.query.source)) ? (String(req.query.source) as MobileSourceFilter) : 'venue';
    const captureId = typeof req.query.captureId === 'string' ? req.query.captureId.replace(/[^a-zA-Z0-9_-]/g, '') : undefined;
    const limit = Number(req.query.limit);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      items: listArchive(deps.archiveRoot, {
        limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
        source,
        captureId: captureId || undefined,
      }),
    });
  });

  app.get('/api/archive-image/:generationId/:file', deps.guard, (req, res) => {
    const file = resolveArchiveImage(deps.archiveRoot, String(req.params.generationId), String(req.params.file));
    if (!file) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  app.post('/api/mobile/generate', deps.guard, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.image !== 'string' || !DATA_URL.test(body.image)) {
      return res.status(400).json({ error: 'image (data URL, jpeg/png/webp) is required' });
    }
    try {
      const job = deps.queue.enqueue({ body, remoteAddress: req.socket.remoteAddress });
      res.json({ jobId: job.id, ...deps.queue.describe(job.id) });
    } catch (error) {
      res.status(429).json({ error: String((error as Error).message) });
    }
  });

  app.get('/api/mobile/job/:id', deps.guard, (req, res) => {
    const info = deps.queue.describe(String(req.params.id));
    res.setHeader('Cache-Control', 'no-store');
    if (!info) return res.status(404).json({ error: 'unknown job' });
    res.json(info);
  });

  app.post('/api/mobile/job/:id/cancel', deps.guard, (req, res) => {
    res.json({ cancelled: deps.queue.cancel(String(req.params.id)) });
  });

  app.get('/api/mobile/status', deps.guard, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const running = deps.queue.runningJob;
    res.json({
      venue: deps.venueSnapshot(),
      mobile: { queued: deps.queue.queuedCount, running: running ? running.id : null },
    });
  });
}
