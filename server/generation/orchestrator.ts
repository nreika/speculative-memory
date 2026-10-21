import {composeSceneReferenceCastInstruction,buildSceneReferenceCast,type ScenePersonReference,type SourceIdentityImage} from './sceneReferenceCast';
import {probe} from '../health/routes';
import {restoreAssetOnlySourceFrame} from '../scenarioFrame';
import {tryAssetOnlyCpuResult} from '../assetOnlyFastPath';
import {generateTurboCandidate,generateTurboProduction,type TurboCandidateParams} from './turboCandidate';
import {defaultLocalImageEngine,selectedLocalImageUrl,type LocalImageEngine} from './imageEngine';
import type { PeopleEditRegion } from './peopleEditRegion';
import { isPastDistance, type PastContinuityVerdict } from './pastScene';
import { behindViewPlacementByPresence, composeBehindViewEdit, isEmptyRoomNoChange, splitCorrection, composeCoherentEdit, keepReferenceIndexes, referenceOwners, ROOM_ANCHOR, temporalSentence, TURBO_NEGATIVE } from './editPrompt';
import { parseHeadBox } from './referenceCrop';
/**
 * Server-side generation orchestrator.
 *
 * Backends:
 *   GENERATION_BACKEND=local   -> Ollama (VLM) + ComfyUI/Qwen (image)   [default]
 *   GENERATION_BACKEND=gemini  -> original Gemini path (services/geminiService)
 *   GENERATION_BACKEND=hybrid  -> Gemini for scenario text, ComfyUI for images
 */
import { FIXED_LIGHTING, identityConstraints, withoutLightingChanges, actionWithBelongings, actionHandConflict } from "./fidelity";
import { withoutHandCommitments, armsChangeAction } from "./handConflict";
import type { PersonInfo } from "./peopleDescribe";
import { behindViewHairPhrase } from "./hairPhrase";
import { behindViewPlacementSentence, behindViewFreeSpotSentence, isStandingAction } from "./behindViewPlacement";
/** Recent person drawn from behind: look, recent place, scene belongings; scene/headBox feed the G-14 v2 free spot. */
export type BehindViewLook = { clothes?: string; hair?: string; position?: string; objects?: string[]; scene?: string; headBox?: readonly number[] | null; belongings?: import("./peopleDescribe").SceneBelonging[] };
import { Target } from "../../types";
import {
  PromptVariantOptions,
  ScenarioResult,
  TimeDirection,
  buildFutureImagePrompt,
  buildScenarioPredictionPrompt,
  clampScenarioCount,
  LONG_SPAN_IMAGE_SEC,
  scenarioDirection,
} from "../../services/promptBuilder";
import {
  buildNegativePrompt,
  buildQualitySuffix,
  comfyConfig,
  generateQwenEdit,
} from "./comfyClient";
import { guardOnce, occupancySourceOf, sanitizeEmptyRoomPrediction } from "./scenarioGuard";
import type { SceneExtras } from "./sceneExtras";
import { planScenariosLocal, vlmConfig, vlmReachable, type PlanTrace, type PlannerLlm } from "./vlmClient";
import { GEMINI_VLM_MODEL, defaultBackends, type StepBackend } from "./backends";
import { foregroundRule, framingAnchor, getRulebook, obstructedLead, personFidelityText, physicsBlock, screenAndFrameText, toneImageRule } from "./rulebook";
import { abandonOnAbort } from "../captureManager";
import {
  DEFAULT_SCENE_PARAMS,
  distanceDirection,
  fallbackSceneDistances,
  normalizeSceneParams,
  presenceAllowsNewPerson,
  type SceneParams,
} from "../../services/sceneParams";

export type GenerationBackend = "local" | "gemini" | "hybrid";

export const BACKEND = ((process.env.GENERATION_BACKEND || "local").toLowerCase() as GenerationBackend);

export type { TimeDirection };

/**
 * Default future distance (seconds) when a client sends none (old clients).
 * Env SCENE_TIME_DELTA_SEC keeps working as that default; the TouchDesigner
 * "Futuredistance" slider overrides it per capture.
 */
const TIME_DELTA_SEC = normalizeSceneParams({
  futureDistanceSec: process.env.SCENE_TIME_DELTA_SEC,
}).futureDistanceSec;

/** Server defaults for scene controls a request does not carry. */
export const SERVER_SCENE_DEFAULTS: SceneParams = {
  ...DEFAULT_SCENE_PARAMS,
  futureDistanceSec: TIME_DELTA_SEC,
  sceneDistancesSec: fallbackSceneDistances(TIME_DELTA_SEC),
};

/**
 * Clock request for one scene from its SIGNED distance: the direction comes from
 * the sign, the digits are shifted by |distance| (so each scene uses its own offset).
 */
export const clockForSignedDistance = (
  signedDistanceSec: number,
  sceneTime: string | undefined,
  visible: boolean | undefined
) => ({
  direction: distanceDirection(signedDistanceSec),
  distanceSec: Math.abs(signedDistanceSec),
  sceneTime,
  visible,
});

