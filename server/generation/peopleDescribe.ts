/**
 * People facts for the planner: a short image call that describes the visible people (used when the person
 * detector said someone is there), the "GROUND TRUTH" note injected at the top of the planning prompt, and the
 * server-side synthesis used when the 4B planner still answers "empty room / No change".
 */
import type { ScenarioResult } from "../../services/promptBuilder";

export interface PersonInfo {
  position: string;
  pose: string;
  clothes: string;
  facing: string;
  /** Hair (colour, length, style), when the describe call gave it. */
  hair?: string;
}

const DATA_URL_PATTERN = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/;

export const DESCRIBE_PROMPT =
  'Describe every visible person in this photo as JSON {"people":[{"position":"left front","pose":"seated in a mesh chair, facing away",' +
  '(position = horizontal third of the image: left, center or right; plus front or background) ' +
  '"clothes":"grey striped shirt","hair":"long straight black hair with pink tips","facing":"away|camera|left|right"}]}. (hair = colour, length and style, including coloured tips) Keep it factual: at most 4 words per field, one short entry per person. ' +
  'Count every person, including people cut off by the frame edge, in side profile, seen from behind or only partly visible. ' +
  'If no human is visible at all (mannequins, posters and screens do not count), return {"people":[]}. ' +
  'Also add two top-level fields: "obstructed" (true ONLY when an inanimate object right in front of the lens, such as a chair back, cloth or wall, covers about half or more of the frame so the room cannot be seen; a person standing or sitting near the camera is NOT an obstruction, and neither is a normal view of the room: then false) and "obstructedBy" (at most 4 English words naming the blocking object, "" when not obstructed).';

export interface Obstruction {
  obstructed: boolean;
  obstructedBy: string;
}

function parseJsonLoose(raw: unknown): any {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

/** Camera-obstruction verdict of the describe reply; null when the model did not give a boolean. */
export function parseObstruction(raw: unknown): Obstruction | null {
  const parsed = parseJsonLoose(raw);
  const o = parsed?.obstructed;
  const flag = typeof o === "boolean" ? o : o === "true" ? true : o === "false" ? false : null;
  if (flag === null) return null;
  const by = String(parsed?.obstructedBy ?? "").trim().slice(0, 60);
  return { obstructed: flag, obstructedBy: flag ? by : "" };
}

export function parsePeople(raw: unknown): PersonInfo[] {
  if (typeof raw !== "string") return [];
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }
  const list = Array.isArray(parsed?.people) ? parsed.people : Array.isArray(parsed) ? parsed : [];
  return list
    .filter((p: any) => p && typeof p === "object")
    .slice(0, 4)
    .map((p: any) => ({
      position: String(p.position ?? "").trim().slice(0, 60),
      pose: String(p.pose ?? "").trim().slice(0, 100),
      clothes: String(p.clothes ?? "").trim().slice(0, 80),
      facing: String(p.facing ?? "").trim().slice(0, 30),
      hair: String(p.hair ?? "").trim().slice(0, 60),
    }))
    .filter((p: PersonInfo) => p.position || p.pose || p.clothes);
}

/** One short call with the image (format json, num_predict 160). [] on any failure. */
export async function describePeople(
  imageDataUrl: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<{ people: PersonInfo[]; elapsedMs: number; ok: boolean; doneReason?: string; rawHead?: string; obstructed?: boolean; obstructedBy?: string }> {
  const started = Date.now();
  const url = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
  const match = imageDataUrl.match(DATA_URL_PATTERN);
  if (!match) return { people: [], elapsedMs: 0, ok: false };
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.VLM_MODEL || "gemma3:latest",
        prompt: DESCRIBE_PROMPT,
        images: [match[1]],
        stream: false,
        think: false,
        format: "json",
        keep_alive: process.env.VLM_PHASE_KEEP_ALIVE ?? "2m",
        options: { temperature: 0, num_predict: 512, num_ctx: 4096 },
      }),
      signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
    });
    if (!res.ok) return { people: [], elapsedMs: Date.now() - started, ok: false };
    const json = (await res.json()) as { response?: string; done_reason?: string };
    const raw = json.response ?? "";
    // A reply cut off by num_predict (done_reason "length") or unparsable JSON is UNKNOWN, never "nobody":
    // with 3 people the old 160-token budget truncated the JSON and the parse gave an empty list.
    let valid = false;
    try {
      valid = Array.isArray(JSON.parse(raw)?.people) && json.done_reason !== "length";
    } catch {
      valid = false;
    }
    const obstruction = valid ? parseObstruction(raw) : null;
    return {
      people: valid ? parsePeople(raw) : [],
      elapsedMs: Date.now() - started,
      ok: valid,
      doneReason: json.done_reason,
      rawHead: raw.slice(0, 300),
      ...(obstruction ? { obstructed: obstruction.obstructed, obstructedBy: obstruction.obstructedBy } : {}),
    };
  } catch {
    return { people: [], elapsedMs: Date.now() - started, ok: false };
  }
}

