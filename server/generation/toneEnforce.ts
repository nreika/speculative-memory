// 2026-10-20: the 4B planner ignores the Tone sentence (TONE 1 scenes came back as "slightly turns the head").
// After planning, a scene whose wording contradicts its tone band is rewritten once by a short text-only call.
// Failure keeps the original plan (never blocks a capture).
import { toneBandIndex } from './rulebook';
import { spanChangeRequirement } from '../../services/promptBuilder';
import { sharedOllamaContextLength } from './sharedOllamaContext';

const WEAK_EN = /\b(slight|slightly|a little|small|subtle|subtly|barely|gently|gentle|minor|faint|tiny)\b/i;
const WEAK_JA = /(わずか|少し|軽く|ほんの|かすか|ちょっと|ゆっくり)/;
const STRONG_EN = /\b(stands? up|stood up|walks?|walked|leaves?|left the|jumps?|runs?|raises? (both|their|his|her) (arms|hands)|turns? around|lies? down|throws?|dances?|stretches?)\b/i;

// 2026-10-21: "posture remains unchanged / no visible movement" is a non-plan at any band above CALM (all three scenes of
// TSC-002 F010 came back like that and passed the tone check). A plan with a real body action verb is not static.
const STATIC_EN = /\b(remains?|remained|stays?|stayed|unchanged|no (visible |noticeable )?(change|movement|motion)|does not (move|change)|did not (move|change)|motionless|keeps? the same)\b/i;
const STATIC_JA = /(変化せず|変わらない|変わらず|変化(は)?(見られ|ない)|動き(は)?(見られ|ない)|動かない|変化なし|そのまま)/;

export type ToneMismatch = 'too_weak' | 'too_strong' | 'implausible' | null;

/** Theatrical / unnatural movements nobody does in an office (2026-10-21 user feedback: "raises it high overhead with locked elbows"). */
export const IMPLAUSIBLE = /\b(overhead|over (their|his|her|the) head|above (their|his|her|the) head|high above|locks? (the|their|his|her) elbows?|locked elbows?|fully extended|fully stretched|thrusts?|thrusting|triumph\w*|victor\w*|heroic\w*|dramatic\w*|theatrical\w*|shouts?|screams?)\b/i;

/**
 * Back view (2026-10-21): any word that implies eyes, gaze, a face or an expression makes the image model draw a face on the
 * back of the head (the negative prompt does nothing at cfg 1.0). Head motion is allowed only as tilting / nodding seen from behind.
 */
