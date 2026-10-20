import promptConfig from "../gemini-prompts.json";
import { Target } from "../types";
import {
  DEFAULT_SCENE_PARAMS,
  formatDistanceEn,
  formatDistanceJa,
  presenceAllowsNewPerson,
  resolveSceneDistances,
  resolveScenePresence,
  resolveSceneTone,
  formatSignedDistanceJa,
  type SceneParams,
} from "./sceneParams";

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
  /** Object very close to the camera, with its real size/distance ("" / undefined = none). Scene-level, copied onto each scenario. */
  foreground_object?: string;
  /**
   * Scene-level, same value on every scenario of one frame: the model's plain
   * description of what is visible in the frame NOW (shown as the NOW text in TD).
   */
  scene_now?: string;
  /** G-24: an unoccupied scene with neither the recent person nor an object change is not generated (reason). */
  skipped?: "no_recent_activity" | "no_movable_object" | "chance";
}

/** Content text shown for one scenario in TD: the situation description only, no prompt boilerplate. */
export const scenarioContentText = (scenario: Pick<ScenarioResult, "scenario_description">): string =>
  String(scenario?.scenario_description ?? "").trim();

/** NOW text of a frame (scene-level, copied onto every scenario); "" if the model gave none. */
export const nowContentText = (scenarios: Array<Pick<ScenarioResult, "scene_now">>): string => {
  for (const s of scenarios) {
    const t = String(s?.scene_now ?? "").trim();
    if (t) return t;
  }
  return "";
};

/** Strict reading of the model's `clock_visible`: only true / "true" count. */
export const parseClockVisible = (value: unknown): boolean =>
  value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");

export type TimeDirection = "future" | "past";

/** Which time direction a scenario represents (index convention + text fallback). */
export function scenarioDirection(scenario: ScenarioResult, index: number): TimeDirection {
  const t = `${scenario.scenario_description} ${scenario.label}`.toLowerCase();
  // Use word boundaries to match explicit time phrases, not embedded words like 手前/後ろ
  const pastMatches = /秒前|分前|過去|\bearlier\b|\brewind\b|(?:seconds?|minutes?) before|\bprior\b/.test(t);
  const futureMatches = /秒後|分後|未来|\blater\b|(?:seconds?|minutes?) after|\bforward\b/.test(t);
  if (pastMatches && !futureMatches) return "past";
  if (futureMatches && !pastMatches) return "future";
  return index >= 2 ? "past" : "future";
}

/** One sentence that applies while the control value is below `below` (last band: no limit). */
interface ControlBand {
  below?: number;
  text: string;
}

