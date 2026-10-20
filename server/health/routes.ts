import { remoteCamera } from '../remoteCamera';
import {defaultLocalImageEngine,selectedLocalImageUrl} from '../generation/imageEngine';
import type { Express } from 'express';

export interface HealthResult {
  ok: true;
  scenarioControlVersion?:1;
  scenarioControlCapabilities?:Record<string,unknown>;
  comfyui: boolean;
  comfyuiUrl?:string;
  localImageEngine?:string;
  localImageEngineReachable?:boolean;
  turbo?:{url:string;reachable:boolean};
  ollama: boolean;
  time: string;
  /** ComfyUI queue sizes (null when /queue does not answer). A growing `pending` with nothing finishing = hung job. */
  comfyQueue?: { running: number; pending: number } | null;
  /** From the ComfyUI watchdog (server/generation/comfyWatchdog.ts); added fresh to every answer, not cached. */
  lastTimeoutAt?: string | null;
  autoRestarts?: number;
  consecutiveTimeouts?: number;
  comfyAlert?: { level: string; message: string; since: string } | null;
}

export interface HealthOptions {
  /** Live watchdog state merged into the answer. */
  scenarioControlVersion?:1;
  scenarioControlCapabilities?:Record<string,unknown>;
  watchdogStatus?: () => { lastTimeoutAt: string | null; autoRestarts: number; consecutiveTimeouts: number; alert: { level: string; message: string; since: string } | null };
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
  const comfyUrl = opts.comfyUrl ?? (() => selectedLocalImageUrl());
  const ollamaUrl = opts.ollamaUrl ?? (() => (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''));
  const timeoutMs = opts.timeoutMs ?? 2000;
  const cacheMs = opts.cacheMs ?? 5000;
  let cached: { at: number; value: HealthResult } | null = null;
  let inflight: Promise<HealthResult> | null = null;
  return async () => {
    if (cached && now() - cached.at < cacheMs) return cached.value;
    if (inflight) return inflight;
    inflight = (async () => {
      const queueProbe = (async (): Promise<{ running: number; pending: number } | null> => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const res = await fetchImpl(`${comfyUrl()}/queue`, { signal: ctrl.signal });
          if (!res.ok) return null;
          const q = (await res.json()) as { queue_running?: unknown[]; queue_pending?: unknown[] };
          return { running: q.queue_running?.length ?? 0, pending: q.queue_pending?.length ?? 0 };
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      })();
      const localImageEngine=defaultLocalImageEngine();
      const selectedUrl=comfyUrl();
      const [comfyui, ollama] = await Promise.all([
        probe(fetchImpl, `${comfyUrl()}/system_stats`, timeoutMs),
        probe(fetchImpl, `${ollamaUrl()}/api/tags`, timeoutMs),
      ]);
      const value: HealthResult = { ok: true, comfyui, ollama, comfyuiUrl:selectedUrl,localImageEngine,localImageEngineReachable:comfyui,...(localImageEngine==='qwen21-turbo'?{turbo:{url:selectedUrl,reachable:comfyui}}:{}),time: new Date(now()).toISOString(), comfyQueue: await queueProbe };
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
    const wd = opts.watchdogStatus?.();
    const extra = wd
      ? { lastTimeoutAt: wd.lastTimeoutAt, autoRestarts: wd.autoRestarts, consecutiveTimeouts: wd.consecutiveTimeouts, comfyAlert: wd.alert }
      : {};
    // Remote phone camera (input "remote-device"): state 'stale' means captures are refused ("remote camera stale").
    const rc = remoteCamera.status();
    Object.assign(extra, { remoteCamera: { selected: rc.selected, state: rc.state, ageSec: rc.ageSec, ...(rc.selected && rc.state !== 'fresh' ? { message: 'remote camera stale' } : {}) } });
    try {
      res.json({ ...(await check()), ...extra, ...(opts.scenarioControlVersion?{scenarioControlVersion:opts.scenarioControlVersion,...(opts.scenarioControlCapabilities?{scenarioControlCapabilities:opts.scenarioControlCapabilities}:{})}:{}) });
    } catch {
      res.json({ ok: true, comfyui: false, ollama: false, time: new Date().toISOString(), comfyQueue: null, ...extra, ...(opts.scenarioControlVersion?{scenarioControlVersion:opts.scenarioControlVersion,...(opts.scenarioControlCapabilities?{scenarioControlCapabilities:opts.scenarioControlCapabilities}:{})}:{}) });
    }
  });
}
