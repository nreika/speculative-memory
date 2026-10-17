/**
 * Automatic QA of generated images (non-blocking, advisory only).
 *
 * When a capture completes, ONE Gemini request looks at the source frame plus
 * every generated image and reports the typical Qwen-Image-Edit failures:
 * extra/duplicated limbs, the same person duplicated, invented objects (e.g. a
 * clock where none exists), melted faces/hands, changed identity.
 *
 * It never delays or blocks generation or display: it runs after
 * `generation.completed`, and every error is caught and logged.
 *
 * Output
 *   logs/qa.jsonl            one JSON line per capture (git-ignored)
 *   captures/qa_flagged/     copies of images with severity >= 2 (git-ignored)
 *   `./node_modules/.bin/tsx scripts/qa-summary.ts [hours]` summarises the log.
 *
 * Env
 *   QA_ENABLED  default "true"; set to 0/false/off/no to disable.
 *   QA_MODEL    default "gemini-3-flash-preview" (the model geminiService uses
 *               for scenarios). "gemini-3-pro-preview" is slower and costlier.
 *   Key: API_KEY || GEMINI_API_KEY (never logged).
 */
import fs from 'fs';
import path from 'path';
import { GoogleGenAI, Type } from '@google/genai';
import { recordGeminiUsage } from '../usage/costTracker';

export const DEFAULT_QA_MODEL = 'gemini-3-flash-preview';
export const QA_FLAG_SEVERITY = 2;
const QA_TIMEOUT_MS = 120_000;
const MAX_IN_FLIGHT = 2;

export interface QaImageInput {
  label: string; // e.g. "gen_a"
  path: string; // absolute path
  predictionPrompt?: string;
}

export interface QaVerdict {
  index: number;
  people_in_source: number;
  people_in_image: number;
  hands_per_person: string;
  duplicated_person: boolean;
  limb_anomaly: boolean;
  limb_detail: string;
  invented_object: boolean;
  invented_detail: string;
  face_or_hand_distortion: boolean;
  distortion_detail: string;
  identity_changed: boolean;
  severity: number;
  reason: string;
}

export interface QaResult {
  model: string;
  latencyMs: number;
  usage: { promptTokens: number; outputTokens: number; thinkingTokens: number } | null;
  verdicts: QaVerdict[];
}

export const isQaEnabled = (): boolean =>
  !/^(0|false|off|no)$/i.test((process.env.QA_ENABLED ?? 'true').trim());
export const getQaModel = (): string => (process.env.QA_MODEL || '').trim() || DEFAULT_QA_MODEL;

export const QA_JUDGE_PROMPT = `You are a strict quality inspector for AI-edited photos. The FIRST image is the SOURCE camera frame (reality). The following images (Image 1, Image 2, ...) were produced by an image-editing model from that source, each with a "what should change" scenario. The editor often makes mistakes; your job is to catch them. Do not be lenient and do not assume the output is fine.

Allowed to change (NOT failures): pose, hand position, expression, gaze, clothing details, time of day, lighting, desk items moved/added when the scenario asks for it, a person leaving the frame.
Failures to detect:
1. duplicated_person: the same person appears more than once (a second copy of the head/body anywhere, including small, distant, partly hidden or in the background). Count heads.
2. limb_anomaly: any extra or missing limb: more than 2 arms, more than 2 hands, extra fingers, an arm with no owner, an arm that does not connect to a shoulder. Count every hand visible in the picture and trace each arm back to a shoulder.
3. invented_object: an object that is NOT in the source frame and not requested by the scenario, notably clocks, flip-clock panels, digital time readouts, numbers/signs, screens showing digits, extra bags, extra people. Compare the source and the image object by object.
4. face_or_hand_distortion: melted, warped, smeared or malformed face/hands/fingers.
5. identity_changed: the person no longer looks like the same person as in the source (different face shape, age, facial hair, skin tone, hair). Judge only from what is visible in both; if the face is cropped out of the source, judge by visible features (hair, facial hair, jaw, skin) and only flag it if clearly different.

Procedure for EACH output image, in this order (fill the fields in this order):
- people_in_source: count of distinct people in the source frame.
- people_in_image: count of distinct people in the output image (heads, even tiny or in background).
- hands_per_person: explicitly count visible hands/arms, e.g. "person1: 2 hands (left on desk, right holding cup)"; list each hand and which arm it belongs to.
- then the boolean flags, each with a short detail (empty string if false).
- severity: 0 = clean (use 0 whenever you found nothing wrong); 1 = trivial blemish nobody would notice; 2 = noticeable failure; 3 = obvious failure that ruins the image (duplicated person, 3rd arm, invented clock, different identity).
- reason: one line in Japanese.
The scenario text describes the INTENDED change. Anything it describes (objects moved, rotated, rearranged, a person leaning, turning, reaching, etc.) is NOT a failure. Moved or re-arranged objects are not "invented"; invented_object means a NEW object (or person) that exists in neither the source nor the scenario, e.g. a clock, a number sign, an extra bag or chair that appears from nowhere. Small changes in dim or noisy scenes are not failures.
Do NOT judge whether the scenario was followed; only visual defects count. Ordinary furniture or items (chairs, boxes, bags, cables, armrests) that appear, move or change in a mostly empty or dark scene are severity 1 at most, unless clearly malformed or an obvious duplicate. Reserve severity 2-3 for: a person duplicated or added, extra/missing limbs, malformed faces or hands, a changed identity, and clocks, digits, text, signs or screens that are not in the source.
Calibration: be strict about STRUCTURAL failures (extra people, extra arms/hands, invented objects, changed identity) but conservative about fine detail. Flag face_or_hand_distortion or finger problems only when the anatomy is clearly wrong at normal viewing size. Foreshortened, overlapping, slightly soft or partly hidden fingers are normal; do not flag a finger count unless you can clearly see a hand with more than 5 digits. Severity 2+ means a typical viewer would notice at a glance.
If people_in_image != people_in_source (and the scenario does not make someone leave), duplicated_person is true. If more than 2 hands belong to one person, limb_anomaly is true.`;

