/**
 * ~200-character Japanese summary of what has happened in the room so far, shown under NOW on the venue display.
 * Built from the scene history (formatted: times, merged identical lines, arrivals/departures) by a short
 * text-only call to the local Ollama model; a template computed from the history is the fallback.
 * Persisted in logs/history-summary.json so a restart keeps showing the last venue summary.
 */
import fs from "node:fs";
import path from "node:path";
import type { SceneHistoryEntry } from "./sceneHistory";
import {
  changeList,
  compressIntervals,
  extractIntervals,
  presentStateOf,
  presentStateSentence,
  templateSummary,
  type Interval,
  type PresentState,
} from "./changePoints";

export interface HistorySummary {
  /** Text shown on the display: the model's flow of events + the server-computed present-state sentence. */
  summary: string;
  updatedAt: string | null;
  captureId: string | null;
  /** The flow-of-events part alone (no elapsed minutes); the state sentence is recomputed at every send. */
  body?: string;
  /** Start of the present state (last arrival/departure, or the first observation) and whether a person is there. */
  since?: string | null;
  hasPerson?: boolean;
  /** Present state from the change points (count, clothes colours, posture); the closing sentence is built from it at send time. */
  state?: PresentState;
  /** Extracted change points (for verification in the viewer). */
  changePoints?: Interval[];
  /**
   * The last interval in which someone was present, kept even after the history window slid past it (so "who was here before
   * the room emptied" and the time it emptied survive). Cleared by reset-history.
   */
  lastOccupied?: Interval;
}

export const EMPTY_SUMMARY: HistorySummary = { summary: "", updatedAt: null, captureId: null };

export const SUMMARY_MAX_CHARS = 200;

export function summaryFilePath(): string {
  return path.resolve(process.cwd(), process.env.HISTORY_SUMMARY_FILE || path.join("logs", "history-summary.json"));
}

export function loadSummary(file = summaryFilePath()): HistorySummary {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      summary: typeof j.summary === "string" ? j.summary : "",
      updatedAt: typeof j.updatedAt === "string" ? j.updatedAt : null,
      captureId: typeof j.captureId === "string" ? j.captureId : null,
      body: typeof j.body === "string" ? j.body : undefined,
      since: typeof j.since === "string" ? j.since : null,
      hasPerson: typeof j.hasPerson === "boolean" ? j.hasPerson : undefined,
      state: j.state && typeof j.state.since === "string" ? j.state : undefined,
      changePoints: Array.isArray(j.changePoints) ? j.changePoints : undefined,
      lastOccupied: j.lastOccupied && typeof j.lastOccupied.start === "string" ? j.lastOccupied : undefined,
    };
  } catch {
    return { ...EMPTY_SUMMARY };
  }
}

export function saveSummary(s: HistorySummary, file = summaryFilePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s), "utf8");
}

/** reset-history: the summary is emptied together with the history. */
export function clearSummary(file = summaryFilePath()): void {
  saveSummary({ ...EMPTY_SUMMARY }, file);
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Where the present state began: the last arrival/departure (or the first observation) and who is there now. */
export function presentState(entries: SceneHistoryEntry[]): { since: string; hasPerson: boolean } | null {
  if (entries.length === 0) return null;
  let prev = entries[0].hasPerson;
  let since = entries[0].time;
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].hasPerson !== prev) {
      prev = entries[i].hasPerson;
      since = entries[i].time;
    }
  }
  return { since, hasPerson: prev };
}

/** The computed closing sentence, e.g. "11:58から現在まで14分間、無人。" / "12:10から人物が在室（3分）。". */
export function stateSentence(state: { since: string; hasPerson: boolean } | null, now = Date.now()): string {
  if (!state) return "";
  const mins = Math.max(0, Math.round((now - Date.parse(state.since)) / 60_000));
  return state.hasPerson ? `${hhmm(state.since)}から人物が在室（${mins}分）。` : `${hhmm(state.since)}から現在まで${mins}分間、無人。`;
}

