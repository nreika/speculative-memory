import type { Express } from 'express';

export interface HealthResult {
  ok: true;
  comfyui: boolean;
  ollama: boolean;
  time: string;
}

export interface HealthOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  comfyUrl?: () => string;
  ollamaUrl?: () => string;
  timeoutMs?: number;
  cacheMs?: number;
}

/** true iff GET url answers 2xx within timeoutMs. Never throws. */
export async function probe(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        ctrl.abort();
        resolve(false);
      }, timeoutMs);
    });
    const req = (async () => {
      const res = await fetchImpl(url, { signal: ctrl.signal });
      return res.ok;
    })().catch(() => false);
    return await Promise.race([req, timeout]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Returns a checker that caches the result for cacheMs (concurrent calls share one probe). */
export function createHealthChecker(opts: HealthOptions = {}): () => Promise<HealthResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const comfyUrl = opts.comfyUrl ?? (() => (process.env.COMFYUI_URL || 'http://127.0.0.1:8000').replace(/\/$/, ''));
  const ollamaUrl = opts.ollamaUrl ?? (() => (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''));
  const timeoutMs = opts.timeoutMs ?? 2000;
  const cacheMs = opts.cacheMs ?? 5000;
  let cached: { at: number; value: HealthResult } | null = null;
  let inflight: Promise<HealthResult> | null = null;
  return async () => {
    if (cached && now() - cached.at < cacheMs) return cached.value;
    if (inflight) return inflight;
    inflight = (async () => {
      const [comfyui, ollama] = await Promise.all([
        probe(fetchImpl, `${comfyUrl()}/system_stats`, timeoutMs),
        probe(fetchImpl, `${ollamaUrl()}/api/tags`, timeoutMs),
      ]);
      const value: HealthResult = { ok: true, comfyui, ollama, time: new Date(now()).toISOString() };
      cached = { at: now(), value };
      return value;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

/** GET /api/health -> { ok, comfyui, ollama, time } (always 200, cached 5 s). */
export function registerHealthRoutes(app: Express, opts: HealthOptions = {}): void {
  const check = createHealthChecker(opts);
  app.get('/api/health', async (_req, res) => {
    try {
      res.json(await check());
    } catch {
      res.json({ ok: true, comfyui: false, ollama: false, time: new Date().toISOString() });
    }
  });
}
