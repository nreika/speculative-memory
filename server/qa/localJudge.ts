/**
 * Continuous image QA with the local Qwen3-VL (Ollama, free): every generated image is compared with its source
 * frame (_NOW) after a capture finished, between captures. Result: { ok, score, defects[{type, where, note}] }.
 *
 *   - never runs while a capture is generating (QaQueue waits; a new /api/generate interrupts the running call)
 *   - a failed call is ok:null (unknown), never "ok"
 *   - results: logs/qa-local.jsonl, the archive's prompts.json (scene.qaLocal), capture-events (qa summary)
 * Paid Gemini is never called from here (that is server/qa/imageJudge.ts, QA_ENABLED=false).
 */
import fs from 'node:fs';
import path from 'node:path';
import { GRID_THRESHOLD_IMAGE, gridScore } from './gridDetect';

export const DEFECT_TYPES = [
  'fabricated_object',
  'fabricated_person',
  'missing_object',
  'floating',
  'implausible_placement',
  'anatomy',
  'scale',
  'screen_changed',
  'mismatch',
  // Reserved by rulebook/USER_GUIDELINES.md (G-11 / G-13); the 4B model does not detect these reliably yet.
  'hair_mismatch',
  'arms_raised',
  // Machine-detected (server/qa/gridDetect.ts): screen-door grid on skin.
  'grid',
  // G-14 / G-15 (user-approved 2026-10-16)
  'lost_belongings',
  'new_face',
  // G-16 / G-07 supplement (user-approved 2026-10-17)
  'new_text_or_clock',
  'obstruction_removed',
  // G-07 supplement 2 (2026-10-17): something behind the obstruction is drawn in front of it / too sharp
  'depth_order_broken',
  'other',
] as const;
export type DefectType = (typeof DEFECT_TYPES)[number];

export interface QaDefect {
  type: DefectType;
  where: string;
  note: string;
}

export interface LocalJudgeResult {
  ok: boolean | null;
  score: number | null;
  defects: QaDefect[];
  model: string;
  elapsedMs: number;
  error?: string;
}

export interface QaRow extends LocalJudgeResult {
  time: string;
  captureId: string;
  sceneKey: string;
  file: string | null;
  rulebookVersion: number | null;
  test?: boolean;
  /** Judged afterwards from the archive by scripts/qa-backfill.ts (baseline), not live. */
  backfill?: boolean;
}

const DEFECT_SET = new Set<string>(DEFECT_TYPES);

/** Free-text type -> the fixed classification (unknown words become "other"). */
export function normalizeDefectType(raw: unknown): DefectType {
  const t = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (DEFECT_SET.has(t)) return t as DefectType;
  if (/person|people|human|figure/.test(t) && /fabric|extra|added|new|invent/.test(t)) return 'fabricated_person';
  if (/fabric|added|extra|new_object|invent|hallucin/.test(t)) return 'fabricated_object';
  if (/missing|disappear|vanish|removed|lost/.test(t)) return 'missing_object';
  if (/float|levitat|hover/.test(t)) return 'floating';
  if (/placement|implausible|physic|gravity|\bhang/.test(t)) return 'implausible_placement';
  if (/new_?text|text_or_clock|garbled|clock|digit/.test(t)) return 'new_text_or_clock';
  if (/depth_?order|in_front_of_(the_)?(mesh|chair)|pasted/.test(t)) return 'depth_order_broken';
  if (/obstruction|removed_?obstruct|backrest_?removed/.test(t)) return 'obstruction_removed';
  if (/lost_?belong|belongings|held_?item|dropped_?item/.test(t)) return 'lost_belongings';
  if (/new_?face|face_?turn|turned_?around|frontal_?face|face_?drawn/.test(t)) return 'new_face';
  if (/grid|screen_?door|moire/.test(t)) return 'grid';
  if (/hair/.test(t)) return 'hair_mismatch';
  if (/arms?_?raised|raised_arm|banzai/.test(t)) return 'arms_raised';
  if (/anatom|hand|arm|finger|limb|body|face/.test(t)) return 'anatomy';
  if (/scale|size|giant|oversize|enlarg/.test(t)) return 'scale';
  if (/screen|monitor|display/.test(t)) return 'screen_changed';
  if (/mismatch|prompt|instruction/.test(t)) return 'mismatch';
  return 'other';
}

