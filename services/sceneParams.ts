/**
 * Perform-panel scene controls (TouchDesigner sliders -> server):
 *   sceneDistancesSec  [a, b, c] signed distance of gen_a / gen_b / gen_c from the frame
 *                      (seconds, -600..+600, negative = past, positive = future)
 *   futureDistanceSec  legacy single distance N: used only when sceneDistancesSec is
 *                      missing/invalid, as [+N, +N, -N]
 *   presence           0..1  how much people appear / move
 *   tone               0..1  calm (0) .. dramatic but plausible (1)
 * Pure helpers shared by the prompt builder, the clock edit and the server.
 */

export interface SceneParams {
  /** Legacy single distance N (5..300 s). Fallback source of sceneDistancesSec only. */
  futureDistanceSec: number;
  /** Signed seconds per scene, order gen_a, gen_b, gen_c. Always set by normalizeSceneParams. */
  sceneDistancesSec?: number[];
  presence: number;
  tone: number;
  /**
   * Per-scene presence / tone, order gen_a, gen_b, gen_c (0..1 each). Set by normalizeSceneParams when the request carries
   * scenePresence / sceneTone; a scene the request does not override inherits the global value. Read via presenceAt / toneAt.
   */
  scenePresence?: number[];
  sceneTone?: number[];
  /**
   * G-25 0..1: chance that a recently seen person (<= 10 min) is drawn from behind in an unoccupied scene
   * (per scene, reproducible roll). Control panel "Empty-room person"; default 0.3.
   */
  emptyRoomPersonChance?: number;
  /** Extra planning context (scene history / recent person); set by the server per capture, not a Perform control. */
  contextNote?: string;
}

export const FUTURE_DISTANCE_MIN_SEC = 5;
export const FUTURE_DISTANCE_MAX_SEC = 300;

/** Per-scene distance limits: |d| is clamped into this range, the sign is kept. */
export const SCENE_DISTANCE_MIN_SEC = 5;
export const SCENE_DISTANCE_MAX_SEC = 600;
export const SCENE_DISTANCE_COUNT = 3;

export const DEFAULT_SCENE_PARAMS: SceneParams = {
  futureDistanceSec: 30,
  sceneDistancesSec: [30, 30, -30],
  presence: 0.3,
  tone: 0.3,
  emptyRoomPersonChance: 0.3,
};

/** Number from a JSON value; null/""/NaN/non-numeric -> undefined (= missing). */
const readNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

export const clampFutureDistanceSec = (value: unknown, fallback = DEFAULT_SCENE_PARAMS.futureDistanceSec): number => {
  const n = readNumber(value) ?? fallback;
  return Math.min(FUTURE_DISTANCE_MAX_SEC, Math.max(FUTURE_DISTANCE_MIN_SEC, Math.round(n)));
};

/** Signed distance: |d| clamped to 5..600 s (integer), sign kept; 0 -> +5. */
export const clampSignedDistanceSec = (value: unknown, fallback = 30): number => {
  const n = Math.round(readNumber(value) ?? fallback);
  const sign = n < 0 ? -1 : 1;
  return sign * Math.min(SCENE_DISTANCE_MAX_SEC, Math.max(SCENE_DISTANCE_MIN_SEC, Math.abs(n)));
};

/** Old behaviour: Future A / Future B at +N, Past at -N. */
export const fallbackSceneDistances = (n: number): number[] => [n, n, -n];

/**
 * `sceneDistancesSec` from a request: an array of exactly three numbers (or numeric
 * strings), each clamped. Anything else (absent, wrong length, a non-numeric item)
 * is invalid as a whole -> undefined, and the caller falls back to futureDistanceSec.
 */
export function parseSceneDistances(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw) || raw.length !== SCENE_DISTANCE_COUNT) return undefined;
  const nums = raw.map(readNumber);
  if (nums.some((n) => n === undefined)) return undefined;
  return nums.map((n) => clampSignedDistanceSec(n));
}