/** Clamp + default the Perform-panel controls (per-scene distances, presence, tone) from a request body. */
export const readSceneParams = (body: unknown): SceneParams => normalizeSceneParams(body, SERVER_SCENE_DEFAULTS);

/**
 * Whether the clock/number-sign edit is applied (env COMFYUI_CLOCK_EDIT).
 *   auto (default): only when the scene-understanding step reported a clock
 *                   or number sign as visible in the frame. Detection that is
 *                   unknown, missing or unparseable counts as "not visible".
 *   on:             always edit (the old behaviour; the image model invents a
 *                   clock when the frame has none).
 *   off:            never edit.
 * The digits themselves stay deterministic and server-side either way: they
 * come from the capture time (+/- SCENE_TIME_DELTA_SEC), never from the VLM.
 */
export type ClockEditMode = "auto" | "on" | "off";

/** 2026-10-21: people seen from behind came out with a face on the back of the head ("drinking from the back of the head").
 *  For a back view the amount of change is capped at QUIET and the body orientation is stated explicitly. */
export function backViewTone(tone: number, people?: PersonInfo[]): number {
  // 2026-10-21: no cap any more (a Tone 1 back view came out as "sits quietly"); the body-orientation sentence below stays.
  void people;
  return tone;
}
export function backViewSentence(people?: PersonInfo[]): string {
  if (!people?.some((p) => p.facing === 'away')) return '';
  return "\n\nA person seen from behind stays seen from behind: the back of the head, the back and the shoulders stay toward the camera, no face or front of the body appears on that side, and the arms bend the way they can from a back view. Never draw a face, mouth or eyes on the back of a head.";
}

export function parseClockEditMode(raw: string | undefined): ClockEditMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (["on", "true", "1", "always"].includes(v)) return "on";
  if (["off", "false", "0", "never"].includes(v)) return "off";
  return "auto";
}

export const CLOCK_EDIT_MODE: ClockEditMode = parseClockEditMode(process.env.COMFYUI_CLOCK_EDIT);

export function shouldEditClock(
  visible: boolean | undefined,
  mode: ClockEditMode = CLOCK_EDIT_MODE
): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return visible === true;
}

/** HH / MM parts of a time shifted by `deltaSec` from `base`. */
function shiftClock(base: Date, deltaSec: number): { hh: string; mm: string } {
  const d = new Date(base.getTime() + deltaSec * 1000);
  return {
    hh: String(d.getHours()).padStart(2, "0"),
    mm: String(d.getMinutes()).padStart(2, "0"),
  };
}

/** "08" -> "zero-eight" so the image model can't collapse it to one glyph. */
function spellDigits(s: string): string {
  const names = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  return s
    .split("")
    .map((c) => names[Number(c)] ?? c)
    .join("-");
}

/**
 * Deterministic clock-edit sentence, computed server-side (never via the VLM).
 * The digits are sceneTime + distanceSec (future) or - distanceSec (past).
 */
export function buildClockInstruction(
  direction: TimeDirection,
  sceneTime?: string,
  distanceSec: number = TIME_DELTA_SEC
): string {
  const base = sceneTime ? new Date(sceneTime) : new Date();
  if (Number.isNaN(base.getTime())) return "";
  const { hh, mm } = shiftClock(base, direction === "future" ? distanceSec : -distanceSec);
  return (
    ` Change ONLY the digits on the physical flip-number sign so its top row shows the two digits ` +
    `${hh} (${spellDigits(hh)}) and its bottom row shows the two digits ${mm} (${spellDigits(mm)}) ` +
    `- keep both digits, including any leading zero (write "${mm}", never "${mm.replace(/^0/, "")}"), ` +
    `same card style, size and position as the input. Do not write the letters H or M.`
  );
}

export { scenarioDirection };

type GeminiModule = Pick<
  typeof import("../../services/geminiService"),
  "planWithGemini" | "generateGeminiText" | "generateImageFromInstruction"
>;

let geminiOverride: GeminiModule | null = null;
/** Tests inject a mock here so no Gemini call is made. */
export function setGeminiModuleForTests(m: GeminiModule | null) {
  geminiOverride = m;
}

async function geminiModule(): Promise<GeminiModule> {
  if (geminiOverride) return geminiOverride;
  // Loaded lazily so the local path never needs @google/genai / an API key.
  return import("../../services/geminiService");
}

/** Server default per step (GENERATION_BACKEND). */
export const DEFAULT_STEP_BACKENDS = defaultBackends(BACKEND);

/** The planner model behind the shared guard/history/extras pipeline when vlmBackend=gemini. */
export function geminiPlannerLlm(
  g: GeminiModule,
  captureId: string | null | undefined,
  signal: AbortSignal | undefined
): PlannerLlm {
  let attempt = 0;
  return {
    model: GEMINI_VLM_MODEL,
    plan: (prompt, imageDataUrl, sig) =>
      abandonOnAbort(g.planWithGemini(prompt, imageDataUrl, { captureId, attempt: (attempt += 1) }, sig ?? signal), sig ?? signal),
    text: (prompt, sig) => abandonOnAbort(g.generateGeminiText(prompt, { captureId }, sig ?? signal), sig ?? signal),
  };
}