export function summarizePeople(people: PersonInfo[]): string {
  return people
    .map((p) => {
      const bits = [p.pose, p.position ? `at the ${p.position}` : "", p.clothes ? `wearing ${p.clothes}` : "", p.facing ? `facing ${p.facing}` : ""];
      return `a person ${bits.filter(Boolean).join(", ")}`;
    })
    .join("; ");
}

/** Injected near the top of the planning prompt. */
export function groundTruthNote(people: PersonInfo[], count?: number): string {
  const n = Math.max(people.length, count ?? 0);
  return (
    `GROUND TRUTH (from a person detector): ${n} person(s) are visible: ${summarizePeople(people)}. ` +
    "scene_description MUST describe them, and every scenario MUST be about what they do next " +
    "(if an operator MAIN EVENT is given below, these persons perform it). Do not say the room is empty."
  );
}

export function spanPhrase(d: number): string {
  const abs = Math.abs(d);
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  const t = m > 0 ? `${m} minute${m > 1 ? "s" : ""}${s ? ` ${s} seconds` : ""}` : `${s} seconds`;
  return `${t} ${d >= 0 ? "later" : "before"},`;
}

const OPPOSITE: Record<string, string> = { left: "right", right: "left", camera: "side", away: "side" };

/**
 * Server-side scenarios when the planner keeps denying the person: the extra if there is one, else a minimal
 * motion that fits the distance. Returns English text (the caller runs the Japanese translation step).
 */
const WEAK_RE = /\b(no change|unchanged|remains? (?:empty|unchanged|stationary|still)|nothing (?:changes|happens)|no movement)\b/i;

/** True for planner answers that say nothing happens ("No change.", "remains empty"). */
export function isWeakScenario(prediction: string): boolean {
  return WEAK_RE.test(prediction) || prediction.trim().length < 12;
}

// Only environmental things: no chairs, bags or other items a hand would have to move.
const EMPTY_OBJECTS = ["curtain", "shelf", "overhead light", "monitor screen", "partition"];

/**
 * Empty-room scenarios written by the server: three different minimal changes of things that exist
 * (light, chair, curtain, screen), worded for the scenario's time span. English; the caller translates.
 */
export function synthesizeEmptyRoom(args: { distances: number[]; objects?: string[]; count: number }): ScenarioResult[] {
  const objs = (args.objects && args.objects.length ? args.objects : EMPTY_OBJECTS).slice(0, 5);
  const short = [
    (o: string) => `The brightness of the light on the ${o} shifts slightly.`,
    (o: string) => `The ${o} sits in a slightly softer shade.`,
    (o: string) => `The colour temperature of the light on the ${o} shifts a little.`,
  ];
  const long = [
    (o: string) => `The overall brightness in the room dims a little and the ${o} looks darker.`,
    (o: string) => `The ${o} looks clearly brighter and warmer than before in the same light.`,
    (o: string) => `The room's light shifts toward a cooler colour temperature and the ${o} looks slightly different in it.`,
  ];
  return Array.from({ length: args.count }, (_, i) => {
    const d = args.distances[i] ?? 30;
    const set = Math.abs(d) >= 120 ? long : short;
    const text = set[i % set.length](objs[i % objs.length]);
    return {
      prediction_prompt: text,
      scenario_description: `${spanPhrase(d)} ${text.charAt(0).toLowerCase()}${text.slice(1)}`,
      label: `Timeline ${i + 1}`,
    } as ScenarioResult;
  });
}

