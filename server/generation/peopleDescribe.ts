import {sharedOllamaContextLength} from "./sharedOllamaContext";
/**
 * People facts for the planner: a short image call that describes the visible people (used when the person
 * detector said someone is there), the "GROUND TRUTH" note injected at the top of the planning prompt, and the
 * server-side synthesis used when the 4B planner still answers "empty room / No change".
 */
import type { ScenarioResult } from "../../services/promptBuilder";

import { parseHeadBox } from "./referenceCrop";
import { emptyRoomObjectChange } from "./scenarioGuard";

export interface HandObjectFact {
  item: string;
  hand: 'left' | 'right' | 'both' | 'unclear';
  evidence: 'hand_supported' | 'surface_contact' | 'unclear';
}
export interface AttachmentFact {
  item: string;
  attachment: 'body_attached' | 'furniture_supported' | 'nearby_only' | 'unclear';
}
/** Movable belonging seen in the frame, from the same describe call (2026-10-19, F004: guard.scene named neither the
 * backpack nor the jacket on the chair). Recorded as guard.belongings; feeds the behind-view free spot and objectsVisible. */
export interface SceneBelonging {
  name: string;
  on: string;
  position: 'left' | 'center' | 'right';
}
export const MAX_SCENE_BELONGINGS = 6;
const BELONGING_SCHEMA = {
  type: 'array', maxItems: MAX_SCENE_BELONGINGS,
  items: {
    type: 'object',
    properties: { name: { type: 'string' }, on: { type: 'string' }, position: { type: 'string', enum: ['left', 'center', 'right'] } },
    required: ['name', 'on', 'position'], additionalProperties: false,
  },
};
/** Tolerant: a missing/invalid list or entry becomes [] / is dropped. Accepts the whole reply (string/object) or the array. */
export function parseSceneBelongings(raw: unknown): SceneBelonging[] {
  const value = typeof raw === 'string' ? parseJsonLoose(raw) : raw;
  const list = Array.isArray(value) ? value : Array.isArray(value?.belongings) ? value.belongings : [];
  const out: SceneBelonging[] = [];
  for (const b of list) {
    if (!b || typeof b !== 'object' || typeof b.name !== 'string' || !b.name.trim()) continue;
    const name = b.name.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
    if (out.some((x) => x.name === name)) continue;
    const on = typeof b.on === 'string' ? b.on.trim().toLowerCase().slice(0, 40) : '';
    const pos = String(b.position ?? '').toLowerCase();
    const position = pos === 'left' || pos === 'right' || pos === 'center' ? pos : /\bleft\b/.test(on) ? 'left' : /\bright\b/.test(on) ? 'right' : 'center';
    out.push({ name, on, position });
    if (out.length >= MAX_SCENE_BELONGINGS) break;
  }
  return out;
}

export interface PersonInfo {
  position: string;
  pose: string;
  clothes: string;
  /** Normalised by parsePeople to toward | side | away | unknown (hand-built values may still be free text). */
  facing: string;
  /** Hair (colour, length, style), when the describe call gave it. */
  hair?: string;
  holding?: string;
  worn?: string;
  /** All observed candidates, including surface/furniture contact excluded from ownership instructions. */
  holdingFacts?: HandObjectFact[];
  wornFacts?: AttachmentFact[];
  /** null means no usable visible-head reference; keep the person without inventing a crop. */
  headBox?: [number,number,number,number] | null;
}

const DATA_URL_PATTERN = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/;

export const DESCRIBE_SCHEMA = {
  type: 'object',
  properties: {
    people: {
      type: 'array', maxItems: 4,
      items: {
        type: 'object',
        properties: {
          position: { type: 'string' }, pose: { type: 'string' },
          clothes: { type: 'string' }, hair: { type: 'string' },
          holding: { type: 'array', maxItems: 4, items: {
            type: 'object', properties: {
              item: { type: 'string' }, hand: { type: 'string', enum: ['left','right','both','unclear'] },
              evidence: { type: 'string', enum: ['hand_supported','surface_contact','unclear'] },
            }, required: ['item','hand','evidence'], additionalProperties: false,
          } },
          worn: { type: 'array', maxItems: 4, items: {
            type: 'object', properties: {
              item: { type: 'string' }, attachment: { type: 'string', enum: ['body_attached','furniture_supported','nearby_only','unclear'] },
            }, required: ['item','attachment'], additionalProperties: false,
          } },
          facing: { type: 'string', enum: ['toward', 'side', 'away', 'unknown'] },
          head_box: { anyOf: [
            { type: 'array', items: { type: 'number', minimum: 0, maximum: 1000 }, minItems: 4, maxItems: 4 },
            { type: 'null' },
          ] },
        },
        required: ['position', 'pose', 'clothes', 'hair', 'holding', 'worn', 'facing', 'head_box'],
        additionalProperties: false,
      },
    },
    obstructed: { type: 'boolean' }, obstructedBy: { type: 'string' },
    belongings: BELONGING_SCHEMA,
  },
  required: ['people', 'obstructed', 'obstructedBy', 'belongings'], additionalProperties: false,
};

