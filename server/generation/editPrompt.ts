/**
 * Coherent image-edit prompt (2026-10-21 rebuild). One short instruction, each fact stated once, in this order:
 *   1. framing anchor   2. temporal frame   3. who (each original person: clothes, position, facing; references)
 *   4. the action, once  5. amount of change (Tone) + presence (Presence)   6. at most three hard constraints.
 * The old composition repeated the action 2-3 times among 20+ rule sentences (~2.7k chars) and contradicted itself
 * ("replace the pose" vs "preserve the face", face references for people seen from behind, "undo" next to a big-pose request).
 * Pure text; no model call.
 */
import type { PersonInfo } from "./peopleDescribe";
import { spanWords, type PastContinuityVerdict } from "./pastScene";
import { uniqueActionPerson, withoutLightingChanges } from "./fidelity";
import { isRelocationAction } from "./compactPeople";

/** Room sentence that follows the rulebook framing anchor. */
export const ROOM_ANCHOR = "Keep the room architecture, lighting and screen contents; edit only what is described below.";
export const EDIT_ANCHOR =
  "Edit image1: keep the same camera, framing (no crop, no zoom), room architecture, lighting and screen contents.";

const lower = (s: string) => s.replace(/\s+/g, " ").trim();
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const period = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

export const isAway = (p?: Pick<PersonInfo, "facing">) => /\b(?:away|back)\b/i.test(p?.facing ?? "");
export const isSeated = (p?: Pick<PersonInfo, "pose">) => /\b(?:sit|sits|sitting|seated)\b/i.test(p?.pose ?? "");
/** A person the frame edge cuts: they cannot be relocated without inventing the missing half. */
export const isEdgeCropped = (p?: Pick<PersonInfo, "position" | "pose"> & { headBox?: PersonInfo["headBox"] }) => {
  if (/\b(?:edge|cut off|cropped|partially|partial)\b/i.test(`${p?.position ?? ""} ${p?.pose ?? ""}`)) return true;
  // head_box is 0..1000 of the frame: a head at the border means the body is cut by the image edge.
  const b = p?.headBox;
  if (!b || b.length !== 4) return false;
  // The shoulders reach about one head width beyond the head (QA 14:04: head at x 75-215, arm cut by the left edge).
  const w = Math.max(1, b[2] - b[0]);
  return b[0] <= w || 1000 - b[2] <= w || b[1] <= 10;
};

/** Words that ask for a face, eyes, gaze, mouth or expression: impossible (and harmful) for a person seen from behind. */
export const FACE_WORDS =
  /\b(?:face[sd]?|facial|eyes?|eyebrows?|gaz\w*|glanc\w*|look(?:s|ing|ed)?|stares?|staring|smil\w*|laugh\w*|grin\w*|frown\w*|mouth|lips?|expression\w*|wink\w*|blink\w*|yawn\w*|talk\w*|speak\w*|chat\w*|sneez\w*)\b/i;

