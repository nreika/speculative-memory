/**
 * G-26 (2026-10-20): the past scene (negative distance, normally C) shows the room as it plausibly WAS before the
 * captured frame. The frame is the END state. Pure text helpers, no model call:
 * - pastScenePrediction: English edit text without a "..., now ..." present-result clause or a "then/will" tail.
 * - pastJapaneseText: Japanese display text without 今では/現在/今は clauses, ending in the past tense.
 * - pastMomentLead / pastMainChangeLine: the image-edit lines that frame the edit as the EARLIER moment.
 * - buildStateLedger / judgePastContinuity / stateLedgerNote: compact STATE LEDGER from history (ongoing -> earlier moment
 *   of the same activity; NEW within 2x span -> reversal; unclear -> smallest coherent difference; futures continue).
 */
import type { PersonInfo } from "./peopleDescribe";
import { spanPhrase } from "./peopleDescribe";
import { mainActionSentence } from "./mainChange";

export const isPastDistance = (distanceSec: number | undefined | null): boolean =>
  typeof distanceSec === "number" && Number.isFinite(distanceSec) && distanceSec < 0;

/** "30 seconds" / "2 minutes 30 seconds" for a signed distance. */
export const spanWords = (distanceSec: number): string => spanPhrase(distanceSec).replace(/\s+(?:later|before),$/, "");

// A clause that turns the sentence into a change ending in the present ("..., now they have lowered ...").
const NOW_CLAUSE =
  /(?:\s*[,;:]\s*|\s+)(?:(?:but|and|while|whereas)\s+)?(?:now|currently|at present|by now|at this moment|at the moment|right now)\b[\s,]*/i;
const THEN_CLAUSE = /(?:\s*[,;]\s*|\s+)(?:and\s+)?(?:then|afterwards|after that|later|eventually|soon)\b[\s,]*|\s+(?:will|is going to|are going to)\s+/i;
const ORIGIN_WORDS = /\b(?:originally|initially|at first|at the start)\s*,?\s*/gi;

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** "was holding" -> "is holding" (the image edit is a present-tense state of the earlier moment). */
function presentState(s: string): string {
  return s.replace(/\b(was|were)\s+(still\s+)?(\w+ing)\b/gi, (_m, be: string, still: string | undefined, v: string) =>
    `${/^were$/i.test(be) ? "are" : "is"} ${still ?? ""}${v}`);
}

/**
 * English past-scene edit text: keeps the EARLIER state. "X was originally A, now B" -> "X is A." (B is the frame);
 * "A, then B" -> "A.". Returns the input unchanged when there is nothing to rewrite or too little would remain.
 */
export function pastScenePrediction(text: string): string {
  const src = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!src) return src;
  let head = src;
  const now = head.match(NOW_CLAUSE);
  if (now && now.index !== undefined && now.index > 0) head = head.slice(0, now.index);
  const then = head.match(THEN_CLAUSE);
  if (then && then.index !== undefined && then.index > 0) head = head.slice(0, then.index);
  if (head === src && !ORIGIN_WORDS.test(src)) return src;
  ORIGIN_WORDS.lastIndex = 0;
  head = presentState(head.replace(ORIGIN_WORDS, "")).replace(/\s*\b(?:but|and|while)\s*$/i, "").replace(/[\s,;:]+$/, "").trim();
  if (head.split(/\s+/).length < 3) return src;
  return capitalize(head.replace(/\.+$/, "")) + ".";
}

/** True when an English past-scene text still reads as a change ending in the present / the future. */
export function hasPresentResultPhrase(text: string): boolean {
  return NOW_CLAUSE.test(String(text ?? "")) || /\b(?:will|is going to|are going to)\b/i.test(String(text ?? ""));
}

