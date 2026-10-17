/**
 * Guard against the 4B VLM inventing people in an empty room.
 * If scene_description mentions no person but a scenario does, the scenario is a fabrication:
 * the planner retries, and after the last retry replaces the offending scenario with a safe
 * "room stays empty" change built only from objects named in scene_description.
 */
import type { ScenarioResult } from "../../services/promptBuilder";
import { getRulebook } from "./rulebook";

const PERSON_WORDS =
  "person|people|persons|man|men|woman|women|boy|girl|child|children|kid|kids|someone|somebody|anyone|anybody|" +
  "he|she|his|her|hers|him|himself|herself|they|their|them|hand|hands|arm|arms|finger|fingers|head|face|" +
  "figure|individual|human|humans|worker|workers|staff|visitor|visitors|student|students|occupant|silhouette|" +
  "pedestrian|customer|user|guy|lady";

const PERSON_RE = new RegExp("\\b(?:" + PERSON_WORDS + ")\\b", "i");
// Gemini may answer in Japanese; "無人" / "誰もいない" mean empty and are removed first.
const JA_EMPTY_RE = /無人|誰もいない|だれもいない|人がいない|人影はない/g;
const JA_PERSON_RE = /人|男|女|彼|手|腕|顔|子供|誰|スタッフ|作業員|客/;

// "with no people present", "nobody is visible", "no person in the frame" are statements of emptiness.
const NEGATED_RE = new RegExp(
  "\\b(?:no|without|nobody|no one|none of|not any|zero)\\b[^.;]{0,30}?\\b(?:" + PERSON_WORDS + "|one|occupants?)\\b|\\b(?:nobody|no one|unoccupied|uninhabited|deserted)\\b",
  "gi"
);

export function mentionsPerson(text: string): boolean {
  const t = text.replace(NEGATED_RE, " ");
  return PERSON_RE.test(t) || JA_PERSON_RE.test(t.replace(JA_EMPTY_RE, ""));
}

/** True when the frame description names nobody (the room is judged empty). */
export function isUnoccupied(sceneDescription: string | undefined | null): boolean {
  const scene = String(sceneDescription ?? "").trim();
  return scene.length > 0 && !mentionsPerson(scene);
}

/** Indices of scenarios that mention a person although the frame shows none. [] when the frame has people. */
export function findFabricatedScenarios(
  sceneDescription: string | undefined | null,
  scenarios: ScenarioResult[],
  /** A person was seen recently: a person in the scenarios is then the one from the recent frames, not a fabrication. */
  allowPerson = false,
  /** The person detector says the frame is empty: the text's person mention is a hallucination. */
  forceEmpty = false
): number[] {
  if (allowPerson || (!forceEmpty && !isUnoccupied(sceneDescription))) return [];
  const bad: number[] = [];
  scenarios.forEach((s, i) => {
    if (mentionsPerson(s.prediction_prompt) || mentionsPerson(s.scenario_description)) bad.push(i);
  });
  return bad;
}

const LEADING_FILLER = /^(?:an?|the|some|several|many|two|three|visible|various|large|small|empty|open)\s+/i;
const GENERIC = /^(?:room|space|area|scene|view|image|frame|interior|office space|office|background|floor|wall|walls|ceiling)$/i;

/** Object nouns from the scene description ("An office space with visible chairs, shelves" -> chairs, shelves). */
export function extractObjects(sceneDescription: string): string[] {
  const parts = String(sceneDescription)
    .replace(/\.+$/, "")
    .split(/,|;|\band\b|\bwith\b|\bwhile\b|\bnear\b|\bbehind\b|\bin front of\b|\bon\b|\bby\b/i)
    .map((p) => p.trim().replace(LEADING_FILLER, "").replace(LEADING_FILLER, "").trim())
    .filter((p) => p.length > 1 && p.length <= 40 && !GENERIC.test(p) && !mentionsPerson(p));
  return Array.from(new Set(parts));
}

