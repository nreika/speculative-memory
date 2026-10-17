/**
 * Mechanical change points of the room, extracted from the scene history (observations' people records only).
 * Nothing here comes from extras or generated scenario text. The 4B model only polishes the resulting list; the closing
 * "present state" sentence is built by the server.
 *
 * Rules: head count comes from the detector's people record first (the text when there is no record, and also when the detector says nobody but the text names a person); unknown clothes/posture inherit
 * the previous interval when the count is the same; a change must last 2 observations (a single odd observation is absorbed),
 * except entering/leaving (0 <-> 1+), which counts at once.
 */
import type { SceneHistoryEntry } from "./sceneHistory";

export type Posture = "seated" | "standing" | "unknown" | "mixed";

export interface Interval {
  /** ISO time of the first / last observation of this state. */
  start: string;
  end: string;
  count: number;
  /** Dominant clothes colours (normalised words), sorted: this is the key. */
  clothes: string[];
  /** Japanese labels for display ("白シャツ", "ストライプ黒シャツ", "青トップス"), same order as `clothes`. */
  labels: string[];
  posture: Posture;
  /** Japanese place of the first person ("左手前", "中央奥"), display only (not part of the key). */
  place: string;
}

const COLORS = ["teal", "blue", "black", "white", "red", "green", "gray", "grey", "beige", "brown", "pink", "yellow", "orange", "navy", "purple", "dark", "light"];
export const COLOR_JA: Record<string, string> = {
  teal: "青緑", blue: "青", black: "黒", white: "白", red: "赤", green: "緑", gray: "グレー", grey: "グレー", beige: "ベージュ",
  brown: "茶", pink: "ピンク", yellow: "黄", orange: "オレンジ", navy: "紺", purple: "紫", dark: "暗色", light: "明色",
};
const GARMENT_JA: Record<string, string> = {
  shirt: "シャツ", "t-shirt": "Tシャツ", tshirt: "Tシャツ", sweatshirt: "スウェット", sweater: "セーター", hoodie: "パーカー",
  jacket: "ジャケット", top: "トップス", blouse: "ブラウス", coat: "コート", dress: "ワンピース", cap: "キャップ", hat: "帽子", uniform: "制服",
};

function colorOf(clothes: string): string {
  const words = String(clothes ?? "").toLowerCase().split(/[^a-z-]+/).filter(Boolean);
  const hit = words.find((w) => COLORS.includes(w));
  return hit === "grey" ? "gray" : hit ?? "";
}

/** "white shirt" -> "白シャツ", "striped black shirt" -> "ストライプ黒シャツ", "blue top" -> "青トップス". */
export function clothesLabelJa(clothes: string): string {
  const words = String(clothes ?? "").toLowerCase().split(/[^a-z-]+/).filter(Boolean);
  const color = words.find((w) => COLORS.includes(w));
  const garment = words.find((w) => GARMENT_JA[w]);
  const pattern = words.includes("striped") ? "ストライプ" : words.includes("checkered") || words.includes("plaid") ? "チェック" : "";
  if (!color && !garment && !pattern) return "";
  return `${pattern}${color ? COLOR_JA[color] ?? color : ""}${garment ? GARMENT_JA[garment] : "服"}`;
}

function postureOf(pose: string): "seated" | "standing" | "unknown" {
  const t = String(pose ?? "").toLowerCase();
  if (/\b(sit|sits|sitting|seated|seat)\b/.test(t)) return "seated";
  if (/\b(stand|stands|standing)\b/.test(t)) return "standing";
  return "unknown";
}

/** "left front" -> "左手前", "center background" -> "中央奥". */
export function placeJa(position: string): string {
  const t = String(position ?? "").toLowerCase();
  const col = /\bleft\b/.test(t) ? "左" : /\bright\b/.test(t) ? "右" : /\b(center|centre|middle)\b/.test(t) ? "中央" : "";
  const row = /\b(front|foreground|near)\b/.test(t) ? "手前" : /\b(back|background|behind|far)\b/.test(t) ? "奥" : "";
  return `${col}${row}`;
}

