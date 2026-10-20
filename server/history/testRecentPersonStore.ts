/**
 * Persistent test-scope recent-person state (G-01/G-02 for scoped test playback).
 * The in-memory ScopedTestHistory / TestPersonFrames were empty after every server restart until the loop replayed an
 * occupied frame again, so unoccupied test captures skipped all scenes (no_recent_activity). This store keeps the
 * occupied replayed frames (record + source frame) under
 *   <data>/state/test-recent-person/<sha256(historyScope)[0..16]>/<frameId>.json|.jpg
 * with the same limits (<= maxFrames per scope, <= maxScopes, window by replayedAt) and reloads them on startup.
 * Never touches logs/scene-history.jsonl (venue history). If the directory is unavailable it works in memory only.
 * Archive recovery (no model call): the newest archived prompts.json of the same historyScope whose detector saw a person.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ReplayedOriginalObservation } from './historyDisplay';

export const DEFAULT_TEST_RECENT_PERSON_DIR = 'C:\\Users\\nmrei\\GitHub\\speculative-memory_data\\state\\test-recent-person';

interface StoredFrame { row: ReplayedOriginalObservation; image: string }
interface StoreOptions {
  dir: string | null;
  windowMin?: number | (() => number);
  maxScopes?: number;
  maxFrames?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export const scopeHash = (historyScope: string) => createHash('sha256').update(historyScope).digest('hex').slice(0, 16);
const safeName = (frameId: string) => frameId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96) || 'frame';
const time = (row: { replayedAt: string }) => Date.parse(row.replayedAt);

function decodeDataUrl(dataUrl: string): { buffer: Buffer; ext: string } | null {
  const m = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/is.exec(dataUrl);
  if (!m) return null;
  return { buffer: Buffer.from(m[2], 'base64'), ext: m[1].toLowerCase() === 'png' ? 'png' : 'jpg' };
}

export class TestRecentPersonStore {
  private scopes = new Map<string, StoredFrame[]>();
  private dir: string | null;
  private warned = false;
  private readonly windowMin: () => number;
  private readonly maxScopes: number;
  private readonly maxFrames: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(opts: StoreOptions) {
    const w = opts.windowMin ?? 10;
    this.windowMin = typeof w === 'function' ? w : () => w;
    this.maxScopes = opts.maxScopes ?? 12;
    this.maxFrames = opts.maxFrames ?? 4;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(m));
    this.dir = opts.dir;
    if (this.dir) {
      try { fs.mkdirSync(this.dir, { recursive: true }); this.load(); }
      catch (error) { this.unavailable(error); }
    }
  }

  get persistent(): boolean { return this.dir !== null; }

  private unavailable(error: unknown): void {
    if (!this.warned) this.log(`[history] test recent-person state dir unavailable (${String((error as Error)?.message ?? error)}); in-memory only`);
    this.warned = true;
    this.dir = null;
  }

  private scopeDir(scopeKey: string): string | null { return this.dir ? path.join(this.dir, scopeHash(scopeKey)) : null; }

  private removeFiles(scopeKey: string, frameId: string): void {
    const d = this.scopeDir(scopeKey);
    if (!d) return;
    for (const ext of ['json', 'jpg', 'png']) { try { fs.rmSync(path.join(d, `${safeName(frameId)}.${ext}`), { force: true }); } catch { /* best effort */ } }
  }

  private removeScope(scopeKey: string): void {
    const d = this.scopeDir(scopeKey);
    this.scopes.delete(scopeKey);
    if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  }

  private load(): void {
    const loaded: Array<{ scope: string; frame: StoredFrame }> = [];
    for (const sub of fs.readdirSync(this.dir!, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const d = path.join(this.dir!, sub.name);
      for (const file of fs.readdirSync(d)) {
        if (!file.endsWith('.json')) continue;
        try {
          const doc = JSON.parse(fs.readFileSync(path.join(d, file), 'utf8'));
          const row = doc?.row as ReplayedOriginalObservation | undefined;
          if (doc?.schema !== 1 || typeof doc.historyScope !== 'string' || scopeHash(doc.historyScope) !== sub.name || !row || !Number.isFinite(time(row))) continue;
          const imagePath = path.join(d, path.basename(String(doc.imageFile ?? '')));
          if (!doc.imageFile || !fs.existsSync(imagePath)) continue;
          const mime = imagePath.endsWith('.png') ? 'png' : 'jpeg';
          loaded.push({ scope: doc.historyScope, frame: { row, image: `data:image/${mime};base64,${fs.readFileSync(imagePath).toString('base64')}` } });
        } catch { /* skip a corrupt record */ }
      }
    }
    loaded.sort((a, b) => time(a.frame.row) - time(b.frame.row));
    for (const { scope, frame } of loaded) this.insert(scope, frame);
    this.evictExpired();
    // Scope dirs left without a loadable, in-window record are removed (expired or corrupt state).
    for (const sub of fs.readdirSync(this.dir!, { withFileTypes: true })) {
      if (sub.isDirectory() && ![...this.scopes.keys()].some((k) => scopeHash(k) === sub.name)) {
        try { fs.rmSync(path.join(this.dir!, sub.name), { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
    const frames = [...this.scopes.values()].reduce((n, f) => n + f.length, 0);
    if (frames) this.log(`[history] test recent-person state loaded: ${frames} frame(s) in ${this.scopes.size} scope(s)`);
  }

  /** Memory-side insert with limits (oldest frame / least recently touched scope evicted, files too). */
  private insert(scopeKey: string, frame: StoredFrame): void {
    const frames = (this.scopes.get(scopeKey) ?? []).filter((f) => f.row.frameId !== frame.row.frameId);
    frames.push(frame);
    frames.sort((a, b) => time(a.row) - time(b.row));
    while (frames.length > this.maxFrames) { const old = frames.shift()!; this.removeFiles(scopeKey, old.row.frameId); }
    this.scopes.delete(scopeKey);
    this.scopes.set(scopeKey, frames);
    while (this.scopes.size > this.maxScopes) this.removeScope(this.scopes.keys().next().value!);
  }

  /** Drop frames older than the window (by replayedAt) from memory and disk. */
  evictExpired(): void {
    const since = this.now() - this.windowMin() * 60_000;
    for (const [scopeKey, frames] of [...this.scopes]) {
      const keep = frames.filter((f) => time(f.row) >= since);
      if (keep.length === frames.length) continue;
      for (const f of frames) if (!keep.includes(f)) this.removeFiles(scopeKey, f.row.frameId);
      if (!keep.length) this.removeScope(scopeKey); else this.scopes.set(scopeKey, keep);
    }
  }

  /** Remember an occupied replayed frame of a test scope (record + source frame data URL); persisted when possible. */
  remember(scopeKey: string, row: ReplayedOriginalObservation, imageDataUrl: string): void {
    const copy: ReplayedOriginalObservation = { ...row, people: row.people?.map((p) => ({ ...p })) };
    this.insert(scopeKey, { row: copy, image: imageDataUrl });
    const d = this.scopeDir(scopeKey);
    const decoded = decodeDataUrl(imageDataUrl);
    if (!d || !decoded || !this.scopes.get(scopeKey)?.some((f) => f.row === copy)) return;
    try {
      fs.mkdirSync(d, { recursive: true });
      const imageFile = `${safeName(copy.frameId)}.${decoded.ext}`;
      // Image first: a record is loadable only once its image exists.
      fs.writeFileSync(path.join(d, imageFile), decoded.buffer);
      fs.writeFileSync(path.join(d, `${safeName(copy.frameId)}.json`), JSON.stringify({ schema: 1, historyScope: scopeKey, frameId: copy.frameId, originalCaptureId: copy.originalCaptureId, replayedAt: copy.replayedAt, imageFile, row: copy }, null, 1), 'utf8');
    } catch (error) { this.unavailable(error); }
  }

  /** Occupied replayed frames of this scope within the window, oldest first (copies). */
  observations(scopeKey: string): ReplayedOriginalObservation[] {
    this.evictExpired();
    return (this.scopes.get(scopeKey) ?? []).map((f) => ({ ...f.row, people: f.row.people?.map((p) => ({ ...p })) }));
  }

  frame(scopeKey: string, originalCaptureId: string): string | undefined {
    const frames = this.scopes.get(scopeKey) ?? [];
    for (let i = frames.length - 1; i >= 0; i -= 1) if (frames[i].row.originalCaptureId === originalCaptureId) return frames[i].image;
    return undefined;
  }
}

/** Merge replayed observations from several sources, de-duplicated by frame + replay time, oldest first. */
export function mergeReplayed(...lists: ReadonlyArray<readonly ReplayedOriginalObservation[]>): ReplayedOriginalObservation[] {
  const seen = new Set<string>();
  const out: ReplayedOriginalObservation[] = [];
  for (const list of lists) for (const row of list) {
    const key = `${row.frameId}|${row.originalCaptureId}|${row.replayedAt}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(row);
  }
  return out.sort((a, b) => time(a) - time(b));
}

export interface ArchiveRecoveredPerson { row: ReplayedOriginalObservation; imageDataUrl: string; minutesAgo: number; dir: string }

/**
 * Newest archived capture of this historyScope whose detector saw a person within the window: its _NOW.jpg + guard.people.
 * Reads <archiveRoot>/<YYYY-MM-DD>/<generationId>/<generationId>_prompts.json, newest first (last two date folders).
 */
export function recoverTestPersonFromArchive(opts: {
  archiveRoot: string; historyScope: string; windowMin: number; now?: number;
  excludeDir?: string | null; excludeFrameId?: string; maxFolders?: number;
}): ArchiveRecoveredPerson | null {
  const now = opts.now ?? Date.now();
  const since = now - opts.windowMin * 60_000;
  const exclude = opts.excludeDir ? path.resolve(opts.excludeDir) : null;
  let budget = opts.maxFolders ?? 400;
  let days: string[];
  try { days = fs.readdirSync(opts.archiveRoot).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse().slice(0, 2); }
  catch { return null; }
  for (const day of days) {
    let names: string[];
    try { names = fs.readdirSync(path.join(opts.archiveRoot, day)).sort().reverse(); } catch { continue; }
    for (const name of names) {
      if (budget-- <= 0) return null;
      const dir = path.join(opts.archiveRoot, day, name);
      if (exclude && path.resolve(dir) === exclude) continue;
      let doc: any;
      try { doc = JSON.parse(fs.readFileSync(path.join(dir, `${name}_prompts.json`), 'utf8')); } catch { continue; }
      const t = Date.parse(doc?.capturedAt);
      if (!Number.isFinite(t) || t > now + 60_000) continue;
      // Folders are chronological; allow a small margin before stopping.
      if (t < since - 5 * 60_000) return null;
      if (t < since) continue;
      const hc = doc?.historyContext;
      const guard = doc?.vlm?.guard;
      if (hc?.historyScope !== opts.historyScope || guard?.detector?.person !== true) continue;
      if (opts.excludeFrameId && hc.testFrameId === opts.excludeFrameId) continue;
      const people = (Array.isArray(guard.people) ? guard.people : []).filter((p: any) => p && typeof p.clothes === 'string');
      if (!people.length) continue;
      let nowFile: string | undefined;
      try { nowFile = fs.readdirSync(dir).find((f) => /_NOW\.(jpe?g|png)$/i.test(f)); } catch { continue; }
      if (!nowFile) continue;
      let image: Buffer;
      try { image = fs.readFileSync(path.join(dir, nowFile)); } catch { continue; }
      const cached = hc.cachedObservation ?? {};
      const row: ReplayedOriginalObservation = {
        sceneId: String(hc.testSceneId ?? ''),
        frameId: String(hc.testFrameId ?? name),
        sourceImageSha256: String(cached.sourceImageSha256 ?? ''),
        originalCaptureId: String(cached.originalCaptureId ?? doc.captureId ?? name),
        sourceObservedAt: typeof cached.sourceObservedAt === 'string' ? cached.sourceObservedAt : null,
        observation: typeof doc.nowText === 'string' ? doc.nowText : '',
        detectorPerson: true,
        people: people.map((p: any) => ({
          position: String(p.position ?? ''), pose: String(p.pose ?? ''), clothes: p.clothes, facing: String(p.facing ?? ''),
          ...(typeof p.hair === 'string' ? { hair: p.hair } : {}),
          ...(Array.isArray(p.headBox) && p.headBox.length === 4 ? { headBox: p.headBox } : {}),
        })),
        replayedAt: new Date(t).toISOString(),
      };
      const mime = /\.png$/i.test(nowFile) ? 'png' : 'jpeg';
      return { row, imageDataUrl: `data:image/${mime};base64,${image.toString('base64')}`, minutesAgo: Math.max(0, Math.round((now - t) / 60_000)), dir };
    }
  }
  return null;
}
