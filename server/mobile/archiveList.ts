/**
 * Read side of the generation archive for the phone page, plus the retention rule for phone captures.
 *   <root>/<YYYY-MM-DD>/<generationId>/<generationId>_prompts.json ...
 */
import fs from 'node:fs';
import path from 'node:path';

const GENERATION_ID = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;
const IMAGE_NAME = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})_(NOW\.(?:jpg|jpeg|png)|[A-J]\.(?:png|jpg|jpeg|webp))$/i;

export type MobileSourceFilter = 'venue' | 'mobile' | 'all';

export interface MobileScene {
  key: string;
  letter: string;
  distanceSec: number;
  imageUrl: string | null;
  sceneText: string;
}

export interface MobileCaptureItem {
  generationId: string;
  captureId: string;
  source: string;
  capturedAt: string;
  status: string;
  scenes: MobileScene[];
  nowUrl: string | null;
  nowText: string;
  vlmBackend: string | null;
  vlmModel: string | null;
  imageBackend: string | null;
  imageModel: string | null;
  params: { presence?: number; tone?: number } | null;
}

export const imageUrlFor = (generationId: string, file: string) =>
  `/api/archive-image/${generationId}/${encodeURIComponent(file)}`;

/**
 * Absolute path of an archive image, or null. Only <root>/<date>/<generationId>/<generationId>_<NOW|A..J>.<ext>
 * is reachable: ids and names are matched against strict patterns, so "..", separators and absolute paths never pass.
 */
export function resolveArchiveImage(root: string, generationId: string, filename: string): string | null {
  if (!GENERATION_ID.test(generationId)) return null;
  const m = IMAGE_NAME.exec(filename);
  if (!m || m[1] !== generationId) return null;
  const rootAbs = path.resolve(root);
  const file = path.resolve(rootAbs, generationId.slice(0, 10), generationId, filename);
  if (!file.startsWith(rootAbs + path.sep)) return null;
  return file;
}

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Pure conversion of one prompts.json document. */
export function toMobileItem(doc: any): MobileCaptureItem | null {
  const generationId = String(doc?.generationId ?? '');
  if (!GENERATION_ID.test(generationId)) return null;
  const scenes: MobileScene[] = Array.isArray(doc.scenes)
    ? doc.scenes.map((s: any, i: number) => ({
        key: String(s?.sceneKey ?? `gen_${String.fromCharCode(97 + i)}`),
        letter: String(s?.letter ?? String.fromCharCode(65 + i)),
        distanceSec: num(s?.distanceSec, num(doc?.params?.sceneDistancesSec?.[i])),
        imageUrl: typeof s?.file === 'string' ? imageUrlFor(generationId, s.file) : null,
        sceneText: String(s?.scenarioDescription ?? '').trim(),
      }))
    : [];
  const parsed = Array.isArray(doc?.vlm?.parsedScenarios) ? doc.vlm.parsedScenarios : [];
  const nowText = String(doc?.nowText ?? parsed.map((p: any) => p?.scene_now).find((t: unknown) => typeof t === 'string' && t.trim()) ?? '').trim();
  return {
    generationId,
    captureId: String(doc.captureId ?? ''),
    source: String(doc.source ?? ''),
    capturedAt: String(doc.capturedAt ?? ''),
    status: String(doc.status ?? ''),
    scenes,
    nowUrl: typeof doc.sourceFile === 'string' ? imageUrlFor(generationId, doc.sourceFile) : null,
    nowText,
    vlmBackend: doc.vlmBackend ?? null,
    vlmModel: doc.vlmModel ?? null,
    imageBackend: doc.imageBackend ?? null,
    imageModel: doc.imageModel ?? null,
    params: doc.params ? { presence: doc.params.presence, tone: doc.params.tone } : null,
  };
}

export const matchesSource = (source: string, filter: MobileSourceFilter): boolean =>
  filter === 'all' ? true : filter === 'mobile' ? source === 'mobile' : source === 'td-native' || source === 'browser';

const readDirs = (p: string) => {
  try {
    return fs.readdirSync(p).sort();
  } catch {
    return [];
  }
};

/** Newest first. Walks date folders from the newest, stops once `limit` finished items are found. */
export function listArchive(
  root: string,
  opts: { limit?: number; source?: MobileSourceFilter; captureId?: string; includeIncomplete?: boolean } = {}
): MobileCaptureItem[] {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
  const source = opts.source ?? 'all';
  const out: MobileCaptureItem[] = [];
  const days = readDirs(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).reverse();
  for (const day of days) {
    const ids = readDirs(path.join(root, day)).filter((d) => GENERATION_ID.test(d)).reverse();
    for (const id of ids) {
      const file = path.join(root, day, id, `${id}_prompts.json`);
      let doc: any;
      try {
        doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      const item = toMobileItem(doc);
      if (!item || !matchesSource(item.source, source)) continue;
      if (opts.captureId && item.captureId !== opts.captureId) continue;
      if (!opts.includeIncomplete && (item.status !== 'completed' || !item.scenes.length)) continue;
      out.push(item);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// ---- retention of phone captures -------------------------------------------------

export interface RetentionEntry {
  dir: string;
  generationId: string;
  source: string;
  /** Epoch ms of the capture (generation id is Tokyo local time; file mtime is used instead). */
  mtimeMs: number;
}

/** Only source=mobile folders older than `hours` (0 or negative = keep forever). */
export function selectExpired(entries: RetentionEntry[], nowMs: number, hours: number): RetentionEntry[] {
  if (!(hours > 0)) return [];
  const cutoff = nowMs - hours * 3600_000;
  return entries.filter((e) => e.source === 'mobile' && e.mtimeMs < cutoff);
}

export function scanRetentionEntries(root: string): RetentionEntry[] {
  const out: RetentionEntry[] = [];
  for (const day of readDirs(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
    for (const id of readDirs(path.join(root, day)).filter((d) => GENERATION_ID.test(d))) {
      const dir = path.join(root, day, id);
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(dir, `${id}_prompts.json`), 'utf8'));
        const source = String(doc?.source ?? '');
        if (source !== 'mobile') continue;
        out.push({ dir, generationId: id, source, mtimeMs: fs.statSync(path.join(dir, `${id}_prompts.json`)).mtimeMs });
      } catch {
        // unreadable folder: never a deletion candidate
      }
    }
  }
  return out;
}

/**
 * Deletes expired phone-capture folders (and the loose copies in the captures dir listed in <id>_mobile.json).
 * Returns the number of folders removed. Never touches anything that is not source=mobile.
 */
export function purgeExpiredMobile(root: string, capturesDir: string | null, hours: number, nowMs = Date.now()): number {
  let removed = 0;
  for (const e of selectExpired(scanRetentionEntries(root), nowMs, hours)) {
    try {
      const rootAbs = path.resolve(root);
      if (!path.resolve(e.dir).startsWith(rootAbs + path.sep)) continue;
      if (capturesDir) {
        try {
          const side = JSON.parse(fs.readFileSync(path.join(e.dir, `${e.generationId}_mobile.json`), 'utf8'));
          for (const f of Array.isArray(side?.captureFiles) ? side.captureFiles : []) {
            const name = path.basename(String(f));
            if (/^(record|Gen_[abc])_[\w.-]+$/i.test(name)) fs.rmSync(path.join(capturesDir, name), { force: true });
          }
        } catch {
          // no sidecar
        }
      }
      fs.rmSync(e.dir, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      console.error('[mobile] retention: failed to remove', e.dir, error);
    }
  }
  return removed;
}
