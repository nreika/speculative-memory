import { GoogleGenAI, Type } from "@google/genai";
import promptConfig from "../gemini-prompts.json";
import { Target } from "../types";

export interface PromptVariantOptions {
  variant?: string;
  params?: Record<string, number | string>;
}

interface GeminiPromptConfig {
  editingGuide?: {
    editThisSection?: string;
    doNotEditSection?: string;
    keepPlaceholders?: string[];
    notes?: string[];
  };
  userEditable: {
    scenarioPrediction: {
      sceneAnalysisIntro: string;
      defaultTargetContext: string;
      targetedTargetContextTemplate: string;
      targetedTargetFocus: string;
      predictionRequest: string;
      variationGuidance: string;
      descriptionLanguageRule: string;
    };
    futureImageGeneration: {
      editInstructionTemplate: string;
    };
  };
  systemFixed: {
    scenarioPrediction: {
      hardRules: string[];
      outputFormatRules: string[];
    };
    futureImageGeneration: {
      hardRules: string[];
    };
  };
}

const getAI = () => new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
const prompts = promptConfig as GeminiPromptConfig;
const MIN_SCENARIO_COUNT = 1;
const MAX_SCENARIO_COUNT = 10;
const DEFAULT_SCENARIO_COUNT = 3;
const IMAGE_DATA_URL_PATTERN = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/;

const joinLines = (lines: string[]): string => lines.join("\n").trim();
const joinPromptSections = (...sections: Array<string | string[]>): string =>
  sections
    .map((section) => (Array.isArray(section) ? joinLines(section) : section.trim()))
    .filter(Boolean)
    .join("\n\n")
    .trim();

const replacePlaceholders = (
  template: string,
  values: Record<string, string>
): string =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
    template
  );

const buildDefaultScenarioContext = (): string =>
  prompts.userEditable.scenarioPrediction.defaultTargetContext.trim();

const buildPromptVariantContext = (options?: PromptVariantOptions): string => {
  if (!options?.variant) {
    return '';
  }

  const variant = String(options.variant).trim();
  const params = options.params ? Object.entries(options.params) : [];
  const paramSummary = params.length > 0
    ? `Additional prompt controls: ${params.map(([key, value]) => `${key}=${value}`).join(', ')}.`
    : '';

  return [`Prompt variant: ${variant}.`, paramSummary].filter(Boolean).join(' ');
};

const buildTargetedScenarioContext = (target: Target): string =>
  joinPromptSections(
    replacePlaceholders(
      prompts.userEditable.scenarioPrediction.targetedTargetContextTemplate,
      {
        TARGET_X: target.x.toFixed(2),
        TARGET_Y: target.y.toFixed(2),
      }
    ),
    prompts.userEditable.scenarioPrediction.targetedTargetFocus
  );

const clampScenarioCount = (value: number): number => {
  if (!Number.isFinite(value)) {
    return DEFAULT_SCENARIO_COUNT;
  }

  return Math.min(MAX_SCENARIO_COUNT, Math.max(MIN_SCENARIO_COUNT, Math.round(value)));
};

export const buildScenarioPredictionPrompt = (
  target: Target | null,
  scenarioCount: number,
  options?: PromptVariantOptions
): string => {
  const targetContext = target
    ? buildTargetedScenarioContext(target)
    : buildDefaultScenarioContext();
  const countPlaceholders = { SCENARIO_COUNT: String(scenarioCount) };
  const variantContext = buildPromptVariantContext(options);

  return joinPromptSections(
    prompts.userEditable.scenarioPrediction.sceneAnalysisIntro,
    targetContext,
    variantContext,
    replacePlaceholders(
      prompts.userEditable.scenarioPrediction.predictionRequest,
      countPlaceholders
    ),
    prompts.systemFixed.scenarioPrediction.hardRules,
    prompts.userEditable.scenarioPrediction.variationGuidance,
    prompts.userEditable.scenarioPrediction.descriptionLanguageRule,
    prompts.systemFixed.scenarioPrediction.outputFormatRules.map((rule) =>
      replacePlaceholders(rule, countPlaceholders)
    )
  );
};

const buildFutureImagePrompt = (
  predictionPrompt: string,
  options?: PromptVariantOptions
): string => {
  const variantContext = buildPromptVariantContext(options);

  return joinPromptSections(
    replacePlaceholders(
      prompts.userEditable.futureImageGeneration.editInstructionTemplate,
      { PREDICTION_PROMPT: predictionPrompt }
    ),
    variantContext,
    prompts.systemFixed.futureImageGeneration.hardRules
  );
};

const extractInlineImageData = (imageDataUrl: string) => {
  const match = imageDataUrl.match(IMAGE_DATA_URL_PATTERN);
  if (!match) {
    throw new Error("Unsupported image data URL.");
  }

  const [, mimeType, data] = match;
  return { mimeType, data };
};

export interface ScenarioResult {
  prediction_prompt: string;
  scenario_description: string;
  label: string;
}

/**
 * Step 1: Analyze frame and predict the requested number of realistic 5-minute outcomes.
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
      model: 'gemini-3-flash-preview',
      contents: {
        parts: [
          { inlineData: sourceImage },
          { text: prompt }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            scenarios: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  prediction_prompt: { type: Type.STRING },
                  scenario_description: { type: Type.STRING },
                  label: { type: Type.STRING }
                },
                required: ["prediction_prompt", "scenario_description", "label"]
              }
            }
          },
          required: ["scenarios"]
        }
      }
    });

    const parsed = JSON.parse(response.text || "{}");
    const scenarios = Array.isArray(parsed.scenarios)
      ? parsed.scenarios.filter((item): item is ScenarioResult =>
          typeof item?.prediction_prompt === 'string' &&
          typeof item?.scenario_description === 'string' &&
          typeof item?.label === 'string'
        )
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
  options?: PromptVariantOptions
): Promise<string> => {
  const ai = getAI();
  const sourceImage = extractInlineImageData(originalBase64);
  
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: {
      parts: [
        { inlineData: sourceImage },
        { text: buildFutureImagePrompt(predictionPrompt, options) }
      ]
    },
    config: {
      imageConfig: {
        aspectRatio: "16:9"
      }
    }
  });

  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData) {
      return `data:image/png;base64,${part.inlineData.data}`;
    }
  }
  throw new Error("No image generated");
};