export const DESCRIBE_PROMPT =
  'Describe every visible person in this photo as JSON. Example: {"people":[{"position":"left front","pose":"seated in a chair","clothes":"plain shirt","hair":"short dark hair","holding":[],"worn":[],"facing":"away","head_box":[20,100,220,400]}],"obstructed":false,"obstructedBy":""}. ' +
  'The example illustrates the structure only; use the actual people and coordinates in this image. Facing MUST be exactly one of: toward (face turned to the camera), side (profile, face partly visible), away (back to the camera, face not visible), unknown (cannot tell). Use away ONLY when no part of the face is visible; if any part of the face shows, use side or toward. Position means horizontal third of the image (left, center or right), plus front or background. Hair means colour, length and style. Name the base colour of most of the hair first; if only the tips or ends have another colour, add them after it, e.g. "long black hair with pink tips". Never name only the tip colour (not "pink hair" or "pink-tipped") when most of the hair is another colour. Each person MUST have head_box: [left,top,right,bottom] normalized to 0..1000, tightly enclosing ONLY the visible face and all visible hair, excluding the body and room. Visible hair from behind or a partly cropped head still needs a box around its visible portion; never invent the missing face or extend beyond the frame. Use null only when no head/hair is visible or its bounds cannot be determined confidently. Keep that person in people even when head_box is null. ' +
  'For each visible hand-contacted item, holding has {"item":"brief visible item description","hand":"left|right|both|unclear","evidence":"hand_supported|surface_contact|unclear"}. Use hand_supported ONLY when a visible hand grip or support actually carries the movable item in the hand. Use surface_contact when fingers rest, press, type or operate an item supported by a desk, stand, shelf or floor. Touching a laptop keyboard, mouse or desk is surface_contact, NOT carrying a laptop. A cup/tablet/phone visibly supported in the hand can be hand_supported. Merely nearby objects or hidden contact points are NOT evidence of ownership; use unclear for uncertain contact, not hand_supported. Observe left and right independently; do not copy an item to the other hand. One entry per physical item; use hand both for one item actually supported by both hands. ' +
  'For each visible accessory/bag candidate, worn has {"item":"brief visible item description","attachment":"body_attached|furniture_supported|nearby_only|unclear"}. Use body_attached ONLY when its visible strap, loop, fastening or other support clearly attaches it to this person’s body, shoulder or wrist. Use furniture_supported for a bag/case/jacket resting on or hanging from a chair, desk or other furniture, even right behind the person. Being beside a body, overlapping its silhouette, or appearing behind a shoulder does NOT establish a body attachment; use nearby_only or unclear instead. Never infer a strap hidden by the person or chair. A visible wrist loop or shoulder strap actually supporting an accessory on the body is body_attached. Return [] when no candidates are visible, and an empty string for an uncertain ordinary text field. Never infer an item hidden in a pocket. Keep it factual: at most 12 words per text field, one short entry per person. ' +
  'Count every person, including people cut off by the frame edge, in side profile, seen from behind or only partly visible. ' +
  'If no human is visible at all (mannequins, posters and screens do not count), return "people":[] (still with the top-level fields below). ' +
  'Also add two top-level fields: "obstructed" (true ONLY when an inanimate object right in front of the lens, such as a chair back, cloth or wall, covers about half or more of the frame so the room cannot be seen; a person standing or sitting near the camera is NOT an obstruction, and neither is a normal view of the room: then false) and "obstructedBy" (at most 4 English words naming the blocking object, "" when not obstructed). ' +
  'Also add a top-level "belongings" array (always, whether or not a person is present; [] when none): up to 6 movable personal items left in the room that are NOT worn or held by a visible person: bags and backpacks, jackets and coats, and items left on chairs, desks or the floor (bottles, cups, phones, laptops). Each entry is {"name":"colour + item, e.g. blue backpack","on":"what it rests on or hangs from, e.g. chair at left","position":"left|center|right"} where position is the horizontal third of the image where the item is. Do not list furniture, monitors, shelves or items stored on shelves.';

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

