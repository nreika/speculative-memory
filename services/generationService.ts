/**
 * Drop-in replacement for services/geminiService.
 *
 * Same signatures as the Gemini version, but the work happens on the Node
 * server (see server/generation/*), which routes to a local ComfyUI/Qwen +
 * Ollama stack (or falls back to Gemini via GENERATION_BACKEND).
 *
 * Switch the app back to direct Gemini by importing from ./geminiService.
 */
import { Target } from "../types";
import {
  DEFAULT_SCENARIO_COUNT,
  PromptVariantOptions,
  ScenarioResult,
  buildFutureImagePrompt,
  buildScenarioPredictionPrompt,
  scenarioDirection,
} from "./promptBuilder";

export type { PromptVariantOptions, ScenarioResult };
export { buildScenarioPredictionPrompt, buildFutureImagePrompt };

/**
 * Ties a request to a tracked capture. `signal` aborts the fetch (a newer
 * capture replaced this one); the server answers 409 { cancelled: true } when
 * it has cancelled the capture itself. Both surface as an error named
 * "AbortError" (see isCaptureCancelled).
 */
export interface CaptureRequestContext {
  captureId: string;
  signal?: AbortSignal;
}

export class CaptureCancelledError extends Error {
  constructor(public readonly captureId: string | null) {
    super(`capture ${captureId ?? ""} was cancelled`);
    this.name = "AbortError";
  }
}

export const isCaptureCancelled = (error: unknown) =>
  !!error && typeof error === "object" && (error as { name?: string }).name === "AbortError";

export async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 409) {
    const detail = (await res.json().catch(() => ({}))) as { cancelled?: boolean; captureId?: string };
    if (detail?.cancelled) {
      throw new CaptureCancelledError(detail.captureId ?? null);
    }
    throw new Error(`${url} failed (409)`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json())?.error ?? "";
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error(detail || `${url} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export const predictFutureScenarios = async (
  base64Image: string,
  target: Target | null,
  requestedScenarioCount = DEFAULT_SCENARIO_COUNT,
  options?: PromptVariantOptions,
  capture?: CaptureRequestContext
): Promise<ScenarioResult[]> => {
  const { scenarios } = await postJson<{ scenarios: ScenarioResult[] }>(
    "/api/predict-scenarios",
    {
      image: base64Image,
      target,
      scenarioCount: requestedScenarioCount,
      promptOptions: options,
      sceneTime: new Date().toISOString(),
      captureId: capture?.captureId,
    },
    capture?.signal
  );
  return scenarios;
};

export const generateFutureImage = async (
  originalBase64: string,
  predictionPrompt: string,
  options?: PromptVariantOptions,
  capture?: CaptureRequestContext,
  /**
   * The scenario this image is for, plus its index and the capture time. Carries
   * the planner's clock_visible and the time direction so the server can decide
   * whether (and how) to edit a clock. Omitted -> no clock edit.
   */
  scene?: { scenario: ScenarioResult; index: number; sceneTime: string }
): Promise<string> => {
  const { image } = await postJson<{ image: string }>(
    "/api/generate-image",
    {
      originalImage: originalBase64,
      predictionPrompt,
      promptOptions: options,
      captureId: capture?.captureId,
      ...(scene
        ? {
            clockVisible: scene.scenario.clock_visible === true,
            timeDirection: scenarioDirection(scene.scenario, scene.index),
            sceneTime: scene.sceneTime,
          }
        : {}),
    },
    capture?.signal
  );
  return image;
};