/** Removes elapsed-time phrases the model may have invented ("27分間", "10分経過", "約3時間"). */
export function stripDurations(text: string): string {
  return text
    .replace(/[（(]?約?[0-9０-９]+\s*(?:分間|分経過|時間|時間経過)[）)]?/g, "")
    .replace(/(?:、|，|,){2,}/g, "、")
    .replace(/、(?=。)/g, "")
    .replace(/(?:が|を|は|で|に|の|と)(?=。)/g, "")
    .replace(/^[、。\s]+/, "")
    .trim();
}

/** Body + state sentence within `max` characters; the OLDEST sentences of the body are dropped first. */
export function composeWithState(body: string, state: string, max = SUMMARY_MAX_CHARS): string {
  body = body.trim();
  if (body && !/[。.!?]$/.test(body)) body += "。";
  if (!state) return body.slice(-max);
  if (!body) return state.slice(0, max);
  const room = max - state.length;
  if (room <= 0) return state.slice(0, max);
  let b = body;
  while (b.length > room) {
    const cut = b.indexOf("。");
    if (cut < 0 || cut >= b.length - 1) {
      b = b.slice(b.length - room);
      break;
    }
    b = b.slice(cut + 1);
  }
  return `${b}${state}`;
}

/** Display text from a stored summary at time `now` (the elapsed minutes always match the send time). */
export function composeSummary(s: HistorySummary, now = Date.now()): string {
  if (s.state) return composeWithState(s.body ?? "", presentStateSentence(s.state, now));
  if (!s.body && !s.since) return s.summary;
  return composeWithState(s.body ?? "", stateSentence(s.since ? { since: s.since, hasPerson: s.hasPerson === true } : null, now));
}

/** Template flow of events from the change points alone (no model, no elapsed minutes). */
export function fallbackSummary(entries: SceneHistoryEntry[], now = Date.now()): string {
  if (entries.length === 0) return "";
  return templateSummary(compressIntervals(extractIntervals(entries), now));
}

export const SUMMARY_PROMPT_HEAD =
  "以下は部屋の状態の変化点リスト（時刻・人数・服装・姿勢・位置）です。リストの内容だけを、時系列に沿った自然な日本語の文に整えてください。" +
  "各行の服装や姿勢が前の行から変わったときは、その変化（交代した・加わった・立った・座った）を必ず文に書く。" +
  "リストにない事実・動作・推測は絶対に足さない。リストにない時刻は書かない。経過時間や「〜分間」は書かない。120字以内。" +
  '出力は JSON {"summary":"..."} のみ。\n';