/** Face/gaze/mouth clauses rewritten to what a back view can show; clauses that still need a face are dropped. */
export function backViewAction(action: string): string {
  const text = lower(action).replace(/[.!?]+$/, "");
  if (!text) return text;
  const subject =
    text.match(/^((?:the|a|an)\s+(?:[\w-]+\s+){0,5}?(?:person|man|woman|individual)(?:\s+(?:in|wearing)\s+(?:[\w-]+\s+){0,5}?[\w-]+?(?=\s+(?:is|are|\w+s)\b))?|he|she|they)\b/i)?.[1] ?? "The person";
  const clauses = text.split(/(?<=[.!?;])\s+|,\s*(?:and\s+|while\s+)?|\s+(?:and|while)\s+/i).map((c) => c.trim()).filter(Boolean);
  const out: string[] = [];
  for (let c of clauses) {
    c = c
      // "with their back to the camera" stays whole; only face-toward-camera phrases go.
      .replace(/(?<!\bback\s*)\s*\b(?:toward|towards|to|at)\s+(?:the\s+)?(?:camera|viewer|lens)\b/gi, "")
      .replace(/\b(turns?|turning|turned)\s+((?:his|her|their|the)\s+)?head\b/gi, "tilts $2head")
      .replace(/\bhead\s+turns?\b/gi, "head tilts")
      .replace(/\b(?:looks?|looking|glances?|glancing|gazes?|gazing|stares?|staring)\s+(?:around|about)\b/gi, "turns the shoulders slightly")
      .replace(/\b(?:looks?|looking|glances?|glancing|gazes?|gazing|stares?|staring)\s+(up|down)\b/gi, "tilts the head $1")
      .replace(/\b(?:looks?|looking|glances?|glancing|gazes?|gazing|stares?|staring)(?:\s+(?:over|out|back|across))?\s+(?:at|toward|towards|to|into)\b/gi, "tilts the head toward")
      .replace(/\b(?:looks?|glances?|gazes?|stares?)\b/gi, "tilts the head")
      .replace(/\b(?:drinks?|drinking|sips?|sipping)(?:\s+from\s+((?:the|a|an|their|his|her)\s+[\w\s-]+))?/gi, (_m, what?: string) => `raises ${what ? what.trim() : "the cup"} in front of the body`)
      .replace(/\b(?:eats?|eating)\b/gi, "brings the food forward with one hand");
    if (FACE_WORDS.test(c)) continue;
    out.push(c);
  }
  if (!out.length) return `${cap(subject)} shifts the shoulders and moves one arm slightly.`;
  let first = out[0];
  // A dropped opening clause took the subject with it: give the first remaining clause one again.
  if (!/^(?:the|a|an|he|she|they|their|his|her)\b/i.test(first)) first = `${subject} ${first}`;
  return period(cap([first, ...out.slice(1)].join(", ")));
}

/** A seated person does not stand up or walk; an edge-cropped person does not relocate. */
export function physicallyPossibleAction(action: string, actor?: PersonInfo): string {
  let a = action;
  if (actor && isSeated(actor)) {
    a = a
      .replace(/\b(?:stands?|standing|gets?|getting|rises?|rising)\s+up(?:\s+from\s+(?:the|their|a|his|her)\s+(?:chair|seat))?/gi, "leans forward in the chair")
      .replace(/\b(?:rises?|rising)\s+from\s+(?:the|their|a|his|her)\s+(?:chair|seat)/gi, "leans forward in the chair")
      .replace(/\b(?:walks?|walking|steps?|stepping|strolls?|strolling)\b(?:\s+(?:away|over|across|to|toward|towards|out|off)\b[^,.;]*)?/gi, "turns in the chair")
      .replace(/\bstands?\b/gi, "sits");
  }
  if (actor && isEdgeCropped(actor) && isRelocationAction(a)) {
    a = a.replace(/\b(?:walk\w*|leav\w*|cross\w*|run(?:s|ning)?|step(?:s|ping)?)\b(?:\s+(?:away|over|across|to|toward|towards|out|off|into)\b[^,.;]*)?|\bmov(?:e|es|ing)\s+(?:to|toward|across)\b[^,.;]*/gi, "shifts in place");
  }
  return a;
}

function facingPhrase(p: PersonInfo): string {
  if (isAway(p)) return "seen from behind, back of head to camera, face never visible";
  if (/\bside|profile\b/i.test(p.facing ?? "")) return "seen in profile";
  if (/\btoward|front|camera\b/i.test(p.facing ?? "")) return "facing the camera";
  return "";
}

export function personLabel(p: PersonInfo): string {
  return p.clothes?.trim() ? `the person in the ${p.clothes.trim().replace(/^(?:a|an|the)\s+/i, "")}` : `the person at the ${p.position || "original place"}`;
}

/** The visible pose beyond seated/standing ("hands behind head"), so a small action keeps it (QA 14:16). */
function posePhrase(p: PersonInfo): string {
  const rest = (p.pose ?? "").replace(/\b(?:seated|sitting|sits|standing|stands)\b(?:\s+(?:in|on|at)\s+(?:a|the)\s+(?:chair|desk|seat))?/gi, "").replace(/^[\s,;]+|[\s,;.]+$/g, "").replace(/\s+/g, " ");
  return rest && rest.length <= 80 ? `in image1 ${rest}` : "";
}

