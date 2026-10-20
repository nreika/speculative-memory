// 2026-10-20: the 4B planner ignores the Tone sentence (TONE 1 scenes came back as "slightly turns the head").
// After planning, a scene whose wording contradicts its tone band is rewritten once by a short text-only call.
// Failure keeps the original plan (never blocks a capture).
import { toneBandIndex } from './rulebook';
import { sharedOllamaContextLength } from './sharedOllamaContext';

const WEAK_EN = /\b(slight|slightly|a little|small|subtle|subtly|barely|gently|gentle|minor|faint|tiny)\b/i;
const WEAK_JA = /(わずか|少し|軽く|ほんの|かすか|ちょっと|ゆっくり)/;
const STRONG_EN = /\b(stands? up|stood up|walks?|walked|leaves?|left the|jumps?|runs?|raises? (both|their|his|her) (arms|hands)|turns? around|lies? down|throws?|dances?|stretches?)\b/i;

export type ToneMismatch = 'too_weak' | 'too_strong' | null;

export function toneMismatch(tone: number, english: string, japanese = ''): ToneMismatch {
  const band = toneBandIndex(Number.isFinite(tone) ? tone : 0.3);
  if (band >= 2 && (WEAK_EN.test(english) || WEAK_JA.test(japanese))) return 'too_weak';
  if (band === 0 && STRONG_EN.test(english)) return 'too_strong';
  return null;
}

const TARGET = [
  'CALM: almost nothing changes; at most a tiny shift of gaze or fingers.',
  'QUIET: one small but visible change of pose or gaze.',
  'LIVELY: a clearly visible action on an object that is already visible near the person (e.g. picking it up, opening it, pushing it aside), with the hands and arms in a clearly different position.',
  'DRAMATIC: a large, concrete action on an object that is already visible near the person, ending in a clearly different body pose (e.g. picking the object up off where it rests and holding it against the chest, lifting it to shoulder height, pulling it toward themselves). The person stays at the same spot.',
];

export interface ToneRewrite { prediction_prompt: string; scenario_description: string }

// Recent rewritten actions (newest last) so high-tone scenes do not all become the same "pick it up" move.
const recentActions: string[] = [];
export function rememberToneAction(action: string): void { recentActions.push(action.slice(0, 160)); if (recentActions.length > 6) recentActions.shift(); }

export function toneRewritePrompt(tone: number, english: string, japanese: string, seconds: number | null): string {
  const band = toneBandIndex(Number.isFinite(tone) ? tone : 0.3);
  const span = typeof seconds === 'number' && Number.isFinite(seconds) ? `${Math.abs(seconds)} seconds ${seconds < 0 ? 'earlier' : 'later'}` : 'a moment later';
  return [
    `Rewrite ONE planned action for a single still photo taken ${span}. Required intensity — ${TARGET[band]}`,
    'Keep exactly the same people (count, who they are, where they are), the same objects and the same room. Do not add people or objects. Do not mention faces turning to the camera.',
    'Replace weak words (slightly, a little, small, わずか, 少し) with one concrete verb on a specific object that is visible in the scene (pick up, lift, hold against the chest, pull, open). Do NOT make the person stand up, step back, walk away, leave the frame or turn toward the camera; their face stays as hidden as in the original.',
    `Original action (English): ${english}`,
    `Original action (Japanese): ${japanese}`,
    recentActions.length ? 'Do not repeat these recently used actions; choose a different object or a different verb: ' + recentActions.join(' | ') : '',
    'Answer JSON: {"prediction_prompt": English, one sentence; "scenario_description": Japanese, one sentence, starting with the same time phrase as the original Japanese}.',
  ].join('\n');
}

export async function rewriteForTone(args: { tone: number; english: string; japanese: string; seconds: number | null; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<ToneRewrite | null> {
  const url = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  try {
    const res = await (args.fetchImpl ?? fetch)(`${url}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.VLM_MODEL || 'gemma3:latest', prompt: toneRewritePrompt(args.tone, args.english, args.japanese, args.seconds),
        stream: false, think: false, keep_alive: process.env.VLM_PHASE_KEEP_ALIVE ?? '2m',
        format: { type: 'object', properties: { prediction_prompt: { type: 'string' }, scenario_description: { type: 'string' } }, required: ['prediction_prompt', 'scenario_description'] },
        options: { temperature: 0.2, num_predict: 300, num_ctx: sharedOllamaContextLength() },
      }),
      signal: args.signal ? AbortSignal.any([args.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { response?: string; done_reason?: string };
    if (json.done_reason === 'length') return null;
    const value = JSON.parse(json.response || '{}');
    const en = String(value?.prediction_prompt ?? '').trim();
    // The 4B model sometimes appends English ("…向きChanged.") to the Japanese line: cut trailing Latin text, end with 。
    let ja = String(value?.scenario_description ?? '').trim().replace(/[\sA-Za-z0-9.,;:'"!?()\-]+$/, '').replace(/[、,]$/, '');
    if (ja && !/[。！？]$/.test(ja)) ja += '。';
    if (/[A-Za-z]{3,}/.test(ja)) return null;
    if (en.length < 12 || en.length > 600 || ja.length < 4 || ja.length > 300) return null;
    // The rewrite must actually fix the mismatch; otherwise keep the original.
    if (toneMismatch(args.tone, en, ja)) return null;
    // 2026-10-20 A/B: standing up / stepping back / leaping broke the framing and turned faces to the camera.
    if (/\b(stands? up|stood up|steps? back|walks?|leaves?|leaps?|jumps?|turns? (to|toward) the camera)\b/i.test(en)) return null;
    // Chinese/Japanese inside the English instruction (seen 2026-10-20) or a copy of a recent action is refused.
    if (/[぀-ヿ一-鿿]/.test(en)) return null;
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
    if (recentActions.some((r) => norm(r) === norm(en))) return null;
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