export async function predictScenarios(args: {
  imageDataUrl: string;
  target: Target | null;
  scenarioCount: number;
  options?: PromptVariantOptions;
  sceneTime?: string;
  /** Future distance / presence / tone (already clamped; default = server defaults). */
  sceneParams?: SceneParams;
  /** For cost attribution (logs/usage.jsonl). */
  captureId?: string | null;
  /**
   * Cancels the planning step. The Gemini call cannot be stopped, so it is
   * abandoned (rejects immediately, its late result is dropped); the local
   * Ollama request is closed.
   */
  signal?: AbortSignal;
  /** Optional out-param: receives the VLM prompt/raw response (archive). */
  trace?: PlanTrace;
  /** A person was seen recently: people in scenarios are allowed (the guard then does not replace them). */
  allowPerson?: boolean;
  /** G-24/G-25 per-scene empty-room decisions (emptyRoomDecision.ts); see planScenariosLocal. */
  emptyRoomScenes?: import("./emptyRoomDecision").EmptyRoomSceneDecision[];
  /** TD sceneExtras (checked after local planning). */
  sceneExtras?: SceneExtras;
  /** Person detector verdict on the source frame. */
  detector?: { person: boolean | null; count?: number; elapsedMs: number; doneReason?: string; raw?: string };
  /** People described by the short image call, and the signed distance of each scene. */
  people?: import("./peopleDescribe").PersonInfo[];
  sceneDistances?: number[];
  /** Scene-recognition backend for this request (default: from GENERATION_BACKEND). */
  vlmBackend?: StepBackend;
}): Promise<ScenarioResult[]> {
  const count = clampScenarioCount(args.scenarioCount);
  const sceneParams = args.sceneParams ?? SERVER_SCENE_DEFAULTS;
  const vlmBackend = args.vlmBackend ?? DEFAULT_STEP_BACKENDS.vlm;

  // Gemini: same planner pipeline (people facts, guard, history/extras note, English plan + Japanese display),
  // only the model calls differ. Gemini returns reliable JSON, so retries stay at the planner's own minimum.
  const llm = vlmBackend === "gemini" ? geminiPlannerLlm(await geminiModule(), args.captureId, args.signal) : undefined;

  const prompt = buildScenarioPredictionPrompt(args.target, count, args.options, sceneParams);
  return planScenariosLocal({
    imageDataUrl: args.imageDataUrl,
    prompt,
    scenarioCount: count,
    trace: args.trace,
    signal: args.signal,
    allowPerson: args.allowPerson,
    emptyRoomScenes: args.emptyRoomScenes,
    sceneExtras: args.sceneExtras,
    detector: args.detector,
    people: args.people,
    sceneDistances: args.sceneDistances,
    llm,
    ...(llm ? { maxAttempts: Math.min(2, args.people && args.people.length > 0 ? 2 : 1) } : {}),
  });
}

/**
 * A person who was in the room minutes ago is drawn again in an empty frame: from behind, same clothes and hair
 * (no face is shown, so identity mismatches do not matter). One place for the fixed constraint text.
 */
export const BEHIND_VIEW_RULE = "The person is seen from behind with their back turned to the camera; the face is not visible.";
/** The recent-person path draws exactly ONE person (the last one seen), never a second or a duplicate. */
export const ONE_PERSON_RULE = "Exactly one person appears in the whole image, and no second person or duplicate.";

/**
 * G-15: the behind view never shows a face or a profile (one B render turned the head to a side view). Fixed text,
 * added right after the rulebook behindViewRule.
 */
export const BEHIND_VIEW_NO_FACE_RULE =
  "Seen from behind; no part of the face is visible: no profile, no cheek, nose or eye outline, the head is not turned to the side or toward the camera, only the back of the head and the hair are seen.";

/** `action`: the planned action; a standing (not clearly seated) person also gets the concrete free spot (G-14 v2). */
export function behindViewSentence(p?: BehindViewLook, action?: string): string {
  const ip = getRulebook().imagePrompt;
  // G-13: the hair is written as described, with base colour and coloured tips kept apart ("dark hair, only the tips pink").
  const hair = behindViewHairPhrase(p?.hair);
  const same = [p?.clothes ? `same clothes: ${p.clothes}` : "", hair ? `same hair: ${hair} (keep the hair length exactly; never shorten or lengthen it)` : ""].filter(Boolean).join(", ");
  const base = (same ? `${ip.behindViewRule} ${same[0].toUpperCase()}${same.slice(1)}.` : ip.behindViewRule) + ` ${BEHIND_VIEW_NO_FACE_RULE} ${ip.hairRule}`;
  const place = p?.position ? ` (${p.position}, e.g. at the far desk)` : "";
  return (
    `${ip.onePersonRule} ${base} The person stands or sits at their original place${place} at the same scale as in the reference image: ` +
    ip.behindViewPlacementRule +
    // G-14 (2026-10-19): beside the existing objects, never on top of / in place of them; an occupied place moves aside.
    " " + behindViewPlacementSentence(p?.objects) +
    // G-14 v2: a standing person gets one named free spot beside the occupied chair (seated renders kept the belongings).
    (isStandingAction(action) ? " " + behindViewFreeSpotSentence(p) : "")
  );
}