function leadingSpan(description: string): string {
  const m = description.match(/^[^,]{0,40}\b(?:later|before|after|earlier|ago)\b[^,]{0,10},/i);
  return m ? m[0] : "Shortly after,";
}

/** A minimal, person-free replacement for scenario `index` (0-based). */
export function safeScenario(sceneDescription: string, original: ScenarioResult, index: number): ScenarioResult {
  const objects = extractObjects(sceneDescription);
  const obj = objects.length ? objects[index % objects.length] : "furniture";
  const templates = [
    `The room stays empty; only the light on the ${obj} shifts slightly.`,
    `The room stays empty and still; the ${obj} sits in a slightly softer shade.`,
    `Nobody enters the room; the brightness of the ${obj} changes slightly.`,
  ];
  const text = templates[index % templates.length];
  return {
    ...original,
    prediction_prompt: text,
    scenario_description: `${leadingSpan(original.scenario_description)} the room is still empty; ${text.split("; ")[1] ?? text}`,
  };
}

export interface GuardRecord {
  /** scene_description named no person. */
  unoccupied: boolean;
  /** Number of VLM calls (retries + 1) that were made while checking. */
  attempts: number;
  /** Fabricated scenarios seen at each attempt (index lists), in order. */
  fabricatedPerAttempt: number[][];
  /** Scenario indices replaced by the safe fallback ([] = none). */
  replaced: number[];
  /** Scenario indices that repeated an earlier scenario in the final answer (replaced when the room is empty). */
  duplicates?: number[];
  /** The model was re-asked once because scenarios repeated each other. */
  duplicateRetried?: boolean;
  /** Per-scene sceneExtras check: reflected in the scenario text? (only scenes that had an extra) */
  extras?: Record<string, { reflected: boolean; retried: boolean; synthesized?: boolean; source?: 'server'; text?: string; english?: string }>;
  /** The person detector's verdict on the source frame (null person = failed / not run). */
  detector?: { person: boolean | null; count?: number; elapsedMs: number; doneReason?: string; raw?: string };
  /** Where "occupied" came from: the detector, the scene_description text, both, or none (= empty). */
  occupancySource?: 'detector' | 'text' | 'both' | 'none';
  /** People facts used (describe call) for the GROUND TRUTH note. */
  people?: Array<{ position: string; pose: string; clothes: string; facing: string }>;
  /** The scenarios were written by the server because the planner kept denying a detected person. */
  synthesized?: boolean;
  /** Wall time of the planning phase (ms) and how many planner calls it used. */
  planMs?: number;
  planCalls?: number;
  /** Scenarios that named things the frame description does not (and the words), plus whether the planner was re-asked. */
  fabricatedObjects?: Array<{ index: number; words: string[] }>;
  objectRetried?: boolean;
  /** The planner was re-asked because the detector saw a person but scene_description named none. */
  detectorRetried?: boolean;
  /** The detector said nobody but scene_description names a person: treated as possibly occupied (the short call can miss people). */
  detectorDisagree?: boolean;
  /**
   * Scenes whose planner text raised the arms (regex or the short semantic check) and were replaced by a modest motion.
   * 'arms_raised' is also the reserved QA classification name for the continuous image QA (not produced here).
   */
  armsRaised?: number[];
  /** Operator extras that were not applied, with a short reason for the display (e.g. 'ignored: frame empty'). */
  extrasStatus?: Record<string, string>;
  /** The describe call judged the camera view blocked by a close object (chair back, hand, cloth). Recorded only; generation continues. */
  obstructed?: boolean;
  obstructedBy?: string;
  /** English scene_description of the frame (as seen by the guard). */
  scene?: string;
  /** A person was seen within RECENT_PERSON_WINDOW_MIN, so people in scenarios were allowed. */
  recentPersonAllowed?: boolean;
}

/** Lower-cased, punctuation-free token string for comparing scenario texts. */
function normalizeText(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function bigrams(t: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i += 1) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1);
  return m;
}

