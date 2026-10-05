/**
 * Server-side generation orchestrator.
 *
 * Backends:
 *   GENERATION_BACKEND=local   -> Ollama (VLM) + ComfyUI/Qwen (image)   [default]
 *   GENERATION_BACKEND=gemini  -> original Gemini path (services/geminiService)
 *   GENERATION_BACKEND=hybrid  -> Gemini for scenario text, ComfyUI for images
 */
import { Target } from "../../types";
import {
  PromptVariantOptions,
  ScenarioResult,
  TimeDirection,
  buildFutureImagePrompt,
  buildScenarioPredictionPrompt,
  clampScenarioCount,
  scenarioDirection,
} from "../../services/promptBuilder";
import {
  buildNegativePrompt,
  buildQualitySuffix,
  comfyConfig,
  comfyReachable,
  generateQwenEdit,
} from "./comfyClient";
import { planScenariosLocal, vlmConfig, vlmReachable } from "./vlmClient";
import { abandonOnAbort } from "../captureManager";

export type GenerationBackend = "local" | "gemini" | "hybrid";

export const BACKEND = ((process.env.GENERATION_BACKEND || "local").toLowerCase() as GenerationBackend);

export type { TimeDirection };

const TIME_DELTA_SEC = Number(process.env.SCENE_TIME_DELTA_SEC || "30");

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

/** Deterministic clock-edit sentence, computed server-side (never via the VLM). */
export function buildClockInstruction(direction: TimeDirection, sceneTime?: string): string {
  const base = sceneTime ? new Date(sceneTime) : new Date();
  if (Number.isNaN(base.getTime())) return "";
  const { hh, mm } = shiftClock(base, direction === "future" ? TIME_DELTA_SEC : -TIME_DELTA_SEC);
  return (
    ` Change ONLY the digits on the physical flip-number sign so its top row shows the two digits ` +
    `${hh} (${spellDigits(hh)}) and its bottom row shows the two digits ${mm} (${spellDigits(mm)}) ` +
    `- keep both digits, including any leading zero (write "${mm}", never "${mm.replace(/^0/, "")}"), ` +
    `same card style, size and position as the input. Do not write the letters H or M.`
  );
}

export { scenarioDirection };

async function geminiModule() {
  // Loaded lazily so the local path never needs @google/genai / an API key.
  return import("../../services/geminiService");
}

export async function predictScenarios(args: {
  imageDataUrl: string;
  target: Target | null;
  scenarioCount: number;
  options?: PromptVariantOptions;
  sceneTime?: string;
  /**
   * Cancels the planning step. The Gemini call cannot be stopped, so it is
   * abandoned (rejects immediately, its late result is dropped); the local
   * Ollama request is closed.
   */
  signal?: AbortSignal;
}): Promise<ScenarioResult[]> {
  const count = clampScenarioCount(args.scenarioCount);

  if (BACKEND === "gemini" || BACKEND === "hybrid") {
    const { predictFutureScenarios } = await abandonOnAbort(geminiModule(), args.signal);
    return abandonOnAbort(
      predictFutureScenarios(args.imageDataUrl, args.target, count, args.options),
      args.signal
    );
  }

  const prompt = buildScenarioPredictionPrompt(args.target, count, args.options);
  return planScenariosLocal({
    imageDataUrl: args.imageDataUrl,
    prompt,
    scenarioCount: count,
    signal: args.signal,
  });
}

/** The full ComfyUI edit instruction; clock wording appears only when the clock edit applies. */
export function composeEditInstruction(args: {
  predictionPrompt: string;
  options?: PromptVariantOptions;
  clock?: { direction: TimeDirection; sceneTime?: string; visible?: boolean };
  mode?: ClockEditMode;
}): string {
  const clockEdit = !!args.clock && shouldEditClock(args.clock.visible, args.mode);
  const clockInstruction =
    clockEdit && args.clock ? buildClockInstruction(args.clock.direction, args.clock.sceneTime) : "";
  return (
    buildFutureImagePrompt(args.predictionPrompt, args.options, clockEdit) +
    clockInstruction +
    "\n\n" +
    buildQualitySuffix(clockEdit)
  );
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
  clock?: { direction: TimeDirection; sceneTime?: string; visible?: boolean };
  /** Cancels the generation (ComfyUI prompt dequeued/interrupted; Gemini abandoned). */
  signal?: AbortSignal;
}): Promise<string> {
  const clockEdit = !!args.clock && shouldEditClock(args.clock.visible);

  if (BACKEND === "gemini") {
    const { generateFutureImage } = await abandonOnAbort(geminiModule(), args.signal);
    return abandonOnAbort(
      generateFutureImage(args.originalImageDataUrl, args.predictionPrompt, args.options, clockEdit),
      args.signal
    );
  }

  const editInstruction = composeEditInstruction({
    predictionPrompt: args.predictionPrompt,
    options: args.options,
    clock: args.clock,
  });

  const { dataUrl } = await generateQwenEdit({
    sceneImage: args.originalImageDataUrl,
    prompt: editInstruction,
    negativePrompt: buildNegativePrompt(clockEdit),
    faceImage: args.faceImageDataUrl,
    seed: args.seed,
    filenamePrefix: args.filenamePrefix,
    signal: args.signal,
  });
  return dataUrl;
}

export async function backendStatus() {
  const [comfy, vlm] = await Promise.all([
    BACKEND === "gemini" ? Promise.resolve(false) : comfyReachable(),
    BACKEND === "local" ? vlmReachable() : Promise.resolve(false),
  ]);
  return {
    backend: BACKEND,
    comfyui: { url: comfyConfig.url, reachable: comfy, models: comfyConfig.models },
    vlm: { url: vlmConfig.url, model: vlmConfig.model, reachable: vlm },
  };
}