export const BACK_VIEW_FORBIDDEN = /\b(eyes?|gaz(e|es|ed|ing)|look(s|ed|ing)?|glanc(e|es|ed|ing)|stare[sd]?|staring|face[sd]?|facing|smil(e|es|ed|ing)|laugh(s|ed|ing|ter)?|grin(s|ned|ning)?|scream(s|ed|ing)?|shout(s|ed|ing)?|yell(s|ed|ing)?|cr(y|ies|ied|ying)|blink(s|ed|ing)?|wink(s|ed|ing)?|expressions?|mouth|lips?|turns?\s+(?:\w+\s+){0,2}(head|face)|head\s+turns?|turns?\s+(?:sharply\s+|slowly\s+|quickly\s+)?(to|toward|towards)\b|turns?\s+(around|back))\b/i;
/** Hands hidden in front of the body produce tangled arms from behind ("holds the bottle against the chest"). */
export const BACK_VIEW_HANDS_HIDDEN = /\b(against|to|toward|towards|onto) (their|his|her|the) (chest|torso|stomach)\b|\bin front of (their|his|her|the) (body|chest|face|torso)\b|\bpulls? [\w\s]{0,24}(toward|towards) (themselves|their (body|chest))\b|\bhugs?\b|\bclutch(es)?\b/i;
export const backViewForbiddenHit = (english: string) => BACK_VIEW_FORBIDDEN.test(String(english ?? '')) || BACK_VIEW_HANDS_HIDDEN.test(String(english ?? ''));
const BACK_VIEW_SAFE: Array<{ en: string; ja: string }> = [
  { en: 'The person stretches both arms forward over the desk and rolls the shoulders, with their back to the camera.', ja: '両腕を前に伸ばして肩を回す。' },
  { en: 'The person reaches to the side with one arm and takes a visible object, with their back to the camera.', ja: '片腕を横へ伸ばして手近な物を取る。' },
  { en: 'The person leans the upper body forward over the desk, with their back to the camera.', ja: '上半身を机の方へ前かがみに倒す。' },
  { en: 'The person rubs the back of the neck with one hand, with their back to the camera.', ja: '片手で首の後ろをさする。' },
  { en: 'The person pushes the chair back a little and shifts the weight, with their back to the camera.', ja: '椅子を少し引いて体重を移す。' },
  { en: 'The person rests both elbows on the desk and leans in, with their back to the camera.', ja: '両ひじを机について身を乗り出す。' },
  { en: 'The person sits up straight and settles the shoulders, with their back to the camera.', ja: '背筋を伸ばして肩を落ち着かせる。' },
  { en: 'The back of the head tilts to one side while the person stretches the neck, with their back to the camera.', ja: '首を横へ傾けて伸ばす。' },
  { en: 'The person adjusts the sleeve of one arm with the other hand, with their back to the camera.', ja: '片方の袖をもう一方の手で直す。' },
  { en: 'The person leans back in the chair and lets both arms hang loosely, with their back to the camera.', ja: '椅子にもたれて両腕をだらりと下ろす。' },
];
let backViewRotation = 0;
/** In-place arm / upper-body action for a person seen from behind, with a fixed Japanese caption. */
export function backViewFallback(index: number, seconds: number | null, actor?: string, others = false): { prediction_prompt: string; scenario_description: string } {
  // The pool rotates (a counter on top of the scene index), so consecutive captures do not repeat the same canned action.
  const pick = BACK_VIEW_SAFE[(Math.abs(Math.trunc(index)) + backViewRotation++) % BACK_VIEW_SAFE.length];
  const lead = typeof seconds === 'number' && Number.isFinite(seconds) ? `${Math.abs(Math.round(seconds))}秒${seconds < 0 ? '前' : '後'}、` : '';
  // With 2+ people the actor is named (by clothes / position) and the others stay as they are.
  const en = actor && actor.trim() ? pick.en.replace(/^The person/, actor.trim()) + (others ? ' Everybody else stays exactly as they are.' : '') : pick.en;
  return { prediction_prompt: en, scenario_description: `${lead}人物が${pick.ja}` };
}

/** Quiet band ceiling used for a person seen from behind: an in-place arm / upper-body action, never a big move. */
export const BACK_VIEW_TONE_CAP = 0.44;

/** True when the (non-skipped) plans of a capture say practically the same thing (word overlap >= 0.8 for every pair). */
/** Word-overlap similarity (0..1) of two English plans. */
export function planSimilarity(a: string, b: string): number {
  const words = (x: string) => new Set(String(x ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 2));
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / new Set([...A, ...B]).size;
}

export function plansNearIdentical(texts: string[]): boolean {
  const sets = texts.map((x) => new Set(String(x ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 2)));
  if (sets.length < 2 || sets.some((s) => s.size === 0)) return false;
  for (let i = 0; i < sets.length; i += 1) for (let j = i + 1; j < sets.length; j += 1) {
    const inter = [...sets[i]].filter((w) => sets[j].has(w)).length, union = new Set([...sets[i], ...sets[j]]).size;
    if (inter / union < 0.8) return false;
  }
  return true;
}

// 2026-10-21: at LIVELY/DRAMATIC a plan that only moves the head, eyes or face ("head tilts, eyes widen") is too weak
// as well: the image model then changes only the expression. It must move hands/arms/body or an object.
const BODY_ACTION = /\b(lift|lifts|lifted|lifting|pick|picks|picked|holds? up|open|opens|opened|close|closes|pull|pulls|pulled|push|pushes|pushed|reach|reaches|reached|grab|grabs|grabbed|raise|raises|raised|carr(y|ies|ied)|put|puts|place|places|placed|slide|slides|slam|slams|swing|swings|throw|throws|wave|waves|point|points|gestur\w*|lean|leans|leaning|bend|bends|bending|twist|twists|turns? (their|his|her)? ?(whole )?(body|torso|upper body)|flip|flips|tilts? the|hug|hugs|clap|claps|stretch\w*|type|types|typing|write|writes|writing)\b/i;

