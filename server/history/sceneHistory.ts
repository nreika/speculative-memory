/**
 * Scene history (logs/scene-history.jsonl): one line per capture with the English scene description
 * ("observation") and whether a person was in the frame. Used to
 *   - allow a person in the scenarios only if one was seen recently (fabricated-person guard),
 *   - inject the flow of recent observations into the scenario prompt (history context),
 *   - serve GET /api/action-history, POST /api/reset-history, GET /api/latest-prediction.
 * Field names sceneDescription / hasPerson are fixed (to be merged with the September action history).
 */
import fs from "node:fs";
import path from "node:path";
import { mentionsPerson } from "../generation/scenarioGuard";

export interface SceneHistoryEntry {
  /** ISO timestamp of the capture. */
  time: string;
  captureId: string;
  sceneDescription: string;
  hasPerson: boolean;
  /** Person detector verdict for the frame (null / missing = not available); preferred over the text. */
  detectorPerson?: boolean | null;
  /** Who was in the frame (describe call), for drawing a recent person again. */
  people?: Array<{ position: string; pose: string; clothes: string; facing: string; hair?: string }>;
  /** Same text as sceneDescription (kept separate for the history API / future action log). */
  observation: string;
  /** File name inside the captures dir of the frame this was observed from (reference image for a re-entering person). */
  imageFile?: string;
  /** Downscaled person-frame kept for reference-image use, relative to the ref-frames dir (REF_FRAMES_ENABLED). */
  refFrameFile?: string;
}

export function historyFilePath(): string {
  return path.resolve(process.cwd(), process.env.SCENE_HISTORY_FILE || path.join("logs", "scene-history.jsonl"));
}

export function historyEnabled(): boolean {
  return (process.env.SCENE_HISTORY_ENABLED ?? "true").toLowerCase() !== "false";
}

export function historyLimit(): number {
  const n = Number(process.env.SCENE_HISTORY_LIMIT ?? "8");
  return Number.isFinite(n) && n > 0 ? Math.min(50, Math.floor(n)) : 8;
}

export function historyWindowMin(): number {
  const n = Number(process.env.SCENE_HISTORY_WINDOW_MIN ?? "30");
  return Number.isFinite(n) && n > 0 ? n : 30;
}

export function recentPersonWindowMin(): number {
  const n = Number(process.env.RECENT_PERSON_WINDOW_MIN ?? "10");
  return Number.isFinite(n) && n > 0 ? n : 10;
}

export function appendHistory(entry: SceneHistoryEntry, file = historyFilePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
}

export function readHistory(file = historyFilePath()): SceneHistoryEntry[] {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: SceneHistoryEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e?.time === "string" && typeof e?.sceneDescription === "string") {
        out.push({
          time: e.time,
          captureId: String(e.captureId ?? ""),
          sceneDescription: e.sceneDescription,
          // Recomputed: older lines (and other writers) may have judged negations such as "no people present" wrongly.
          // the detector/describe verdict wins; the text only decides when there is none (old rows, gemini)
          hasPerson: typeof e.detectorPerson === "boolean" ? e.detectorPerson : mentionsPerson(e.sceneDescription),
          detectorPerson: typeof e.detectorPerson === "boolean" ? e.detectorPerson : null,
          people: Array.isArray(e.people) ? e.people : undefined,
          observation: typeof e.observation === "string" ? e.observation : e.sceneDescription,
          imageFile: typeof e.imageFile === "string" ? e.imageFile : undefined,
          refFrameFile: typeof e.refFrameFile === "string" ? e.refFrameFile : undefined,
        });
      }
    } catch {
      /* skip a damaged line */
    }
  }
  return out;
}

/** Newest-last entries within the window (minutes) before `now`, at most `limit`. */
export function recentEntries(
  entries: SceneHistoryEntry[],
  opts: { limit: number; windowMin: number; now?: number }
): SceneHistoryEntry[] {
  const now = opts.now ?? Date.now();
  const since = now - opts.windowMin * 60_000;
  const inWindow = entries.filter((e) => {
    const t = Date.parse(e.time);
    return Number.isFinite(t) && t >= since && t <= now + 60_000;
  });
  return inWindow.slice(-opts.limit);
}

