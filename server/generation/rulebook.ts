/**
 * The versioned rulebook: every fixed constraint that goes into the image prompt, the negative prompt, the guard and the
 * planner instruction, in one place (rulebook/rulebook.v<N>.json; the active version is rulebook/active.json).
 *
 *   - v1 is exactly the wording that used to live in orchestrator.ts / comfyClient.ts / vlmClient.ts (ruleTexts.ts)
 *   - read on every capture (cached by file mtime), so a new version or a rollback needs no restart
 *   - the automatic improver (server/qa/improver.ts) may only change the EDITABLE_PATHS below, additively;
 *     rulebook/USER_GUIDELINES.md (G-xx) wording is frozen and never touched by it
 * No images or personal data here: the files are safe in the public repository.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as T from './ruleTexts';

export interface Rulebook {
  version: number;
  createdAt: string;
  /** Version this one was derived from (null for v1). */
  parent: number | null;
  note: string;
  imagePrompt: {
    physicsRule: string;
    hairRule: string;
    behindViewRule: string;
    onePersonRule: string;
    behindViewPlacementRule: string;
    foregroundRuleNamed: string;
    foregroundRuleGeneric: string;
    disembodiedRule: string;
    referencePersonRule: string;
    emptyRoomNoPersonRule: string;
    emptyRoom: { head: string; scope: string; keep: string; preserve: string; noAdd: string; screens: string; tail: string };
    /** G-14: items a person holds in the input stay (absent in v1/v2 files = no sentence). */
    holdingsRule?: string;
    /** G-15: no new face is drawn for a person whose face is not visible in the input (absent in v1/v2 files). */
    noNewFaceRule?: string;
    /** G-16: no new text, numbers, clocks or UI on screens/surfaces (absent in older files = no sentence). */
    noNewTextRule?: string;
    /** G-07 supplement: when the camera is obstructed, keep the obstruction and the composition (absent in older files). */
    obstructedRule?: string;
    /** G-07 supplement 3: first sentence of the prompt when obstructed; placeholders {by}, {through}, {pattern} (absent in older files). */
    obstructedLeadRule?: string;
    /** G-17: no lens flare / light streaks / glow, in both templates (absent in older files). */
    noLightArtifactRule?: string;
    /** G-17: in an empty room the light changes in brightness and colour temperature only (absent in older files). */
    emptyRoomLightRule?: string;
    /** Extra sentences after the physics rule (both templates; must contain no person words). Automatic improvements go here. */
    extraConstraints: string[];
  };
  /** Optional (older versions lack it: the built-in text is used). Four tone bands each, see ruleTexts.ts. */
  toneImage?: { people: string[]; emptyRoom: string[] };
  quality: { base: string; entering: string; clock: string; longSpan: string };
  negative: { base: string; clock: string; noPerson: string; behindView: string; /** Terms added by the improver. */ added: string[]; /** G-16 terms, used only when no clock edit applies. */ noNewText?: string; /** G-07 supplement terms, used only when the camera is obstructed. */ obstructed?: string };
  guard: {
    guardRetries: number;
    timeBudgetMs: number;
    duplicateThreshold: number;
    /** Extra vocabulary groups for the object-fabrication guard (first word names the group). */
    extraObjectGroups: string[][];
    /** Extra words stripped from empty-room prompts. */
    extraEmptyRoomBannedWords: string[];
  };
  vlm: { /** Extra lines appended to the planner instruction (before the JSON-format part). */ extraInstructions: string[] };
}

/** Paths the automatic improver may change, and how. Everything else needs the user. */
export const EDITABLE_PATHS = {
  'imagePrompt.extraConstraints': 'append-string',
  'negative.added': 'append-string',
  'guard.extraObjectGroups': 'append-group',
  'guard.extraEmptyRoomBannedWords': 'append-string',
  'vlm.extraInstructions': 'append-string',
  'guard.guardRetries': 'number:0:5',
  'guard.timeBudgetMs': 'number:10000:40000',
} as const;
export type EditablePath = keyof typeof EDITABLE_PATHS;

