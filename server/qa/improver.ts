import {sharedOllamaContextLength} from "../generation/sharedOllamaContext";
/**
 * Automatic rulebook improvement from the continuous QA (server/qa/localJudge.ts):
 *
 *   every N captures (QA_IMPROVE_EVERY, default 30) of the active version:
 *     1. verify the active version against its parent: defect rate (images with >= 1 defect) or the rate of a targeted
 *        defect type worse by >= QA_ROLLBACK_DELTA (default 0.05) -> automatic rollback, the version is "rejected" and the
 *        same change is never proposed again
 *     2. pick the top 1-2 defect types and build a SMALL change (<= 2 items, additive, only EDITABLE_PATHS of the rulebook:
 *        negative terms, one constraint sentence, guard vocabulary, one planner instruction line)
 *     3. apply it as version N+1 (rulebook.v<N+1>.json, active.json, CHANGELOG.md, logs/rulebook-changes.jsonl)
 *   it asks the user instead (logs/qa-proposals/<time>.md, nothing applied) when the change touches the artwork's
 *   expression (size of change, whether people appear, tone, presence/distance, kind of change in an empty room), does not
 *   fit in a few items, or the same defect type did not improve over 3 versions in a row.
 * Rulebook/USER_GUIDELINES.md (G-xx) is never edited here.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  EDITABLE_PATHS,
  getRulebook,
  listVersions,
  loadRulebook,
  readActive,
  rulebookDir,
  setActive,
  writeRulebook,
  type EditablePath,
  type Rulebook,
} from '../generation/rulebook';
import { mentionsPerson } from '../generation/scenarioGuard';
import { DEFECT_TYPES, readQaRows, latestQaRows, summarizeQa, completedQaCaptureIds, qaMetrics, type DefectType, type QaRow, type QaSummaryGroup } from './localJudge';

export interface Change {
  path: EditablePath;
  /** string for list paths (appended), string[] = one vocabulary group, number for numeric paths. */
  value: string | string[] | number;
}

export interface Proposal {
  changes: Change[];
  targets: DefectType[];
  reason: string;
  source: 'catalog' | 'llm';
}

export interface ImproverPaths {
  rulebookDir: string;
  logsDir: string;
  qaFile: string;
}

export function defaultPaths(): ImproverPaths {
  const logsDir = path.join(process.cwd(), 'logs');
  return { rulebookDir: rulebookDir(), logsDir, qaFile: path.join(logsDir, 'qa-local.jsonl') };
}