interface ObsState {
  count: number;
  clothes: string[];
  labels: string[];
  posture: Posture;
  place: string;
  /** The text said a person is there although the detector found nobody. */
  disagree: boolean;
}

/** Normalised state of one observation. Count: the detector's people record first, the detector's verdict, then the text. */
export function entryState(e: SceneHistoryEntry): ObsState {
  const people = Array.isArray(e.people) ? e.people : [];
  let count = people.length;
  let disagree = false;
  if (count === 0) {
    if (e.detectorPerson === true) count = 1;
    else if (e.detectorPerson === false) {
      // The detector/describe call found nobody: that wins over a person named only in the text.
      count = 0;
      disagree = e.hasPerson;
    } else count = e.hasPerson ? 1 : 0;
  }
  if (count === 0) return { count: 0, clothes: [], labels: [], posture: "unknown", place: "", disagree };
  const byColor = new Map<string, string>();
  for (const p of people) {
    const c = colorOf(p.clothes);
    if (c && !byColor.has(c)) byColor.set(c, clothesLabelJa(p.clothes));
  }
  const clothes = Array.from(byColor.keys()).sort();
  const labels = clothes.map((c) => byColor.get(c) || "");
  const postures = Array.from(new Set(people.map((p) => postureOf(p.pose))));
  const posture: Posture = postures.length === 0 ? "unknown" : postures.length === 1 ? postures[0] : postures.includes("unknown") ? "unknown" : "mixed";
  return { count, clothes, labels, posture, place: placeJa(people[0]?.position ?? ""), disagree };
}

type Core = { count: number; clothes: string[]; labels: string[]; posture: Posture; place: string };
const keyOf = (s: Core) => `${s.count}|${s.clothes.join(",")}|${s.posture}`;

/**
 * Consecutive observations with the same state become one interval.
 * Unknown clothes/posture inherit from the previous state when the head count is the same; a change must hold for two
 * observations (or be an entry/exit) to start a new interval.
 */
export function extractIntervals(entries: SceneHistoryEntry[], onDisagree?: (e: SceneHistoryEntry) => void): Interval[] {
  // 1) per-observation states with inheritance of unknown details
  const states: Core[] = [];
  let prev: Core | null = null;
  for (const e of entries) {
    const o = entryState(e);
    if (o.disagree) onDisagree?.(e);
    let st: Core = { count: o.count, clothes: o.clothes, labels: o.labels, posture: o.posture, place: o.place };
    if (prev && prev.count === st.count && st.count > 0) {
      if (st.clothes.length === 0) st = { ...st, clothes: prev.clothes, labels: prev.labels };
      if (st.posture === "unknown") st = { ...st, posture: prev.posture };
      if (!st.place) st = { ...st, place: prev.place };
    }
    states.push(st);
    prev = st;
  }
  // 2) adopt a change only when it lasts 2 observations, or when someone enters / leaves
  const out: Interval[] = [];
  let adopted: Core | null = null;
  for (let i = 0; i < states.length; i += 1) {
    let st = states[i];
    if (adopted && keyOf(st) !== keyOf(adopted)) {
      const presenceChange = adopted.count > 0 !== st.count > 0;
      const nextSame = i + 1 < states.length && keyOf(states[i + 1]) === keyOf(st);
      if (!presenceChange && !nextSame) st = adopted; // a single odd observation is absorbed into the previous interval
    }
    if (out.length > 0 && adopted && keyOf(st) === keyOf(adopted)) {
      out[out.length - 1].end = entries[i].time;
    } else {
      out.push({ start: entries[i].time, end: entries[i].time, count: st.count, clothes: st.clothes, labels: st.labels, posture: st.posture, place: st.place });
      adopted = st;
    }
  }
  return out;
}

function tierOf(ageMin: number): "full" | "presence" | "count" {
  return ageMin <= 30 ? "full" : ageMin <= 60 ? "presence" : "count";
}