/** G-13: hair never changes (also for the recent person drawn from behind). Reserved QA class name: "hair_mismatch". */
export const HAIR_RULE =
  "Keep each person's hairstyle, hair length and hair colour exactly as in the input (and the reference image).";

/** Support and gravity: nothing hangs on a chair back or floats (the image model once put a laptop on a chair back). */
export const PHYSICS_RULE =
  "Objects rest on surfaces in physically plausible positions (laptops and cups on desks, bags on the floor or a chair seat); nothing hangs on a chair back or floats in the air; gravity and support stay realistic.";

/** Near-camera objects keep their real-world scale (the dark chair back was rendered as a giant sail). */
export function foregroundScaleRule(foreground?: string): string {
  return foregroundRule(foreground);
}

export const REFERENCE_FRAMES_SENTENCE =
  "Match each existing person to their identity reference in image2/image3. Preserve their exact facial features, hair length, hair colour and coloured tips; the requested pose may change. References never introduce another person or replace the image1 composition.";

/** The full ComfyUI edit instruction; clock wording appears only when the clock edit applies. */
export function composeEditInstruction(args: {
  predictionPrompt: string;
  options?: PromptVariantOptions;
  /** `distanceSec`: the future distance the clock digits are shifted by (default: server default). */
  clock?: { direction: TimeDirection; sceneTime?: string; visible?: boolean; distanceSec?: number };
  mode?: ClockEditMode;
  /** Presence 0..1: how much visible people move (a new person is never added by it). */
  presence?: number;
  /** Tone 0..1: adds the "amount of change" sentence (undefined = none, the old behaviour). */
  tone?: number;
  /**
   * Signed distance (seconds) of this image from the frame; long spans add the
   * "keep the background identical" clause. Default: taken from `clock`.
   */
  distanceSec?: number;
  /** A photo of a recently seen person is attached as the second image: any person must be that person. */
  referencePerson?: boolean;
  /** Recent frames of the person are attached as image2/image3: keep face, hair and clothes consistent. */
  referenceFrames?: boolean;
  people?: PersonInfo[];
  personCount?: number;
  compactPeople?: boolean;
  /** VLM's description of the near-camera object (real size/distance), if any. */
  foregroundObject?: string;
  /** A recently seen person is drawn in an empty frame: from behind, same clothes and hair. */
  behindView?: BehindViewLook;
  /** The describe step judged the lens blocked by a near object (chair back...): keep it and the composition (G-07 supplement). */
  obstructed?: boolean;
  /** What blocks the lens (describe step), e.g. "mesh chair backrest". */
  obstructedBy?: string;
  /** G-26 past scene: the history verdict (ongoing = step the same activity back instead of undoing it). */
  pastContinuity?: PastContinuityVerdict;
  /** Owner (index into people) of each attached reference image2, image3...; null = a whole frame of the same people. */
  references?: Array<number | null>;
}): string {
  const clockEdit = !!args.clock && shouldEditClock(args.clock.visible, args.mode);
  const clockInstruction =
    clockEdit && args.clock
      ? buildClockInstruction(args.clock.direction, args.clock.sceneTime, args.clock.distanceSec)
      : "";
  args = { ...args, predictionPrompt: withoutLightingChanges(args.predictionPrompt) || "Keep the scene exactly as in the input." };
  const presence = args.presence ?? SERVER_SCENE_DEFAULTS.presence;
  const spanSec =
    args.distanceSec ??
    (args.clock ? (args.clock.direction === "past" ? -1 : 1) * (args.clock.distanceSec ?? TIME_DELTA_SEC) : 0);
  // Unoccupied room: a separate template with no person words at all (negations steer a diffusion model the wrong way).
  const rb0 = getRulebook();
  // A both-hands object while the action needs a hand: the fixed holdings rule must not say "same hand" (third-hand fix 2026-10-19).
  const handConflict = actionHandConflict(args.predictionPrompt, args.people ?? []);
  // The action itself says the arms change (uncross / one arm keeps the object, the other hand rises); the Main-change line repeats it.
  if (handConflict) args = { ...args, predictionPrompt: armsChangeAction(args.predictionPrompt, handConflict) };
  const rb = handConflict ? { ...rb0, imagePrompt: { ...rb0.imagePrompt, holdingsRule: rb0.imagePrompt.holdingsRule && withoutHandCommitments(rb0.imagePrompt.holdingsRule) } } : rb0;
  const ip = rb.imagePrompt;
  // G-26: a scene BEFORE the frame is framed as the EARLIER moment (lead line + "Main difference ... EARLIER moment").
  const past = isPastDistance(spanSec);
  const emptyTemplate = presence <= 0 && !args.referencePerson;
  // 2026-10-21 rebuild: one coherent prompt per scene (editPrompt.ts); the old one repeated the action 2-3 times among 20+ rules.
  const lead = obstructedLead(rb, args.obstructed, args.obstructedBy);
  if (emptyTemplate) {
    const er = ip.emptyRoom;
    const when = past ? temporalSentence(spanSec, args.pastContinuity, true) : "";
    return (
      lead + framingAnchor(rb) + (when ? when + "\n\n" : "") +
      `${er.head}${sanitizeEmptyRoomPrediction(splitCorrection(args.predictionPrompt).action)}. ` +
      `${er.scope} ` +
      `${er.keep} ` +
      `${er.preserve} ` +
      `${er.noAdd} ` +
      `${er.screens}` +
      clockInstruction +
      "\n\n" +
      foregroundScaleRule(args.foregroundObject) +
      "\n\n" + physicsBlock(rb) +
      screenAndFrameText(rb, args.obstructed, true) +
      (args.tone !== undefined ? "\n\n" + toneImageRule(args.tone, true, rb) : "") +
      `\n\n${er.tail} ${FIXED_LIGHTING}`
    );
  }
  const tail = (clockInstruction ? " " + clockInstruction.trim() : "");
  const fa = framingAnchor(rb).trim();
  const anchor = fa ? `${fa} ${ROOM_ANCHOR}` : undefined;
  if (args.behindView) {
    // QA 13:39: at Presence 0.28 the behind-view figure filled the frame; Presence now sets depth and size explicitly.
    const placement = behindViewPlacementByPresence(presence, args.behindView.scene) + (isStandingAction(args.predictionPrompt) && presence > 0.35 ? " " + behindViewFreeSpotSentence(args.behindView) : "");
    return composeBehindViewEdit({
      action: args.predictionPrompt, look: { clothes: args.behindView.clothes, hair: behindViewHairPhrase(args.behindView.hair), position: args.behindView.position },
      placement, tone: args.tone, presence, spanSec, pastContinuity: args.pastContinuity, referencePerson: !!args.referencePerson, lead, anchor, tail,
    });
  }
  // References are optional: never a generic face reference next to a person seen from behind.
  const references = args.references ?? (args.referenceFrames ? [null] : []);
  const people = args.people ?? [];
  const keep = keepReferenceIndexes(people, references);
  return composeCoherentEdit({
    action: args.predictionPrompt, people, personCount: args.personCount, tone: args.tone, presence, spanSec,
    pastContinuity: args.pastContinuity, references: keep.map((i) => references[i]), lead, anchor,
    tail: (args.referencePerson ? " " + ip.referencePersonRule : "") + tail,
  });
}