/** The most recent entry with a person within the window, or null. */
export function latestPerson(
  entries: SceneHistoryEntry[],
  windowMin: number,
  now = Date.now()
): { entry: SceneHistoryEntry; minutesAgo: number } | null {
  const since = now - windowMin * 60_000;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const t = Date.parse(entries[i].time);
    if (entries[i].hasPerson && Number.isFinite(t) && t >= since) {
      return { entry: entries[i], minutesAgo: Math.max(0, Math.round((now - t) / 60_000)) };
    }
  }
  return null;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function normalizeObs(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export interface FormattedHistory {
  /** One line per run of identical observations (not yet numbered). */
  lines: string[];
  /** Machine-extracted arrivals/departures summary ("" when there are no entries). */
  people: string;
  /** Numbered lines + people line, exactly as injected into the prompt. */
  text: string;
}

/**
 * Prompt form of the recent entries (oldest first): clock time + "N min ago" per line, consecutive identical
 * observations merged, and an arrived/left summary derived from hasPerson transitions (no VLM involved).
 */
export function formatHistory(entries: SceneHistoryEntry[], now = Date.now()): FormattedHistory {
  const mins = (iso: string) => Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  const lines: string[] = [];
  for (let i = 0; i < entries.length; ) {
    let j = i + 1;
    while (j < entries.length && normalizeObs(entries[j].observation) === normalizeObs(entries[i].observation)) j += 1;
    const first = entries[i];
    const last = entries[j - 1];
    const n = j - i;
    if (n === 1) {
      lines.push(`[${hhmm(first.time)}, ${mins(first.time)} min ago] ${first.observation}`);
    } else {
      const span = Math.max(0, Math.round((Date.parse(last.time) - Date.parse(first.time)) / 60_000));
      lines.push(
        `\u00d7${n} (${hhmm(first.time)}\u2013${hhmm(last.time)}, latest ${mins(last.time)} min ago, no change for ${span} min) ${last.observation}`
      );
    }
    i = j;
  }

  let people = "";
  if (entries.length > 0) {
    const events: string[] = [];
    let prev = entries[0].hasPerson;
    let since = Date.parse(entries[0].time);
    for (let k = 1; k < entries.length; k += 1) {
      const cur = entries[k].hasPerson;
      if (cur !== prev) {
        events.push(`${cur ? "a person arrived" : "left"} at ${hhmm(entries[k].time)}`);
        since = Date.parse(entries[k].time);
        prev = cur;
      }
    }
    const lastHas = entries[entries.length - 1].hasPerson;
    const sinceMin = Math.max(0, Math.round((now - since) / 60_000));
    if (events.length > 0) {
      people =
        "People: " + events.join("; ") + "; " +
        (lastHas ? `present now for ${sinceMin} min` : `the room has been empty for ${sinceMin} min`);
    } else {
      people = lastHas
        ? `People: no one has entered or left in the last ${sinceMin} min; a person is present`
        : `People: the room has been empty for ${sinceMin} min`;
    }
  }

  return {
    lines,
    people,
    text: lines.map((l, i) => `${i + 1}. ${l}`).join("\n") + (people ? "\n" + people : ""),
  };
}

export function historyText(items: Array<{ observation: string }>): string {
  return items.map((e, i) => `${i + 1}. ${e.observation}`).join("\n");
}

/** Moves the jsonl to logs/archive/scene-history_<Tokyo time>.jsonl (never deletes). Returns the new path or null. */
export function resetHistory(file = historyFilePath(), now = new Date()): string | null {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return null;
  const tokyo = new Date(now.getTime() + 9 * 3600_000).toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const dir = path.join(path.dirname(file), "archive");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `scene-history_${tokyo}_JST.jsonl`);
  fs.renameSync(file, dest);
  fs.writeFileSync(file, "", "utf8");
  return dest;
}

export interface LatestPrediction {
  captureId: string;
  observation: string;
  savedAt: string;
  scenarios: Array<{ sceneKey: string; label: string; text: string }>;
}