/**
 * Older intervals are compressed: last 30 min everything; 30-60 min only presence (in / out); older than 60 min only the head count.
 */
export function compressIntervals(intervals: Interval[], now = Date.now()): Interval[] {
  const age = (iso: string) => (now - Date.parse(iso)) / 60_000;
  const merge = (a: Interval, b: Interval, byPresence: boolean): Interval => ({
    start: a.start,
    end: b.end,
    count: byPresence ? Math.max(a.count, b.count) : a.count,
    clothes: [],
    labels: [],
    posture: "unknown",
    place: "",
  });
  const out: Interval[] = [];
  for (const iv of intervals) {
    const mode = tierOf(age(iv.end));
    const cur: Interval = mode === "full" ? iv : { ...iv, clothes: [], labels: [], posture: "unknown", place: "" };
    const prev = out[out.length - 1];
    const sameBucket =
      prev && mode !== "full" &&
      tierOf(age(prev.end)) === mode &&
      (mode === "presence" ? prev.count > 0 === cur.count > 0 : prev.count === cur.count);
    if (sameBucket) out[out.length - 1] = merge(prev, cur, mode === "presence");
    else out.push(cur);
  }
  return out;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const POSTURE_JA: Record<Posture, string> = { seated: "着席", standing: "起立", unknown: "在室", mixed: "着席・起立が混在" };

function whoJa(labels: string[], colors: string[]): string {
  const l = labels.filter(Boolean);
  if (l.length > 0) return `${l.join("・")}の`;
  return colors.length > 0 ? `${colors.map((c) => COLOR_JA[c] ?? c).join("・")}系の服の` : "";
}

/** One interval as a plain Japanese line (time, count, clothes, posture, place; nothing else). */
export function intervalJa(iv: Interval): string {
  const t = iv.start === iv.end || hhmm(iv.start) === hhmm(iv.end) ? hhmm(iv.start) : `${hhmm(iv.start)}〜${hhmm(iv.end)}`;
  if (iv.count === 0) return `${t}、無人`;
  return `${t}、${whoJa(iv.labels, iv.clothes)}人物${iv.count}人、${POSTURE_JA[iv.posture]}${iv.place ? `、${iv.place}` : ""}`;
}

/** The list handed to the model, and the template summary built from the same lines. */
export function changeList(intervals: Interval[]): string[] {
  return intervals.map(intervalJa);
}

export function templateSummary(intervals: Interval[], max = 150): string {
  const lines = changeList(intervals);
  let text = lines.map((l) => `${l}。`).join("");
  // the newest information matters most: drop the oldest lines first
  while (text.length > max && lines.length > 1) {
    lines.shift();
    text = lines.map((l) => `${l}。`).join("");
  }
  return text.slice(-max);
}

export interface PresentState {
  since: string;
  count: number;
  clothes: string[];
  labels?: string[];
  posture: Posture;
}

export function presentStateOf(intervals: Interval[]): PresentState | null {
  const last = intervals[intervals.length - 1];
  return last ? { since: last.start, count: last.count, clothes: last.clothes, labels: last.labels, posture: last.posture } : null;
}

/** Closing sentence computed at send time: "19:11以降、黒シャツの人物が1人で着席している（36分）。" / "…から現在まで14分間、無人。" */
export function presentStateSentence(st: PresentState | null, now = Date.now()): string {
  if (!st) return "";
  const mins = Math.max(0, Math.round((now - Date.parse(st.since)) / 60_000));
  if (st.count === 0) return `${hhmm(st.since)}から現在まで${mins}分間、無人。`;
  const tail = st.posture === "seated" ? "着席している" : st.posture === "standing" ? "起立している" : st.posture === "mixed" ? "着席・起立が混在している" : "在室している";
  return `${hhmm(st.since)}以降、${whoJa(st.labels ?? [], st.clothes)}人物が${st.count}人で${tail}（${mins}分）。`;
}