export function synthesizeScenarios(args: {
  people: PersonInfo[];
  distances: number[];
  extrasEnglish: Record<string, string | undefined>;
  extras: Record<string, string | undefined>;
  keys: readonly string[];
  base: ScenarioResult[];
}): { scenes: ScenarioResult[]; sceneNow: string } {
  const sceneNow = `${summarizePeople(args.people).replace(/^a person/, "A person")}.`;
  const p = args.people[0];
  const who = `The person${p?.position ? ` on the ${p.position}` : ""}${p?.clothes ? ` (${p.clothes})` : ""}`;
  const side = OPPOSITE[(p?.facing || "").toLowerCase()] ?? "side";
  const seated = /seat|sit/i.test(p?.pose ?? "");
  const scenes = args.base.map((b, i) => {
    const d = args.distances[i] ?? 30;
    const key = args.keys[i];
    const extra = key ? args.extras[key] : undefined;
    let action: string;
    if (extra) {
      const en = args.extrasEnglish[key!];
      action = en ? (/^[a-z]+ing\b/i.test(en) ? `is ${en}` : en) : `performs: ${extra}`;
      if (en && /^(the|a|an)\s/i.test(en)) {
        const sentence = /[.!?]$/.test(en) ? en : `${en}.`;
        return { ...b, prediction_prompt: sentence, scenario_description: `${spanPhrase(d)} ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`, scene_now: sceneNow };
      }
    } else if (Math.abs(d) >= 120) {
      action = seated ? "stands up and steps toward the exit" : "turns and steps toward the exit";
    } else if (i % 2 === 0) {
      action = `turns their head slightly to the ${side}`;
    } else {
      action = seated ? "adjusts their posture slightly in the chair" : "shifts their weight slightly";
    }
    const pred = (extra ? `The person already in the photo ${action}.` : `${who} ${action}.`).replace(/\s+/g, " ");
    return {
      ...b,
      prediction_prompt: pred,
      scenario_description: `${spanPhrase(d)} ${pred.charAt(0).toLowerCase()}${pred.slice(1)}`,
      scene_now: sceneNow,
    };
  });
  return { scenes, sceneNow };
}

/** Large arm motions (raising both hands, stretching, waving, banzai): only allowed when an operator extra asks for them. */
const BIG_ARM_RE = /(?:rais\w*|lift\w*|throw\w*|stretch\w*|extend\w*)[^.;]{0,40}\b(?:arms?|hands?)\b[^.;]{0,30}\b(?:overhead|above (?:the |their |his |her )?head|up|into the air|high)\b|\b(?:arms?|hands?)\b[^.;]{0,15}\b(?:overhead|raised|in the air)\b|\bstretch(?:es|ing)?\b|\bwav(?:e|es|ing)\b|banzai|both (?:arms|hands) (?:up|raised)/i;

export function hasBigArmMotion(prediction: string): boolean {
  return BIG_ARM_RE.test(prediction);
}

/** Quiet replacement motion for a scene whose planner text was a large arm motion. */
export function modestMotion(people: PersonInfo[] | undefined, index: number): string {
  const p = people?.[0];
  const who = `The person${p?.position ? ` on the ${p.position}` : ""}${p?.clothes ? ` (${p.clothes})` : ""}`;
  const seated = /seat|sit/i.test(p?.pose ?? "");
  const options = seated
    ? ["adjusts their posture slightly in the chair", "turns their head slowly to the side", "leans back a little in the chair"]
    : ["shifts their weight slightly", "turns slowly to look to the side", "stands quietly and looks around"];
  return `${who} ${options[index % options.length]}.`;
}

/** Verb phrases for the recent person (back to the camera, quiet): subject-less, to be joined to "The person ...". */
const RECENT_PHRASES = [
  "stands quietly with their back to the camera",
  "sits quietly with their back to the camera",
  "walks slowly toward the shelf with their back to the camera",
];
export function recentPersonPhrase(index: number): string {
  return RECENT_PHRASES[index % RECENT_PHRASES.length];
}

/** More than one person named (the recent-person path draws exactly one). */
const MULTI_PERSON_RE = /\b(two|three|several|both|another|other|second|everyone|people|persons|someone else|each other|a couple|group)\b/i;
export function mentionsSeveralPeople(text: string): boolean {
  return MULTI_PERSON_RE.test(text);
}
