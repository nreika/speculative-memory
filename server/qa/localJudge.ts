import {sharedOllamaContextLength} from "../generation/sharedOllamaContext";
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
  // G-17 (2026-10-17): lens flare / rainbow light streaks / added glow
  'light_artifact',
  // Pre-publish inspection (2026-10-19): a person shows 3 or more hands (combinedInspection hand count)
  'extra_hand',
  // Pre-publish CPU framing check (2026-10-19): output zoomed/shifted/rotated against the source frame (scripts/frame-align.py)
  'framing_drift',
  // Pre-publish inspection (2026-10-19): an object the source scene lists on its furniture is hidden/removed in the output
  'missing_belongings',
  // Pre-publish inspection (2026-10-21): head/torso/arms do not form one body (face on the back of the head, arm out of the back)
  'incoherent_body',
  // Pre-publish inspection (2026-10-21): the planned action (prediction_prompt) is not visible in the image
  'action_not_shown',
  // Mechanical check (2026-10-21): a face is drawn on a person who is seen from behind in the original
  'face_on_back_view',
  // Pre-publish inspection (2026-10-21): the same object appears twice (moved object also at its old place)
  'duplicate_object',
  // Mechanical size check (2026-10-21): the person drawn into an empty room is larger / closer than its Presence allows
  'person_too_large',
  // Mechanical check (2026-10-21): the person was enlarged / pulled to another place compared with NOW
  'person_moved',
  // Mechanical check (2026-10-21): the person drawn into an empty room does not look like the recently seen person
  'wrong_person',
  'other',
] as const;
export type DefectType = (typeof DEFECT_TYPES)[number];

export interface QaDefect {
  type: DefectType;
  where: string;
  note: string;
}

export const LOCAL_INSPECTION_VERSION = 'preservation-category-instances-v5-string-lists-20261018';

/** Bounded, image-free fields already returned by the same Ollama call. */
export interface JudgeResponseDiagnostic {
  requestElapsedMs:number;done_reason?:string;done?:boolean;
  eval_count?:number;prompt_eval_count?:number;total_duration?:number;
  load_duration?:number;eval_duration?:number;prompt_eval_duration?:number;
}
export type JudgeResponseDiagnostics=Partial<Record<'pair'|'swappedPair'|'single',JudgeResponseDiagnostic>>;
export interface VerifiedPersonInventory {
 originalSourceCount:number;expectedInventoryCount:number;verified:true;
}
export interface LocalJudgeResult {
 /** Image-free roster evidence, present only on explicit-reference QA jobs. */
 referenceCastIntegrity?:import('../generation/sceneReferenceCast').ReferenceCastIntegrity;
  ok: boolean | null;
  score: number | null;
  defects: QaDefect[];
  model: string;
  elapsedMs: number;
  error?: string;
  /** This inspection does not validate requested action achievement or the displayed caption. */
  inspectionVersion?: string;
  evidence?: { pair?: string; swappedPair?: string; single?: string };
  responseDiagnostics?:JudgeResponseDiagnostics;
}