/**
 * Signed distance of each of `count` scenarios. Scenarios beyond the third reuse
 * the third (the old convention: index >= 2 is the past one).
 */
export function resolveSceneDistances(
  params: Pick<SceneParams, "futureDistanceSec" | "sceneDistancesSec">,
  count = SCENE_DISTANCE_COUNT
): number[] {
  const base =
    parseSceneDistances(params.sceneDistancesSec) ?? fallbackSceneDistances(clampFutureDistanceSec(params.futureDistanceSec));
  return Array.from({ length: count }, (_, i) => base[Math.min(i, base.length - 1)]);
}

/** Signed distance of scenario `index` (0 = gen_a, 1 = gen_b, 2 = gen_c). */
export const sceneDistanceAt = (
  params: Pick<SceneParams, "futureDistanceSec" | "sceneDistancesSec">,
  index: number
): number => resolveSceneDistances(params, Math.max(index + 1, SCENE_DISTANCE_COUNT))[Math.max(0, index)];

export const distanceDirection = (signedSec: number): "future" | "past" => (signedSec < 0 ? "past" : "future");

export const clampUnit = (value: unknown, fallback: number): number => {
  const n = readNumber(value) ?? fallback;
  return Math.min(1, Math.max(0, n));
};

export const SCENE_KEYS = ["gen_a", "gen_b", "gen_c"] as const;
export type SceneKey = (typeof SCENE_KEYS)[number];

/**
 * Per-scene 0..1 override from a request: a map { gen_a?, gen_b?, gen_c? } (or a 3-item array, null = inherit).
 * Each scene without a valid number inherits `fallback` (the global value). Always returns 3 clamped values.
 */
export function parseSceneUnitMap(raw: unknown, fallback: number): number[] {
  const pick = (i: number): unknown =>
    Array.isArray(raw) ? raw[i] : raw && typeof raw === "object" ? (raw as Record<string, unknown>)[SCENE_KEYS[i]] : undefined;
  return SCENE_KEYS.map((_, i) => clampUnit(pick(i), fallback));
}

const sceneUnitList = (list: number[] | undefined, fallback: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => {
    const v = list?.[Math.min(i, SCENE_DISTANCE_COUNT - 1)];
    return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
  });

/** Presence of each of `count` scenarios (absent override = global presence; index >= 2 reuses the third). */
export const resolveScenePresence = (p: Pick<SceneParams, "presence" | "scenePresence">, count = SCENE_DISTANCE_COUNT): number[] =>
  sceneUnitList(p.scenePresence, p.presence, count);

/** Tone of each of `count` scenarios (absent override = global tone). */
export const resolveSceneTone = (p: Pick<SceneParams, "tone" | "sceneTone">, count = SCENE_DISTANCE_COUNT): number[] =>
  sceneUnitList(p.sceneTone, p.tone, count);

/** Presence of scenario `index` (0 = gen_a). */
export const presenceAt = (p: Pick<SceneParams, "presence" | "scenePresence">, index: number): number =>
  resolveScenePresence(p, Math.max(index + 1, SCENE_DISTANCE_COUNT))[Math.max(0, index)];

/** Tone of scenario `index` (0 = gen_a). */
export const toneAt = (p: Pick<SceneParams, "tone" | "sceneTone">, index: number): number =>
  resolveSceneTone(p, Math.max(index + 1, SCENE_DISTANCE_COUNT))[Math.max(0, index)];

/** { gen_a, gen_b, gen_c } record of a 3-value list (for logs / archive / request bodies). */
export const sceneRecord = (values: number[]): Record<SceneKey, number> =>
  ({ gen_a: values[0], gen_b: values[1], gen_c: values[2] }) as Record<SceneKey, number>;

/**
 * Clamp + default. Accepts a request body (or any object); a missing or
 * invalid field falls back to `defaults` so old clients keep working.
 */