// Japanese: a clause that switches to the present ("…ていたが、今では…") or the future.
const JA_NOW_CLAUSE = /(?:が|けど|けれど|けれども|ものの)?[、,，]?\s*(?:そして)?(?:今では|今は|今や|いまでは|いまは|現在では|現在は|現在|今、|この後|これから)/;
const JA_ORIGIN = /(?:元々|もともと|最初は|当初は|はじめは|初めは)[、,]?/g;
const JA_FUTURE_END = /(?:する|になる)?(?:だろう|でしょう|予定だ|予定です|つもりだ)(?=。|$)/;
const ICHIDAN_SINGLE = new Set(["見", "居", "寝", "出", "着", "似", "煮", "射", "得", "経", "来"]);
const E_I_ROW = /[えけげせぜてでねへべぺめれいきぎしじちぢにひびぴみり]/;
const GODAN_TE: Record<string, string> = { う: "って", つ: "って", る: "って", む: "んで", ぶ: "んで", ぬ: "んで", く: "いて", ぐ: "いで", す: "して" };

/** Final verb of a clause in the past (…ていた); unknown endings are left as they are. */
function pastEnding(body: string): string {
  if (/(?:た|だ|でした|ました|かった)$/.test(body)) return body;
  if (/(?:て|で)います$/.test(body)) return body.replace(/います$/, "いました");
  if (/(?:て|で)いる$/.test(body)) return body.replace(/いる$/, "いた");
  if (/します$/.test(body)) return body.replace(/します$/, "していました");
  if (/する$/.test(body)) return body.replace(/する$/, "していた");
  if (/(?:^|[^て])いる$/.test(body)) return body.replace(/いる$/, "いた");
  if (/ある$/.test(body)) return body.replace(/ある$/, "あった");
  if (/くる$|来る$/.test(body)) return body.replace(/(?:くる|来る)$/, (m) => (m === "来る" ? "来ていた" : "きていた"));
  if (/(?:ない)$/.test(body)) return body.replace(/ない$/, "なかった");
  if (/(?:だ|である)$/.test(body)) return body.replace(/(?:だ|である)$/, "だった");
  const last = body.slice(-1);
  const prev = body.slice(-2, -1);
  if (last === "る") {
    // ichidan: e/i-row kana before る (向ける, 起きる) or a one-kanji ichidan verb (見る, 寝る); else godan (握る, 座る, まわる).
    if (E_I_ROW.test(prev) || ICHIDAN_SINGLE.has(prev)) return body.slice(0, -1) + "ていた";
    return body.slice(0, -1) + "っていた";
  }
  if (GODAN_TE[last] && /[一-鿿぀-ゟ]/.test(prev)) return body.slice(0, -1) + GODAN_TE[last] + "いた";
  return body;
}

/**
 * Japanese past-scene display text: 「30秒前、人物は元々…握っていたが、今では…ている。」 -> 「30秒前、人物は…握っていた。」;
 * the final verb goes to the past tense (…観察する。 -> …観察していた。). Untranslated English is returned unchanged.
 */
export function pastJapaneseText(text: string): string {
  const src = String(text ?? "").trim();
  if (!/[぀-ヿ一-鿿]/.test(src)) return src;
  const span = src.match(/^((?:約)?(?:[0-9０-９]+\s*(?:時間|分|秒))+\s*前[、,，]?)/)?.[1] ?? "";
  let body = src.slice(span.length).trim();
  const m = body.match(JA_NOW_CLAUSE);
  if (m && m.index !== undefined && m.index > 2) body = body.slice(0, m.index);
  body = body.replace(JA_ORIGIN, "").replace(JA_FUTURE_END, "").replace(/[。.、,，\s]+$/, "");
  if (!body) return src;
  return `${span}${pastEnding(body)}。`;
}

/** True when a Japanese past-scene display text still contains a present/future marker. */
export function hasJapanesePresentMarker(text: string): boolean {
  return /今では|今は|今や|いまでは|現在|これから|だろう|でしょう/.test(String(text ?? ""));
}

/**
 * Image-edit lead for a past scene (people present or not). `emptyRoom` uses object-only wording (no person words).
 * `continuity` ongoing: the activity was already going on, so the edit steps it back instead of undoing it.
 */
