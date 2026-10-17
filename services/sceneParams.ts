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
  return {
    futureDistanceSec,
    sceneDistancesSec,
    presence: clampUnit(src.presence, base.presence),
    tone: clampUnit(src.tone, base.tone),
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
  `presence=${p.presence.toFixed(2)} tone=${p.tone.toFixed(2)}`;
