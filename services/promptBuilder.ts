import promptConfig from "../gemini-prompts.json";
import { Target } from "../types";

export interface PromptVariantOptions {
  variant?: string;
  params?: Record<string, number | string>;
}

export interface ScenarioResult {
  prediction_prompt: string;
  scenario_description: string;
  label: string;
}

interface GeminiPromptConfig {
  editingGuide?: unknown;
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

const prompts = promptConfig as GeminiPromptConfig;

export const MIN_SCENARIO_COUNT = 1;
export const MAX_SCENARIO_COUNT = 10;
export const DEFAULT_SCENARIO_COUNT = 3;

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
    return "";
  }

  const variant = String(options.variant).trim();
  const params = options.params ? Object.entries(options.params) : [];
  const paramSummary =
    params.length > 0
      ? `Additional prompt controls: ${params
          .map(([key, value]) => `${key}=${value}`)
          .join(", ")}.`
      : "";

  return [`Prompt variant: ${variant}.`, paramSummary].filter(Boolean).join(" ");
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

export const clampScenarioCount = (value: number): number => {
  if (!Number.isFinite(value)) {
    return DEFAULT_SCENARIO_COUNT;
  }

  return Math.min(
    MAX_SCENARIO_COUNT,
    Math.max(MIN_SCENARIO_COUNT, Math.round(value))
  );
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

export const buildFutureImagePrompt = (
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