export function pastMomentLead(distanceSec: number, emptyRoom = false, continuity?: PastContinuityVerdict): string {
  const span = spanWords(distanceSec);
  const undo = continuity === "ongoing"
    ? "show the same ongoing activity one small step earlier (a slightly different pose or progress of the same action) rather than adding a new action or undoing the activity"
    : emptyRoom
      ? "undo the most recent small object change rather than adding a new one"
      : "undo the most recent small action rather than adding a new one";
  const keep = emptyRoom
    ? "Keep the framing, camera, lighting and every object's identity and count exactly as in the photo."
    : "Keep the same people count, identities, clothes, hair, belongings, framing, camera and lighting as in the photo.";
  return `This image is the moment ${span} BEFORE this photo; the photo shows what happened next. Render that earlier moment: ${undo}. ${keep}\n\n`;
}

/** "Main difference from the photo (this is the EARLIER moment): …" or "" when there is no action. */
export function pastMainChangeLine(prediction: string): string {
  const sentence = mainActionSentence(prediction);
  if (!sentence || /^(?:keep|preserve) the scene\b|^nothing changes\b/i.test(sentence)) return "";
  return `\n\nMain difference from the photo (this is the EARLIER moment): ${sentence}`;
}

export type PastContinuityVerdict = "ongoing" | "new" | "unknown";
export interface PastContinuity {
  verdict: PastContinuityVerdict;
  reason: string;
  /** Ledger key the decision was about ("object:cup", "posture:seated", "person"). */
  key?: string;
  /** Minutes the current state has been observed before this frame (ongoing only). */
  sinceMin?: number;
}

/** One history row (live scene-history entry or a replayed test observation mapped to this shape). */
export interface PastHistoryRow {
  time: string;
  hasPerson?: boolean;
  detectorPerson?: boolean | null;
  observation?: string;
  sceneDescription?: string;
  people?: Array<{ pose?: string; clothes?: string; position?: string }>;
}

/**
 * One observed state of the compact STATE LEDGER (G-26, best effort): "person", "posture:seated", "object:cup".
 * firstSeen = start of the latest continuous run of rows that show it (this frame included when seenNow);
 * lastAbsent = the newest row before that run that did not show it (null = never seen without it in the history).
 */
export interface LedgerState {
  key: string;
  label: string;
  firstSeen: string;
  lastSeen: string;
  durationMin: number;
  seenNow: boolean;
  lastAbsent: string | null;
}
export interface StateLedger {
  now: string;
  /** History rows within the ledger window (this frame not counted). */
  rows: number;
  states: LedgerState[];
}

/** Reversal (unopened / in the bag / cup on the desk) only when the state began within this many past spans. */
export const REVERSAL_SPAN_FACTOR = 2;
const LEDGER_WINDOW_MIN = 30;

const postureOf = (text: string | undefined): "seated" | "standing" | "" =>
  /\b(?:sit|sits|sitting|seated)\b/i.test(text ?? "") ? "seated" : /\b(?:stand|stands|standing)\b/i.test(text ?? "") ? "standing" : "";

// Everyday objects the ledger tracks (eating / drinking / carrying / working); singular nouns.
const LEDGER_OBJECTS = [
  "cup", "mug", "glass", "bottle", "can", "container", "lid", "bowl", "plate", "tray", "box", "food", "snack", "sandwich", "onigiri",
  "rice ball", "bread", "chopsticks", "fork", "spoon", "paper bag", "shopping bag", "bag", "backpack", "phone", "smartphone", "laptop",
  "book", "notebook", "papers", "paper", "document", "pen", "tablet", "headphones", "umbrella", "jacket", "coat",
];
const OBJECT_RE = new RegExp(`\\b(${[...LEDGER_OBJECTS].sort((a, b) => b.length - a.length).map((w) => w.replace(/ /g, "\\s+")).join("|")})(?:e?s)?\\b`, "gi");
const canonObject = (w: string) => {
  const o = w.toLowerCase().replace(/\s+/g, " ");
  return ({ "paper bag": "bag", "shopping bag": "bag", papers: "paper", smartphone: "phone", mug: "cup", "rice ball": "onigiri" } as Record<string, string>)[o] ?? o;
};