/** No arm, hand, torso or position change in the action: only the face or head moves (blink, gaze, small head turn). */
const BODY_ACTION = /\b(?:arms?|hands?|fingers?|elbows?|shoulders?|torso|body|legs?|feet|foot|stands?|standing|sits?|sitting|leans?|leaning|reach\w*|lift\w*|rais\w*|lower\w*|stretch\w*|pick\w*|grasp\w*|tak(?:e|es|ing)|grab\w*|pull\w*|push\w*|put\w*|plac\w*|walk\w*|step\w*|turns?\s+(?:the\s+)?(?:chair|body)|typ\w*|writ\w*|drink\w*|eat\w*|hold\w*|open\w*|clos\w*|wav\w*|point\w*)\b/i;
export const isStillAction = (action: string) => !!action.trim() && !BODY_ACTION.test(action);

function personClause(p: PersonInfo): string {
  const bits = [
    personLabel(p),
    p.position ? `${isSeated(p) ? "seated " : ""}at the ${p.position.replace(/^the\s+/i, "")}` : isSeated(p) ? "seated" : "",
    facingPhrase(p),
    posePhrase(p),
    // Which hand is left out: the action may free a hand or put the object down (no grip commitment).
    p.holding ? `in image1 holding ${p.holding.replace(/\s+(?:in|with)\s+(?:the\s+|their\s+)?(?:both|left|right|one|two)\s+hands?\b/gi, "")}` : "",
  ].filter(Boolean);
  return bits.join(", ");
}

/** Short spans keep the physical limits of the current pose (seated, edge-cropped); longer spans may change them. */
export const SHORT_SPAN_SEC = 60;

/**
 * Sentence 2: the exact span, then one clause that grows with it (the planner's plan is proportional to the span; a long
 * span must never be written as "the same activity"). Past scenes mirror the future and never say "undo".
 */
export function temporalSentence(spanSec: number, continuity?: PastContinuityVerdict, emptyRoom = false, holding = true): string {
  if (!Number.isFinite(spanSec) || spanSec === 0) return "";
  const span = spanWords(spanSec);
  const a = Math.abs(spanSec);
  const who = emptyRoom ? "" : "the person";
  if (spanSec > 0) {
    const what =
      a <= 45 ? `the next moment of the same activity${holding ? "; a held object may be set down" : ""}`
      : a <= 90 ? `the activity has gone on a little further${holding ? "; objects in hand may have been set down or moved" : ""}`
      : a <= 180 ? "the activity may have moved on; held objects may have been set down or used, and the posture may differ"
      : a <= 300 ? "enough time for a different activity; objects may have been finished, set aside or moved, and the posture and position may differ"
      : a <= 900 ? `enough time for the activity to have changed; objects may have been finished, set aside or put away${who ? "; the person may be elsewhere in the room" : ""}`
      : `a long time; objects may be rearranged${who ? ", and the person may be elsewhere in the room or gone (never replaced by someone else)" : ""}; only the camera, room architecture and lighting stay`;
    return `This is ${span} later: ${what}.`;
  }
  const what =
    a <= 45 && emptyRoom ? "a slightly earlier moment of the same room"
    : a <= 45
      ? continuity === "new" ? "the moment just before the latest change seen in image1"
        : continuity === "ongoing" ? "the same activity one step earlier"
        : "a slightly earlier moment of the same activity"
    : a <= 90 ? `the activity was a little less far along${holding ? "; objects now in hand may still have been on a surface" : ""}`
    : a <= 180 ? "the activity may have been a different step; objects now in hand may not yet have been picked up, and the posture may differ"
    : a <= 300 ? "possibly a different activity; objects may not yet have been taken out, and the posture and position may differ"
    : a <= 900 ? `enough time for a different activity; objects may not yet have been taken out or were elsewhere${who ? "; the person may have been elsewhere in the room" : ""}`
    : `a long time earlier; objects may have been arranged differently${who ? ", and the person may have been elsewhere in the room or not yet there (never someone else)" : ""}; only the camera, room architecture and lighting stay`;
  return `This is ${span} before image1: ${what}.`;
}