const clip = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function parseJson(raw: unknown): any | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

/** One list item of the model (string, or an object such as {object_type, location}) as a short string. */
function itemText(v: unknown): string {
  if (typeof v === 'string') return clip(v, 80);
  if (v && typeof v === 'object') {
    return clip(
      Object.values(v as Record<string, unknown>)
        .filter((x) => typeof x === 'string')
        .join(' '),
      80
    );
  }
  return '';
}

function itemList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v.slice(0, 6)) {
    const t = itemText(x);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export interface PairAnswer {
  added: string[];
  removed: string[];
}

/** {"added":[...], "removed":[...]} of the pair comparison. null = unusable. */
export function parsePairAnswer(raw: unknown): PairAnswer | null {
  const j = parseJson(raw);
  if (!j || typeof j !== 'object' || !('added' in j || 'removed' in j)) return null;
  return { added: itemList(j.added), removed: itemList(j.removed) };
}

/** {"defects":[{type, where, note}]} of the single-image check (floating / anatomy / scale / implausible_placement only). */
export function parseSingleAnswer(raw: unknown): QaDefect[] | null {
  const j = parseJson(raw);
  if (!j || typeof j !== 'object' || !('defects' in j)) return null;
  const out: QaDefect[] = [];
  for (const d of (Array.isArray(j.defects) ? j.defects : []).slice(0, 4)) {
    if (!d || typeof d !== 'object') continue;
    const type = normalizeDefectType(d.type);
    if (!['floating', 'anatomy', 'scale', 'implausible_placement', 'hair_mismatch', 'arms_raised', 'other'].includes(type)) continue;
    out.push({ type, where: clip(d.where, 80), note: clip(d.note, 160) });
  }
  return out;
}

const PERSON_NOUN = /\b(person|people|man|men|woman|women|boy|girl|human|figure|someone|staff|worker|child|kid|silhouette|student|visitor|he|she|head|face|hair)\b/i;
const STOP = new Set(['a', 'an', 'the', 'of', 'on', 'in', 'at', 'to', 'and', 'with', 'by', 'near', 'left', 'right', 'center', 'centre', 'front', 'back', 'behind', 'side', 'middle', 'top', 'bottom', 'foreground', 'background', 'image', 'photo', 'visible', 'small', 'large', 'big', 'white', 'black', 'beige', 'gray', 'grey', 'brown', 'red', 'blue', 'green', 'dark', 'light', 'pair']);
const stem = (w: string) => w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '');
const nouns = (t: string) =>
  t
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(stem);

/** Whether the instruction names the thing (the edit asked for it), by noun overlap. */
function askedByInstruction(item: string, instruction: string): boolean {
  if (PERSON_NOUN.test(item) && PERSON_NOUN.test(instruction)) return true;
  const inst = new Set(nouns(instruction));
  return nouns(item).some((n) => inst.has(n));
}

const TEXT_ITEM = /\b(clock|digits?|numbers?|text|writing|timestamp|time display|ui|interface|characters?|letters?)\b/i;
const OBSTRUCTION_ITEM = /\b(backrest|chair back|headrest|obstruct\w*|foreground chair)\b/i;
const HELD_ITEM = /\b(microphone|mic|phone|smartphone|mug|cup|bottle|tablet|badge|umbrella|folder|clipboard|held|holding|carried)\b/i;

export interface PairEvidence {
  /** A: [NOW, image] answer. B: [image, NOW] answer (its "added" are things the image lacks). */
  a: PairAnswer | null;
  b: PairAnswer | null;
  single: QaDefect[] | null;
}