/** A span of 5+ minutes needs a plan that really changes the state (activity step, object, posture), not the same gesture again. */
const CHANGE_WORDS = /\b(finish(es|ed)?|put(s)?\s+(\w+\s+){0,3}(down|aside|away)|sets?\s+(\w+\s+){0,3}(down|aside)|(has|have) (left|moved|finished|put|stopped)|no longer|moved? to|now (holds?|holding|sits?|sitting|stands?|standing|works?|working|reads?|reading)|different|another|instead|switch(es|ed)?|rearrang\w+|stack(s|ed)?|closes?|picks? up|takes? out|hands?\s+over|stopped|begins?|starts?|resum\w+)\b/i;
export const spanBand = (seconds: number | null | undefined): 'short' | 'step' | 'long' => {
  const s = Math.abs(typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 30);
  return s <= 90 ? 'short' : s <= 360 ? 'step' : 'long';
};

export function toneMismatch(tone: number, english: string, japanese = '', seconds?: number | null): ToneMismatch {
  const band = toneBandIndex(Number.isFinite(tone) ? tone : 0.3);
  if (english && spanBand(seconds) !== 'short' && typeof seconds === 'number' && Math.abs(seconds) >= 300 && !CHANGE_WORDS.test(english)) return 'too_weak';
  if (english && IMPLAUSIBLE.test(english)) return 'implausible';
  if (band >= 1 && english && !BODY_ACTION.test(english) && (STATIC_EN.test(english) || STATIC_JA.test(japanese))) return 'too_weak';
  if (band >= 2 && (WEAK_EN.test(english) || WEAK_JA.test(japanese))) return 'too_weak';
  if (band >= 2 && english && !BODY_ACTION.test(english)) return 'too_weak';
  if (band === 0 && STRONG_EN.test(english)) return 'too_strong';
  return null;
}

const TARGET = [
  'CALM: almost nothing changes; at most a tiny shift of gaze or fingers.',
  'QUIET: one small but visible change of pose or gaze.',
  'LIVELY: a clearly visible everyday action on an object that is already visible near the person (e.g. picking it up, drinking from it, opening it, pushing it aside), with the hands and arms in a clearly different position.',
  'BIG EVERYDAY MOVEMENT: a big but ordinary movement a real person would do in this room, clearly changing the body pose (e.g. stretching the arms and yawning, leaning back and laughing, pushing the chair back, taking a bottle and drinking, putting on a jacket). Never raise an object overhead, lock the elbows, thrust, strike a pose or act theatrically. The person stays at the same spot.',
];

export interface ToneRewrite { prediction_prompt: string; scenario_description: string }

// Recent rewritten actions (newest last) so high-tone scenes do not all become the same "pick it up" move.
const recentActions: string[] = [];
export function rememberToneAction(action: string): void { recentActions.push(action.slice(0, 160)); if (recentActions.length > 10) recentActions.shift(); }
/** The last actions used (newest last): passed to the planner as "do not repeat". */
export const recentActionList = (): string[] => [...recentActions];