/** Sorensen-Dice similarity of character bigrams (1 = identical). */
export function similarity(a: string, b: string): number {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bx = bigrams(x);
  const by = bigrams(y);
  let inter = 0;
  for (const [k, v] of bx) inter += Math.min(v, by.get(k) ?? 0);
  return (2 * inter) / (x.length - 1 + (y.length - 1));
}

/** Indices (never the first of a group) of scenarios that repeat an earlier prediction_prompt (>= threshold). */
export function findDuplicateScenarios(scenarios: ScenarioResult[], threshold = getRulebook().guard.duplicateThreshold): number[] {
  const dup: number[] = [];
  scenarios.forEach((s, i) => {
    for (let j = 0; j < i; j += 1) {
      if (similarity(s.prediction_prompt, scenarios[j].prediction_prompt) >= threshold) {
        dup.push(i);
        break;
      }
    }
  });
  return dup;
}

// Any substring match counts (the image model reacts to the token, not the word): "armrest", "warm", "handle" go too.
const EMPTY_ROOM_BANNED_BASE = /person|people|figure|silhouette|hand|arm|nobody|no one|human|someone|enter|\b(?:man|woman|he|she|his|her|they|their|him|them)\b/i;

/** Base words plus the rulebook's guard.extraEmptyRoomBannedWords (substring match, like the base list). */
function emptyRoomBanned(): RegExp {
  const extra = getRulebook().guard.extraEmptyRoomBannedWords.filter((w) => /^[a-z][a-z -]{1,30}$/i.test(w));
  return extra.length === 0 ? EMPTY_ROOM_BANNED_BASE : new RegExp(EMPTY_ROOM_BANNED_BASE.source + "|" + extra.join("|"), "i");
}

/**
 * Empty-room image prompts must contain no person words at all (a diffusion model reads "no person" as "person").
 * Keeps only the sentences/clauses of the prediction that are free of them; falls back to a light change.
 */
export function sanitizeEmptyRoomPrediction(prediction: string): string {
  const clauses = String(prediction)
    .split(/(?<=[.!?;])\s+|;\s*/)
    .map((c) => c.trim().replace(/[.;]+$/, ""))
    .filter((c) => c.length > 0 && !emptyRoomBanned().test(c));
  return clauses.length > 0 ? clauses.join("; ") : "the light on the furniture shifts slightly";
}

export function occupancySourceOf(textOccupied: boolean, detectorPerson: boolean | null | undefined): 'detector' | 'text' | 'both' | 'none' {
  const d = detectorPerson === true;
  return d && textOccupied ? 'both' : d ? 'detector' : textOccupied ? 'text' : 'none';
}

/** The scene description without the sentences that mention people ("An empty room." when nothing is left). */
export function sceneWithoutPeople(scene: string): string {
  const kept = String(scene)
    .split(/(?<=[.!?])\s+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && !emptyRoomBanned().test(c));
  return kept.length > 0 ? kept.join(" ") : "An empty room.";
}

export function applySafeFallback(scenarios: ScenarioResult[], bad: number[]): ScenarioResult[] {
  const scene = scenarios[0]?.scene_now ?? "";
  return scenarios.map((s, i) => (bad.includes(i) ? safeScenario(scene, s, i) : s));
}

/** One-shot guard (no retries): used where the model is not re-called (Gemini/hybrid). */
export function guardOnce(
  scenarios: ScenarioResult[],
  allowPerson = false
): { scenarios: ScenarioResult[]; record: GuardRecord } {
  const scene = scenarios[0]?.scene_now ?? "";
  const bad = findFabricatedScenarios(scene, scenarios, allowPerson);
  return {
    scenarios: bad.length ? applySafeFallback(scenarios, bad) : scenarios,
    record: { unoccupied: isUnoccupied(scene), attempts: 1, fabricatedPerAttempt: [bad], replaced: bad, scene, recentPersonAllowed: allowPerson },
  };
}