export function buildV1(): Rulebook {
  return {
    version: 1,
    createdAt: '2026-10-16T00:00:00.000Z',
    parent: null,
    note: 'Existing wording moved unchanged from orchestrator.ts / comfyClient.ts / vlmClient.ts.',
    imagePrompt: {
      physicsRule: T.PHYSICS_RULE,
      hairRule: T.HAIR_RULE,
      behindViewRule: T.BEHIND_VIEW_RULE,
      onePersonRule: T.ONE_PERSON_RULE,
      behindViewPlacementRule: T.BEHIND_VIEW_PLACEMENT_RULE,
      foregroundRuleNamed: T.FOREGROUND_RULE_NAMED,
      foregroundRuleGeneric: T.FOREGROUND_RULE_GENERIC,
      disembodiedRule: T.DISEMBODIED_RULE,
      referencePersonRule: T.REFERENCE_PERSON_RULE,
      emptyRoomNoPersonRule: T.EMPTY_ROOM_NO_PERSON_RULE,
      emptyRoom: { ...T.EMPTY_ROOM },
      extraConstraints: [],
    },
    quality: { base: T.QUALITY_SUFFIX, entering: T.QUALITY_SUFFIX_ENTERING, clock: T.CLOCK_QUALITY_SUFFIX, longSpan: T.LONG_SPAN_QUALITY_SUFFIX },
    negative: {
      base: T.DEFAULT_NEGATIVE_PROMPT,
      clock: T.CLOCK_NEGATIVE_PROMPT,
      noPerson: T.NO_PERSON_NEGATIVE_PROMPT,
      behindView: T.BEHIND_VIEW_NEGATIVE_PROMPT,
      added: [],
    },
    guard: {
      guardRetries: 3,
      timeBudgetMs: 25000,
      duplicateThreshold: 0.9,
      extraObjectGroups: [],
      extraEmptyRoomBannedWords: [],
    },
    vlm: { extraInstructions: [] },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------------------------------

export function rulebookDir(): string {
  const env = (process.env.RULEBOOK_DIR || '').trim();
  if (env) return env;
  // Tests (node --test) must not depend on the live active version (the improver changes it): they get the built-in v1.
  if (process.env.NODE_TEST_CONTEXT) return path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'rulebook-no-files');
  return path.join(process.cwd(), 'rulebook');
}
export const rulebookFile = (version: number, dir = rulebookDir()) => path.join(dir, `rulebook.v${version}.json`);
const activeFile = (dir = rulebookDir()) => path.join(dir, 'active.json');

export interface ActiveInfo {
  version: number;
  appliedAt: string;
  by?: string;
  reason?: string;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/** Structural validation of a rulebook object (returns the problems; [] = valid). */
export function validateRulebook(rb: any): string[] {
  const errs: string[] = [];
  const need = (cond: boolean, msg: string) => {
    if (!cond) errs.push(msg);
  };
  need(rb && typeof rb === 'object', 'not an object');
  if (errs.length) return errs;
  need(Number.isInteger(rb.version) && rb.version >= 1, 'version');
  need(isStr(rb.createdAt), 'createdAt');
  need(rb.parent === null || Number.isInteger(rb.parent), 'parent');
  const ip = rb.imagePrompt ?? {};
  for (const k of ['physicsRule', 'hairRule', 'behindViewRule', 'onePersonRule', 'behindViewPlacementRule', 'foregroundRuleNamed', 'foregroundRuleGeneric', 'disembodiedRule', 'referencePersonRule', 'emptyRoomNoPersonRule']) {
    need(isStr(ip[k]), `imagePrompt.${k}`);
  }
  for (const k of ['head', 'scope', 'keep', 'preserve', 'noAdd', 'screens', 'tail']) need(isStr(ip.emptyRoom?.[k]), `imagePrompt.emptyRoom.${k}`);
  need(isStrArr(ip.extraConstraints), 'imagePrompt.extraConstraints');
  need(ip.holdingsRule === undefined || isStr(ip.holdingsRule), 'imagePrompt.holdingsRule');
  need(ip.noNewFaceRule === undefined || isStr(ip.noNewFaceRule), 'imagePrompt.noNewFaceRule');
  need(ip.noNewTextRule === undefined || isStr(ip.noNewTextRule), 'imagePrompt.noNewTextRule');
  need(ip.obstructedRule === undefined || isStr(ip.obstructedRule), 'imagePrompt.obstructedRule');
  need(ip.obstructedLeadRule === undefined || isStr(ip.obstructedLeadRule), 'imagePrompt.obstructedLeadRule');
  need(ip.noLightArtifactRule === undefined || isStr(ip.noLightArtifactRule), 'imagePrompt.noLightArtifactRule');
  need(ip.emptyRoomLightRule === undefined || isStr(ip.emptyRoomLightRule), 'imagePrompt.emptyRoomLightRule');
  need(rb.negative?.noNewText === undefined || isStr(rb.negative.noNewText), 'negative.noNewText');
  need(rb.negative?.obstructed === undefined || isStr(rb.negative.obstructed), 'negative.obstructed');
  need(rb.toneImage === undefined || (isStrArr(rb.toneImage?.people) && isStrArr(rb.toneImage?.emptyRoom)), 'toneImage');
  for (const k of ['base', 'entering', 'clock', 'longSpan']) need(isStr(rb.quality?.[k]), `quality.${k}`);
  for (const k of ['base', 'clock', 'noPerson', 'behindView']) need(isStr(rb.negative?.[k]), `negative.${k}`);
  need(isStrArr(rb.negative?.added), 'negative.added');
  const g = rb.guard ?? {};
  need(Number.isFinite(g.guardRetries), 'guard.guardRetries');
  need(Number.isFinite(g.timeBudgetMs), 'guard.timeBudgetMs');
  need(Number.isFinite(g.duplicateThreshold), 'guard.duplicateThreshold');
  need(Array.isArray(g.extraObjectGroups) && g.extraObjectGroups.every(isStrArr), 'guard.extraObjectGroups');
  need(isStrArr(g.extraEmptyRoomBannedWords), 'guard.extraEmptyRoomBannedWords');
  need(isStrArr(rb.vlm?.extraInstructions), 'vlm.extraInstructions');
  return errs;
}

let cache: { key: string; rb: Rulebook; active: ActiveInfo | null } | null = null;

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const mtime = (f: string) => {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};

export function readActive(dir = rulebookDir()): ActiveInfo | null {
  const a = readJson(activeFile(dir));
  return a && Number.isInteger(a.version) ? (a as ActiveInfo) : null;
}

export function loadRulebook(version: number, dir = rulebookDir()): Rulebook | null {
  const rb = readJson(rulebookFile(version, dir));
  return rb && validateRulebook(rb).length === 0 ? (rb as Rulebook) : null;
}

/** The active rulebook; the built-in v1 when no (valid) file exists. Re-read when a file changes, never needs a restart. */
export function getRulebook(): Rulebook {
  const dir = rulebookDir();
  const active = readActive(dir);
  const version = active?.version ?? 1;
  const key = `${dir}|${version}|${mtime(activeFile(dir))}|${mtime(rulebookFile(version, dir))}`;
  if (cache && cache.key === key) return cache.rb;
  const rb = loadRulebook(version, dir) ?? (version === 1 ? null : loadRulebook(1, dir)) ?? buildV1();
  cache = { key, rb, active };
  return rb;
}

export const rulebookVersion = (): number => getRulebook().version;

export function listVersions(dir = rulebookDir()): number[] {
  try {
    return fs
      .readdirSync(dir)
      .map((f) => /^rulebook\.v(\d+)\.json$/.exec(f)?.[1])
      .filter((v): v is string => !!v)
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export function writeRulebook(rb: Rulebook, dir = rulebookDir()): void {
  const errs = validateRulebook(rb);
  if (errs.length) throw new Error(`invalid rulebook: ${errs.join(', ')}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(rulebookFile(rb.version, dir), JSON.stringify(rb, null, 2) + '\n', 'utf8');
}

export function setActive(version: number, meta: { by?: string; reason?: string } = {}, dir = rulebookDir(), now: () => Date = () => new Date()): ActiveInfo {
  if (!loadRulebook(version, dir)) throw new Error(`rulebook v${version} does not exist or is invalid`);
  const info: ActiveInfo = { version, appliedAt: now().toISOString(), ...meta };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(activeFile(dir), JSON.stringify(info, null, 2) + '\n', 'utf8');
  return info;
}

/** Writes rulebook.v1.json and active.json when missing (first start). */
export function ensureRulebookFiles(dir = rulebookDir()): void {
  try {
    if (!fs.existsSync(rulebookFile(1, dir))) writeRulebook(buildV1(), dir);
    if (!readActive(dir)) setActive(1, { by: 'init', reason: 'initial version' }, dir);
  } catch (error) {
    console.error('[rulebook] could not initialise files (built-in v1 is used):', error);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Prompt pieces read from the active rulebook (used by orchestrator / comfyClient / vlmClient / guards)
// ---------------------------------------------------------------------------------------------------------------------

/** Sentences appended after the physics rule ("" for v1). */
export function extraConstraintsText(rb: Rulebook = getRulebook()): string {
  return rb.imagePrompt.extraConstraints.length ? rb.imagePrompt.extraConstraints.join(' ') : '';
}

export function foregroundRule(foreground: string | undefined, rb: Rulebook = getRulebook()): string {
  const fg = (foreground ?? '').trim();
  return fg ? rb.imagePrompt.foregroundRuleNamed.replace('{fg}', fg) : rb.imagePrompt.foregroundRuleGeneric;
}

/** G-14 / G-15 sentences (empty string when the active version has none), each preceded by a blank line. */
export function personFidelityText(rb: Rulebook = getRulebook()): string {
  return [rb.imagePrompt.holdingsRule, rb.imagePrompt.noNewFaceRule].filter((s): s is string => !!s).map((s) => `\n\n${s}`).join('');
}

/**
 * G-07 supplement 3: the obstruction is the frontmost layer. Placed FIRST in the prompt (experiment 2026-10-17: at the top it
 * kept the monitors behind the mesh; the same rule later in the prompt did not). `by` = the describe step's obstructedBy.
 */
export function obstructedLead(rb: Rulebook = getRulebook(), obstructed = false, by?: string): string {
  const tpl = rb.imagePrompt.obstructedLeadRule;
  if (!obstructed || !tpl) return '';
  const what = String(by ?? '').replace(/[^A-Za-z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'near-camera obstruction';
  const mesh = /mesh/i.test(what);
  return tpl.replace('{by}', what).replace('{through}', mesh ? 'the mesh' : 'it').replace('{pattern}', mesh ? 'the mesh pattern' : 'its pattern') + '\n\n';
}

/** G-16 (no new text/clock/UI) and the G-07 supplement (obstructed camera: keep the obstruction); '' when the version has none. */
export function screenAndFrameText(rb: Rulebook = getRulebook(), obstructed = false, emptyRoom = false): string {
  const parts = [rb.imagePrompt.noNewTextRule, rb.imagePrompt.noLightArtifactRule, emptyRoom ? rb.imagePrompt.emptyRoomLightRule : undefined, obstructed ? rb.imagePrompt.obstructedRule : undefined].filter((s): s is string => !!s);
  return parts.map((s) => `\n\n${s}`).join('');
}

/** "Physical plausibility" block: the physics rule plus automatic extra constraints. */
export function physicsBlock(rb: Rulebook = getRulebook()): string {
  const extra = extraConstraintsText(rb);
  return extra ? `${rb.imagePrompt.physicsRule} ${extra}` : rb.imagePrompt.physicsRule;
}

/** Tone band index: CALM < 0.15, QUIET < 0.45, LIVELY < 0.75, DRAMATIC (same edges as gemini-prompts.json). */
export const toneBandIndex = (tone: number): number => (tone < 0.15 ? 0 : tone < 0.45 ? 1 : tone < 0.75 ? 2 : 3);

/** "Amount of change" sentence for the image edit by tone; `emptyRoom` uses the light-only wording (no person words). */
export function toneImageRule(tone: number, emptyRoom: boolean, rb: Rulebook = getRulebook()): string {
  const set = emptyRoom ? (rb.toneImage?.emptyRoom ?? T.TONE_IMAGE_RULES_EMPTY) : (rb.toneImage?.people ?? T.TONE_IMAGE_RULES);
  const list = set.length === 4 ? set : emptyRoom ? T.TONE_IMAGE_RULES_EMPTY : T.TONE_IMAGE_RULES;
  return list[toneBandIndex(Number.isFinite(tone) ? tone : 0.3)];
}

export function qualitySuffix(clockEdit: boolean, allowNewPerson: boolean, longSpan: boolean, rb: Rulebook = getRulebook()): string {
  const base = allowNewPerson ? rb.quality.entering : rb.quality.base;
  const withClock = clockEdit ? `${base} ${rb.quality.clock}` : base;
  return longSpan ? `${withClock} ${rb.quality.longSpan}` : withClock;
}

/** Hair-length terms: a long-haired person must not become a bob, and the other way round. */
export function hairNegativeTerms(hair?: string): string {
  const h = String(hair ?? '').toLowerCase();
  if (/\blong\b|below the shoulders|waist/.test(h)) return 'short hair, bob haircut, cropped hair';
  if (/\bshort\b|\bbob\b|cropped|pixie/.test(h)) return 'long hair';
  return '';
}

export function negativePrompt(
  clockEdit: boolean,
  noPerson: boolean,
  behindView: boolean | { hair?: string },
  rb: Rulebook = getRulebook(),
  obstructed = false
): string {
  const n = rb.negative;
  const base = clockEdit ? `${n.base}, ${n.clock}` : n.base;
  const withAdded0 = n.added.length ? `${base}, ${n.added.join(', ')}` : base;
  // G-16 terms (clock, digits, text...) would fight a real clock edit, so they apply only when no clock is being edited.
  const withText = n.noNewText && !clockEdit ? `${withAdded0}, ${n.noNewText}` : withAdded0;
  const withAdded = n.obstructed && obstructed ? `${withText}, ${n.obstructed}` : withText;
  const withPerson = noPerson ? `${withAdded}, ${n.noPerson}` : withAdded;
  if (!behindView) return withPerson;
  const hair = typeof behindView === 'object' ? hairNegativeTerms(behindView.hair) : '';
  return `${withPerson}, ${n.behindView}${hair ? `, ${hair}` : ''}`;
}

/** Planner instruction with the rulebook's extra lines inserted before the JSON-format part. */
export function withVlmExtras(instruction: string, rb: Rulebook = getRulebook()): string {
  if (rb.vlm.extraInstructions.length === 0) return instruction;
  const i = instruction.indexOf(T.VLM_EXTRA_MARKER);
  const extra = rb.vlm.extraInstructions.join(' ') + '\n';
  return i < 0 ? instruction + ' ' + extra : instruction.slice(0, i) + extra + instruction.slice(i);
}

/** Environment overrides (operator) win over the rulebook value. */
export function guardRetries(rb: Rulebook = getRulebook()): number {
  const env = process.env.VLM_GUARD_RETRIES;
  return Math.max(0, env !== undefined && env !== '' ? Number(env) : rb.guard.guardRetries);
}
export function timeBudgetMs(rb: Rulebook = getRulebook()): number {
  const env = process.env.VLM_TIME_BUDGET_MS;
  return Math.max(1000, env !== undefined && env !== '' ? Number(env) : rb.guard.timeBudgetMs);
}