const rowText = (r: PastHistoryRow) => `${r.observation ?? ""} ${r.sceneDescription ?? ""} ${(r.people ?? []).map((p) => p.pose ?? "").join(" ")}`;
const rowHasPerson = (r: PastHistoryRow) => r.hasPerson === true || r.detectorPerson === true || (r.people?.length ?? 0) > 0;

function statesOfText(text: string, person: boolean, pose?: string): Map<string, string> {
  const out = new Map<string, string>();
  if (person) out.set("person", "a person present");
  const posture = postureOf(pose) || (person ? postureOf(text) : "");
  if (posture) out.set(`posture:${posture}`, `a person ${posture}`);
  for (const m of text.matchAll(OBJECT_RE)) { const o = canonObject(m[1]); out.set(`object:${o}`, o); }
  return out;
}

/** States of this frame from the describe step (people + held objects + the frame description). */
export function currentStates(people: PersonInfo[], sceneNow = ""): Map<string, string> {
  const text = `${sceneNow} ${people.map((x) => `${x.holding ?? ""} ${x.pose ?? ""}`).join(" ")}`;
  return statesOfText(text, people.length > 0, people[0]?.pose);
}

/**
 * Compact STATE LEDGER from the history rows and this frame. Pure; no model call.
 * A row that does not name a state counts as "not seen" (best effort: the observation text may simply omit it).
 */
export function buildStateLedger(args: { history: PastHistoryRow[]; people: PersonInfo[]; sceneNow?: string; now?: number }): StateLedger {
  const now = args.now ?? Date.now();
  const rows = args.history
    .filter((r) => { const t = Date.parse(r.time); return Number.isFinite(t) && t < now && t >= now - LEDGER_WINDOW_MIN * 60_000; })
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const frames = [
    ...rows.map((r) => ({ t: Date.parse(r.time), states: statesOfText(rowText(r), rowHasPerson(r), r.people?.[0]?.pose) })),
    { t: now, states: currentStates(args.people, args.sceneNow) },
  ];
  const keys = new Map<string, string>();
  frames.forEach((f) => f.states.forEach((label, key) => keys.set(key, label)));
  const iso = (t: number) => new Date(t).toISOString();
  const states: LedgerState[] = [];
  for (const [key, label] of keys) {
    let last = -1;
    for (let i = frames.length - 1; i >= 0; i -= 1) if (frames[i].states.has(key)) { last = i; break; }
    let first = last;
    while (first > 0 && frames[first - 1].states.has(key)) first -= 1;
    states.push({
      key, label, firstSeen: iso(frames[first].t), lastSeen: iso(frames[last].t),
      durationMin: Math.max(0, Math.round((frames[last].t - frames[first].t) / 60_000)),
      seenNow: last === frames.length - 1,
      lastAbsent: first > 0 ? iso(frames[first - 1].t) : null,
    });
  }
  return { now: iso(now), rows: rows.length, states };
}

const hhmm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/** Prompt lines of the ledger ("" when it is empty). */
export function formatStateLedger(l: StateLedger): string {
  if (l.states.length === 0) return "";
  const lines = l.states.map((s) => `- ${s.label}: ${s.seenNow
    ? `seen now; this run since ${hhmm(s.firstSeen)} (${s.durationMin} min)${s.lastAbsent ? `, not seen at ${hhmm(s.lastAbsent)}` : l.rows ? ", in every history row" : ""}`
    : `not seen now; last seen ${hhmm(s.lastSeen)}`}`);
  return `STATE LEDGER (server-built from HISTORY, ${l.rows} rows; best effort, the observations may omit things):\n${lines.join("\n")}`;
}