export interface ImproverConfig {
  /** Captures of the active version per cycle. */
  every: number;
  /** Worsening (as a fraction, 0.05 = 5 points) that triggers the rollback. */
  rollbackDelta: number;
  /** A type needs at least this many defective images in the window to be targeted. */
  minTypeCount: number;
  /** Overall defect rate under which nothing is changed. */
  quietRate: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ImproverConfig {
  const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    every: Math.max(1, Math.floor(num(env.QA_IMPROVE_EVERY, 30))),
    rollbackDelta: num(env.QA_ROLLBACK_DELTA, 0.05),
    minTypeCount: Math.max(1, Math.floor(num(env.QA_MIN_TYPE_COUNT, 3))),
    quietRate: num(env.QA_QUIET_RATE, 0.03),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------------------------

interface AppliedEntry {
  from: number;
  to: number;
  types: DefectType[];
  /** Per-type rate in the window that led to the change. */
  rateAtApply: Record<string, number>;
  /** Per-type rate measured on the new version's own window (filled by the next cycle). */
  rateAfter?: Record<string, number>;
  rolledBack?: boolean;
}

export interface ImproverState {
  /** Window start: rows older than this (time) are not part of the next cycle. */
  lastCycleAt: string | null;
  validated: Record<string, { time: string; rate: number | null; parentRate: number | null }>;
  rejected: Array<{ version: number; time: string; reason: string; changes: Change[] }>;
  applied: AppliedEntry[];
  /** One open "ask the user" proposal per key (defect type or 'general'): { file, time }. */
  pending: Record<string, { file: string; time: string }>;
}

const emptyState = (): ImproverState => ({ lastCycleAt: null, validated: {}, rejected: [], applied: [], pending: {} });
const stateFile = (p: ImproverPaths) => path.join(p.logsDir, 'rulebook-state.json');

export function readState(p: ImproverPaths): ImproverState {
  try {
    return { ...emptyState(), ...JSON.parse(fs.readFileSync(stateFile(p), 'utf8')) };
  } catch {
    return emptyState();
  }
}
function writeState(p: ImproverPaths, s: ImproverState): void {
  fs.mkdirSync(p.logsDir, { recursive: true });
  fs.writeFileSync(stateFile(p), JSON.stringify(s, null, 2), 'utf8');
}

function appendJsonl(file: string, row: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  } catch (error) {
    console.error('[improver] log write failed:', error);
  }
}

export const changesLogFile = (p: ImproverPaths) => path.join(p.logsDir, 'rulebook-changes.jsonl');
export const proposalsDir = (p: ImproverPaths) => path.join(p.logsDir, 'qa-proposals');

// ---------------------------------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------------------------------

/** Rows of venue and test captures judged with `version`, newest `captures` captures, optionally only after `since`. */
export function windowRows(rows: QaRow[], version: number, opts: { since?: string | null; captures?: number; before?: string | null } = {}): QaRow[] {
  let list = latestQaRows(rows).filter((r) => r.rulebookVersion === version);
  if (opts.since) list = list.filter((r) => r.time >= opts.since!);
  if (opts.before) list = list.filter((r) => r.time < opts.before!);
  const complete = completedQaCaptureIds(list);
  const order: string[] = [];
  for (const r of list) if (complete.has(r.captureId) && !order.includes(r.captureId)) order.push(r.captureId);
  if (opts.captures && order.length >= opts.captures) {
    const keep = new Set(order.slice(-opts.captures));
    const firstTime = list.find(r => keep.has(r.captureId))!.time;
    // Keep recent failed/incomplete captures as repair evidence without counting them towards the gate.
    list = list.filter(r => keep.has(r.captureId) || (!complete.has(r.captureId) && r.time >= firstTime));
  }
  return list;
}

export const captureCount = (rows: QaRow[]): number => completedQaCaptureIds(rows).size;

export function statsOf(rows: QaRow[]): QaSummaryGroup {
  return (
    summarizeQa(rows, 'none')[0] ?? { key: 'all', ...qaMetrics([]), rejected: qaMetrics([]), completedCaptures: 0 }
  );
}

const rateOf = (s: QaSummaryGroup, type: string): number => s.byType[type]?.rate ?? 0;

// ---------------------------------------------------------------------------------------------------------------------
// Candidate changes (a small catalog per defect type, tried in order) and validation
// ---------------------------------------------------------------------------------------------------------------------

type Candidate = Change;

const CATALOG: Partial<Record<DefectType, Candidate[]>> = {
  fabricated_object: [
    { path: 'negative.added', value: 'added objects, extra objects that are not in the original, new furniture, new bags' },
    { path: 'imagePrompt.extraConstraints', value: 'Every object in the result already exists in the input photo; keep the same number of chairs, bags, jackets and laptops as the input.' },
    { path: 'vlm.extraInstructions', value: 'Name only objects that are clearly visible in this photo; never introduce a chair, bag, jacket or laptop that is not visible.' },
  ],
  missing_object: [
    { path: 'imagePrompt.extraConstraints', value: 'Keep every object that is visible in the input photo, including bags, cups, papers and items on desks; none of them may disappear or be replaced.' },
    { path: 'negative.added', value: 'missing object, removed object, disappearing items' },
  ],
  floating: [
    { path: 'imagePrompt.extraConstraints', value: 'Every object has visible support: it rests on a desk, a floor or a seat and never hovers in mid-air.' },
    { path: 'negative.added', value: 'unsupported object, hovering items, objects in mid-air' },
  ],
  implausible_placement: [
    { path: 'imagePrompt.extraConstraints', value: 'Keep laptops, cups and papers on desks and bags on the floor or a seat; nothing balances on a chair back, a monitor or a cable.' },
    { path: 'negative.added', value: 'object balanced on chair back, laptop on chair back, unstable placement' },
  ],
  scale: [
    { path: 'imagePrompt.extraConstraints', value: 'Keep the relative size of near and far objects exactly as in the input; nothing close to the camera becomes larger or smaller.' },
    { path: 'negative.added', value: 'enlarged foreground, oversized object, distorted perspective' },
  ],
  screen_changed: [
    { path: 'imagePrompt.extraConstraints', value: 'Every screen keeps its exact content, brightness and position as in the input.' },
    { path: 'negative.added', value: 'different screen content, changed display image, extra screen' },
  ],
  anatomy: [
    { path: 'negative.added', value: 'extra fingers, extra arms, malformed hands, warped body, grid noise on skin, changed hairstyle' },
  ],
  other: [
    { path: 'negative.added', value: 'grid pattern, noise artifacts, banding, ghosting, warped furniture' },
  ],
};

/** Types whose remedy touches the artwork's expression: never applied automatically. */
const ASK_TYPES = new Set<DefectType>(['fabricated_person', 'mismatch']);

/** Words in a proposed sentence that mean it touches the expression (size of change, people, tone, presence, distance). */
const EXPRESSION_RE =
  /\b(tone|mood|atmosphere|dramatic|calm|subtle|bold|stronger|weaker|more change|less change|bigger change|smaller change|magnitude|amount of change|intensity|presence|distance|seconds?|minutes?|future|past|time span|people|person|human|crowd|enter(?:s|ing)?|appear(?:s|ing)?|someone|nobody|occupied|unoccupied|empty room|movement|motion)\b/i;

export interface Validation {
  ok: boolean;
  problems: string[];
  /** Reasons that make this an "ask the user" proposal (not applied automatically). */
  ask: string[];
}

const textOf = (c: Change): string => (Array.isArray(c.value) ? c.value.join(' ') : String(c.value));

export function validateChanges(changes: Change[], rb: Rulebook, rejected: ImproverState['rejected'] = []): Validation {
  const problems: string[] = [];
  const ask: string[] = [];
  if (changes.length === 0) problems.push('no changes');
  if (changes.length > 2) ask.push(`proposal has ${changes.length} items (more than the few allowed for automatic changes)`);
  const rejectedKeys = new Set(rejected.flatMap((r) => r.changes.map(changeKey)));
  for (const c of changes) {
    const kind = (EDITABLE_PATHS as Record<string, string>)[c.path];
    if (!kind) {
      ask.push(`path ${c.path} is not an automatically editable item`);
      continue;
    }
    if (kind === 'append-string') {
      if (typeof c.value !== 'string' || c.value.trim().length < 3 || c.value.length > 220) problems.push(`${c.path}: value must be a string of 3-220 chars`);
    } else if (kind === 'append-group') {
      if (!Array.isArray(c.value) || c.value.length < 1 || c.value.length > 8 || !c.value.every((w) => typeof w === 'string' && /^[a-z][a-z -]{1,30}$/i.test(w))) {
        problems.push(`${c.path}: value must be 1-8 plain words`);
      }
    } else if (kind.startsWith('number:')) {
      const [, lo, hi] = kind.split(':').map(Number);
      if (typeof c.value !== 'number' || !(c.value >= lo && c.value <= hi)) problems.push(`${c.path}: number must be in ${lo}..${hi}`);
    }
    const t = textOf(c);
    if (c.path === 'imagePrompt.extraConstraints' && mentionsPerson(t)) problems.push(`${c.path}: the empty-room template must stay free of person words (G-01)`);
    if (typeof c.value !== 'number' && EXPRESSION_RE.test(t)) ask.push(`"${t.slice(0, 60)}" touches the expression (change size, people, tone, presence or distance)`);
    if (rejectedKeys.has(changeKey(c))) problems.push(`${c.path}: this change was rejected by a rollback before`);
    if (alreadyThere(c, rb)) problems.push(`${c.path}: already in the rulebook`);
  }
  return { ok: problems.length === 0, problems, ask };
}

function changeKey(c: Change): string {
  return `${c.path}=${JSON.stringify(c.value).toLowerCase()}`;
}

function alreadyThere(c: Change, rb: Rulebook): boolean {
  const lower = (s: string) => s.trim().toLowerCase();
  switch (c.path) {
    case 'imagePrompt.extraConstraints':
      return rb.imagePrompt.extraConstraints.some((x) => lower(x) === lower(String(c.value)));
    case 'negative.added':
      return rb.negative.added.some((x) => lower(x) === lower(String(c.value)));
    case 'vlm.extraInstructions':
      return rb.vlm.extraInstructions.some((x) => lower(x) === lower(String(c.value)));
    case 'guard.extraEmptyRoomBannedWords':
      return rb.guard.extraEmptyRoomBannedWords.some((x) => lower(x) === lower(String(c.value)));
    case 'guard.extraObjectGroups':
      return rb.guard.extraObjectGroups.some((g) => lower(g.join(',')) === lower((c.value as string[]).join(',')));
    case 'guard.guardRetries':
      return rb.guard.guardRetries === c.value;
    case 'guard.timeBudgetMs':
      return rb.guard.timeBudgetMs === c.value;
  }
}

/** The rulebook with the changes applied as the next version (not written). */
export function applyToRulebook(rb: Rulebook, changes: Change[], meta: { note: string; now: Date; existing?: number[] }): Rulebook {
  const next: Rulebook = JSON.parse(JSON.stringify(rb));
  // Never reuse a version number (rejected versions stay on disk).
  next.version = Math.max(rb.version, ...(meta.existing ?? [])) + 1;
  next.parent = rb.version;
  next.createdAt = meta.now.toISOString();
  next.note = meta.note;
  for (const c of changes) {
    switch (c.path) {
      case 'imagePrompt.extraConstraints':
        next.imagePrompt.extraConstraints.push(String(c.value).trim());
        break;
      case 'negative.added':
        next.negative.added.push(String(c.value).trim());
        break;
      case 'vlm.extraInstructions':
        next.vlm.extraInstructions.push(String(c.value).trim());
        break;
      case 'guard.extraEmptyRoomBannedWords':
        next.guard.extraEmptyRoomBannedWords.push(String(c.value).trim());
        break;
      case 'guard.extraObjectGroups':
        next.guard.extraObjectGroups.push((c.value as string[]).map((w) => w.trim()));
        break;
      case 'guard.guardRetries':
        next.guard.guardRetries = Number(c.value);
        break;
      case 'guard.timeBudgetMs':
        next.guard.timeBudgetMs = Number(c.value);
        break;
    }
  }
  return next;
}

/** First catalog change per type (in ladder order) that is valid for this rulebook. */
export function catalogProposal(types: DefectType[], rb: Rulebook, rejected: ImproverState['rejected']): Proposal | null {
  const changes: Change[] = [];
  const hit: DefectType[] = [];
  for (const type of types) {
    for (const cand of CATALOG[type] ?? []) {
      const v = validateChanges([cand], rb, rejected);
      if (v.ok && v.ask.length === 0 && !changes.some((c) => c.path === cand.path && changeKey(c) === changeKey(cand))) {
        changes.push(cand);
        hit.push(type);
        break;
      }
    }
  }
  if (changes.length === 0) return null;
  return { changes, targets: hit, source: 'catalog', reason: `top defect types: ${hit.join(', ')}` };
}

// ---------------------------------------------------------------------------------------------------------------------
// Optional local-LLM wording (Qwen text call, schema-validated; falls back to the catalog)
// ---------------------------------------------------------------------------------------------------------------------

export type TextLlm = (prompt: string) => Promise<string>;

const TYPE_HINT: Partial<Record<DefectType, string>> = {
  fabricated_object: 'objects (chairs, bags, jackets, laptops...) appear that are not in the original photo',
  missing_object: 'objects of the original photo (bags, cups, items held in hands) disappear',
  floating: 'objects float in the air or have no support',
  implausible_placement: 'objects are placed where gravity does not allow (hanging on chair backs, balanced on cables)',
  scale: 'objects near the camera become far too large or small',
  screen_changed: 'what screens display, or the number of screens, changes',
  anatomy: 'bodies, hands or faces are malformed',
  other: 'visual artifacts such as noise grids, ghosting or warped furniture appear',
};

/**
 * Wording step for the local Qwen. It gets only the defect type (generic hint), never the raw QA notes: the 4B inspector's
 * notes name objects that are really in the room, and a rule built from them would suppress real objects.
 */
export function buildLlmPrompt(type: DefectType, rb: Rulebook): string {
  return (
    'You tune the prompt rules of an image-editing pipeline that edits a photo of an office (the camera never moves). ' +
    `A quality inspector often finds this defect in the edited photos: ${TYPE_HINT[type] ?? type}.\n` +
    'Write ONE short rule sentence in English that the image editor must follow to avoid it. ' +
    'Choose where it goes: "imagePrompt.extraConstraints" (about objects, support, size or screens; it is also used for empty rooms, so NEVER use words about people, hands or arms) ' +
    'or "vlm.extraInstructions" (tells the scenario writer what NOT to write). Max 25 words, general, no concrete object colours.\n' +
    `Rules already present, do not repeat them: ${[...rb.imagePrompt.extraConstraints, ...rb.vlm.extraInstructions].join(' | ') || '(none)'}\n` +
    'Do not change how big the change is, whether people appear, the tone, or time distances. ' +
    'JSON only: {"changes":[{"path":"...","value":"..."}]}'
  );
}

/** Parses and schema-checks an LLM answer into changes (invalid answers return null). */
export function parseLlmChanges(raw: string, rb: Rulebook, rejected: ImproverState['rejected']): Change[] | null {
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      j = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  const list = Array.isArray(j?.changes) ? j.changes : null;
  if (!list || list.length === 0 || list.length > 2) return null;
  // Negative-prompt terms never come from the LLM (a term such as "laptops" would suppress real laptops): catalog only.
  const allowed = new Set<string>(['imagePrompt.extraConstraints', 'vlm.extraInstructions']);
  const changes: Change[] = [];
  for (const c of list) {
    if (!c || typeof c.path !== 'string' || typeof c.value !== 'string' || !allowed.has(c.path)) return null;
    const value = c.value.replace(/\s+/g, ' ').trim();
    if (value.split(' ').length > 40 || value.split(' ').length < 4) return null;
    changes.push({ path: c.path as EditablePath, value });
  }
  const v = validateChanges(changes, rb, rejected);
  return v.ok && v.ask.length === 0 ? changes : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Proposal markdown for the user
// ---------------------------------------------------------------------------------------------------------------------

function fmtPct(n: number | null | undefined): string {
  return n === null || n === undefined ? '-' : `${(n * 100).toFixed(1)}%`;
}

export function proposalMarkdown(args: {
  time: string;
  version: number;
  reasons: string[];
  stats: QaSummaryGroup;
  proposal: Proposal | null;
  captures: number;
}): string {
  const types = Object.entries(args.stats.byType)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([t, v]) => `- ${t}: ${v.count} 枚 (${fmtPct(v.rate)})`)
    .join('\n');
  return [
    `# ルールブック改善の提案（要確認）`,
    ``,
    `- 時刻: ${args.time}`,
    `- 現在の版: v${args.version}（直近 ${args.captures} 撮影、判定 ${args.stats.judged} 枚、不良率 ${fmtPct(args.stats.defectRate)}）`,
    `- 自動適用しなかった理由:`,
    ...args.reasons.map((r) => `  - ${r}`),
    ``,
    `## 不良の内訳`,
    types || '(なし)',
    ``,
    `## 提案する変更`,
    args.proposal ? '```json\n' + JSON.stringify(args.proposal.changes, null, 2) + '\n```' : '(自動で作れる変更がありません。内容を見て手で決めてください)',
    ``,
    `## 適用するには`,
    '`npx tsx scripts/qa-improve.ts --apply-proposal <このファイル名>`（ユーザーが了承したときだけ）。',
    '却下するときは何もしなくてよい（同じ種類の提案は、このファイルを消すまで再送されません）。',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------------------------------------------------

export interface CycleResult {
  action: 'wait' | 'quiet' | 'applied' | 'rolledback' | 'ask' | 'dry-run';
  version: number;
  detail: string;
  proposal?: Proposal | null;
  newVersion?: number;
  askFile?: string;
  stats?: QaSummaryGroup;
  askReasons?: string[];
  rollback?: { to: number; fromRate: number | null; parentRate: number | null };
}

export interface CycleOptions {
  paths?: ImproverPaths;
  config?: ImproverConfig;
  now?: () => Date;
  llm?: TextLlm | null;
  /** Evaluate and report, change nothing, and ignore the "N captures reached" gate. */
  dryRun?: boolean;
  /** Ignore the "N captures reached" gate (manual run); still changes things unless dryRun. */
  force?: boolean;
}

function notImproved(state: ImproverState, type: DefectType): number {
  let n = 0;
  for (let i = state.applied.length - 1; i >= 0; i--) {
    const a = state.applied[i];
    if (!a.rolledBack && !a.rateAfter) continue; // the newest version has not been measured yet
    if (!a.types.includes(type)) break;
    const before = a.rateAtApply[type] ?? 0;
    const after = a.rateAfter?.[type];
    const worse = a.rolledBack || (after !== undefined && after >= before - 0.01);
    if (!worse) break;
    n += 1;
  }
  return n;
}

export async function runCycle(opts: CycleOptions = {}): Promise<CycleResult> {
  const paths = opts.paths ?? defaultPaths();
  const cfg = opts.config ?? configFromEnv();
  const now = opts.now ?? (() => new Date());
  const rbDir = paths.rulebookDir;
  const active = readActive(rbDir);
  const rb = (active ? loadRulebook(active.version, rbDir) : null) ?? getRulebook();
  const version = rb.version;
  const state = readState(paths);
  const rows = readQaRows(paths.qaFile);
  const since = [active?.appliedAt ?? null, state.lastCycleAt].filter(Boolean).sort().pop() ?? null;
  // A dry run looks at every judged image of the active version (including backfilled ones), whatever the gate says.
  const win = windowRows(rows, version, { since: opts.dryRun ? null : since, captures: opts.dryRun || opts.force ? undefined : cfg.every });
  const captures = captureCount(win);
  const stats = statsOf(win);
  if (!opts.force && !opts.dryRun && captures < cfg.every) {
    return { action: 'wait', version, detail: `${captures}/${cfg.every} captures`, stats };
  }
  if (stats.judged === 0) return { action: 'wait', version, detail: 'no judged images yet', stats };

  // 1. verify the active version against its parent
  const lastApplied = state.applied[state.applied.length - 1];
  if (!opts.dryRun && lastApplied && lastApplied.to === version && !lastApplied.rateAfter) {
    lastApplied.rateAfter = Object.fromEntries(DEFECT_TYPES.map((t) => [t, rateOf(stats, t)]));
    const parentRows = windowRows(rows, lastApplied.from, { before: active?.appliedAt ?? null, captures: cfg.every });
    const pStats = statsOf(parentRows);
    const worseOverall = stats.defectRate !== null && pStats.defectRate !== null && stats.defectRate - pStats.defectRate >= cfg.rollbackDelta;
    const worseTarget = lastApplied.types.find((t) => rateOf(stats, t) - rateOf(pStats, t) >= cfg.rollbackDelta);
    if (worseOverall || worseTarget) {
      const reason = worseOverall
        ? `defect rate ${fmtPct(pStats.defectRate)} -> ${fmtPct(stats.defectRate)} (>= +${cfg.rollbackDelta * 100} points)`
        : `${worseTarget} rate ${fmtPct(rateOf(pStats, worseTarget!))} -> ${fmtPct(rateOf(stats, worseTarget!))} (>= +${cfg.rollbackDelta * 100} points)`;
      const cur = loadRulebook(version, rbDir);
      lastApplied.rolledBack = true;
      state.rejected.push({ version, time: now().toISOString(), reason, changes: diffChanges(loadRulebook(lastApplied.from, rbDir), cur) });
      state.lastCycleAt = now().toISOString();
      setActive(lastApplied.from, { by: 'improver', reason: `rollback of v${version}: ${reason}` }, rbDir, now);
      writeState(paths, state);
      logChange(paths, { time: now().toISOString(), kind: 'rollback', from: version, to: lastApplied.from, changes: [], reason, defectStats: compactStats(stats), parentStats: compactStats(pStats) });
      appendChangelog(rbDir, `## v${lastApplied.from} 復帰（v${version} を却下） — ${now().toISOString()}\n- 理由: ${reason}\n- v${version} の不良率 ${fmtPct(stats.defectRate)}、v${lastApplied.from} の不良率 ${fmtPct(pStats.defectRate)}\n`);
      console.error(`[improver] rollback v${version} -> v${lastApplied.from}: ${reason}`);
      return { action: 'rolledback', version, detail: reason, stats, rollback: { to: lastApplied.from, fromRate: stats.defectRate, parentRate: pStats.defectRate } };
    }
    state.validated[String(version)] = { time: now().toISOString(), rate: stats.defectRate, parentRate: pStats.defectRate };
  }

  // 2. what to change
  // Rejected attempts inform fixes, but never the accepted-image rollback rates above.
  const evidence = qaMetrics(win);
  const overall = evidence.defectRate ?? 0;
  if (overall < cfg.quietRate) {
    if (!opts.dryRun) {
      state.lastCycleAt = now().toISOString();
      writeState(paths, state);
    }
    return { action: 'quiet', version, detail: `defect rate ${fmtPct(overall)} < ${fmtPct(cfg.quietRate)}`, stats };
  }
  const ranked = Object.entries(evidence.byType)
    .filter(([, v]) => v.count >= cfg.minTypeCount)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([t]) => t as DefectType);
  const targets = ranked.slice(0, 2);
  if (targets.length === 0) {
    if (!opts.dryRun) {
      state.lastCycleAt = now().toISOString();
      writeState(paths, state);
    }
    return { action: 'quiet', version, detail: 'no defect type reached the minimum count', stats };
  }

  const askReasons: string[] = [];
  const stuck = targets.filter((t) => notImproved(state, t) >= 3);
  for (const t of stuck) askReasons.push(`${t} did not improve over 3 versions in a row`);
  const askTypes = targets.filter((t) => ASK_TYPES.has(t));
  for (const t of askTypes) askReasons.push(`${t}: the remedy depends on the expression (whether people appear / how the scenario is written)`);
  const autoTargets = targets.filter((t) => !ASK_TYPES.has(t) && !stuck.includes(t));

  let proposal: Proposal | null = null;
  if (autoTargets.length > 0) {
    if (opts.llm) {
      try {
        const changes = parseLlmChanges(await opts.llm(buildLlmPrompt(autoTargets[0], rb)), rb, state.rejected);
        if (changes) proposal = { changes, targets: [autoTargets[0]], source: 'llm', reason: `top defect type: ${autoTargets[0]}` };
      } catch (error) {
        console.error('[improver] llm proposal failed (catalog is used):', String((error as any)?.message ?? error));
      }
    }
    proposal = proposal ?? catalogProposal(autoTargets, rb, state.rejected);
    if (!proposal) askReasons.push(`no new automatic change left for ${autoTargets.join(', ')} (catalog exhausted)`);
  }
  if (proposal) {
    const v = validateChanges(proposal.changes, rb, state.rejected);
    if (!v.ok) askReasons.push(...v.problems);
    askReasons.push(...v.ask);
  }

  const resultBase = { version, stats, proposal };
  if (askReasons.length > 0) {
    const key = targets[0] ?? 'general';
    if (opts.dryRun) return { action: 'dry-run', ...resultBase, detail: 'would ask the user', askReasons };
    const pendingFile = state.pending[key]?.file;
    if (pendingFile && fs.existsSync(path.join(proposalsDir(paths), pendingFile))) {
      state.lastCycleAt = now().toISOString();
      writeState(paths, state);
      return { action: 'wait', ...resultBase, detail: `proposal ${pendingFile} is still open`, askReasons };
    }
    const time = now().toISOString();
    const file = `${time.replace(/[:.]/g, '-')}.md`;
    fs.mkdirSync(proposalsDir(paths), { recursive: true });
    fs.writeFileSync(path.join(proposalsDir(paths), file), proposalMarkdown({ time, version, reasons: askReasons, stats, proposal, captures }), 'utf8');
    state.pending[key] = { file, time };
    state.lastCycleAt = time;
    writeState(paths, state);
    logChange(paths, { time, kind: 'ask', from: version, to: version, changes: proposal?.changes ?? [], reason: askReasons.join('; '), defectStats: compactStats(stats), file });
    console.error(`[improver] needs the user: ${askReasons.join('; ')} -> logs/qa-proposals/${file}`);
    return { action: 'ask', ...resultBase, detail: askReasons.join('; '), askFile: file, askReasons };
  }

  if (opts.dryRun) return { action: 'dry-run', ...resultBase, detail: 'would apply automatically' };

  // 3. apply as the next version
  const time = now();
  const next = applyToRulebook(rb, proposal!.changes, { note: `auto: ${proposal!.reason}`, now: time, existing: listVersions(rbDir) });
  writeRulebook(next, rbDir);
  setActive(next.version, { by: 'improver', reason: proposal!.reason }, rbDir, () => time);
  state.applied.push({ from: version, to: next.version, types: proposal!.targets, rateAtApply: Object.fromEntries(DEFECT_TYPES.map((t) => [t, rateOf(stats, t)])) });
  state.lastCycleAt = time.toISOString();
  writeState(paths, state);
  logChange(paths, { time: time.toISOString(), kind: 'apply', from: version, to: next.version, changes: proposal!.changes, reason: proposal!.reason, source: proposal!.source, defectStats: compactStats(stats) });
  appendChangelog(
    rbDir,
    `## v${next.version} — ${time.toISOString()}（自動）\n- 元: v${version}、対象の不良: ${proposal!.targets.join(', ')}（不良率 ${fmtPct(stats.defectRate)}、直近 ${captures} 撮影）\n` +
      proposal!.changes.map((c) => `- ${c.path} に追加: ${textOf(c)}`).join('\n') +
      `\n- 検証: 次の ${cfg.every} 撮影で v${version} より不良率が +${cfg.rollbackDelta * 100} ポイント以上悪ければ自動で戻す\n`
  );
  console.error(`[improver] applied v${next.version} (from v${version}): ${proposal!.changes.map((c) => `${c.path} += ${textOf(c)}`).join(' | ')}`);
  return { action: 'applied', ...resultBase, detail: proposal!.reason, newVersion: next.version };
}

function compactStats(s: QaSummaryGroup) {
  return { rejected: s.rejected, completedCaptures: s.completedCaptures, images: s.images, judged: s.judged, defective: s.defective, defectRate: s.defectRate, byType: s.byType };
}

function logChange(p: ImproverPaths, row: Record<string, unknown>): void {
  appendJsonl(changesLogFile(p), row);
}

function appendChangelog(dir: string, entry: string): void {
  try {
    const file = path.join(dir, 'CHANGELOG.md');
    const head = fs.existsSync(file) ? '' : '# ルールブック変更履歴\n\n新しい順ではなく追記順。自動改善（server/qa/improver.ts）と手動の変更が入る。\n\n';
    fs.appendFileSync(file, head + entry + '\n', 'utf8');
  } catch (error) {
    console.error('[improver] CHANGELOG write failed:', error);
  }
}

/** What differs between two versions in the editable lists (for the rejected record). */
export function diffChanges(a: Rulebook | null, b: Rulebook | null): Change[] {
  if (!a || !b) return [];
  const out: Change[] = [];
  const added = (x: string[], y: string[]) => y.filter((v) => !x.includes(v));
  for (const v of added(a.imagePrompt.extraConstraints, b.imagePrompt.extraConstraints)) out.push({ path: 'imagePrompt.extraConstraints', value: v });
  for (const v of added(a.negative.added, b.negative.added)) out.push({ path: 'negative.added', value: v });
  for (const v of added(a.vlm.extraInstructions, b.vlm.extraInstructions)) out.push({ path: 'vlm.extraInstructions', value: v });
  for (const v of added(a.guard.extraEmptyRoomBannedWords, b.guard.extraEmptyRoomBannedWords)) out.push({ path: 'guard.extraEmptyRoomBannedWords', value: v });
  for (const g of b.guard.extraObjectGroups.filter((g) => !a.guard.extraObjectGroups.some((h) => h.join(',') === g.join(',')))) out.push({ path: 'guard.extraObjectGroups', value: g });
  return out;
}

/** Manual rollback to `to` (or the parent of the active version): the active version is recorded as rejected. */
export function manualRollback(opts: { to?: number; reason?: string; paths?: ImproverPaths; now?: () => Date } = {}): { from: number; to: number } {
  const paths = opts.paths ?? defaultPaths();
  const now = opts.now ?? (() => new Date());
  const active = readActive(paths.rulebookDir);
  const from = active?.version ?? getRulebook().version;
  const cur = loadRulebook(from, paths.rulebookDir);
  const to = opts.to ?? cur?.parent ?? 1;
  const state = readState(paths);
  const reason = opts.reason ?? 'manual rollback';
  state.rejected.push({ version: from, time: now().toISOString(), reason, changes: diffChanges(loadRulebook(to, paths.rulebookDir), cur) });
  const last = state.applied[state.applied.length - 1];
  if (last && last.to === from) last.rolledBack = true;
  state.lastCycleAt = now().toISOString();
  setActive(to, { by: 'manual', reason }, paths.rulebookDir, now);
  writeState(paths, state);
  logChange(paths, { time: now().toISOString(), kind: 'rollback', from, to, changes: [], reason });
  appendChangelog(paths.rulebookDir, `## v${to} 復帰（手動、v${from} を却下） — ${now().toISOString()}\n- 理由: ${reason}\n`);
  return { from, to };
}

/** Applies the changes of a proposal file (only after the user agreed). */
export function applyProposalFile(file: string, opts: { paths?: ImproverPaths; now?: () => Date } = {}): { version: number } {
  const paths = opts.paths ?? defaultPaths();
  const now = opts.now ?? (() => new Date());
  const full = path.isAbsolute(file) ? file : path.join(proposalsDir(paths), file);
  const md = fs.readFileSync(full, 'utf8');
  const m = md.match(/```json\n([\s\S]*?)\n```/);
  if (!m) throw new Error('no json block in the proposal');
  const changes = JSON.parse(m[1]) as Change[];
  const rb = getRulebook();
  const v = validateChanges(changes, rb);
  const hard = v.problems;
  if (hard.length) throw new Error(`proposal is not valid: ${hard.join('; ')}`);
  const t = now();
  const next = applyToRulebook(rb, changes, { note: `approved by user: ${path.basename(full)}`, now: t, existing: listVersions(paths.rulebookDir) });
  writeRulebook(next, paths.rulebookDir);
  setActive(next.version, { by: 'user', reason: path.basename(full) }, paths.rulebookDir, () => t);
  const state = readState(paths);
  state.applied.push({ from: rb.version, to: next.version, types: [], rateAtApply: {} });
  for (const k of Object.keys(state.pending)) if (state.pending[k].file === path.basename(full)) delete state.pending[k];
  state.lastCycleAt = t.toISOString();
  writeState(paths, state);
  logChange(paths, { time: t.toISOString(), kind: 'apply', from: rb.version, to: next.version, changes, reason: `approved: ${path.basename(full)}`, source: 'user' });
  appendChangelog(paths.rulebookDir, `## v${next.version} — ${t.toISOString()}（ユーザー承認）\n- 提案: ${path.basename(full)}\n` + changes.map((c) => `- ${c.path} に追加: ${textOf(c)}`).join('\n') + '\n');
  try {
    fs.renameSync(full, full.replace(/\.md$/, '.applied.md'));
  } catch {
    /* keep */
  }
  return { version: next.version };
}

export function listProposals(paths: ImproverPaths = defaultPaths()): Array<{ file: string; time: string; status: 'open' | 'applied'; head: string }> {
  try {
    return fs
      .readdirSync(proposalsDir(paths))
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse()
      .map((file) => {
        const text = fs.readFileSync(path.join(proposalsDir(paths), file), 'utf8');
        return { file, time: /- 時刻: (.+)/.exec(text)?.[1] ?? '', status: file.endsWith('.applied.md') ? ('applied' as const) : ('open' as const), head: text.split('\n').slice(0, 14).join('\n') };
      });
  } catch {
    return [];
  }
}

export function readChanges(paths: ImproverPaths = defaultPaths(), limit = 50): unknown[] {
  try {
    return fs
      .readFileSync(changesLogFile(paths), 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((l) => JSON.parse(l))
      .reverse();
  } catch {
    return [];
  }
}

/** Local Qwen text call (free) used for the optional wording step. */
export function ollamaTextLlm(): TextLlm {
  return async (prompt: string) => {
    const url = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const res = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.QA_LOCAL_MODEL || process.env.VLM_MODEL || 'qwen3-vl:4b-instruct',
        prompt,
        stream: false,
        think: false,
        format: 'json',
        keep_alive: process.env.OLLAMA_KEEP_ALIVE ?? '5m',
        // Use the same shared runner context as recognition/planning; output budget stays 256.
        options: { temperature: 0.2, num_predict: 256, num_ctx: sharedOllamaContextLength() },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    return String(((await res.json()) as { response?: string }).response ?? '');
  };
}