const FIELD_ORDER = [
  'index',
  'people_in_source',
  'people_in_image',
  'hands_per_person',
  'duplicated_person',
  'limb_anomaly',
  'limb_detail',
  'invented_object',
  'invented_detail',
  'face_or_hand_distortion',
  'distortion_detail',
  'identity_changed',
  'severity',
  'reason',
];

const verdictSchema = {
  type: Type.OBJECT,
  propertyOrdering: FIELD_ORDER,
  properties: {
    index: { type: Type.INTEGER, description: '1-based number of the generated image.' },
    people_in_source: { type: Type.INTEGER },
    people_in_image: { type: Type.INTEGER },
    hands_per_person: { type: Type.STRING, description: 'Explicit hand/arm count per person before deciding.' },
    duplicated_person: { type: Type.BOOLEAN },
    limb_anomaly: { type: Type.BOOLEAN },
    limb_detail: { type: Type.STRING, description: 'e.g. "3 hands visible on one person"; empty if none.' },
    invented_object: { type: Type.BOOLEAN },
    invented_detail: { type: Type.STRING },
    face_or_hand_distortion: { type: Type.BOOLEAN },
    distortion_detail: { type: Type.STRING },
    identity_changed: { type: Type.BOOLEAN },
    severity: { type: Type.INTEGER, description: '0 clean .. 3 obvious failure' },
    reason: { type: Type.STRING, description: 'One line, Japanese.' },
  },
  required: FIELD_ORDER,
};

const mimeOf = (file: string) => {
  const ext = path.extname(file).toLowerCase();
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
};
const inlinePart = (file: string) => ({
  inlineData: { mimeType: mimeOf(file), data: fs.readFileSync(file).toString('base64') },
});

const getAI = () =>
  new GoogleGenAI({ apiKey: process.env.API_KEY || process.env.GEMINI_API_KEY || '' });

/** One Gemini request: source frame + all generated images -> one verdict per image. */
export async function judgeImages(
  sourcePath: string,
  images: QaImageInput[],
  opts: { model?: string; prompt?: string; timeoutMs?: number; captureId?: string | null } = {}
): Promise<QaResult> {
  const model = opts.model || getQaModel();
  const parts: any[] = [{ text: 'SOURCE frame:' }, inlinePart(sourcePath)];
  images.forEach((img, i) => {
    parts.push({
      text: `Image ${i + 1} (${img.label}). Scenario/prediction prompt: ${img.predictionPrompt || '(not available)'}`,
    });
    parts.push(inlinePart(img.path));
  });
  parts.push({ text: opts.prompt || QA_JUDGE_PROMPT });

  const started = Date.now();
  const call = getAI().models.generateContent({
    model,
    contents: { parts },
    config: {
      responseMimeType: 'application/json',
      temperature: 0,
      responseSchema: { type: Type.ARRAY, items: verdictSchema },
    },
  }).then((r) => {
    // Billed even if the timeout below already gave up on waiting.
    recordGeminiUsage({ purpose: 'qa', model, response: r, captureId: opts.captureId });
    return r;
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('QA request timed out')), opts.timeoutMs ?? QA_TIMEOUT_MS);
  });
  let response;
  try {
    response = await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    call.catch(() => undefined);
  }
  const latencyMs = Date.now() - started;
  const raw = JSON.parse(response.text || '[]');
  if (!Array.isArray(raw)) throw new Error('QA response was not an array');
  const verdicts: QaVerdict[] = raw.map((v: any, i: number) => ({
    ...v,
    index: Number.isInteger(v?.index) ? v.index : i + 1,
    severity: Math.max(0, Math.min(3, Number(v?.severity) || 0)),
  }));
  const u: any = response.usageMetadata;
  return {
    model,
    latencyMs,
    usage: u
      ? {
          promptTokens: u.promptTokenCount ?? 0,
          outputTokens: u.candidatesTokenCount ?? 0,
          thinkingTokens: u.thoughtsTokenCount ?? 0,
        }
      : null,
    verdicts,
  };
}

