import { GoogleGenAI, Type } from "@google/genai";
import { Target } from "../types";
import {
  DEFAULT_SCENARIO_COUNT,
  PromptVariantOptions,
  ScenarioResult,
  buildFutureImagePrompt,
  buildScenarioPredictionPrompt,
  clampScenarioCount,
  parseClockVisible,
} from "./promptBuilder";

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

/**
 * Step 1: Analyze frame and predict the requested number of realistic outcomes.
 */
export const predictFutureScenarios = async (
  base64Image: string,
  target: Target | null,
  requestedScenarioCount = DEFAULT_SCENARIO_COUNT,
  options?: PromptVariantOptions
): Promise<ScenarioResult[]> => {
  const ai = getAI();
  const sourceImage = extractInlineImageData(base64Image);
  const scenarioCount = clampScenarioCount(requestedScenarioCount);
  const prompt = buildScenarioPredictionPrompt(target, scenarioCount, options);
  let latestScenarioCount = 0;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [{ inlineData: sourceImage }, { text: prompt }],
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          // clock_visible first, so the model decides it before writing prompts.
          propertyOrdering: ["clock_visible", "scenarios"],
          properties: {
            clock_visible: {
              type: Type.BOOLEAN,
              description:
                "True ONLY if a clock, a digital time readout, or a physical number/flip sign " +
                "showing a time is clearly visible in this frame. False if there is none, it is " +
                "not clearly visible, or you are unsure. Do not guess true.",
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
          required: ["clock_visible", "scenarios"],
        },
      },
    });

    const parsed = JSON.parse(response.text || "{}");
    // Missing / non-boolean counts as "not visible"; copied onto every scenario
    // so it round-trips through /api/predict-scenarios -> /api/generate-image.
    const clockVisible = parseClockVisible(parsed.clock_visible);
    const scenarios = Array.isArray(parsed.scenarios)
      ? parsed.scenarios
          .filter(
            (item): item is ScenarioResult =>
              typeof item?.prediction_prompt === "string" &&
              typeof item?.scenario_description === "string" &&
              typeof item?.label === "string"
          )
          .map((item) => ({ ...item, clock_visible: clockVisible }))
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
  clockEdit = false
): Promise<string> => {
  const ai = getAI();
  const sourceImage = extractInlineImageData(originalBase64);

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-image",
    contents: {
      parts: [
        { inlineData: sourceImage },
        { text: buildFutureImagePrompt(predictionPrompt, options, clockEdit) },
      ],
    },
    config: {
      imageConfig: {
        aspectRatio: "16:9",
      },
    },
  });

  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData) {
      return `data:image/png;base64,${part.inlineData.data}`;
    }
  }
  throw new Error("No image generated");
};