interface GeminiPromptConfig {
  editingGuide?: unknown;
  userEditable: {
    scenarioPrediction: {
      historyIntroTemplate: string;
      recentPersonTemplate: string;
      sceneAnalysisIntro: string;
      defaultTargetContext: string;
      targetedTargetContextTemplate: string;
      targetedTargetFocus: string;
      predictionRequest: string;
      /** One line of the per-scenario timeline: {{N}}, {{DISTANCE}}, {{DIRECTION}} (AFTER / BEFORE). */
      scenarioTimelineLine: string;
      /** Two scenarios at the same signed distance: {{A}}, {{B}}. */
      sameMomentPairGuidance: string;
      /** Three or more scenarios at the same signed distance: {{LIST}}. */
      sameMomentGroupGuidance: string;
      /** Scenarios BEFORE the frame: {{LIST}}, {{EACH}} ("each " when several, else empty). */
      rewindGuidance: string;
      /** Same direction, different time spans: {{LIST}}, {{BOTH_ALL}} (both / all), {{DIRECTION}}. */
      differentSpanGuidance: string;
      descriptionLanguageRule: string;
      sceneControls: {
        distanceScale: ControlBand[];
        presence: ControlBand[];
        tone: ControlBand[];
      };
    };
    futureImageGeneration: {
      editInstructionTemplate: string;
      /** Only added when a clock/number sign is visible and being edited. */
      clockEditClause: string;
      /** Added for scenes with a long time span (>= LONG_SPAN_IMAGE_SEC): keep the background identical. */
      longSpanClause: string;
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
      /** Person rule for the image edit; which one applies depends on presence. */
      newPersonRule: string;
      enteringPersonRule: string;
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

const distancePlaceholders = (sec: number): Record<string, string> => ({
  DISTANCE: formatDistanceEn(sec),
  DISTANCE_JA: formatDistanceJa(sec),
});

const pickBand = (bands: ControlBand[], value: number): string => {
  const band = bands.find((b) => b.below === undefined || value < b.below) ?? bands[bands.length - 1];
  return band.text;
};

/** Time-span sentence for a time span in seconds (before or after the frame): short -> small changes, long -> larger changes plausible. */
export const buildDistanceScaleSentence = (spanSec: number): string => {
  const span = Math.abs(spanSec);
  return replacePlaceholders(
    pickBand(prompts.userEditable.scenarioPrediction.sceneControls.distanceScale, span),
    distancePlaceholders(span)
  );
};

/** People sentence by presence (0 = nobody new, minimal motion .. 1 = a person may walk in). */
export const buildPresenceSentence = (presence: number): string =>
  pickBand(prompts.userEditable.scenarioPrediction.sceneControls.presence, presence);

/** What {{DISTANCE}} stands for in a sentence that covers every scenario at once. */
const sharedSpanPhrase = (spansSec: number[]): string => {
  const abs = spansSec.map((d) => Math.abs(d));
  return abs.every((a) => a === abs[0]) ? formatDistanceEn(abs[0]) : "the time span of its scenario";
};

/**
 * Tone sentence by tone (0 = calm .. 1 = dramatic but physically plausible).
 * `distanceSec`: one time span (seconds), or the per-scenario list (a list whose
 * spans differ says "the time span of its scenario" instead of one number).
 */
export const buildToneSentence = (
  tone: number,
  distanceSec: number | number[] = DEFAULT_SCENE_PARAMS.futureDistanceSec
): string =>
  replacePlaceholders(pickBand(prompts.userEditable.scenarioPrediction.sceneControls.tone, tone), {
    DISTANCE: Array.isArray(distanceSec) ? sharedSpanPhrase(distanceSec) : formatDistanceEn(Math.abs(distanceSec)),
    DISTANCE_JA: formatDistanceJa(Math.abs(Array.isArray(distanceSec) ? distanceSec[0] : distanceSec)),
  });

const scenarioListEn = (indexes: number[]): string => {
  const nums = indexes.map((i) => i + 1);
  if (nums.length === 1) return `Scenario ${nums[0]}`;
  return `Scenarios ${nums.slice(0, -1).join(", ")} and ${nums[nums.length - 1]}`;
};

/** Group scenario indexes by a key, in order of first appearance. */
const groupBy = (values: number[], key: (v: number) => string | number): number[][] => {
  const groups = new Map<string | number, number[]>();
  values.forEach((v, i) => groups.set(key(v), [...(groups.get(key(v)) ?? []), i]));
  return [...groups.values()];
};

/** "Scenario 1: exactly about 30 seconds AFTER this frame" lines, one per scenario. */
export const buildScenarioTimeline = (signedDistancesSec: number[]): string =>
  signedDistancesSec
    .map((d, i) =>
      replacePlaceholders(prompts.userEditable.scenarioPrediction.scenarioTimelineLine, {
        N: String(i + 1),
        DISTANCE: formatDistanceEn(Math.abs(d)),
        DIRECTION: d < 0 ? "BEFORE" : "AFTER",
      })
    )
    .join("\n");

/**
 * Time-span sentence(s) for all scenarios. All spans equal -> the single sentence
 * (as before); otherwise one sentence per distinct span, naming its scenarios.
 */
export const buildDistanceScaleSection = (signedDistancesSec: number[]): string => {
  const groups = groupBy(signedDistancesSec, (d) => Math.abs(d));
  if (groups.length === 1) return buildDistanceScaleSentence(signedDistancesSec[0]);
  return groups
    .map((idx) => `For ${scenarioListEn(idx)}: ${buildDistanceScaleSentence(signedDistancesSec[idx[0]])}`)
    .join("\n");
};

/** Which scenarios must differ from each other / be a rewind / be farther than another. */
export const buildVariationGuidance = (signedDistancesSec: number[]): string => {
  const sp = prompts.userEditable.scenarioPrediction;
  const lines: string[] = [];
  // Same direction and distance: clearly different alternatives.
  for (const idx of groupBy(signedDistancesSec, (d) => d)) {
    if (idx.length === 2) {
      lines.push(replacePlaceholders(sp.sameMomentPairGuidance, { A: String(idx[0] + 1), B: String(idx[1] + 1) }));
    } else if (idx.length > 2) {
      lines.push(replacePlaceholders(sp.sameMomentGroupGuidance, { LIST: scenarioListEn(idx).replace(/^Scenarios /, "") }));
    }
  }
  // Same direction, different spans: the farther one changes more.
  for (const dir of ["future", "past"] as const) {
    const idx = signedDistancesSec.map((_, i) => i).filter((i) => (signedDistancesSec[i] < 0) === (dir === "past"));
    if (new Set(idx.map((i) => Math.abs(signedDistancesSec[i]))).size > 1) {
      lines.push(
        replacePlaceholders(sp.differentSpanGuidance, {
          LIST: scenarioListEn(idx),
          BOTH_ALL: idx.length === 2 ? "both" : "all",
          DIRECTION: dir === "past" ? "BEFORE" : "AFTER",
        })
      );
    }
  }
  // Scenarios before the frame: an unmistakable rewind.
  const past = signedDistancesSec.map((_, i) => i).filter((i) => signedDistancesSec[i] < 0);
  if (past.length > 0) lines.push(replacePlaceholders(sp.rewindGuidance, { LIST: scenarioListEn(past), EACH: past.length > 1 ? "each " : "" }));
  if (past.length > 0) lines.push(buildPastSceneContract(past.map((i) => signedDistancesSec[i]), past));
  return lines.join(" ");
};

/**
 * G-26 (2026-10-20, user: 「過去のPROMPTが、全然過去ではない」): the contract for every scenario BEFORE the frame.
 * The frame is the END state; the past scenario is the earlier state that led into it, written as that state
 * (never a change that ends in "now"), and consistent with HISTORY: an activity already seen for longer than the
 * span was already going on (a slightly earlier moment of it), only a NEW state is reversed.
 */
export const PAST_SCENE_USER_WORDS =
  "「たとえば、何かを食べている場合、それが未開封になってるとか、紙袋にはいってるとか、ならわかる」 / " +
  "「ただ、常に未開封だと、変。すでに10分以上食事しているときに、その３０秒前が常に未開封なシーン、だと不自然。」 / " +
  "「整合性のある、あり得た過去・未来を生成するのは、だいぶハイコンテクスト。完全にはできないとおもうけど、ベストエフォートで実装したい」";

export function buildPastSceneContract(pastDistancesSec: number[], pastIndexes?: number[]): string {
  const list = scenarioListEn(pastIndexes ?? pastDistancesSec.map((_, i) => i));
  const span = sharedSpanPhrase(pastDistancesSec);
  return (
    `PAST-SCENE CONTRACT for ${list}: this frame is the END state. ${list} must show the room as it plausibly WAS ${span} earlier, ` +
    `the moment that led into this frame, causally consistent with it (same people, same belongings, same places; nothing that could not become this frame within ${span}). ` +
    `First decide from HISTORY and the STATE LEDGER (when given) whether the current activity or state started within the last ${span}. ` +
    `If it was already going on before that (the same activity appears in HISTORY for longer than ${span}, e.g. the person has been eating for 10 minutes), ` +
    `the SAME activity was already going on: show a slightly earlier moment of it (one bite earlier, the cup a little lower, the hands in a slightly different position), never the unopened, closed, packed-away or absent state. ` +
    `If HISTORY is missing or unclear, use the SMALLEST coherent difference (a slightly earlier moment of the same state), never a bold reversal. ` +
    `Only if HISTORY shows the state is NEW (it began within about twice ${span}) reverse the most recent action or state change: ` +
    `if a person is eating something now, earlier the item was still unopened or still inside its paper bag; ` +
    `if a cup is at the mouth now, earlier it was still on the desk; if a bag is open now, earlier it was still closed. ` +
    `Never invent a new or unrelated action. ` +
    `Write its prediction_prompt as the earlier state itself (e.g. "The cup is still on the desk next to her right hand; both her hands rest on the desk."), ` +
    `never as a change that ends in the present: no "now", "currently", "at present", "originally ... now", "has lowered", "then", "will". ` +
    `Its scenario_description is that earlier state in the past tense (e.g. "${formatDistanceEn(Math.abs(pastDistancesSec[0] ?? 30))} before, the cup was still on the desk."). ` +
    `(User guidance G-26: ${PAST_SCENE_USER_WORDS})`
  );
}

/** Japanese time phrase each scenario_description must begin with. */
export const buildDescriptionPhrases = (signedDistancesSec: number[]): string =>
  signedDistancesSec.map((d, i) => `Scenario ${i + 1}: "${formatSignedDistanceJa(d)}、..."`).join("; ");

/**
 * People sentence(s) for all scenarios. Every scenario on the same presence band -> the single sentence (as before);
 * otherwise one sentence per band, naming its scenarios ("For Scenario 2: People: ...").
 */
export const buildPresenceSection = (presences: number[]): string => {
  const groups = groupBy(presences, (p) => buildPresenceSentence(p));
  if (groups.length <= 1) return buildPresenceSentence(presences[0] ?? DEFAULT_SCENE_PARAMS.presence);
  return groups.map((idx) => `For ${scenarioListEn(idx)}: ${buildPresenceSentence(presences[idx[0]])}`).join("\n");
};

/**
 * Tone sentence(s) for all scenarios. One band for all -> the single sentence (as before); otherwise one sentence per
 * band, and its "applies to ALL scenarios" wording is narrowed to the scenarios it names.
 */
export const buildToneSection = (tones: number[], signedDistancesSec: number[]): string => {
  const groups = groupBy(tones, (t) => buildToneSentence(t, signedDistancesSec));
  if (groups.length <= 1) return buildToneSentence(tones[0] ?? DEFAULT_SCENE_PARAMS.tone, signedDistancesSec);
  return groups
    .map((idx) => {
      const list = scenarioListEn(idx);
      const spans = idx.map((i) => signedDistancesSec[i] ?? signedDistancesSec[signedDistancesSec.length - 1]);
      const text = buildToneSentence(tones[idx[0]], spans).replace(
        /applies to ALL scenarios, including the one before this frame/,
        `applies ONLY to ${list}; the other scenarios follow their own Tone sentence`
      );
      return `For ${list}: ${text}`;
    })
    .join("\n");
};

const buildSceneControlSentences = (params: SceneParams, signedDistancesSec: number[]): string[] => [
  buildDistanceScaleSection(signedDistancesSec),
  buildPresenceSection(resolveScenePresence(params, signedDistancesSec.length)),
  buildToneSection(resolveSceneTone(params, signedDistancesSec.length), signedDistancesSec),
];

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
  options?: PromptVariantOptions,
  sceneParams: SceneParams = DEFAULT_SCENE_PARAMS
): string => {
  // Signed distance per scenario (gen_a, gen_b, gen_c); old single-N params fall back to [+N, +N, -N].
  const distances = resolveSceneDistances(sceneParams, scenarioCount);
  const targetContext = target ? buildTargetedScenarioContext(target) : buildDefaultScenarioContext();
  const countPlaceholders = {
    SCENARIO_COUNT: String(scenarioCount),
    SCENARIO_TIMELINE: buildScenarioTimeline(distances),
  };
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
    buildSceneControlSentences(sceneParams, distances),
    buildVariationGuidance(distances),
    replacePlaceholders(prompts.userEditable.scenarioPrediction.descriptionLanguageRule, {
      DESCRIPTION_PHRASES: buildDescriptionPhrases(distances),
    }),
    prompts.systemFixed.scenarioPrediction.outputFormatRules.map((rule) =>
      replacePlaceholders(rule, countPlaceholders)
    ),
    sceneParams.contextNote ?? ""
  );
};

/** History + recent-person paragraphs for the scenario prompt ("" when there is nothing to add). */
export const buildHistoryContextNote = (args: {
  observations: string[];
  /** Closing line(s) of the history section (e.g. the machine-extracted arrival/departure summary). */
  footer?: string;
  recentPerson?: { description: string; minutesAgo: number } | null;
}): string => {
  const sp = prompts.userEditable.scenarioPrediction;
  const parts: string[] = [];
  if (args.observations.length > 0) {
    parts.push(
      replacePlaceholders(sp.historyIntroTemplate, {
        HISTORY_LINES:
          args.observations.map((o, i) => `${i + 1}. ${o}`).join("\n") + (args.footer ? "\n" + args.footer : ""),
      })
    );
  }
  if (args.recentPerson) {
    parts.push(
      replacePlaceholders(sp.recentPersonTemplate, {
        MINUTES: String(args.recentPerson.minutesAgo),
        DESCRIPTION: args.recentPerson.description,
      })
    );
  }
  return parts.join("\n");
};

/** From this time span on, the image prompt adds the "keep the background identical" clause. */
export const LONG_SPAN_IMAGE_SEC = 120;

/**
 * `clockEdit` is true only when a clock / number sign is visible AND its digits
 * are to be edited; otherwise the prompt says nothing about clocks or signs, so
 * the image model has no reason to paint one.
 */
export const buildFutureImagePrompt = (
  predictionPrompt: string,
  options?: PromptVariantOptions,
  clockEdit = false,
  presence: number = DEFAULT_SCENE_PARAMS.presence,
  /** Distance (seconds, any sign) of this image from the frame; long spans add the background clause. */
  distanceSec = 0
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
    presenceAllowsNewPerson(presence) ? rules.enteringPersonRule : rules.newPersonRule,
    clockEdit ? rules.clockHardRules : [],
    Math.abs(distanceSec) >= LONG_SPAN_IMAGE_SEC ? image.longSpanClause : ""
  );
};
