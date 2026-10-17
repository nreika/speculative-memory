import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import { detectPerson, type PersonDetectResult } from './personDetect';

/** POST /api/detect-person { image: dataURL } -> { person, count?, elapsedMs, model, error? } (always 200). */
export function registerPresenceRoutes(app: Express, logsDir: string = path.join(process.cwd(), 'logs')): void {
  const logPath = path.join(logsDir, 'presence.jsonl');
  const log = (r: PersonDetectResult) => {
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      const line = {
        time: new Date().toISOString(),
        person: r.person,
        count: r.count ?? null,
        elapsedMs: r.elapsedMs,
        ...(r.error ? { error: r.error } : {}),
      };
      fs.appendFileSync(logPath, JSON.stringify(line) + '\n', 'utf8');
    } catch (error) {
      console.error('[presence] log write failed:', error);
    }
  };
  app.post('/api/detect-person', async (req, res) => {
    const result = await detectPerson(req.body?.image);
    log(result);
    res.json(result);
  });
}
