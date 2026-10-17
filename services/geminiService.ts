import { GoogleGenAI, Type } from "@google/genai";
import { Target } from "../types";
import type { SceneParams } from "./sceneParams";
import {
  DEFAULT_SCENARIO_COUNT,
  PromptVariantOptions,
  ScenarioResult,
  buildFutureImagePrompt,
  buildScenarioPredictionPrompt,
  clampScenarioCount,
  parseClockVisible,
} from "./promptBuilder";
import { recordGeminiUsage } from "../server/usage/costTracker";
import { GEMINI_IMAGE_MODEL, GEMINI_VLM_MODEL } from "../server/generation/backends";

// Re-export so existing imports (and tests) keep working.
export type { PromptVariantOptions, ScenarioResult };
export { buildScenarioPredictionPrompt, buildFutureImagePrompt };

// API_KEY is what vite's `define` injects into the client bundle; GEMINI_API_KEY
// is the raw .env name, which is all that exists when this module is imported
// server-side (GENERATION_BACKEND=gemini|hybrid goes through the Node server).
const getAI = () =>
  new GoogleGenAI({ apiKey: process.env.API_KEY || process.env.GEMINI_API_KEY || "" });
const IMAGE_DATA_URL_PATTERN = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/;

const extractInlineImageData = (imageDataUrl: string) => {
  const match = imageDataUrl.match(IMAGE_DATA_URL_PATTERN);
  if (!match) {
    throw new Error("Unsupported image data URL.");
  }

  const [, mimeType, data] = match;
  return { mimeType, data };
};

const SCENARIO_MODEL = GEMINI_VLM_MODEL;
const IMAGE_MODEL = GEMINI_IMAGE_MODEL;

/**
 * Step 1: Analyze frame and predict the requested number of realistic outcomes.
 */
export const predictFutureScenarios = async (
  base64Image: string,
  target: Target | null,
  requestedScenarioCount = DEFAULT_SCENARIO_COUNT,
  options?: PromptVariantOptions,
  usageContext?: { captureId?: string | null },
  sceneParams?: SceneParams
): Promise<ScenarioResult[]> => {
  const ai = getAI();
  const sourceImage = extractInlineImageData(base64Image);
  const scenarioCount = clampScenarioCount(requestedScenarioCount);
  const prompt = buildScenarioPredictionPrompt(target, scenarioCount, options, sceneParams);
  let latestScenarioCount = 0;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await ai.models.generateContent({
      model: SCENARIO_MODEL,
      contents: {
        parts: [{ inlineData: sourceImage }, { text: prompt }],
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          // clock_visible first, so the model decides it before writing prompts.
          propertyOrdering: ["clock_visible", "scene_description", "scenarios"],
          properties: {
            clock_visible: {
              type: Type.BOOLEAN,
              description:
                "True ONLY if a clock, a digital time readout, or a physical number/flip sign " +
                "showing a time is clearly visible in this frame. False if there is none, it is " +
                "not clearly visible, or you are unsure. Do not guess true.",
            },
            scene_description: {
              type: Type.STRING,
              description:
                "Plain Japanese description (1-2 short sentences, max about 100 characters) of what is " +
                "visible in this frame right now: who or what is where and what they are doing, and the " +
                "state of notable objects. Describe only what is seen; no predictions.",
            },
            scenarios: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  prediction_prompt: { type: Type.STRING },
                  scenario_description: { type: Type.STRING },
                  label: { type: Type.STRING },
                },
                required: [
                  "prediction_prompt",
                  "scenario_description",
                  "label",
                ],
              },
            },
          },
          required: ["clock_visible", "scene_description", "scenarios"],
        },
      },
    });

    // Every attempt is billed, including ones that return too few scenarios.
    recordGeminiUsage({
      purpose: "scenario",
      model: SCENARIO_MODEL,
      response,
      captureId: usageContext?.captureId,
      attempt: attempt + 1,
    });

    const parsed = JSON.parse(response.text || "{}");
    // Missing / non-boolean counts as "not visible"; copied onto every scenario
    // so it round-trips through /api/predict-scenarios -> /api/generate-image.
    const clockVisible = parseClockVisible(parsed.clock_visible);
    const sceneNow = typeof parsed.scene_description === "string" ? parsed.scene_description.trim() : "";
    const scenarios = Array.isArray(parsed.scenarios)
      ? parsed.scenarios
          .filter(
            (item): item is ScenarioResult =>
              typeof item?.prediction_prompt === "string" &&
              typeof item?.scenario_description === "string" &&
              typeof item?.label === "string"
          )
          .map((item) => ({ ...item, clock_visible: clockVisible, scene_now: sceneNow }))
      : [];

    latestScenarioCount = scenarios.length;
    if (scenarios.length >= scenarioCount) {
      return scenarios.slice(0, scenarioCount);
    }
  }

  throw new Error(
    `Expected ${scenarioCount} scenarios, but the model returned ${latestScenarioCount}. Please try again.`
  );
};