/** Tone = how big the movement is, never theatrical (user, 2026-10-21). */
const TONE_PEOPLE = [
  "Amount of movement: a small natural movement.",
  "Amount of movement: a modest natural movement of a hand, the head or the shoulders.",
  "Amount of movement: a clear, ordinary everyday movement; the posture visibly changes in place ({mid}).",
  "Amount of movement: a big but ordinary everyday movement, as a real person would do in this room; the whole posture clearly changes in place, for example {big}.",
];
/** Examples follow the actor's posture (QA 14:00: chair examples next to a standing person eating). */
const TONE_EXAMPLES = {
  seated: { mid: "leaning in, turning on the chair or reaching out", big: "leaning far back in the chair, half standing up, turning the chair to another direction or stretching both arms forward" },
  standing: { mid: "leaning in, turning the upper body or reaching out", big: "bending forward, turning the whole body, shifting the weight to one leg or stretching both arms forward" },
  any: { mid: "leaning in, turning the upper body or reaching out", big: "leaning far back, turning the whole body or stretching both arms forward" },
};
export function toneSentence(tone: number, posture: "seated" | "standing" | "any" = "seated"): string {
  const t = Number.isFinite(tone) ? Math.min(1, Math.max(0, tone)) : 0.3;
  const ex = TONE_EXAMPLES[posture];
  return TONE_PEOPLE[t < 0.25 ? 0 : t < 0.5 ? 1 : t < 0.75 ? 2 : 3].replace("{mid}", ex.mid).replace("{big}", ex.big);
}

/** Presence 0..1 = how much the person is present in the picture (never adds a person). */
export function presenceSentence(presence: number, count: number): string {
  const who = count > 1 ? "the people are" : "the person is";
  const p = Number.isFinite(presence) ? presence : 0.5;
  if (p < 0.25) return `Presence: ${who} barely there, small and inconspicuous at the edge of attention.`;
  if (p < 0.5) return `Presence: ${who} present but subdued.`;
  if (p < 0.75) return `Presence: ${who} clearly present.`;
  return `Presence: ${who} fully present, the centre of attention.`;
}

export interface CoherentEditInput {
  action: string;
  people: PersonInfo[];
  personCount?: number;
  tone?: number;
  presence: number;
  spanSec: number;
  pastContinuity?: PastContinuityVerdict;
  /** Owner (index into people) of each attached reference image2, image3...; null = whole frame of the same people. */
  references?: Array<number | null>;
  lead?: string;
  /** Replaces EDIT_ANCHOR (the versioned rulebook framing anchor + the room sentence). */
  anchor?: string;
  tail?: string;
}

/** Which person the action is about (undefined = ambiguous or several). */
export function actionActor(action: string, people: PersonInfo[]): PersonInfo | undefined {
  const byClothes = uniqueActionPerson(action, people);
  if (byClothes) return byClothes;
  // "The person lifts the white cup" with one cup owner: that owner is the actor.
  const words = (s: string) => (s.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length > 2 && !["the", "and", "with", "hand", "left", "right"].includes(w));
  const said = new Set(words(action));
  const owners = people.filter((p) => p.holding && words(p.holding).some((w) => said.has(w)));
  return owners.length === 1 ? owners[0] : undefined;
}

/** "The person ..." with 2+ people and no clothing or object clue: the first described person acts (never "The person" alone). */
export function resolveActor(action: string, people: PersonInfo[]): PersonInfo | undefined {
  const generic = /^(?:the|a)\s+person\b(?!\s+(?:in|wearing|on|at)\b)/i.test(action);
  return actionActor(action, people) ?? (people.length > 1 && generic ? people[0] : undefined);
}

/** The action stated once, made possible for the actor (back view, seated, edge) and naming the actor with 2+ people. */
/** QA 14:04: "grasps the blue water bottle" drew a second bottle in the hand. Name the object as the one from its spot. */
export function movedObjectSentence(action: string): string {
  const m = lower(action).match(/\b(?:picks?\s+up|picking\s+up|grasps?|grasping|takes?|taking|grabs?|grabbing|lifts?|lifting|pulls?|pulling|reaches?\s+for|reaching\s+for)\s+((?:the|a|an|their|his|her)\s+(?:[\w-]+\s+){0,3}?[\w-]+)(?=\s+(?:from|off|on|in|at|with|to|and|while|then)\b|[,.;]|$)/i);
  if (!m) return "";
  const obj = m[1].replace(/^(?:a|an|their|his|her)\s+/i, "the ");
  if (/\b(?:hand|arm|head|chair|desk|table|object|item|thing)s?$/i.test(obj)) return "";
  return `${cap(obj)} in the hand is the same one that was on the desk; its old spot is now empty.`;
}

