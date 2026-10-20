/**
 * G-24 / G-25: what an UNOCCUPIED frame may show, decided per scene (A/B/C) with reproducible rolls.
 *   - recent person (<= RECENT_PERSON_WINDOW_MIN): drawn from behind iff roll(`${captureId}:${sceneKey}`) < emptyRoomPersonChance,
 *     or always when the operator instruction of that scene names a person; never without a recent person (G-01).
 *   - movable-object change: only when someone was in the room within EMPTY_ROOM_ACTIVITY_MIN (default 3) minutes AND
 *     roll(`${captureId}:${sceneKey}:object`) < EMPTY_ROOM_OBJECT_CHANCE (default 0.3). Long-empty rooms never move objects.
 *   - neither: the scene is skipped (not generated, no "remains the same" sentence).
 * Pure: no I/O besides reading the two env constants.
 */
import { createHash } from "node:crypto";
import { mentionsPerson } from "./scenarioGuard";

export const DEFAULT_EMPTY_ROOM_PERSON_CHANCE = 0.3;
export const DEFAULT_EMPTY_ROOM_ACTIVITY_MIN = 3;
export const DEFAULT_EMPTY_ROOM_OBJECT_CHANCE = 0.3;

export type EmptyRoomSkipReason = "no_recent_activity" | "no_movable_object" | "chance";

export interface EmptyRoomSceneDecision {
  sceneKey: string;
  emptyRoomPersonChance: number;
  /** Person roll r in [0,1): first 32 bits of sha256(`${captureId}:${sceneKey}`) / 2^32. */
  roll: number;
  personDrawn: boolean;
  /** Why the person is (not) drawn: operator_mention | chance | no_recent_person. */
  reason: "operator_mention" | "chance" | "no_recent_person";
  objectChance: number;
  objectRoll: number;
  /** Minutes since the last occupied frame (null = none known within the activity window). */
  activityMinutesAgo: number | null;
  activityWindowMin: number;
  /** Object change allowed: recent activity AND objectRoll < objectChance (or forced by an operator element). */
  objectAllowed: boolean;
  /** Reason the object change is not allowed (null when allowed). */
  objectBlockedReason: "no_recent_activity" | "chance" | null;
  /** An operator image element / scene mode forces the scene to be generated (never skipped). */
  forceKeep?: boolean;
  /** Filled after planning: the scene was skipped, and why. */
  skipped?: boolean;
  skipReason?: EmptyRoomSkipReason;
}

/** Reproducible value in [0,1) from the first 32 bits of sha256(key). */
export function emptyRoomRoll(key: string): number {
  return createHash("sha256").update(key).digest().readUInt32BE(0) / 2 ** 32;
}

const unit = (value: unknown): number | undefined => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined;
};

export function emptyRoomActivityMin(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.EMPTY_ROOM_ACTIVITY_MIN);
  return env.EMPTY_ROOM_ACTIVITY_MIN?.trim() && Number.isFinite(n) && n >= 0 ? n : DEFAULT_EMPTY_ROOM_ACTIVITY_MIN;
}

export function emptyRoomObjectChance(env: NodeJS.ProcessEnv = process.env): number {
  return unit(env.EMPTY_ROOM_OBJECT_CHANCE) ?? DEFAULT_EMPTY_ROOM_OBJECT_CHANCE;
}

export function decideEmptyRoomScenes(args: {
  captureId: string;
  sceneKeys: readonly string[];
  emptyRoomPersonChance: number;
  /** A usable recent person (<= 10 min, live or test-scope history). */
  recentPerson: boolean;
  /** Operator instruction per scene (sceneExtras: Continuous / One shot / scenario prompt). */
  extras?: Partial<Record<string, string | undefined>>;
  /** Minutes since the newest occupied frame (null = none). */
  activityMinutesAgo: number | null;
  activityWindowMin?: number;
  objectChance?: number;
  /** Scenes an operator image element / scene mode forces to be generated. */
  forceKeep?: ReadonlySet<string>;
}): EmptyRoomSceneDecision[] {
  const chance = unit(args.emptyRoomPersonChance) ?? DEFAULT_EMPTY_ROOM_PERSON_CHANCE;
  const windowMin = args.activityWindowMin ?? emptyRoomActivityMin();
  const objectChance = unit(args.objectChance) ?? emptyRoomObjectChance();
  const active = args.activityMinutesAgo !== null && Number.isFinite(args.activityMinutesAgo) && args.activityMinutesAgo <= windowMin;
  return args.sceneKeys.map((sceneKey) => {
    const roll = emptyRoomRoll(`${args.captureId}:${sceneKey}`);
    const objectRoll = emptyRoomRoll(`${args.captureId}:${sceneKey}:object`);
    const extra = args.extras?.[sceneKey];
    const mention = !!extra && mentionsPerson(extra);
    const personDrawn = args.recentPerson && (mention || roll < chance);
    const reason = !args.recentPerson ? "no_recent_person" : mention ? "operator_mention" : "chance";
    const forceKeep = args.forceKeep?.has(sceneKey) === true;
    const objectWins = active && objectRoll < objectChance;
    return {
      sceneKey,
      emptyRoomPersonChance: chance,
      roll,
      personDrawn,
      reason,
      objectChance,
      objectRoll,
      activityMinutesAgo: args.activityMinutesAgo,
      activityWindowMin: windowMin,
      objectAllowed: objectWins || forceKeep,
      objectBlockedReason: objectWins || forceKeep ? null : active ? "chance" : "no_recent_activity",
      ...(forceKeep ? { forceKeep: true } : {}),
    };
  });
}