/** Pure classification of the three model answers into defects (instruction-requested changes are not defects). */
export function classifyEvidence(ev: PairEvidence, instruction: string): QaDefect[] {
  const defects: QaDefect[] = [];
  const seen = new Set<string>();
  const push = (type: DefectType, where: string, note: string) => {
    const key = `${type}|${nouns(where).join(' ')}`;
    if (seen.has(key)) return;
    seen.add(key);
    defects.push({ type, where: clip(where, 80), note: clip(note, 160) });
  };
  const addedInImage = [...(ev.a?.added ?? []), ...(ev.b?.removed ?? [])];
  const missingInImage = [...(ev.a?.removed ?? []), ...(ev.b?.added ?? [])];
  for (const item of addedInImage) {
    if (askedByInstruction(item, instruction)) continue;
    if (TEXT_ITEM.test(item)) push('new_text_or_clock', item, `${item}: text, digits or a clock appear that are not in the original`);
    else if (PERSON_NOUN.test(item)) push('fabricated_person', item, `${item}: appears in the image but not in the original`);
    else push('fabricated_object', item, `${item}: appears in the image but not in the original`);
  }
  for (const item of missingInImage) {
    if (askedByInstruction(item, instruction)) continue;
    // Things people carry or hold (G-14) are their own class; a vanished near-camera obstruction (chair back) too.
    if (OBSTRUCTION_ITEM.test(item)) push('obstruction_removed', item, `${item}: blocked the view in the original but is gone in the image`);
    else if (HELD_ITEM.test(item)) push('lost_belongings', item, `${item}: held/carried in the original but missing in the image`);
    else push('missing_object', item, `${item}: is in the original but missing in the image`);
  }
  for (const d of ev.single ?? []) push(d.type, d.where, d.note);
  return defects;
}

const PAIR_PROMPT = (a: string, b: string) =>
  `${a} is a photo of a room. ${b} is another photo of the same room taken a moment later. ` +
  `Compare them. List the physical things (objects, furniture, bags, clothes, people) that are visible in ${b} but NOT visible in ${a} ("added"), and the things visible in ${a} but NOT visible in ${b} ("removed"). ` +
  'Ignore lighting, colour and screen glow. Short noun phrases with the place, at most 4 each; use empty lists if nothing. JSON only: {"added":[],"removed":[]}';

export const SINGLE_PROMPT =
  'Inspect this photo for rendering defects only: objects floating in the air or hanging in an impossible way, malformed or extra hands/arms/fingers, distorted face, a person duplicated, an object near the camera that is absurdly huge. ' +
  'Report only clear defects. JSON only: {"defects":[{"type":"floating|anatomy|scale|implausible_placement","where":"...","note":"..."}]}';

export const buildPairPrompt = () => PAIR_PROMPT('IMAGE 1', 'IMAGE 2');

const DATA_URL = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/;
const bare = (u: string): string | null => u.match(DATA_URL)?.[1] ?? null;