/** Gemini has no negative prompt: the avoid-list becomes one positive sentence appended to the edit instruction. */
export function composeGeminiInstruction(editInstruction: string, negativePrompt: string): string {
  const avoid = negativePrompt.trim();
  return avoid ? `${editInstruction}

The result must be free of: ${avoid}.` : editInstruction;
}

/** Filled by generateImage when passed as `trace`: the final positive/negative prompt and seed. */
/**
 * Obstructed captures (a near object blocks the lens) use a lower denoise so the composition stays closer to the input:
 * env COMFYUI_OBSTRUCTED_DENOISE (default 0.8; 1 or invalid = off). 0.6 drew rainbow light streaks on the A scenes, 1.0 pasted screens onto the mesh; 0.8 was clean on 4 of 4 test cases (scripts/obstruct-ab.ts, 2026-10-17).
 */
export function obstructedDenoise(env: NodeJS.ProcessEnv = process.env): number | null {
  const v = Number(env.COMFYUI_OBSTRUCTED_DENOISE ?? "0.8");
  return Number.isFinite(v) && v >= 0.2 && v < 1 ? v : null;
}

export interface ImageTrace {
  assetOnlyExecution?:{mode:'cpu-only-assets-only';modelExecuted:false;modelCalls:0;generationMs:0;cpuMs:number;proofVersion:string;generatedContributionPixels:0};
  turboCandidate?:unknown;
  sourceFrameRestoration?:unknown;
  editInstruction?: string | null;
  negativePrompt?: string | null;
  seed?: number | null;
  /** First-pass KSampler denoise actually used (null = the production default 1.0). Lowered for obstructed captures only. */
  denoise?: number | null;
  /** Gemini path: whether the recent-person reference photo was attached ("attached" | "none"). */
  referenceImage?: string;
}