// ---------------------------------------------------------------------------
// Server hook: collect saved images per capture, judge after completion.
// ---------------------------------------------------------------------------

interface SavedImageEvent {
  captureId: string;
  sceneKey: string;
  absolutePath: string;
  sourceImageAbsolutePath: string | null;
}

interface Pending {
  sourcePath: string | null;
  images: QaImageInput[];
  prompts: Map<string, string>;
}

export function createCaptureQa(options: { rootDir: string; capturesDir: string }) {
  const pending = new Map<string, Pending>();
  let inFlight = 0;
  const logPath = path.join(options.rootDir, 'logs', 'qa.jsonl');
  const flaggedDir = path.join(options.capturesDir, 'qa_flagged');
  const rel = (p: string) => path.relative(options.rootDir, p).replace(/\\/g, '/');

  const entry = (captureId: string): Pending => {
    let e = pending.get(captureId);
    if (!e) {
      e = { sourcePath: null, images: [], prompts: new Map() };
      pending.set(captureId, e);
      if (pending.size > 20) pending.delete(pending.keys().next().value as string);
    }
    return e;
  };

  const run = async (captureId: string, p: Pending) => {
    if (!p.sourcePath || !p.images.length) return;
    const images = p.images.map((i) => ({ ...i, predictionPrompt: p.prompts.get(i.label) }));
    const result = await judgeImages(p.sourcePath, images, { captureId });
    const verdicts = images.map((img, i) => {
      const v = result.verdicts.find((x) => x.index === i + 1) ?? result.verdicts[i];
      return { label: img.label, file: rel(img.path), ...(v ?? { severity: null, reason: 'no verdict returned' }) };
    });
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        captureId,
        source: rel(p.sourcePath),
        model: result.model,
        latencyMs: result.latencyMs,
        usage: result.usage,
        verdicts,
      }) + '\n',
      'utf8'
    );
    const flagged = verdicts.filter((v) => typeof v.severity === 'number' && v.severity >= QA_FLAG_SEVERITY);
    if (flagged.length) {
      fs.mkdirSync(flaggedDir, { recursive: true });
      for (const v of flagged) {
        const src = path.join(options.rootDir, v.file);
        fs.copyFileSync(src, path.join(flaggedDir, path.basename(src)));
      }
      const srcCopy = path.join(flaggedDir, path.basename(p.sourcePath));
      if (!fs.existsSync(srcCopy)) fs.copyFileSync(p.sourcePath, srcCopy);
      console.log(
        `[qa] ${captureId}: FLAGGED ${flagged.map((v) => `${v.label}(sev ${v.severity}: ${(v as any).reason})`).join(', ')}`
      );
    } else {
      console.log(`[qa] ${captureId}: ok (${result.latencyMs}ms)`);
    }
  };

  return {
    /** Call from publishCapture for every saved image. */
    noteSaved(e: SavedImageEvent) {
      if (!isQaEnabled()) return;
      const p = entry(e.captureId);
      if (e.sourceImageAbsolutePath) p.sourcePath = e.sourceImageAbsolutePath;
      p.images.push({ label: e.sceneKey, path: e.absolutePath });
    },
    /** Optional context: the scenario's prediction prompt for a scene. */
    notePrompt(captureId: string, sceneKey: string, prompt: string) {
      if (!isQaEnabled()) return;
      entry(captureId).prompts.set(sceneKey, prompt);
    },
    /** Call on generation.completed. Returns immediately; never throws. */
    onCompleted(captureId: string) {
      const p = pending.get(captureId);
      pending.delete(captureId);
      if (!isQaEnabled() || !p) return;
      if (inFlight >= MAX_IN_FLIGHT) {
        console.warn(`[qa] ${captureId}: skipped (QA backlog)`);
        return;
      }
      inFlight += 1;
      setImmediate(() => {
        run(captureId, p)
          .catch((error) => console.error(`[qa] ${captureId} failed:`, error instanceof Error ? error.message : error))
          .finally(() => {
            inFlight -= 1;
          });
      });
    },
    /** Call on cancelled/failed: drop what was collected. */
    discard(captureId: string) {
      pending.delete(captureId);
    },
  };
}