/**
 * Step 2: Generate a single future image based on a prompt.
 */
export const generateFutureImage = async (
  originalBase64: string,
  predictionPrompt: string,
  options?: PromptVariantOptions,
  clockEdit = false,
  usageContext?: { captureId?: string | null },
  /** Signed distance (seconds) of this image from the frame (long spans keep the background identical). */
  distanceSec = 0
): Promise<string> => {
  const ai = getAI();
  const sourceImage = extractInlineImageData(originalBase64);

  const response = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: {
      parts: [
        { inlineData: sourceImage },
        { text: buildFutureImagePrompt(predictionPrompt, options, clockEdit, undefined, distanceSec) },
      ],
    },
    config: {
      imageConfig: {
        aspectRatio: "16:9",
      },
    },
  });

  recordGeminiUsage({
    purpose: "image",
    model: IMAGE_MODEL,
    response,
    captureId: usageContext?.captureId,
  });

  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData) {
      return `data:image/png;base64,${part.inlineData.data}`;
    }
  }
  throw new Error("No image generated");
};

/**
 * Per-request Gemini path (server/generation/orchestrator.ts): ONE planner call with the finished
 * prompt (guard/history/extras are applied by the shared planner, not here). Returns the raw JSON text.
 */
export const planWithGemini = async (
  prompt: string,
  imageDataUrl: string,
  usageContext?: { captureId?: string | null; attempt?: number },
  signal?: AbortSignal
): Promise<string> => {
  const ai = getAI();
  const sourceImage = extractInlineImageData(imageDataUrl);
  const response = await ai.models.generateContent({
    model: SCENARIO_MODEL,
    contents: { parts: [{ inlineData: sourceImage }, { text: prompt }] },
    config: { responseMimeType: "application/json", ...(signal ? { abortSignal: signal } : {}) },
  });
  recordGeminiUsage({
    purpose: "scenario",
    model: SCENARIO_MODEL,
    response,
    captureId: usageContext?.captureId,
    attempt: usageContext?.attempt,
  });
  return response.text || "";
};

/** Short text-only JSON call (extras translation / judge / Japanese display text). Billed like any other call. */
export const generateGeminiText = async (
  prompt: string,
  usageContext?: { captureId?: string | null },
  signal?: AbortSignal
): Promise<string> => {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: SCENARIO_MODEL,
    contents: { parts: [{ text: prompt }] },
    config: { responseMimeType: "application/json", ...(signal ? { abortSignal: signal } : {}) },
  });
  recordGeminiUsage({ purpose: "other", model: SCENARIO_MODEL, response, captureId: usageContext?.captureId });
  return response.text || "";
};

/**
 * Image edit with a finished instruction (composeEditInstruction + negatives folded in as positive text).
 * `referenceDataUrl` (a recently seen person) is attached as the second image.
 */
export const generateImageFromInstruction = async (
  sourceDataUrl: string,
  instruction: string,
  referenceDataUrl?: string,
  usageContext?: { captureId?: string | null }
): Promise<string> => {
  const ai = getAI();
  const parts: Array<Record<string, unknown>> = [{ inlineData: extractInlineImageData(sourceDataUrl) }];
  if (referenceDataUrl) parts.push({ inlineData: extractInlineImageData(referenceDataUrl) });
  parts.push({ text: instruction });
  const response = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: { parts: parts as any },
    config: { imageConfig: { aspectRatio: "16:9" } },
  });
  recordGeminiUsage({ purpose: "image", model: IMAGE_MODEL, response, captureId: usageContext?.captureId });
  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData) return `data:image/png;base64,${part.inlineData.data}`;
  }
  throw new Error("No image generated");
};