// 2026-10-21: the rewrite invented a coffee mug that was not in the photo; the image model then re-drew the person
// standing in the middle with a phantom mug (malformed). Only objects observed in the photo may be used, and a person
// at the frame edge / seen from behind gets an in-place action (no re-composition).
export function toneRewritePrompt(tone: number, english: string, japanese: string, seconds: number | null, objects: string[] = [], cautious = false, backView = false): string {
  const band = toneBandIndex(Number.isFinite(tone) ? tone : 0.3);
  const span = typeof seconds === 'number' && Number.isFinite(seconds) ? `${Math.abs(seconds)} seconds ${seconds < 0 ? 'earlier' : 'later'}` : 'a moment later';
  return [
    `Rewrite ONE planned action for a single still photo taken ${span}. Required intensity — ${TARGET[band]}`,
    `The photo shows the state ${span}: it must be ${spanChangeRequirement(seconds ?? 30)}. Objects seen anywhere in the recent footage of this room may be used; never an object that was not in this room.`,
    'Keep exactly the same people (count, who they are, where they are), the same objects and the same room. Do not add people or objects. Do not mention faces turning to the camera.',
    'Replace weak words (slightly, a little, small, わずか, 少し) with one concrete verb on a specific object that is visible in the scene (pick up, lift, hold against the chest, pull, open). Do NOT make the person stand up, step back, walk away, leave the frame or turn toward the camera; their face stays as hidden as in the original.',
    objects.length ? `Objects actually visible in the photo (use ONLY these, never any other object): ${objects.join(', ')}.` : 'No movable object is visible in the photo: use a clear hand or arm gesture without any object; do not mention any object that is not already in the original action.',
    cautious ? 'The person is at the edge of the frame or seen from behind: keep them in exactly the same place, size, posture base (seated stays seated) and facing (the back stays toward the camera; never turn around, no face, never stand up). Express the required intensity ONLY with the arms, hands and upper body, in a way that reads clearly from behind. At LIVELY or the big band use a big ordinary in-place action such as stretching both arms forward and rolling the shoulders, reaching to the side to take a visible object, or leaning the whole upper body forward. Never raise anything overhead.' : '',
    backView ? 'The person is seen from behind: NEVER use the words eyes, gaze, looks, glances, stares, face, smile, expression or mouth, and never turn the head toward the camera. Head motion is allowed only as the back of the head tilting or nodding. Use the arms and upper body, in a way that is readable from behind WITHOUT hands in front of the body: reach to the side, stretch the arms forward or out, lean back, roll the shoulders; never hold or hug something against the chest.' : '',
    `Original action (English): ${english}`,
    `Original action (Japanese): ${japanese}`,
    recentActions.length ? 'Do not repeat these recently used actions; choose a different object or a different verb: ' + recentActions.join(' | ') : '',
    'Answer JSON: {"prediction_prompt": English, one sentence}.',
  ].join('\n');
}


const OBJECT_NOUNS = ['mug', 'cup', 'bottle', 'glass', 'phone', 'smartphone', 'book', 'notebook', 'folder', 'box', 'bin', 'container', 'lid', 'bag', 'backpack', 'laptop', 'keyboard', 'mouse', 'pen', 'pencil', 'paper', 'papers', 'document', 'tablet', 'camera', 'microphone', 'mic', 'headphones', 'chair', 'umbrella', 'jacket', 'coat', 'tote', 'can', 'snack', 'food', 'plate', 'remote'];
/** True when the rewrite names an object that is neither in the observed objects nor in the original action. */
export function inventsObject(rewrite: string, original: string, objects: string[]): boolean {
  const known = (objects.join(' ') + ' ' + original).toLowerCase();
  for (const noun of OBJECT_NOUNS) {
    if (new RegExp(`\\b${noun}s?\\b`, 'i').test(rewrite) && !new RegExp(`\\b${noun}`, 'i').test(known)) return true;
  }
  return false;
}

