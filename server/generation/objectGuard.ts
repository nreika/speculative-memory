/**
 * Object-fabrication guard: a scenario may only name things that the frame description names.
 * Simple vocabulary check (groups of synonyms): a group named in prediction_prompt but absent from
 * scene_description (+ the people description) counts as invented ("a beige jacket pulled from the chair").
 */
import type {PersonInfo} from "./peopleDescribe";
import type { ScenarioResult } from "../../services/promptBuilder";
import { getRulebook } from "./rulebook";

/** Each group = words for the same thing; the first is used in messages. */
const GROUPS: string[][] = [
  ["chair", "chairs", "armchair", "seat", "stool"],
  ["jacket", "coat", "hoodie", "sweater", "cardigan"],
  ["bag", "bags", "backpack", "handbag", "suitcase"],
  ["box", "boxes", "carton", "cardboard", "container"],
  ["laptop", "laptops", "notebook", "computer", "pc"],
  ["monitor", "monitors", "screen", "screens", "display", "displays", "tv", "television"],
  ["curtain", "curtains", "partition", "partitions", "drape", "drapes", "blind", "blinds"],
  ["door", "doors", "doorway"],
  ["window", "windows"],
  ["lamp", "lamps", "light", "lights", "lighting", "fixture", "fixtures", "tube", "tubes", "bulb", "bulbs"],
  ["cup", "cups", "mug", "mugs", "glass"],
  ["bottle", "bottles"],
  ["paper", "papers", "document", "documents", "sheet", "sheets", "note", "notes"],
  ["shelf", "shelves", "shelving", "rack", "racks", "cabinet", "cabinets"],
  ["table", "tables", "desk", "desks", "counter", "workbench"],
  ["cable", "cables", "cord", "cords", "wire", "wires"],
  ["plant", "plants", "flower", "flowers"],
  ["book", "books"],
  ["phone", "phones", "smartphone"],
  ["keyboard", "keyboards"],
  ["mouse"],
  ["pipe", "pipes", "duct", "ducts", "ductwork"],
  ["umbrella", "umbrellas"],
  ["hat", "cap", "helmet"],
  ["shoe", "shoes", "sneaker", "sneakers"],
  ["clock", "clocks"],
  ["poster", "posters", "picture", "pictures", "painting"],
  ["sofa", "couch"],
  ["whiteboard", "board"],
];

function wordRegex(w: string): RegExp {
  return new RegExp("\\b" + w + "\\b", "i");
}

/** Words that only count as "the frame has this" (a scenario saying "the light dims" is not inventing a lamp). */
const PRESENCE_ONLY = new Set(["light", "lights", "lighting"]);

const toRegex = (g: string[]) => ({
  name: g[0],
  test: new RegExp("\\b(?:" + g.join("|") + ")\\b", "i"),
  trigger: new RegExp("\\b(?:" + g.filter((w) => !PRESENCE_ONLY.has(w)).join("|") + ")\\b", "i"),
});
const BASE_GROUP_REGEX: Array<{ name: string; test: RegExp; trigger: RegExp }> = GROUPS.map(toRegex);

let extraCache: { key: string; list: Array<{ name: string; test: RegExp; trigger: RegExp }> } = { key: "", list: [] };
/** Built-in groups plus the rulebook's extra vocabulary groups (guard.extraObjectGroups), re-read per capture. */
function groupRegexes(): Array<{ name: string; test: RegExp; trigger: RegExp }> {
  const extra = getRulebook().guard.extraObjectGroups.filter((g) => g.length > 0 && g.every((w) => /^[a-z][a-z -]{0,30}$/i.test(w)));
  if (extra.length === 0) return BASE_GROUP_REGEX;
  const key = JSON.stringify(extra);
  if (extraCache.key !== key) extraCache = { key, list: extra.map(toRegex) };
  return [...BASE_GROUP_REGEX, ...extraCache.list];
}

/** Vocabulary groups mentioned in `text` (frame side: any member counts). */
export function mentionedObjects(text: string): string[] {
  return groupRegexes().filter((g) => g.test.test(text)).map((g) => g.name);
}

/** Groups used by a scenario that the frame description (and people description) does not name. */
export function inventedObjects(prediction: string, frameText: string): string[] {
  const inFrame = new Set(mentionedObjects(frameText));
  return groupRegexes().filter((g) => g.trigger.test(prediction)).map((g) => g.name).filter((name) => !inFrame.has(name));
}

export interface ObjectFabrication {
  index: number;
  words: string[];
}

export function findFabricatedObjects(
  frameText: string,
  scenarios: Array<Pick<ScenarioResult, "prediction_prompt">>
): ObjectFabrication[] {
  const out: ObjectFabrication[] = [];
  scenarios.forEach((s, index) => {
    const words = inventedObjects(s.prediction_prompt, frameText);
    if (words.length > 0) out.push({ index, words });
  });
  return out;
}

export const OBJECT_REMINDER_HEAD =
  "REMINDER: do not write about any object that is not visible in this photo. Visible objects: ";

export function objectReminder(frameText: string, invented: string[]): string {
  return `\n\n${OBJECT_REMINDER_HEAD}${frameText}. You wrote about things that are NOT in the photo (${invented.join(", ")}); remove them.`;
}

// kept for tests
export const _wordRegex = wordRegex;

/** Visible source facts establish object presence, never ownership or a future action.
 * Keep this separate from prediction text: a generated object cannot authorize itself.
 */
export function observedObjectContext(scene:string,people:PersonInfo[]|undefined,foreground:unknown):string {
 const facts=(people??[]).flatMap(person=>[
  person.pose,person.position,person.clothes,
  ...(person.holdingFacts??[]).filter(f=>f.evidence==='hand_supported'||f.evidence==='surface_contact').map(f=>f.item),
  ...(person.wornFacts??[]).filter(f=>['body_attached','furniture_supported','nearby_only'].includes(f.attachment)).map(f=>f.item),
 ]).filter(x=>typeof x==='string'&&x.trim());
 const near=typeof foreground==='string'&&!/^(?:none\b|no\b|not\b|unknown\b|unclear\b|n\/a\b)/i.test(foreground.trim())?foreground.trim().slice(0,200):'';
 return [scene,...facts,near].filter(Boolean).join(' ');
}