/** peopleIntegrity's retry correction is appended to the action (server.ts); its sentences start with these fixed openings. */
const CORRECTION_START = /\s+(?=The requested action must be clearly visible in the pose:|Keep the exact framing, scale and rotation|Draw each person as ONE coherent body|The person is seen from behind: keep|Each person has exactly two hands and two arms|No person may appear anywhere|Render each original individual exactly once|Every bag, jacket and personal item on the furniture must|The [^.]{1,120} must remain fully visible exactly where)/;
/** Splits the planned action from an appended retry correction; the correction's restatement of the action is dropped. */
export function splitCorrection(text: string): { action: string; correction: string } {
  const t = lower(text);
  const m = t.match(CORRECTION_START);
  if (!m || m.index === undefined) return { action: t, correction: "" };
  const correction = t.slice(m.index).trim().replace(/The requested action must be clearly visible in the pose:.*?(?=\s+(?:Keep the exact framing|Draw each person|The person is seen from behind: keep|Each person has exactly|No person may appear|Render each original)|$)/, "").trim();
  return { action: t.slice(0, m.index).trim(), correction };
}
export const withoutActionRestatement = (action: string) => splitCorrection(action).action;

export function coherentAction(action: string, people: PersonInfo[], spanSec = 0): string {
  // QA 14:42: "takes a visible object" made the model sweep an arm at nothing; a generic object is dropped, the reach stays.
  let a = withoutActionRestatement(action).replace(/\s*,?\s*(?:and\s+)?(?:takes?|taking|picks?\s+up|grabs?|grabbing)\s+(?:a|an|some)\s+(?:visible\s+|nearby\s+|small\s+)?(?:object|item|thing)s?\b/gi, "") || "The people keep their poses.";
  // "The person ..." with 2+ people and no clothing or object clue: the first described person acts (never "The person" alone).
  const actor = resolveActor(a, people);
  if (Math.abs(spanSec) <= SHORT_SPAN_SEC) a = physicallyPossibleAction(a, actor);
  if (people.length > 1 && actor && /^(?:the|a)\s+person\b(?!\s+(?:in|wearing)\b)/i.test(a)) a = a.replace(/^(?:the|a)\s+person\b/i, cap(personLabel(actor)));
  const backView = actor ? isAway(actor) : people.some(isAway);
  if (backView) a = backViewAction(a);
  return period(cap(a));
}

export function referenceSentence(people: PersonInfo[], references?: Array<number | null>): string {
  if (!references?.length) return "";
  const named = references.map((owner, i) => {
    const p = owner === null ? undefined : people[owner];
    return p ? `image${i + 2} shows the face and hair of ${personLabel(p)}` : "";
  }).filter(Boolean);
  if (named.length === references.length) return period(named.join("; "));
  const n = references.length;
  return `${n > 1 ? `image2 to image${n + 1} show` : "image2 shows"} the same people at another moment, only for their face and hair.`;
}

/** World rule (user, 2026-10-21): anything seen in this room's recent footage may appear; held movable objects may be put down. */
export const WORLD_RULE =
  "Objects seen earlier in this room may appear and held movable objects may be put down or moved, but nothing that was never in this room, and no duplicate copy of any person or object: a held or moved object is the existing one (desk to hand, hand to desk) and is gone from its old place.";

export function constraintSentences(count: number, people: PersonInfo[]): string {
  const n = count === 1 ? "Exactly one person is" : `Exactly ${count} people are`;
  const out = [`${n} in the image, ${count === 1 ? "with" : "each with"} two arms and two hands.`, WORLD_RULE];
  if (people.some(isAway)) out.push("People seen from behind stay seen from behind, with no face on the back of any head.");
  return out.join(" ");
}