async function ollamaJson(prompt: string, schema: object, numPredict: number, signal: AbortSignal | undefined, fetchImpl: typeof fetch | undefined): Promise<any | null> {
  const url = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const res = await (fetchImpl ?? fetch)(`${url}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.VLM_MODEL || 'gemma3:latest', prompt, stream: false, think: false, keep_alive: process.env.VLM_PHASE_KEEP_ALIVE ?? '2m',
      format: schema, options: { temperature: 0.2, num_predict: numPredict, num_ctx: sharedOllamaContextLength() } }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { response?: string; done_reason?: string };
  if (json.done_reason === 'length') return null;
  try { return JSON.parse(json.response || '{}'); } catch { return null; }
}

export async function rewriteForTone(args: { tone: number; english: string; japanese: string; seconds: number | null; objects?: string[]; cautious?: boolean; backView?: boolean; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<ToneRewrite | null> {
  try {
    // Step 1: the English action only.
    const v1 = await ollamaJson(toneRewritePrompt(args.tone, args.english, args.japanese, args.seconds, args.objects ?? [], !!args.cautious, !!args.backView),
      { type: 'object', properties: { prediction_prompt: { type: 'string' } }, required: ['prediction_prompt'] }, 200, args.signal, args.fetchImpl);
    const en = String(v1?.prediction_prompt ?? '').trim();
    if (en.length < 12 || en.length > 600) return null;
    if (toneMismatch(args.tone, en, '', args.seconds)) return null;
    if (args.backView && backViewForbiddenHit(en)) return null;
    if (inventsObject(en, args.english, args.objects ?? [])) return null;
    // 2026-10-20 A/B: standing up / stepping back / leaping broke the framing and turned faces to the camera.
    if (/\b(stands? up|stood up|steps? back|walks?|leaves?|leaps?|jumps?|turns? (to|toward) the camera|turns? around|turn(s|ed)? to look (back|behind)|looks? (back|behind)|glances? (back|behind)|turns? (his|her|their) (head|body|face) (back|around))\b/i.test(en)) return null;
    // Chinese/Japanese inside the English instruction (seen 2026-10-20) or a copy of a recent action is refused.
    if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(en)) return null;
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
    if (recentActions.some((r) => norm(r) === norm(en))) return null;
    // Step 2: the Japanese caption, translated from the NEW English (never from the original Japanese).
    const lead = (/^\s*(\d+\s*(秒|分)[前後]、)/.exec(args.japanese)?.[1])
      ?? (typeof args.seconds === 'number' && Number.isFinite(args.seconds) ? `${Math.abs(Math.round(args.seconds))}秒${args.seconds < 0 ? '前' : '後'}、` : '');
    const v2 = await ollamaJson(`Translate this action into ONE natural Japanese sentence for a photo caption. Start the sentence with "${lead}". Describe only what the English says; do not add other actions. English: ${en}\nAnswer JSON: {"japanese": the sentence}.`,
      { type: 'object', properties: { japanese: { type: 'string' } }, required: ['japanese'] }, 200, args.signal, args.fetchImpl);
    // The 4B model sometimes appends English ("…向きChanged.") to the Japanese line: cut trailing Latin text, end with 。
    let ja = String(v2?.japanese ?? '').trim().replace(/[\sA-Za-z0-9.,;:'"!?()\-]+$/, '').replace(/[、,]$/, '');
    if (lead && ja && !ja.startsWith(lead.replace(/\s/g, ''))) ja = lead + ja.replace(/^\d+\s*(秒|分)[前後]、?/, '');
    if (ja && !/[。！？]$/.test(ja)) ja += '。';
    if (/[A-Za-z]{3,}/.test(ja) || ja.length < 4 || ja.length > 300 || WEAK_JA.test(ja)) return null;
    rememberToneAction(en);
    return { prediction_prompt: en, scenario_description: ja };
  } catch (error) {
    if (args.signal?.aborted) throw error;
    return null;
  }
}

/** Fallback when the rewrite call fails: swap weak words for clear ones (too_weak) or soften strong verbs (too_strong). */
export function forceToneWording(mismatch: Exclude<ToneMismatch, null>, english: string, japanese: string): ToneRewrite {
  if (mismatch === 'too_weak') {
    const en = english.replace(/\b(slightly|subtly|gently|barely|faintly)\b/gi, 'clearly').replace(/\b(slight|subtle|gentle|minor|faint|tiny|small)\b/gi, 'large').replace(/\ba little\b/gi, 'a lot');
    const ja = japanese.replace(/わずかに|少し|軽く|ほんの少し|かすかに|ちょっと/g, '大きく').replace(/わずかな|小さな|かすかな/g, '大きな').replace(/ゆっくり/g, '勢いよく');
    return { prediction_prompt: en, scenario_description: ja };
  }
  return { prediction_prompt: 'Almost nothing changes: ' + english.replace(STRONG_EN, 'shifts their weight'), scenario_description: japanese };
}
