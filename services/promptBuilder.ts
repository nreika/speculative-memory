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
  /**
   * Scene-level detection from the planning step (same value on every scenario
   * of one frame): a clock, digital time readout or physical number/flip sign
   * is clearly visible. Missing/unknown means "not visible" - never invent one.
   */
  clock_visible?: boolean;
}

/** Strict reading of the model's `clock_visible`: only true / "true" count. */
export const parseClockVisible = (value: unknown): boolean =>
  value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");

export type TimeDirection = "future" | "past";

/** Which time direction a scenario represents (index convention + text fallback). */
export function scenarioDirection(scenario: ScenarioResult, index: number): TimeDirection {
  const t = `${scenario.scenario_description} ${scenario.label}`.toLowerCase();
  // Use word boundaries to match explicit time phrases, not embedded words like 手前/後ろ
  const pastMatches = /秒前|分前|過去|\bearlier\b|\brewind\b|seconds? before|\bprior\b/.test(t);
  const futureMatches = /秒後|分後|未来|\blater\b|seconds? after|\bforward\b/.test(t);
  if (pastMatches && !futureMatches) return "past";
  if (futureMatches && !pastMatches) return "future";
  return index >= 2 ? "past" : "future";
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
      /** Only added when a clock/number sign is visible and being edited. */
      clockEditClause: string;
    };
  };
  systemFixed: {
    scenarioPrediction: {
      hardRules: string[];
      outputFormatRules: string[];
    };
    futureImageGeneration: {
      hardRules: string[];
      /** Only added when a clock/number sign is visible and being edited. */
      clockHardRules: string[];
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

/**
 * `clockEdit` is true only when a clock / number sign is visible AND its digits
 * are to be edited; otherwise the prompt says nothing about clocks or signs, so
 * the image model has no reason to paint one.
 */
export const buildFutureImagePrompt = (
  predictionPrompt: string,
  options?: PromptVariantOptions,
  clockEdit = false
): string => {
  const variantContext = buildPromptVariantContext(options);
  const image = prompts.userEditable.futureImageGeneration;
  const rules = prompts.systemFixed.futureImageGeneration;

  return joinPromptSections(
    replacePlaceholders(
      image.editInstructionTemplate,
      // Trim trailing periods to avoid duplication when template adds its own period
      { PREDICTION_PROMPT: predictionPrompt.trim().replace(/\.+$/, "") }
    ),
    clockEdit ? image.clockEditClause : "",
    variantContext,
    rules.hardRules,
    clockEdit ? rules.clockHardRules : []
  );
};