export function normalizeSceneParams(raw: unknown, defaults: Partial<SceneParams> = {}): SceneParams {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const base: SceneParams = { ...DEFAULT_SCENE_PARAMS, ...defaults };
  const futureDistanceSec = clampFutureDistanceSec(src.futureDistanceSec, base.futureDistanceSec);
  // Priority: valid sceneDistancesSec > legacy futureDistanceSec of the request > server defaults.
  const sceneDistancesSec =
    parseSceneDistances(src.sceneDistancesSec) ??
    (readNumber(src.futureDistanceSec) !== undefined
      ? fallbackSceneDistances(futureDistanceSec)
      : parseSceneDistances(defaults.sceneDistancesSec) ?? fallbackSceneDistances(futureDistanceSec));
  const presence = clampUnit(src.presence, base.presence);
  const tone = clampUnit(src.tone, base.tone);
  return {
    futureDistanceSec,
    sceneDistancesSec,
    presence,
    tone,
    // Only when the request carries the map: absent = every scene inherits the global value (resolveScenePresence/Tone).
    ...(src.scenePresence != null ? { scenePresence: parseSceneUnitMap(src.scenePresence, presence) } : {}),
    ...(src.sceneTone != null ? { sceneTone: parseSceneUnitMap(src.sceneTone, tone) } : {}),
    emptyRoomPersonChance: clampUnit(src.emptyRoomPersonChance, base.emptyRoomPersonChance ?? 0.3),
  };
}

/** "30 seconds", "1 minute", "2 minutes", "1 minute 30 seconds". */
export function formatDistanceEn(sec: number): string {
  const s = Math.round(sec);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (s < 60) return plural(s, "second");
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? plural(m, "minute") : `${plural(m, "minute")} ${plural(r, "second")}`;
}

/** "30秒", "2分", "1分30秒". */
export function formatDistanceJa(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}分` : `${m}分${r}秒`;
}

/** "30 seconds after", "2 minutes before" (signed seconds). */
export const formatSignedDistanceEn = (signedSec: number): string =>
  `${formatDistanceEn(Math.abs(signedSec))} ${signedSec < 0 ? "before" : "after"}`;

/** "30秒後", "2分前" (signed seconds). */
export const formatSignedDistanceJa = (signedSec: number): string =>
  `${formatDistanceJa(Math.abs(signedSec))}${signedSec < 0 ? "前" : "後"}`;

/** "+30s", "-2m", "-1m30s", "+10m" for logs. */
export function formatSignedDistanceShort(signedSec: number): string {
  const sign = signedSec < 0 ? "-" : "+";
  const a = Math.abs(Math.round(signedSec));
  if (a < 60) return `${sign}${a}s`;
  const m = Math.floor(a / 60);
  const r = a % 60;
  return r === 0 ? `${sign}${m}m` : `${sign}${m}m${r}s`;
}

/**
 * Presence = how much the people already in the frame move (and whether they may leave it), NOT whether someone new
 * enters (G-01: an unknown new person is never drawn, however high the presence). A recently seen person is the only
 * exception and goes through the referencePerson / behindView path. Kept as a function so callers stay unchanged.
 */
export const presenceAllowsNewPerson = (_presence: number): boolean => false;

/** Compact one-line description for logs. */
export const describeSceneParams = (p: SceneParams): string =>
  `distances=[${resolveSceneDistances(p).map(formatSignedDistanceShort).join(", ")}] (gen_a, gen_b, gen_c) ` +
  `presence=${p.presence.toFixed(2)} tone=${p.tone.toFixed(2)}` +
  perSceneSuffix("presence", resolveScenePresence(p), p.presence) +
  perSceneSuffix("tone", resolveSceneTone(p), p.tone);

/** " presence[A,B,C]=0.30/0.80/0.30" when any scene differs from the global value, else "". */
const perSceneSuffix = (name: string, values: number[], global: number): string =>
  values.some((v) => v !== global) ? ` ${name}[A,B,C]=${values.map((v) => v.toFixed(2)).join("/")}` : "";