export async function generateImage(args: {
  originalImageDataUrl: string;
  predictionPrompt: string;
  options?: PromptVariantOptions;
  faceImageDataUrl?: string;
  seed?: number;
  filenamePrefix?: string;
  /**
   * Requests a deterministic clock-digit edit. It is applied only if
   * COMFYUI_CLOCK_EDIT allows it: in auto mode `visible` (the scenario's
   * clock_visible) must be true, otherwise no clock text reaches the model.
   */
  clock?: { direction: TimeDirection; sceneTime?: string; visible?: boolean; distanceSec?: number };
  /** Presence 0..1 of this capture (whether a new person may enter); default = server default. */
  presence?: number;
  /** Tone 0..1 of this capture: sets the size of the change in the image edit (see toneImageRule). */
  tone?: number;
  /** Signed distance (seconds) of this image; default: from `clock`. */
  distanceSec?: number;
  /** Near-camera object description from the planner (real size/distance). */
  foregroundObject?: string;
  /** Draw the recent person from behind (see BEHIND_VIEW_RULE); the details come from the people description. */
  behindView?: BehindViewLook;
  /** See composeEditInstruction. */
  obstructed?: boolean;
  obstructedBy?: string;
  pastContinuity?: PastContinuityVerdict;
  /** Rough rectangle of that person inside faceImageDataUrl (pixels). */
  faceCrop?: { x: number; y: number; width: number; height: number };
  /** `faceImageDataUrl` is a recently seen person (not a face crop): tell the edit to reuse that person only. */
  referencePerson?: boolean;
  /** Recent person frames (downscaled data URLs, max 2) attached as image2/image3 on the ComfyUI path. */
  referenceImages?: string[];
  referenceCrops?: Array<{x:number;y:number;width:number;height:number}>;
  editRegion?: PeopleEditRegion;
  scenarioElementInstruction?: string;
  assetOnlyInstruction?: string;
  assetOnlyFrame?:{rawImageDataUrl:string;protectedCoreMaskDataUrl:string;rectangles:Array<{x:number;y:number;width:number;height:number}>};
  people?: PersonInfo[];
  personCount?: number;
  compactPeople?: boolean;
  /** For cost attribution (logs/usage.jsonl) on the pure gemini backend. */
  captureId?: string | null;
  /** Cancels the generation (ComfyUI prompt dequeued/interrupted; Gemini abandoned). */
  signal?: AbortSignal;
  /** Optional out-param: receives the final prompt text and seed (archive). */
  trace?: ImageTrace;
  /** Image backend for this request (default: from GENERATION_BACKEND). */
  imageBackend?: StepBackend;
  referenceCast?:{sourcePeople:PersonInfo[];references:ScenePersonReference[];sourceIdentityImages?:SourceIdentityImage[]};
  localImageEngine?:LocalImageEngine;
  turboContext?:Pick<TurboCandidateParams,'sourceActors'|'protectedBoxes'|'sourceEvidenceComplete'|'expectedPeople'>;
}): Promise<string> {
  const localImageEngine=args.localImageEngine??defaultLocalImageEngine();
  // 2026-10-21: a scene planned EMPTY (presence 0, no behind-view person) gets no person image at all. server.ts still passed
  // the recent-person photo for unoccupied NOW frames, and the edit drew that person into "The room stays empty" scenes.
  if (!args.referenceCast && (args.presence ?? SERVER_SCENE_DEFAULTS.presence) <= 0 && args.referencePerson !== true)
    args = { ...args, faceImageDataUrl: undefined, faceCrop: undefined, referenceImages: [], referenceCrops: undefined };
  // An empty room where nothing changes: the NOW frame is the exact answer; the edit model would only drift the framing.
  if (!args.referenceCast && !args.assetOnlyInstruction && !args.assetOnlyFrame && !args.behindView && args.referencePerson !== true &&
      (args.presence ?? SERVER_SCENE_DEFAULTS.presence) <= 0 && isEmptyRoomNoChange(args.predictionPrompt)) {
    if (args.trace) Object.assign(args.trace, { editInstruction: "(no edit: empty room, nothing changes; the NOW frame is returned)", negativePrompt: null, seed: null, denoise: null, referenceImage: "none" });
    return args.originalImageDataUrl;
  }
  const clockEdit = !!args.clock && shouldEditClock(args.clock.visible);
  // Reference frames are a ComfyUI-only feature (Gemini takes at most the single recent-person photo).
  const refFramesAll = (args.imageBackend ?? DEFAULT_STEP_BACKENDS.image) === "gemini" ? [] : isTurboEngineForReferences(localImageEngine) ? (args.referenceImages ?? []) : (args.referenceImages ?? []).slice(0, 2);
  // 2026-10-21: references are optional. The reference cast keeps its own bindings; otherwise only people whose face is
  // visible get one (all facing away -> none), and the prompt names whose face each image shows.
  const refOwnersAll = args.referenceCast ? [] : referenceOwners({ people: args.people ?? [], refFrames: refFramesAll, crops: args.referenceCrops, sceneImage: args.originalImageDataUrl, hasHeadBox: (p) => !!parseHeadBox(p.headBox) });
  const keptRefs = args.referenceCast ? refFramesAll.map((_, i) => i) : keepReferenceIndexes(args.people ?? [], refOwnersAll);
  const refFrames = keptRefs.map((i) => refFramesAll[i]);
  const referenceCrops = args.referenceCrops && !args.referenceCast ? keptRefs.map((i) => args.referenceCrops![i]).filter(Boolean) : args.referenceCrops;

  if(args.referenceCast){
    if(localImageEngine!=='qwen21-turbo'||(args.imageBackend??DEFAULT_STEP_BACKENDS.image)!=='local'||args.assetOnlyInstruction||args.assetOnlyFrame||args.behindView||args.referencePerson||args.faceImageDataUrl)throw Error('Reference cast requires the dedicated production Turbo input roles');
    const roster=buildSceneReferenceCast(args.referenceCast.sourcePeople,args.referenceCast.references,args.referenceCast.sourceIdentityImages);
    if(refFrames.length!==roster.imageBindings.length-1)throw Error('Reference cast image bindings disagree with attached images');
    for(const ref of args.referenceCast.references){const slot=roster.allowedInventory.find(x=>x.contentId===ref.contentId)!.imageNumber;if(refFrames[slot-2]!==ref.imageDataUrl)throw Error('Reference cast image order mismatch');}
  }
  let editInstruction =
    args.referenceCast ? composeSceneReferenceCastInstruction({...args.referenceCast,predictionPrompt:args.predictionPrompt}) : args.assetOnlyInstruction ?? composeEditInstruction({
      predictionPrompt: args.predictionPrompt,
      options: args.options,
      clock: args.clock,
      presence: args.presence,
      tone: args.tone,
      distanceSec: args.distanceSec,
      referencePerson: args.referencePerson === true && !!args.faceImageDataUrl,
      referenceFrames: refFrames.length > 0 || (!!args.faceImageDataUrl && !args.referencePerson),
      references: refFrames.length ? keptRefs.map((i) => refOwnersAll[i] ?? null) : undefined,
      people: args.people,
      personCount: args.personCount,
      compactPeople: args.compactPeople,
      foregroundObject: args.foregroundObject,
      behindView: args.behindView,
      obstructed: args.obstructed,
      obstructedBy: args.obstructedBy,
      pastContinuity: args.pastContinuity,
    });
  // G-26: the reference-cast template gets the same EARLIER-moment lead for a past scene.
  if (args.referenceCast && isPastDistance(args.distanceSec)) editInstruction = temporalSentence(args.distanceSec!, args.pastContinuity) + "\n\n" + editInstruction;
  // Framing anchor (rulebook v20+) leads the reference-cast template too (composeEditInstruction adds it to the others).
  if (args.referenceCast) editInstruction = framingAnchor() + editInstruction;
  if(args.scenarioElementInstruction)editInstruction+='\n\n'+withoutLightingChanges(args.scenarioElementInstruction);

  // Empty room (presence 0): also push person words into the negative prompt (inert at cfg 1, active above).
  // Turbo runs at cfg 1.0, where the negative prompt has no effect at all: send a few words instead of a misleading list.
  const turboCfg1 = (args.imageBackend ?? DEFAULT_STEP_BACKENDS.image) !== "gemini" && isTurboEngineForReferences(localImageEngine);
  const negativePrompt = turboCfg1 ? TURBO_NEGATIVE : buildNegativePrompt(clockEdit, !args.referenceCast&&(args.presence ?? SERVER_SCENE_DEFAULTS.presence) <= 0, args.behindView ? { hair: args.behindView.hair } : false, args.obstructed === true);
  const seed = args.seed ?? Math.floor(Math.random() * 2 ** 31);
  const denoise = args.obstructed === true ? obstructedDenoise() : null;
  if (args.trace) Object.assign(args.trace, { referenceImage: args.faceImageDataUrl || refFrames.length ? "attached" : "none", editInstruction, negativePrompt, seed, denoise: (args.imageBackend ?? DEFAULT_STEP_BACKENDS.image) === "gemini" ? null : denoise });

  if ((args.imageBackend ?? DEFAULT_STEP_BACKENDS.image) === "gemini") {
    // Same instruction as the ComfyUI path (empty-room template, foreground scale rule, quality suffix);
    // Gemini has no negative prompt, so the negatives are folded in as one positive sentence.
    const instruction = composeGeminiInstruction(editInstruction, negativePrompt);
    const referenceImage = args.referencePerson === true ? args.faceImageDataUrl : undefined;
    if (args.trace) Object.assign(args.trace, { editInstruction: instruction, seed: null, referenceImage: referenceImage ? "attached" : "none" });
    const g = await abandonOnAbort(geminiModule(), args.signal);
    return abandonOnAbort(
      g.generateImageFromInstruction(args.originalImageDataUrl, instruction, referenceImage, { captureId: args.captureId }),
      args.signal
    );
  }

  // Only production asset_only with a mathematical zero-contribution proof may bypass diffusion.
  // This returns to the existing caller: integrity inspection, captions, archive/save and QA still run.
  if(localImageEngine==='qwen21-turbo'&&process.env.LOCAL_IMAGE_ENGINE==='qwen21-turbo'&&args.assetOnlyInstruction&&args.assetOnlyFrame){
    const cpu=await tryAssetOnlyCpuResult(args.assetOnlyFrame.rawImageDataUrl,args.originalImageDataUrl,args.assetOnlyFrame.protectedCoreMaskDataUrl,args.assetOnlyFrame.rectangles,{signal:args.signal});
    if(cpu){
      if(args.trace)Object.assign(args.trace,{seed:null,denoise:null,negativePrompt:null,referenceImage:'not-used-cpu-only',assetOnlyExecution:{mode:'cpu-only-assets-only',modelExecuted:false,modelCalls:0,generationMs:0,cpuMs:cpu.cpuMs,proofVersion:'asset-only-core-covers-edit-union-v1',generatedContributionPixels:0},sourceFrameRestoration:{executionMode:'cpu-only-assets-only',modelExecuted:false,modelSize:null,sourceSize:{width:cpu.width,height:cpu.height},proof:cpu.proof,timings:{cpuMs:cpu.cpuMs,generationMs:0},method:'all allowed model pixels provably overwritten by protected composed pixels; raw frame kept outside'}});
      return cpu.imageDataUrl;
    }
  }
  if(localImageEngine==='qwen21-turbo-candidate'||localImageEngine==='qwen21-turbo'){
    const candidate=localImageEngine==='qwen21-turbo-candidate';
    if(candidate&&(!args.turboContext||args.assetOnlyFrame||args.scenarioElementInstruction))throw Error('Turbo test context missing or unsupported image-element mode');
    const params={...args.turboContext,compositionMode:args.turboContext?'protected' as const:'full-frame' as const,sceneImage:args.originalImageDataUrl,prompt:editInstruction,negativePrompt,faceImage:args.faceImageDataUrl,faceCrop:args.faceCrop,referenceImages:refFrames,referenceCrops,seed,steps:8,cfg:1,denoise:1,filenamePrefix:args.filenamePrefix,signal:args.signal};
    const result=localImageEngine==='qwen21-turbo'?await generateTurboProduction(params):await generateTurboCandidate({...params,...args.turboContext!,test:true});
    if(args.trace){args.trace.turboCandidate=result.trace;args.trace.denoise=1;}
    if(args.assetOnlyFrame){const restored=await restoreAssetOnlySourceFrame(args.assetOnlyFrame.rawImageDataUrl,result.dataUrl,args.assetOnlyFrame.rectangles,{signal:args.signal,composedImageDataUrl:args.originalImageDataUrl,protectedCoreMaskDataUrl:args.assetOnlyFrame.protectedCoreMaskDataUrl});if(args.trace)args.trace.sourceFrameRestoration=restored.transform;return restored.imageDataUrl;}
    return result.dataUrl;
  }
  const { dataUrl } = await generateQwenEdit({
    sceneImage: args.originalImageDataUrl,
    prompt: editInstruction,
    negativePrompt,
    faceImage: args.faceImageDataUrl,
    faceCrop: args.faceCrop,
    referenceImages: refFrames,
    referenceCrops,
    editRegion: args.editRegion,
    seed,
    denoise: denoise ?? undefined,
    filenamePrefix: args.filenamePrefix,
    signal: args.signal,
  });
  if(args.assetOnlyFrame){const restored=await restoreAssetOnlySourceFrame(args.assetOnlyFrame.rawImageDataUrl,dataUrl,args.assetOnlyFrame.rectangles,{signal:args.signal,composedImageDataUrl:args.originalImageDataUrl,protectedCoreMaskDataUrl:args.assetOnlyFrame.protectedCoreMaskDataUrl});if(args.trace)args.trace.sourceFrameRestoration=restored.transform;return restored.imageDataUrl;}
  return dataUrl;
}

function isTurboEngineForReferences(engine:LocalImageEngine){return engine==='qwen21-turbo'||engine==='qwen21-turbo-candidate';}

export async function backendStatus() {
  const localImageEngine=defaultLocalImageEngine(),url=selectedLocalImageUrl();
  const [comfy, vlm] = await Promise.all([
    probe(fetch,`${url}/system_stats`,2000),
    vlmReachable(),
  ]);
  return {
    backend: BACKEND,
    localImageEngine,
    comfyui: { url, reachable: comfy, models: localImageEngine==='qwen21-turbo'?{unet:'qwen_image_2.1_turbo_int8_convrot.safetensors',clip:'qwen3vl_8b_w4a8.safetensors',vae:'qwen_image_2.1_vae_bf16.safetensors'}:comfyConfig.models },
    vlm: { url: vlmConfig.url, model: vlmConfig.model, reachable: vlm },
  };
}