/**
 * Ongoing vs new for the past scene, from the ledger. Focus = the held object, else the posture, else presence.
 * - new (reversal allowed): the focus state was NOT seen in a history row within REVERSAL_SPAN_FACTOR x |span| before now;
 * - ongoing: the focus state was already seen in history rows before this frame;
 * - unknown (no history / ambiguous): the past scene takes the SMALLEST coherent difference, never a bold reversal.
 */
export function judgePastContinuity(args: { ledger: StateLedger; people: PersonInfo[]; spanSec: number }): PastContinuity {
  const now = Date.parse(args.ledger.now);
  const person = args.people[0];
  if (!person) return { verdict: "unknown", reason: "no person in this frame" };
  if (args.ledger.rows === 0) return { verdict: "unknown", reason: "no history rows" };
  const held = person.holding ? [...currentStates([person]).keys()].find((k) => k.startsWith("object:")) : undefined;
  const posture = postureOf(person.pose);
  const key = held ?? (posture ? `posture:${posture}` : "person");
  const s = args.ledger.states.find((x) => x.key === key);
  if (!s || !s.seenNow) return { verdict: "unknown", reason: `${key} not in the ledger`, key };
  const reversalSince = now - REVERSAL_SPAN_FACTOR * Math.abs(args.spanSec) * 1000;
  if (s.lastAbsent && Date.parse(s.lastAbsent) >= reversalSince) {
    return { verdict: "new", reason: `${s.label} was not seen at ${hhmm(s.lastAbsent)}, within ${REVERSAL_SPAN_FACTOR}x the span`, key };
  }
  if (Date.parse(s.firstSeen) < now) {
    return { verdict: "ongoing", reason: `${s.label} already seen since ${hhmm(s.firstSeen)}`, key, sinceMin: Math.max(0, Math.round((now - Date.parse(s.firstSeen)) / 60_000)) };
  }
  return { verdict: "unknown", reason: `${s.label} first seen in this frame, but the previous row is older than ${REVERSAL_SPAN_FACTOR}x the span`, key };
}

/**
 * Planner note: the ledger, the future-continuity line and (with a past scene) the past verdict.
 * "" when there is neither a ledger nor a past scene.
 */
export function stateLedgerNote(args: { ledger: StateLedger; continuity?: PastContinuity; pastSpanSec?: number }): string {
  const parts: string[] = [];
  const ledger = args.ledger.rows > 0 ? formatStateLedger(args.ledger) : "";
  if (ledger) {
    parts.push(ledger);
    parts.push("FUTURE CONTINUITY: scenarios AFTER this frame continue the activities the ledger shows as ongoing (the next moment of the same activity); they do not restart them.");
  }
  if (args.continuity && args.pastSpanSec !== undefined) {
    const c = args.continuity;
    const span = spanWords(args.pastSpanSec);
    const what = c.key ? c.key.replace(/^object:/, "holding the ").replace(/^posture:/, "being ").replace(/^person$/, "being in the room") : "the current activity";
    parts.push(c.verdict === "ongoing"
      ? `PAST CONTINUITY (server check): ${what} was already going on ${c.sinceMin ?? 0} min before this frame, longer than ${span}. In every scenario BEFORE this frame the SAME activity was already going on: show a slightly earlier moment of it (one step earlier in the same action, a small difference of pose or progress), never the unopened, closed, packed-away or absent state.`
      : c.verdict === "new"
        ? `PAST CONTINUITY (server check): ${what} is NEW (${c.reason}). In every scenario BEFORE this frame reverse that most recent change (e.g. the item not yet in hand: still on the desk, still unopened or still in its bag).`
        : `PAST CONTINUITY (server check): unclear (${c.reason}). In every scenario BEFORE this frame use the SMALLEST coherent difference: a slightly earlier moment of the same state, never a bold reversal.`);
  }
  return parts.join("\n");
}
