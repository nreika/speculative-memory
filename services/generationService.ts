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
} from "./promptBuilder";

export type { PromptVariantOptions, ScenarioResult };
export { buildScenarioPredictionPrompt, buildFutureImagePrompt };

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
  options?: PromptVariantOptions
): Promise<ScenarioResult[]> => {
  const { scenarios } = await postJson<{ scenarios: ScenarioResult[] }>(
    "/api/predict-scenarios",
    {
      image: base64Image,
      target,
      scenarioCount: requestedScenarioCount,
      promptOptions: options,
      sceneTime: new Date().toISOString(),
    }
  );
  return scenarios;
};

export const generateFutureImage = async (
  originalBase64: string,
  predictionPrompt: string,
  options?: PromptVariantOptions
): Promise<string> => {
  const { image } = await postJson<{ image: string }>("/api/generate-image", {
    originalImage: originalBase64,
    predictionPrompt,
    promptOptions: options,
  });
  return image;
};