export interface QaRow extends LocalJudgeResult {
  time: string;
  captureId: string;
  sceneKey: string;
  file: string | null;
  rulebookVersion: number | null;
  test?: boolean;
  /** Expected accepted scenes; historical rows default to the three scene capture. */
  sceneCount?: number;
  disposition?: 'accepted' | 'rejected';
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
  if (/(?:extra|third|additional|duplicat\w*)_?(?:hand|arm)|(?:three|3)_hands/.test(t)) return 'extra_hand';
  if (/person|people|human|figure/.test(t) && /fabric|extra|added|new|invent/.test(t)) return 'fabricated_person';
  if (/fabric|added|extra|new_object|invent|hallucin/.test(t)) return 'fabricated_object';
  if (/missing|disappear|vanish|removed|lost/.test(t)) return 'missing_object';
  if (/float|levitat|hover/.test(t)) return 'floating';
  if (/placement|implausible|physic|gravity|\bhang/.test(t)) return 'implausible_placement';
  if (/new_?text|text_or_clock|garbled|clock|digit/.test(t)) return 'new_text_or_clock';
  if (/light_?artifact|lens_?flare|light_?streak|rainbow|sparkle|glow/.test(t)) return 'light_artifact';
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

function itemList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    if (Array.isArray(x) || (typeof x !== 'string' && (!x || typeof x !== 'object'))) return null;
    if (typeof x === 'object' && Object.values(x).some(value => typeof value !== 'string')) return null;
    const t = itemText(x);
    if (!t) return null;
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export interface ObjectInstance {
  /** Unique within one image, including across categories; not a cross-image identity claim. */
  id: string;
  support: string | null;
  /** 'none' means unowned; null means unknown. */
  holder: string | null;
}
export interface CategoryCount {
  /** Canonical physical category, never a holder/support/state. Legacy readers also use this internal name. */
  item: string;
  a: number | null;
  b: number | null;
  instancesA?: ObjectInstance[] | null;
  instancesB?: ObjectInstance[] | null;
}
const categoryKey = (item: string) => item.trim().replace(/\s+/g, ' ').toLowerCase();

function parseInstances(value: unknown): ObjectInstance[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  const out: ObjectInstance[] = [];
  for (const instance of value) {
    if (!instance || typeof instance !== 'object' || Array.isArray(instance) ||
        typeof instance.id !== 'string' || !instance.id.trim() || instance.id.length > 64 ||
        ![instance.support,instance.holder].every(v => v === null || (typeof v === 'string' && !!v.trim() && v.length <= 120))) return undefined;
    out.push({id:instance.id.trim(), support:instance.support === null ? null : instance.support.trim(),
      holder:instance.holder === null ? null : instance.holder.trim()});
  }
  return out;
}

/** No noun dictionary, state-word stripping, alias guessing or summing overlapping subcategories. */
function inventoryIssues(pair: PairAnswer | null): string[] {
  const issues: string[] = [];
  for (const side of ['A','B'] as const) {
    const ids = new Set<string>();
    for (const c of pair?.counts ?? []) {
      const list = c[side === 'A' ? 'instancesA' : 'instancesB'];
      const count = c[side === 'A' ? 'a' : 'b'];
      if (!list) { issues.push(`unknown instances: ${c.item} image ${side}`); continue; }
      if (count !== null && count !== list.length) issues.push(`total/instances mismatch: ${c.item} image ${side}`);
      for (const instance of list) {
        if (ids.has(instance.id)) issues.push(`repeated physical instance: ${instance.id} image ${side}`);
        ids.add(instance.id);
        if (instance.support === null || instance.holder === null) issues.push(`unknown support/holder: ${c.item} image ${side}`);
      }
    }
  }
  return issues;
}

export interface PairAnswer {
  added: string[];
  removed: string[];
  counts?: CategoryCount[];
  changed?: QaDefect[];
  uncertain?: string[];
}

/** {"added":[...], "removed":[...]} of the pair comparison. null = unusable. */
export function parsePairAnswer(raw: unknown, requirePreservation = false, requireInventory = false): PairAnswer | null {
  const j = parseJson(raw);
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const added = itemList(j.added);
  const removed = itemList(j.removed);
  if (!added || !removed) return null;
  const result: PairAnswer = { added, removed };
  // Historical callers may read v2 counts. Live v3 requires category totals and physical-instance lists.
  if (requirePreservation || requireInventory || 'counts' in j || 'changed' in j || 'uncertain' in j) {
    if (!Array.isArray(j.counts)) return null;
    const validCount = (n: unknown) => n === null || (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0);
    const counts: NonNullable<PairAnswer['counts']> = [];
    const seen = new Set<string>();
    for (const c of j.counts) {
      if (!c || typeof c !== 'object' || Array.isArray(c) || !validCount(c.a) || !validCount(c.b)) return null;
      const category = requireInventory ? c.category : c.category ?? c.item;
      if (typeof category !== 'string' || !category.trim() || category.length > 80) return null;
      // A schema/example label is not an observed physical category. Keep unknown.
      if (requireInventory && /^(?:object\s+type|category)$/i.test(category.trim())) return null;
      const item = clip(category, 80);
      if (seen.has(categoryKey(item))) return null;
      seen.add(categoryKey(item));
      const count: CategoryCount = { item, a: c.a, b: c.b };
      if (requireInventory || 'instancesA' in c || 'instancesB' in c) {
        const instancesA = parseInstances(c.instancesA), instancesB = parseInstances(c.instancesB);
        if (instancesA === undefined || instancesB === undefined) return null;
        Object.assign(count, { instancesA, instancesB });
      }
      counts.push(count);
    }
    const changed = parseSingleAnswer(JSON.stringify({ defects: j.changed }));
    const uncertain = itemList(j.uncertain);
    if (!changed || !uncertain) return null;
    Object.assign(result, { counts, changed, uncertain });
  }
  return result;
}

/** {"defects":[{type, where, note}]} of the single-image check. Every valid reported defect is preserved. */
export function parseSingleAnswer(raw: unknown): QaDefect[] | null {
  const j = parseJson(raw);
  if (!j || typeof j !== 'object' || !Array.isArray(j.defects)) return null;
  const out: QaDefect[] = [];
  for (const d of j.defects) {
    if (!d || typeof d !== 'object' || Array.isArray(d) ||
        typeof d.type !== 'string' || !d.type.trim() ||
        typeof d.where !== 'string' || !d.where.trim() ||
        typeof d.note !== 'string' || !d.note.trim()) return null;
    const type = normalizeDefectType(d.type);
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

const TEXT_ITEM = /\b(clock|digits?|numbers?|text|writing|timestamp|time display|ui|interface|characters?|letters?)\b/i;
const OBSTRUCTION_ITEM = /\b(backrest|chair back|headrest|obstruct\w*|foreground chair)\b/i;
const HELD_ITEM = /\b(microphone|mic|phone|smartphone|mug|cup|bottle|tablet|laptop|notebook|backpack|bag|purse|badge|umbrella|folder|clipboard|held|holding|carried)\b/i;

export interface PairEvidence {
  /** A: [NOW, image] answer. B: [image, NOW] answer (its "added" are things the image lacks). */
  a: PairAnswer | null;
  b: PairAnswer | null;
  single: QaDefect[] | null;
}

/** Pair answers describe added/missing entities, not posture. Naming an entity never authorizes its duplication or loss. */
const canonicalPerson = (item:string) => categoryKey(item)==='person';
export function personInventoryEvidenceIssues(ev:PairEvidence, cast:VerifiedPersonInventory):string[] {
 if(cast?.verified!==true||!Number.isSafeInteger(cast.originalSourceCount)||cast.originalSourceCount<0||!Number.isSafeInteger(cast.expectedInventoryCount)||cast.expectedInventoryCount<=cast.originalSourceCount)return ['Invalid verified person inventory'];
 const a=ev.a?.counts?.filter(c=>canonicalPerson(c.item)),b=ev.b?.counts?.filter(c=>canonicalPerson(c.item));
 if(a?.length!==1||b?.length!==1)return ['Missing canonical person counts for authorized cast'];
 if(a[0].a!==cast.originalSourceCount||a[0].b!==cast.expectedInventoryCount||b[0].a!==cast.expectedInventoryCount||b[0].b!==cast.originalSourceCount)return ['Authorized person counts disagree with strict roster'];
 // No alias, owner, clothes or face noun matching. A richer added/removed description remains a reported defect.
 return inventoryIssues({added:[],removed:[],counts:[a[0]]}).concat(inventoryIssues({added:[],removed:[],counts:[b[0]]}));
}
export function classifyEvidence(ev: PairEvidence, _instruction: string, cast?:VerifiedPersonInventory): QaDefect[] {
 const allowExactPersonDelta=!!cast && personInventoryEvidenceIssues(ev,cast).length===0;
 if(allowExactPersonDelta){
  const strip=(p:PairAnswer|null):PairAnswer|null=>p?{...p,added:p.added.filter(x=>!canonicalPerson(x)),removed:p.removed.filter(x=>!canonicalPerson(x)),counts:p.counts?.filter(x=>!canonicalPerson(x.item))}:null;
  ev={...ev,a:strip(ev.a),b:strip(ev.b)};
 }

  const defects: QaDefect[] = [];
  const seen = new Set<string>();
  const push = (type: DefectType, where: string, note: string) => {
    const key = `${type}|${nouns(where).join(' ')}`;
    if (seen.has(key)) return;
    seen.add(key);
    defects.push({ type, where: clip(where, 80), note: clip(note, 160) });
  };
  // Classify the entity, not the person named as its owner/location.
  const isPerson = (item: string) => PERSON_NOUN.test(item.split(/\b(?:in|on|at|near|beside|behind|held|holding|carried|carrying|worn|owned|belonging)\b/i)[0]);
  const countItems = (pair: PairAnswer | null, direction: 'added' | 'removed') =>
    (pair?.counts ?? []).filter(c => c.a !== null && c.b !== null &&
      // Historical direct callers have no instance lists; live v3 always has them.
      (!('instancesA' in c) || (Array.isArray(c.instancesA) && Array.isArray(c.instancesB) &&
        c.instancesA.length === c.a && c.instancesB.length === c.b &&
        new Set(c.instancesA.map(x=>x.id)).size === c.a && new Set(c.instancesB.map(x=>x.id)).size === c.b)) &&
      (direction === 'added' ? c.b > c.a : c.a > c.b)).map(c => c.item);
  const addedInImage = [...(ev.a?.added ?? []), ...(ev.b?.removed ?? []), ...countItems(ev.a, 'added'), ...countItems(ev.b, 'removed')];
  const missingInImage = [...(ev.a?.removed ?? []), ...(ev.b?.added ?? []), ...countItems(ev.a, 'removed'), ...countItems(ev.b, 'added')];
  for (const item of addedInImage) {
    if (TEXT_ITEM.test(item)) push('new_text_or_clock', item, `${item}: text, digits or a clock appear that are not in the original`);
    else if (isPerson(item)) push('fabricated_person', item, `${item}: appears in the image but not in the original`);
    else push('fabricated_object', item, `${item}: appears in the image but not in the original`);
  }
  for (const item of missingInImage) {
    // Things people carry or hold (G-14) are their own class; a vanished near-camera obstruction (chair back) too.
    if (OBSTRUCTION_ITEM.test(item)) push('obstruction_removed', item, `${item}: blocked the view in the original but is gone in the image`);
    else if (HELD_ITEM.test(item)) push('lost_belongings', item, `${item}: held/carried in the original but missing in the image`);
    else push('missing_object', item, `${item}: is in the original but missing in the image`);
  }
  for (const d of [...(ev.a?.changed ?? []), ...(ev.b?.changed ?? []), ...(ev.single ?? [])]) push(d.type, d.where, d.note);
  return defects;
}

/** Constrain the existing answer fields, without another call or more output tokens.
 * Null stays explicit unknown. Never synthesize missing instance lists. */
const nullableText = { anyOf: [{ type: 'string', minLength: 1, maxLength: 120 }, { type: 'null' }] };
const instanceList = { anyOf: [{ type: 'array', items: {
  type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 64 }, support: nullableText, holder: nullableText },
  required: ['id','support','holder'],
} }, { type: 'null' }] };
// Live output uses strings only; the historical parser still accepts object items.
const itemAnswerList = { type: 'array', items: { type: 'string', minLength: 1 } };
export const PAIR_ANSWER_SCHEMA = {
  type: 'object', properties: {
    added: itemAnswerList, removed: itemAnswerList,
    counts: { type: 'array', items: { type: 'object', properties: {
      category: { type: 'string', minLength: 1, maxLength: 80 },
      a: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
      b: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
      instancesA: instanceList, instancesB: instanceList,
    }, required: ['category','a','b','instancesA','instancesB'] } },
    changed: { type: 'array', items: { type: 'object', properties: {
      type: { type: 'string', minLength: 1 }, where: { type: 'string', minLength: 1 }, note: { type: 'string', minLength: 1 },
    }, required: ['type','where','note'] } },
    uncertain: itemAnswerList,
  }, required: ['added','removed','counts','changed','uncertain'],
};

const PAIR_PROMPT = (a: string, b: string) =>
  `Compare ${a} and ${b} of the same room (a=${a}, b=${b}). Match physical instances. ` +
  'Inventory portable objects with ONE counts row per canonical singular category, covering every copy in the entire image. Category names must stay the same across the two images; do not include pose, holder, location or support in category names. Do not create separate categories for held and resting copies. ' +
  'Each instancesA/instancesB entry is ONE distinct physical object. Its id is unique within that image, including across categories. List support and holder separately; use holder "none" for unowned and null for unknown support/holder. An object touched by a hand while resting on furniture is still one object, supported by furniture. Never list it twice for two contacts. Total a/b must equal the corresponding instance-list length. Use zero and [] only when that category has no visible instance; use null for an unresolvable total or instance list. ' +
  'A held copy plus a separate copy remaining on a surface counts as TWO in that same category. A change in grip, pose or support of one matched object is not an added/removed entity. Only list genuinely unmatched physical entities in added/removed. Report clear ownership transfers between different people in changed as mismatch; pickup from a surface alone is not an ownership transfer. ' +
  'In changed report screen CONTENT differences (text/UI/picture or dark-to-active) as screen_changed, clear lighting/background differences as mismatch. Ignore tiny compression differences. If category correspondence, counts, ownership or visibility is unresolved, explain in uncertain instead of guessing. Short JSON only: ' +
  'added, removed and uncertain must contain only short non-empty strings. Use [] for no entries, never empty objects. Use the supplied answer schema. Each "category" must name a physical category actually observed in the images, never a placeholder such as "object type" or "category". Always supply both "instancesA" and "instancesB", with "support" and "holder" for each instance. Missing evidence must be explicit null and explained in uncertain, not an omitted field. Use changed:[] when no clear change is visible; do not copy an example defect.';

export const SINGLE_PROMPT =
  'Inspect this photo for physical rendering defects: objects floating or intersecting furniture/body, malformed or extra hands/arms/fingers, distorted face, duplicated person, lens flare/rainbow streaks or added glow, absurd object scale. ' +
  'Check the contact and support of portable objects: an object must visibly rest on a surface or have a plausible grip; a hand resting on a keyboard or tabletop is not carrying the entire object. Report only visibly impossible support/contact as implausible_placement; occluded contact alone is not proof of floating. ' +
  'Report only clear defects. JSON only: {"defects":[{"type":"floating|anatomy|scale|implausible_placement|light_artifact","where":"...","note":"..."}]}';

export const buildPairPrompt = (cast?:VerifiedPersonInventory,swapped=false) => PAIR_PROMPT('IMAGE 1', 'IMAGE 2') + (cast ? ` Explicit reference-cast scene: a separate strict identity inventory checks every authorized person exactly once. Still report all actual people, including extra/missing/duplicated ones. Include exactly one canonical counts category "person", with full instance lists; expected IMAGE 1 count is ${swapped?cast.expectedInventoryCount:cast.originalSourceCount}, expected IMAGE 2 count is ${swapped?cast.originalSourceCount:cast.expectedInventoryCount}. These expected counts are not observation: use null/uncertain for ambiguity. For pure person additions/removals use exactly "person" in added/removed, not a clothing, face or owner description. Do not waive object, belongings, ownership, anatomy, lighting or screen defects. ` : '');

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
 * (reverse-order evidence, not statistically independent), C = single-image rendering defects.
 * Structured counts/differences support the verdict; the model can still miss visible defects.
 * Requested action achievement and actual displayed caption are not inspected here.
 */
export async function judgeImage(
  args: { nowImage: string; image: string; predictionPrompt: string; personInventory?:VerifiedPersonInventory },
  options: JudgeOptions = {}
): Promise<LocalJudgeResult> {
  const started = Date.now();
  const ollamaUrl = (options.ollamaUrl ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = options.model ?? process.env.QA_LOCAL_MODEL ?? process.env.VLM_MODEL ?? 'qwen3-vl:4b-instruct';
  const evidence: NonNullable<LocalJudgeResult['evidence']> = {};
  const responseDiagnostics:JudgeResponseDiagnostics={};
  const parsedEvidence = (): PairEvidence => ({ a: parsePairAnswer(evidence.pair, true, true), b: parsePairAnswer(evidence.swappedPair, true, true), single: parseSingleAnswer(evidence.single) });
  const fail = (error: string): LocalJudgeResult => ({ ok: null, score: null, defects: classifyEvidence(parsedEvidence(), args.predictionPrompt, args.personInventory), model, elapsedMs: Date.now() - started, error, inspectionVersion: LOCAL_INSPECTION_VERSION, evidence, responseDiagnostics });
  const now = bare(args.nowImage);
  const img = bare(args.image);
  if (!now || !img) return fail('images must be data:image/...;base64 URLs');
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 90_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const call = async (slot:keyof JudgeResponseDiagnostics,prompt: string, images: string[]): Promise<string> => {
    const callStarted=Date.now();
    const res = await (options.fetchImpl ?? fetch)(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        images,
        stream: false,
        think: false,
        format: images.length === 2 ? PAIR_ANSWER_SCHEMA : 'json',
        keep_alive: process.env.OLLAMA_KEEP_ALIVE ?? '5m',
        // Share recognition/planning runner context; keep this judge's original output budget.
        // Keep the context size stable; the pair output budget accommodates inventory and differences.
        // No extra calls are added, but longer answers can increase elapsed time.
        options: { temperature: 0, num_predict: images.length === 2 ? 512 : 256, num_ctx: sharedOllamaContextLength(), repeat_penalty: 1.3 },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const body = (await res.json()) as Record<string,unknown>;
    const diagnostic:JudgeResponseDiagnostic={requestElapsedMs:Date.now()-callStarted};
    if(typeof body.done_reason==='string')diagnostic.done_reason=body.done_reason.slice(0,32);
    if(typeof body.done==='boolean')diagnostic.done=body.done;
    for(const key of ['eval_count','prompt_eval_count','total_duration','load_duration','eval_duration','prompt_eval_duration'] as const){
      const value=body[key];if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)diagnostic[key]=value;
    }
    responseDiagnostics[slot]=diagnostic;
    return String(body.response ?? '');
  };
  try {
    evidence.pair = await call('pair',buildPairPrompt(args.personInventory), [now, img]);
    evidence.swappedPair = await call('swappedPair',buildPairPrompt(args.personInventory,true), [img, now]);
    evidence.single = await call('single',SINGLE_PROMPT, [img]);
    const truncated=Object.entries(responseDiagnostics).filter(([,d])=>d?.done_reason==='length').map(([slot])=>slot);
    if(truncated.length)return fail(`truncated answer: ${truncated.join(', ')}`);
    const ev = parsedEvidence();
    const defects = classifyEvidence(ev, args.predictionPrompt, args.personInventory);
    // Machine check (no model call): skin-tile FFT. QA_GRID_THRESHOLD overrides the whole-image threshold (default -0.1).
    try {
      const g = gridScore(Buffer.from(img, 'base64'));
      const limit = Number(process.env.QA_GRID_THRESHOLD ?? GRID_THRESHOLD_IMAGE);
      if (g && g.score !== null && g.score > limit) defects.push({ type: 'grid', where: 'skin', note: `skin grid suspected: log10(high/mid)=${g.score} over ${g.tiles} tiles` });
    } catch {
      /* the machine check never blocks the verdict */
    }
    const missing = [!ev.a && 'pair', !ev.b && 'swapped pair', !ev.single && 'single'].filter(Boolean);
    if (missing.length) return { ...fail(`unparseable answer: ${missing.join(', ')}`), defects };
    const castIssues=args.personInventory?personInventoryEvidenceIssues(ev,args.personInventory):[];
    const uncertain = [...castIssues,...[ev.a, ev.b].flatMap(pair => [
      ...(pair?.uncertain ?? []),
      ...inventoryIssues(pair),
      ...(pair?.counts ?? []).filter(c => c.a === null || c.b === null).map(c => `uncertain count: ${c.item}`),
    ])];
    // Categories must correspond in both orders. Do not guess aliases or discard
    // support words: a category seen only in one order remains unresolved.
    const categories = new Set([...(ev.a?.counts ?? []), ...(ev.b?.counts ?? [])].map(c=>categoryKey(c.item)));
    for (const category of categories) {
      const a = ev.a?.counts?.find(c=>categoryKey(c.item)===category);
      const b = ev.b?.counts?.find(c=>categoryKey(c.item)===category);
      if (!a || !b) uncertain.push(`unmatched category: ${category}`);
      else if ((a.a !== null && b.b !== null && a.a !== b.b) ||
          (a.b !== null && b.a !== null && a.b !== b.a)) uncertain.push(`inconsistent count: ${category}`);
    }
    if (uncertain.length) return { ...fail(`uncertain preservation: ${uncertain.join('; ')}`), defects };
    return {
      ok: defects.length === 0,
      score: Math.max(0, Math.round((1 - 0.25 * defects.length) * 100) / 100),
      defects,
      model,
      inspectionVersion: LOCAL_INSPECTION_VERSION,
      evidence,
      responseDiagnostics,
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

/** Rechecking an existing image replaces its old verdict for statistics; the audit log stays append-only. */
export function latestQaRows(rows: QaRow[]): QaRow[] {
  const latest = new Map<string, QaRow>();
  for (const row of rows) latest.set(`${row.rulebookVersion}|${row.captureId}|${row.sceneKey}|${isRejectedQaRow(row) ? row.file ?? 'rejected' : 'accepted'}`, row);
  return [...latest.values()].sort((a,b) => a.time.localeCompare(b.time));
}

export interface QaMetrics {
  images: number;
  judged: number;
  unknown: number;
  defective: number;
  defectRate: number | null;
  byType: Record<string, { count: number; rate: number | null }>;
  avgScore: number | null;
  avgElapsedMs: number | null;
}

/** Old logs identify rejected attempts in the scene key; keep them out of displayed-image rates. */
export function isRejectedQaRow(row: QaRow): boolean {
  return row.disposition === 'rejected' || /\.rejected\d*$/i.test(row.sceneKey);
}

export interface QaSummaryGroup extends QaMetrics {
  key: string;
  rejected: QaMetrics;
  completedCaptures: number;
}

export function qaMetrics(list: QaRow[]): QaMetrics {
  const judged = list.filter(r => typeof r.ok === 'boolean');
  const defective = judged.filter(r => r.ok === false);
  const byType: QaMetrics['byType'] = {};
  for (const r of defective) for (const t of new Set(r.defects.map(d => d.type))) byType[t] = { count: (byType[t]?.count ?? 0) + 1, rate: null };
  for (const t of Object.keys(byType)) byType[t].rate = judged.length ? round3(byType[t].count / judged.length) : null;
  const scores = judged.map(r => r.score).filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  const times = list.map(r => r.elapsedMs).filter(n => Number.isFinite(n));
  return {
    images: list.length, judged: judged.length, unknown: list.length - judged.length,
    defective: defective.length, defectRate: judged.length ? round3(defective.length / judged.length) : null, byType,
    avgScore: scores.length ? round3(scores.reduce((s, n) => s + n, 0) / scores.length) : null,
    avgElapsedMs: times.length ? Math.round(times.reduce((s, n) => s + n, 0) / times.length) : null,
  };
}

/** Only captures with every expected accepted scene judged count towards validation. */
export function completedQaCaptureIds(rows: QaRow[]): Set<string> {
  const groups = new Map<string, QaRow[]>();
  for (const row of latestQaRows(rows)) {
    if (isRejectedQaRow(row)) continue;
    (groups.get(row.captureId) ?? groups.set(row.captureId, []).get(row.captureId)!).push(row);
  }
  const complete = new Set<string>();
  for (const [id, list] of groups) {
    const expected = Math.max(...list.map(r => r.sceneCount ?? 3));
    if (Number.isInteger(expected) && expected > 0 && list.length === expected &&
        new Set(list.map(r => r.sceneKey)).size === expected &&
        new Set(list.map(r => r.rulebookVersion)).size === 1 && list.every(r => typeof r.ok === 'boolean')) complete.add(id);
  }
  return complete;
}

/** Primary metrics describe accepted images; rejected attempts remain separate improvement evidence. */
export function summarizeQa(rows: QaRow[], by: 'rulebookVersion' | 'day' | 'none' = 'none'): QaSummaryGroup[] {
  const groups = new Map<string, QaRow[]>();
  for (const r of rows) {
    const key = by === 'rulebookVersion' ? String(r.rulebookVersion ?? 'none') : by === 'day' ? String(r.time).slice(0, 10) : 'all';
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  return [...groups].map(([key, list]) => ({
    key, ...qaMetrics(list.filter(r => !isRejectedQaRow(r))),
    rejected: qaMetrics(list.filter(isRejectedQaRow)), completedCaptures: completedQaCaptureIds(list).size,
  })).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
