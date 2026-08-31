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
  buildFutureImagePrompt,
  buildScenarioPredictionPrompt,
  clampScenarioCount,
} from "../../services/promptBuilder";
import {
  DEFAULT_NEGATIVE_PROMPT,
  QUALITY_SUFFIX,
  comfyConfig,
  comfyReachable,
  generateQwenEdit,
} from "./comfyClient";
import { planScenariosLocal, vlmConfig, vlmReachable } from "./vlmClient";

export type GenerationBackend = "local" | "gemini" | "hybrid";

export const BACKEND = ((process.env.GENERATION_BACKEND || "local").toLowerCase() as GenerationBackend);

const TIME_DELTA_SEC = Number(process.env.SCENE_TIME_DELTA_SEC || "30");

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

export type TimeDirection = "future" | "past";

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

/** Which time direction a scenario represents (index convention + text fallback). */
export function scenarioDirection(scenario: ScenarioResult, index: number): TimeDirection {
  const t = `${scenario.scenario_description} ${scenario.label}`.toLowerCase();
  if (/earlier|before|rewind|過去|前|prior/.test(t)) return "past";
  if (/later|after|next|後|forward/.test(t)) return "future";
  return index >= 2 ? "past" : "future";
}

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
}): Promise<ScenarioResult[]> {
  const count = clampScenarioCount(args.scenarioCount);

  if (BACKEND === "gemini" || BACKEND === "hybrid") {
    const { predictFutureScenarios } = await geminiModule();
    return predictFutureScenarios(args.imageDataUrl, args.target, count, args.options);
  }

  const prompt = buildScenarioPredictionPrompt(args.target, count, args.options);
  return planScenariosLocal({ imageDataUrl: args.imageDataUrl, prompt, scenarioCount: count });
}

export async function generateImage(args: {
  originalImageDataUrl: string;
  predictionPrompt: string;
  options?: PromptVariantOptions;
  faceImageDataUrl?: string;
  seed?: number;
  filenamePrefix?: string;
  /** When set, a deterministic clock-digit edit is appended to the instruction. */
  clock?: { direction: TimeDirection; sceneTime?: string };
}): Promise<string> {
  if (BACKEND === "gemini") {
    const { generateFutureImage } = await geminiModule();
    return generateFutureImage(args.originalImageDataUrl, args.predictionPrompt, args.options);
  }

  const clockInstruction = args.clock
    ? buildClockInstruction(args.clock.direction, args.clock.sceneTime)
    : "";
  const editInstruction =
    buildFutureImagePrompt(args.predictionPrompt, args.options) +
    clockInstruction +
    "\n\n" +
    QUALITY_SUFFIX;

  const { dataUrl } = await generateQwenEdit({
    sceneImage: args.originalImageDataUrl,
    prompt: editInstruction,
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
    faceImage: args.faceImageDataUrl,
    seed: args.seed,
    filenamePrefix: args.filenamePrefix,
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