function handObjectFacts(raw: unknown): HandObjectFact[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0,4).filter(p => p && typeof p.item === 'string' && p.item.trim() && ['left','right','both','unclear'].includes(p.hand) && ['hand_supported','surface_contact','unclear'].includes(p.evidence))
    .map(p => ({item:p.item.trim().slice(0,80),hand:p.hand,evidence:p.evidence}));
}
function attachmentFacts(raw: unknown): AttachmentFact[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0,4).filter(p => p && typeof p.item === 'string' && p.item.trim() && ['body_attached','furniture_supported','nearby_only','unclear'].includes(p.attachment))
    .map(p => ({item:p.item.trim().slice(0,80),attachment:p.attachment}));
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
    .map((p: any) => {
      // Unsupported old free-text assertions never become preservation/ownership instructions.
      const holdingFacts = handObjectFacts(p.holding), wornFacts = attachmentFacts(p.worn);
      const holding = holdingFacts.filter(f => f.evidence === 'hand_supported').map(f => f.item + (f.hand === 'unclear' ? '' : f.hand === 'both' ? ' in both hands' : ` in ${f.hand} hand`)).join(' and ').slice(0,160);
      const worn = wornFacts.filter(f => f.attachment === 'body_attached').map(f => f.item).join(' and ').slice(0,160);
      return {
      position: String(p.position ?? "").trim().slice(0, 60),
      pose: String(p.pose ?? "").trim().slice(0, 100),
      clothes: String(p.clothes ?? "").trim().slice(0, 80),
      facing: normalizeFacing(p.facing),
      hair: String(p.hair ?? "").trim().slice(0, 100),
      holding, worn, holdingFacts, wornFacts,
      headBox: parseHeadBox(p.head_box) ?? null,
      };
    })
    .filter((p: PersonInfo) => p.position || p.pose || p.clothes || p.hair || p.headBox);
}

/** One image call with required head coordinates or explicit null. [] on any failure. */
export async function describePeople(
  imageDataUrl: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<{ people: PersonInfo[]; elapsedMs: number; ok: boolean; doneReason?: string; rawHead?: string; obstructed?: boolean; obstructedBy?: string; belongings?: SceneBelonging[] }> {
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
        format: DESCRIBE_SCHEMA,
        keep_alive: process.env.VLM_PHASE_KEEP_ALIVE ?? "2m",
        // 768: the belongings list (up to 6 short entries) must not truncate the people JSON (truncated = unknown).
        options: { temperature: 0, num_predict: 768, num_ctx: sharedOllamaContextLength() },
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
      belongings: valid ? parseSceneBelongings(raw) : [],
    };
  } catch {
    return { people: [], elapsedMs: Date.now() - started, ok: false };
  }
}

export type Facing = 'toward' | 'side' | 'away' | 'unknown';
/** Map the describe step's facing (enum or legacy free text) to toward | side | away | unknown. */
export function normalizeFacing(v: unknown): Facing {
  const t = String(v ?? "").trim().toLowerCase();
  if (!t) return 'unknown';
  if (/^(?:toward|side|away|unknown)$/.test(t)) return t as Facing;
  if (/\b(?:away|back|behind|rear)\b/.test(t)) return 'away';
  if (/\b(?:profile|side|sideways|left|right)\b/.test(t)) return 'side';
  if (/\b(?:toward|towards|camera|front|forward|viewer)\b/.test(t)) return 'toward';
  return 'unknown';
}

export function summarizePeople(people: PersonInfo[]): string {
  return people
    .map((p) => {
      const bits = [p.pose, p.position ? `at the ${p.position}` : "", p.clothes ? `wearing ${p.clothes}` : "", p.facing && p.facing !== "unknown" ? `facing ${p.facing}` : ""];
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

const OPPOSITE: Record<string, string> = { left: "right", right: "left", camera: "side", toward: "side", away: "side" };

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
export function synthesizeEmptyRoom(args: { distances: number[]; objects?: string[]; count: number; scene?: string; foregroundObject?: string }): ScenarioResult[] {
  const objs = (args.objects && args.objects.length ? args.objects : EMPTY_OBJECTS).slice(0, 5);
  const short = [(o: string) => `The ${o} remains exactly as in the input.`];
  const long = short;
  return Array.from({ length: args.count }, (_, i) => {
    const d = args.distances[i] ?? 30;
    const set = Math.abs(d) >= 120 ? long : short;
    // A small change of a movable object named in the frame (chair turned, bin shifted); the no-change text only when none exists.
    const text = (args.scene ? emptyRoomObjectChange(args.scene, args.foregroundObject, d, i) : null) ?? set[i % set.length](objs[i % objs.length]);
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