export interface JudgeOptions {
  ollamaUrl?: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Three short calls on the local Qwen: A = what the image added/removed vs the source, B = the same with the images swapped
 * (independent evidence), C = single-image rendering defects. The 4B model does not judge "is this defective" reliably
 * when asked directly (it answers "ok" every time), but lists differences well, so the verdict is classified here from
 * those lists.
 */
export async function judgeImage(
  args: { nowImage: string; image: string; predictionPrompt: string },
  options: JudgeOptions = {}
): Promise<LocalJudgeResult> {
  const started = Date.now();
  const ollamaUrl = (options.ollamaUrl ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = options.model ?? process.env.QA_LOCAL_MODEL ?? process.env.VLM_MODEL ?? 'qwen3-vl:4b-instruct';
  const fail = (error: string): LocalJudgeResult => ({ ok: null, score: null, defects: [], model, elapsedMs: Date.now() - started, error });
  const now = bare(args.nowImage);
  const img = bare(args.image);
  if (!now || !img) return fail('images must be data:image/...;base64 URLs');
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 90_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const call = async (prompt: string, images: string[]): Promise<string> => {
    const res = await (options.fetchImpl ?? fetch)(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        images,
        stream: false,
        think: false,
        format: 'json',
        keep_alive: process.env.OLLAMA_KEEP_ALIVE ?? '5m',
        // num_ctx 4096 = the same as the capture's person-detect and history-summary calls: a different value makes Ollama reload the runner
        // (+5 s on the next capture's first call, measured). Two photos + prompt + answer are ~2.8k tokens.
        options: { temperature: 0, num_predict: 256, num_ctx: 4096, repeat_penalty: 1.3 },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const body = (await res.json()) as { response?: string };
    return String(body.response ?? '');
  };
  try {
    const rawA = await call(buildPairPrompt(), [now, img]);
    const rawB = await call(buildPairPrompt(), [img, now]);
    const rawC = await call(SINGLE_PROMPT, [img]);
    const ev: PairEvidence = { a: parsePairAnswer(rawA), b: parsePairAnswer(rawB), single: parseSingleAnswer(rawC) };
    if (!ev.a && !ev.b) return fail(`unparseable answer: ${rawA.slice(0, 80)}`);
    const defects = classifyEvidence(ev, args.predictionPrompt);
    // Machine check (no model call): skin-tile FFT. QA_GRID_THRESHOLD overrides the whole-image threshold (default -0.1).
    try {
      const g = gridScore(Buffer.from(img, 'base64'));
      const limit = Number(process.env.QA_GRID_THRESHOLD ?? GRID_THRESHOLD_IMAGE);
      if (g && g.score !== null && g.score > limit) defects.push({ type: 'grid', where: 'skin', note: `skin grid suspected: log10(high/mid)=${g.score} over ${g.tiles} tiles` });
    } catch {
      /* the machine check never blocks the verdict */
    }
    return {
      ok: defects.length === 0,
      score: Math.max(0, Math.round((1 - 0.25 * defects.length) * 100) / 100),
      defects,
      model,
      elapsedMs: Date.now() - started,
    };
  } catch (err: any) {
    const aborted = options.signal?.aborted;
    return fail(aborted ? 'interrupted' : err?.name === 'TimeoutError' ? 'timeout' : String(err?.message ?? err));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Queue: one job at a time, never while a capture is generating, interrupted by a new capture.
// ---------------------------------------------------------------------------------------------------------------------

export interface QaJob {
  captureId: string;
  sceneKey: string;
  run: (signal: AbortSignal) => Promise<void>;
}

export class QaQueue {
  private jobs: Array<QaJob & { attempts: number }> = [];
  private running: { job: QaJob & { attempts: number }; ctl: AbortController } | null = null;
  private loop: Promise<void> | null = null;
  private stopped = false;
  constructor(
    private readonly isBusy: () => boolean,
    private readonly opts: { pollMs?: number; maxAttempts?: number; /** false = do not start now (e.g. the next capture is about to begin). */ canStart?: () => boolean } = {}
  ) {}

  get length(): number {
    return this.jobs.length + (this.running ? 1 : 0);
  }

  enqueue(job: QaJob): void {
    this.jobs.push({ ...job, attempts: 0 });
    this.kick();
  }

  /** Drops the oldest waiting jobs beyond `max` (QA is best effort: a backlog is never worth slowing a capture). */
  trim(max: number): number {
    const extra = this.jobs.length - max;
    if (extra <= 0) return 0;
    this.jobs.splice(0, extra);
    return extra;
  }

  /** A capture starts: abort the running job (it goes back to the front of the queue) and hold the rest. */
  interrupt(): void {
    if (this.running) this.running.ctl.abort();
  }

  /** Wait until nothing is queued or running (tests). */
  async idle(): Promise<void> {
    while (this.loop) await this.loop;
  }

  stop(): void {
    this.stopped = true;
    this.interrupt();
  }

  private kick(): void {
    if (this.loop || this.stopped) return;
    this.loop = this.drain().finally(() => {
      this.loop = null;
      if (this.jobs.length > 0 && !this.stopped) this.kick();
    });
  }

  private async drain(): Promise<void> {
    const poll = this.opts.pollMs ?? 1000;
    while (this.jobs.length > 0 && !this.stopped) {
      if (this.isBusy() || (this.opts.canStart && !this.opts.canStart())) {
        await new Promise((r) => setTimeout(r, poll));
        continue;
      }
      const job = this.jobs.shift()!;
      const ctl = new AbortController();
      this.running = { job, ctl };
      try {
        await job.run(ctl.signal);
      } catch (error) {
        console.error('[qa] job failed:', error);
      }
      this.running = null;
      if (ctl.signal.aborted) {
        job.attempts += 1;
        if (job.attempts < (this.opts.maxAttempts ?? 5)) this.jobs.unshift(job);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Storage and aggregation
// ---------------------------------------------------------------------------------------------------------------------

export function appendQaRow(file: string, row: QaRow): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  } catch (error) {
    console.error('[qa] log write failed (continuing):', error);
  }
}

export function readQaRows(file: string): QaRow[] {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows: QaRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.captureId === 'string') rows.push(r as QaRow);
    } catch {
      /* torn line */
    }
  }
  return rows;
}

/** Adds scene.qaLocal into <dir>/*_prompts.json (after the archive's final flush). Returns whether it was written. */
export function patchPromptsJson(archiveDir: string | null | undefined, sceneKey: string, qaLocal: unknown): boolean {
  if (!archiveDir) return false;
  try {
    const name = fs.readdirSync(archiveDir).find((f) => f.endsWith('_prompts.json'));
    if (!name) return false;
    const p = path.join(archiveDir, name);
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    const scene = Array.isArray(doc.scenes) ? doc.scenes.find((s: any) => s.sceneKey === sceneKey) : null;
    if (!scene) return false;
    scene.qaLocal = qaLocal;
    fs.writeFileSync(p, JSON.stringify(doc, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export interface QaSummaryGroup {
  key: string;
  images: number;
  judged: number;
  unknown: number;
  defective: number;
  defectRate: number | null;
  byType: Record<string, { count: number; rate: number | null }>;
  avgScore: number | null;
  avgElapsedMs: number | null;
}

/** Defect rate = images with >= 1 defect / images with a verdict (ok:null is counted separately). */
export function summarizeQa(rows: QaRow[], by: 'rulebookVersion' | 'day' | 'none' = 'none'): QaSummaryGroup[] {
  const groups = new Map<string, QaRow[]>();
  for (const r of rows) {
    const key = by === 'rulebookVersion' ? String(r.rulebookVersion ?? 'none') : by === 'day' ? String(r.time).slice(0, 10) : 'all';
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  const out: QaSummaryGroup[] = [];
  for (const [key, list] of groups) {
    const judged = list.filter((r) => r.ok !== null);
    const defective = judged.filter((r) => r.ok === false);
    const byType: QaSummaryGroup['byType'] = {};
    for (const r of defective) for (const t of new Set(r.defects.map((d) => d.type))) byType[t] = { count: (byType[t]?.count ?? 0) + 1, rate: null };
    for (const t of Object.keys(byType)) byType[t].rate = judged.length ? round3(byType[t].count / judged.length) : null;
    const scores = judged.map((r) => r.score).filter((n): n is number => typeof n === 'number');
    const times = list.map((r) => r.elapsedMs).filter((n) => Number.isFinite(n));
    out.push({
      key,
      images: list.length,
      judged: judged.length,
      unknown: list.length - judged.length,
      defective: defective.length,
      defectRate: judged.length ? round3(defective.length / judged.length) : null,
      byType,
      avgScore: scores.length ? round3(scores.reduce((s, n) => s + n, 0) / scores.length) : null,
      avgElapsedMs: times.length ? Math.round(times.reduce((s, n) => s + n, 0) / times.length) : null,
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