export interface SummaryOptions {
  /** The previous venue summary: its lastOccupied / empty-since survive a history window that no longer contains them. */
  prior?: { lastOccupied?: Interval; state?: PresentState } | null;
  /** The whole history (older than the window): used once to recover the last occupancy when nothing was carried over yet. */
  older?: SceneHistoryEntry[];
  ollamaUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** The "summary" value from the model's JSON; a reply cut off by num_predict is salvaged up to its last sentence. */
export function parseSummaryText(raw: string): string | null {
  try {
    const v = JSON.parse(raw)?.summary;
    return typeof v === "string" ? v : null;
  } catch {
    const m = raw.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (!m) return null;
    const partial = m[1].replace(/\\n/g, "").replace(/\\"/g, "");
    const cut = partial.lastIndexOf("。");
    return cut > 10 ? partial.slice(0, cut + 1) : null;
  }
}

/** Actions the list cannot support: the polished text must not contain them (a 4B model likes to embellish). */
const UNSUPPORTED_ACTION_RE = /立ち上が|歩|走|笑|話し|手を|振り|伸び|食べ|飲|読|書い|作業|操作|入力|会話|対面|向かい合/;

/** True when the polished text only uses times and posture words that the change list supports. */
export function isSupportedByList(text: string, lines: string[]): boolean {
  const list = lines.join("。");
  const times = text.match(/[0-9]{1,2}:[0-9]{2}/g) ?? [];
  if (times.some((t) => !list.includes(t))) return false;
  const hit = text.match(UNSUPPORTED_ACTION_RE);
  if (hit) return false;
  if (/起立|立って|立ち/.test(text) && !list.includes("起立")) return false;
  if (/着席|座/.test(text) && !list.includes("着席")) return false;
  return true;
}

export interface SummaryResult {
  summary: string;
  source: "model" | "fallback" | "carry";
  elapsedMs: number;
  changePoints: Interval[];
  state: PresentState | null;
  /** Last interval with someone present (from the window, else carried over from the previous summary). */
  lastOccupied?: Interval;
}

/**
 * Summary of the room so far: change points are extracted mechanically from the observations' people records, the 4B model
 * only polishes that list into Japanese (checked against the list), and the template is used when anything goes wrong.
 */
export async function summarizeHistory(
  entries: SceneHistoryEntry[],
  now = Date.now(),
  opts: SummaryOptions = {}
): Promise<SummaryResult> {
  const started = Date.now();
  const all = extractIntervals(entries, (e) => {
    console.error(`[summary] count disagreement at ${e.time}: detector found nobody, the text names a person; the detector wins`);
  });
  const intervals = compressIntervals(all, now);
  let state = presentStateOf(all);
  const lines = changeList(intervals);
  const windowOccupied = [...all].reverse().find((i) => i.count > 0);
  const lastOccupied = windowOccupied ?? opts.prior?.lastOccupied;
  const fallback = (): SummaryResult => ({ summary: templateSummary(intervals), source: "fallback", elapsedMs: Date.now() - started, changePoints: all, state, lastOccupied });
  if (entries.length === 0) return { summary: "", source: "fallback", elapsedMs: 0, changePoints: [], state: null, lastOccupied };
  // The window holds nobody: the story before the room emptied comes from the carried-over interval, the "empty since" time
  // from the previous state (the window start would only be a lower bound).
  if (!windowOccupied) {
    if (!opts.prior?.lastOccupied && opts.older && opts.older.length > 0) {
      const oldIv = extractIntervals(opts.older);
      const idx = oldIv.map((i) => i.count > 0).lastIndexOf(true);
      if (idx >= 0) {
        // recovered from the full history: the room emptied at the first empty interval after it
        const emptied = oldIv[idx + 1];
        return {
          summary: templateSummary([oldIv[idx]]),
          source: "carry",
          elapsedMs: Date.now() - started,
          changePoints: all,
          state: emptied ? { since: emptied.start, count: 0, clothes: [], labels: [], posture: "unknown" } : state,
          lastOccupied: oldIv[idx],
        };
      }
    }
    if (state && state.count === 0 && opts.prior?.state && opts.prior.state.count === 0 && Date.parse(opts.prior.state.since) < Date.parse(state.since)) {
      state = { ...state, since: opts.prior.state.since };
    }
    const body = lastOccupied ? templateSummary([lastOccupied]) : "";
    return { summary: body, source: "carry", elapsedMs: Date.now() - started, changePoints: all, state, lastOccupied };
  }
  const record = lines.map((l) => `- ${l}`).join("\n");
  const url = (opts.ollamaUrl ?? process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model ?? process.env.VLM_MODEL ?? "gemma3:latest",
        prompt: SUMMARY_PROMPT_HEAD + record,
        stream: false,
        think: false,
        format: "json",
        keep_alive: process.env.OLLAMA_KEEP_ALIVE ?? "0",
        options: { temperature: 0.1, num_predict: 256, num_ctx: 4096 },
      }),
      signal: opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 45_000)])
        : AbortSignal.timeout(opts.timeoutMs ?? 45_000),
    });
    if (!res.ok) return fallback();
    const raw = ((await res.json()) as { response?: string }).response ?? "{}";
    const text = parseSummaryText(raw);
    if (typeof text !== "string" || text.trim().length < 10) return fallback();
    const cleaned = stripDurations(text.trim());
    if (cleaned.length < 10) return fallback();
    if (!isSupportedByList(cleaned, lines)) {
      console.error(`[summary] model text rejected (not supported by the change list): ${cleaned.slice(0, 80)}`);
      return fallback();
    }
    return { summary: cleaned.slice(0, 400), source: "model", elapsedMs: Date.now() - started, changePoints: all, state };
  } catch (err) {
    console.error(`[summary] model call failed: ${(err as Error).message}`);
    return fallback();
  }
}