/** The whole prompt for a scene with its original people (the normal occupied path). */
export function composeCoherentEdit(x: CoherentEditInput): string {
  const count = x.personCount && x.personCount > 0 ? x.personCount : Math.max(1, x.people.length);
  // QA 13:51: a person cut off at the left edge was re-centred in every scene. Short spans pin the frame position.
  const short = Math.abs(x.spanSec) <= SHORT_SPAN_SEC;
  const edge = x.people.filter((p) => isEdgeCropped(p));
  const edgeClause = !edge.length ? ""
    : x.people.length === 1 ? ", still cut off by the image edge as in image1"
    : `; ${edge.map(personLabel).join(" and ")} ${edge.length > 1 ? "stay" : "stays"} cut off by the image edge as in image1`;
  const pin = !short || !x.people.length ? ""
    : ` ${x.people.length > 1 ? "Each person keeps" : "The person keeps"} the ${edge.length ? "exact same position and size" : "same place"} in the frame${edgeClause}; only the described body parts move.`;
  const actor = resolveActor(lower(splitCorrection(x.action).action), x.people);
  const still = x.people.length > 0 && isStillAction(splitCorrection(x.action).action);
  const posture = actor ? (isSeated(actor) ? "seated" : "standing") : x.people.length && x.people.every(isSeated) ? "seated" : "any";
  const who = x.people.length
    ? `${count === 1 ? "There is one person" : `There are ${count} people`}: ${x.people.map(personClause).join("; ")}.${pin}`
    : `Keep the ${count === 1 ? "person" : `${count} people`} already in image1 in their places.`;
  const parts = [
    (x.lead ?? "") + (x.anchor ?? EDIT_ANCHOR),
    temporalSentence(x.spanSec, x.pastContinuity, false, x.people.some((p) => !!p.holding)),
    who,
    referenceSentence(x.people, x.references),
    coherentAction(x.action, x.people, x.spanSec),
    movedObjectSentence(splitCorrection(x.action).action),
    // A face/head-only action (blink, gaze) pins the body; a "big movement" sentence would contradict it.
    still ? "Everything except the described head and face movement holds exactly the same pose as in image1; the hands and arms stay where they are." : "",
    x.tone !== undefined ? toneSentence(still ? 0 : x.tone, posture) : "",
    presenceSentence(x.presence, count),
    constraintSentences(count, x.people),
  ];
  const fix = splitCorrection(x.action).correction;
  return parts.filter(Boolean).join(" ") + (fix ? " Fix from the previous attempt: " + fix : "") + (x.tail ?? "");
}

/** A concrete far spot that exists in this room (scene text, English or Japanese); the edit model follows places, not sizes. */
export function farAnchor(scene?: string): string {
  const t = scene ?? "";
  if (/shel(?:f|ves)|rack|棚/i.test(t)) return "by the far shelves at the back of the room";
  if (/curtain|カーテン/i.test(t)) return "half hidden behind the curtain at the back of the room";
  if (/\bdoor|ドア|扉/i.test(t)) return "by the door at the back of the room";
  return "against the back wall of the room";
}

/**
 * Size and place of the recent person drawn from behind, from Presence (never close to the camera). QA 14:19: an abstract
 * "small far figure" was drawn large on the near chair, so low Presence names a concrete far spot and keeps the near chair empty.
 * a50010's size post-check retry uses behindViewRetryAnchor with the same words.
 */
export function behindViewPlacementByPresence(presence: number, scene?: string): string {
  const p = Number.isFinite(presence) ? presence : 0.5;
  if (p <= 0.35) return `Place them ${farAnchor(scene)}, small in the distance and partly out of view, back to the camera; the chair at the near desk stays empty; never close to the camera and never filling the frame.`;
  if (p <= 0.7) return "Place them at mid-distance by the far desk, normal size, back to the camera; never close to the camera and never filling the frame.";
  return "Place them near the front desk, fully in view, back to the camera; never close to the camera and never filling the frame.";
}

/** Fix line for a size retry: the same concrete anchor as the first attempt. */
export function behindViewRetryAnchor(presence: number, scene?: string): string {
  return `The person was drawn too large or too close. ${behindViewPlacementByPresence(presence, scene)}`;
}

/** "left front" -> "on the left side": the recent spot gives only the side; Presence sets the depth. */
export function sideOf(position?: string): string {
  const m = (position ?? "").match(/\b(left|right|cent(?:er|re)|middle)\b/i);
  if (!m) return "";
  return /left|right/i.test(m[1]) ? `on the ${m[1].toLowerCase()} side` : "in the middle";
}