/** Minutes between an ISO time and now (null when missing/invalid). */
export function minutesSince(iso: string | undefined | null, now = Date.now()): number | null {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? Math.max(0, (now - t) / 60_000) : null;
}

/**
 * G-24 activity source = the recent-person source (live: sceneHistory latestPerson; test scope: latestTestPerson's newest
 * occupied replayed frame). Minutes since that frame; its rounded minutesAgo when the time is unreadable; null without one.
 * (A separate lookup limited to the 3-minute activity window returned null for a person seen 5 minutes ago.)
 */
export function activityMinutesFromRecent(recent: { entry: { time?: string }; minutesAgo?: number } | null | undefined, now = Date.now()): number | null {
  if (!recent) return null;
  const m = minutesSince(recent.entry?.time, now);
  if (m !== null) return m;
  return typeof recent.minutesAgo === "number" && Number.isFinite(recent.minutesAgo) ? recent.minutesAgo : null;
}

/**
 * Final text of an unoccupied scene that does NOT draw the recent person (planner text already lighting-filtered):
 * the kept planner change / an object change when allowed, otherwise a skip with its reason.
 */
export function resolveEmptyScene(args: {
  decision: EmptyRoomSceneDecision;
  kept: string;
  isNoChange: (text: string) => boolean;
  objectChange: () => string | null;
}): { text: string; skipped?: undefined } | { skipped: EmptyRoomSkipReason; text?: undefined } {
  const d = args.decision;
  if (!d.objectAllowed) return { skipped: d.objectBlockedReason === "chance" ? "chance" : "no_recent_activity" };
  const usable = args.kept && !args.isNoChange(args.kept) && !mentionsPerson(args.kept) ? args.kept : "";
  if (usable) return { text: usable };
  const change = args.objectChange();
  if (change) return { text: change };
  if (d.forceKeep) return { text: args.kept && !mentionsPerson(args.kept) ? args.kept : "Keep the scene exactly as in the input." };
  return { skipped: "no_movable_object" };
}

/**
 * Final text of an unoccupied scene that DOES draw the recent person: the object gate stays authoritative. With
 * objectAllowed=false any planner object change is dropped and only the person's motion (`personOnly`) remains; with an
 * allowed object change the planner text is kept.
 */
export function resolveRecentPersonScene(args: { decision: EmptyRoomSceneDecision; kept: string; personOnly: string }): string {
  if (args.decision.objectAllowed && args.kept) return args.kept;
  return args.personOnly;
}

/**
 * Publication plan of one capture after planning: which scene keys are generated (and get a capture.saved datagram /
 * browser batch entry) and which are skipped. expectedImageCount sent to TD = generated.length.
 */
export function sceneSkipPlan(scenarios: ReadonlyArray<{ skipped?: EmptyRoomSkipReason }>): {
  generated: string[];
  skippedScenes: Array<{ sceneKey: "gen_a" | "gen_b" | "gen_c"; reason: EmptyRoomSkipReason }>;
} {
  const key = (i: number) => `gen_${String.fromCharCode(97 + i)}` as "gen_a" | "gen_b" | "gen_c";
  return {
    generated: scenarios.flatMap((s, i) => (s.skipped ? [] : [key(i)])),
    skippedScenes: scenarios.flatMap((s, i) => (s.skipped ? [{ sceneKey: key(i), reason: s.skipped }] : [])),
  };
}