/** Recent person drawn into an empty room from behind (the person shown in image2). */
export function composeBehindViewEdit(x: {
  action: string; look: { clothes?: string; hair?: string; position?: string }; placement: string; tone?: number; presence: number;
  spanSec: number; pastContinuity?: PastContinuityVerdict; referencePerson: boolean; lead?: string; anchor?: string; tail?: string;
}): string {
  const look = [x.look.clothes ? `wearing ${x.look.clothes}` : "", x.look.hair ? (/\bhair\b/i.test(x.look.hair) ? `with ${x.look.hair}` : x.look.hair) : ""].filter(Boolean).join(", ");
  const side = sideOf(x.look.position);
  const who = `Add exactly one person${x.referencePerson ? ", the person shown in image2" : ""}${look ? `, ${look}` : ""}, ${side ? `${side}, ` : ""}seen from behind, back of head to camera, face never visible.`;
  const action = backViewAction(withoutActionRestatement(x.action) || "The person stands quietly.");
  return [
    (x.lead ?? "") + (x.anchor ?? EDIT_ANCHOR),
    temporalSentence(x.spanSec, x.pastContinuity, false, false),
    who,
    x.referencePerson ? "image2 shows this person's clothes and hair only." : "",
    x.placement,
    action,
    x.tone !== undefined ? toneSentence(x.tone) : "",
    presenceSentence(x.presence, 1),
    `Exactly one person is in the image, with two arms and two hands. ${WORLD_RULE} The person stays seen from behind, with no face on the back of the head.`,
  ].filter(Boolean).join(" ") + (splitCorrection(x.action).correction ? " Fix from the previous attempt: " + splitCorrection(x.action).correction : "") + (x.tail ?? "");
}

/** Owner of each reference image, for the scene-head-crop case (server.ts builds them from people.slice(0,2) with a head box). */
export function referenceOwners(args: { people: PersonInfo[]; refFrames: string[]; crops?: unknown[]; sceneImage: string; hasHeadBox: (p: PersonInfo) => boolean }): Array<number | null> {
  const { people, refFrames } = args;
  if (!refFrames.length) return [];
  if (args.crops && refFrames.every((f) => f === args.sceneImage)) {
    const owners = people.slice(0, 2).map((p, i) => (args.hasHeadBox(p) ? i : -1)).filter((i) => i >= 0);
    if (owners.length === refFrames.length) return owners;
  }
  if (people.length === 1) return refFrames.map(() => 0);
  return refFrames.map(() => null);
}

/** References are optional: keep only those of people whose face is visible (never an away person's, never ambiguous ones next to an away person). */
export function keepReferenceIndexes(people: PersonInfo[], owners: Array<number | null>): number[] {
  // QA 14:42: a face reference for a person cut off by the frame edge invites the model to complete the face and re-centre
  // the person, so edge-cropped people get none either (like people seen from behind).
  const noRef = (p: PersonInfo) => isAway(p) || isEdgeCropped(p);
  if (people.length && people.every(noRef)) return [];
  const anyNoRef = people.some(noRef);
  return owners.map((o, i) => (o === null ? (anyNoRef ? -1 : i) : people[o] && !noRef(people[o]) ? i : -1)).filter((i) => i >= 0);
}

/** cfg 1.0 (Turbo, 8 steps) ignores the negative prompt entirely; a few words keep the trace honest. */
export const TURBO_NEGATIVE = "blurry, extra people, extra limbs, face on the back of a head";

/**
 * An empty-room scene whose action changes nothing ("The room stays empty; nothing in it has been moved"). Running the edit
 * model on it only adds framing drift or drops objects (QA 15:02/15:03), so generateImage returns the NOW frame instead.
 */
export function isEmptyRoomNoChange(action: string): boolean {
  const parts = (withoutLightingChanges(splitCorrection(action).action) || "nothing changes").replace(/[.!]+$/, "").split(/\s*(?:;|,|\band\b|\.\s+)\s*/i).map((x) => x.trim()).filter(Boolean);
  const still = /\b(?:stays?|remains?|is still|are still)\b.*\b(?:empty|unchanged|the same|in place|where (?:it|they) (?:is|are|was|were))\b|\bnothing\b.*\b(?:moved|changes?|moves|happens)\b|\bno (?:visible )?change\b|\bunchanged\b/i;
  return parts.length > 0 && parts.every((x) => still.test(x));
}
