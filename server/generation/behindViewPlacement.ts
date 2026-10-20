/**
 * G-14 for the recent person drawn from behind (2026-10-19, TSC-003 F004/F005): placed at their recent position, the
 * person was drawn on top of the chair where a blue backpack and a jacket hang, and the belongings vanished. The person
 * now goes BESIDE the existing objects; every object of the input stays where it is; an occupied recent place moves to the
 * nearest free floor spot. Object names come from the scene description when it names belongings, else generic words.
 * No object boxes exist for the frame, so the overlap case is stated as a condition the image model resolves.
 */
const COLOURS = 'black|white|grey|gray|silver|blue|navy|light blue|dark blue|red|dark red|green|dark green|yellow|orange|pink|purple|brown|beige|tan|khaki|cream';
const ITEMS = 'backpack|rucksack|handbag|shoulder bag|tote bag|tote|bag|jacket|coat|hoodie|sweater|cardigan|scarf|umbrella|water bottle|bottle|thermos|mug|cup|helmet|cap|hat|notebook|book|laptop|tablet|phone|box|pouch|lunch box';
const ITEM_RE = new RegExp(`\\b(?:(${COLOURS})\\s+)?(?:(${COLOURS})\\s+)?(${ITEMS})(?:e?s)?\\b`, 'gi');

/** Movable belongings named in a scene description ("A blue water bottle and a backpack are visible" -> blue water bottle, backpack). */
export function sceneBelongings(scene?: string, limit = 4): string[] {
  if (!scene) return [];
  const out: string[] = [];
  for (const m of scene.matchAll(ITEM_RE)) {
    const name = [m[1], m[2], m[3]].filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ');
    const noun = m[3].toLowerCase();
    // one entry per noun ("backpack" and "blue backpack" are the same thing); keep the more specific wording
    const i = out.findIndex((x) => x === noun || x.endsWith(' ' + noun));
    if (i >= 0) { if (name.length > out[i].length) out[i] = name; continue; }
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Placement text appended to the behind-view sentence. `objects`: belongings seen in the NOW frame, if known. */
export function behindViewPlacementSentence(objects: string[] = []): string {
  const named = objects.map((o) => o.trim()).filter(Boolean).slice(0, 4).map((o) => `the ${o}`);
  const leave = named.length ? `${list(named)} and every other object` : 'every bag, jacket and item on the chairs and desks';
  return (
    'The person stands or sits BESIDE the existing furniture and objects, never on top of, inside or in place of any object visible in the input image, and never in front of them so that they disappear. ' +
    `Every object in the input image stays exactly where it is and stays visible: bags, backpacks, jackets and coats, items on chairs and desks${named.length ? `, in particular ${list(named)}` : ''}. ` +
    `If the person's place in the reference image is now taken by a chair or an object, the person stands on the nearest free floor spot next to it instead (for example next to the chair), leaving ${leave} untouched.`
  );
}

/** Complementary negative terms for the behind-view path (G-14). */
export const BEHIND_VIEW_OBJECTS_NEGATIVE =
  'person replacing an object, person sitting on a bag or jacket, missing backpack, missing jacket, removed belongings, objects removed from chair, person standing in front of the belongings';

/**
 * G-14 v2 (2026-10-19, TSC-003 F004 A/C): with the generic text above, STANDING behind-view renders still put the person
 * on/in front of the chair holding the blue backpack and black jacket (seated renders kept them). A standing person now
 * gets one concrete free spot: a named side of the occupied chair. The side is chosen from horizontal hints already
 * available without model calls: a position word next to the chair/belongings in the scene description, else the recent
 * person's head box (0-1000) or position word. The person stands on the side with more free space (an object at the left
 * leaves more room to its right, and vice versa); with no usable hint, the side farther from the image centre.
 */
import type { SceneBelonging } from './peopleDescribe';
export type Horizontal = 'left' | 'right' | 'center';
/** Inputs of the free spot: scene text, its belongings names, the recent person's place, and the describe call's
 * belongings (guard.belongings, used when the scene text gives no names/positions). */
export interface FreeSpotInput { scene?: string; objects?: string[]; position?: string; headBox?: readonly number[] | null; belongings?: SceneBelonging[] }
const FURNITURE = ['chair', 'stool', 'sofa', 'bench', 'desk', 'table'] as const;
const CARRIED = /\b(backpack|rucksack|handbag|bag|tote|jacket|coat|hoodie|sweater|cardigan|scarf|umbrella|helmet|pouch)\b/;
const H_WORD = '(left|right|centre|center|middle)';
const toH = (w?: string): Horizontal | undefined => (!w ? undefined : /left/i.test(w) ? 'left' : /right/i.test(w) ? 'right' : 'center');

/** Horizontal word of a position string ("left front" -> left, "center" -> center), else undefined. */
export function horizontalOf(position?: string): Horizontal | undefined {
  const m = position?.match(new RegExp(`\\b${H_WORD}\\b`, 'i'));
  return toH(m?.[1]);
}

/** Furniture the belongings are on (the chair by default) and its horizontal place when the scene states one
 * ("a chair at the left front", "on the right, a chair with a backpack", "the backpack on the right"). */
export function occupiedFurniture(scene?: string, objects: string[] = [], belongings: SceneBelonging[] = []): { name: string; side?: Horizontal } {
  const s = (scene ?? '').toLowerCase();
  const pick = (t: string) => FURNITURE.find((f) => new RegExp(`\\b${f}s?\\b`).test(t) && (f === 'chair' || !/\bchairs?\b/.test(t)));
  const name = pick(s) ?? pick(belongings.map((b) => b.on).join(' ')) ?? 'chair';
  const nouns = [name, ...objects.map((o) => o.toLowerCase().split(' ').pop()!).filter((n) => CARRIED.test(n))];
  for (const n of nouns) {
    const after = s.match(new RegExp(`\\b${n}s?\\b[^.;,]{0,30}?\\b${H_WORD}\\b`));
    const before = s.match(new RegExp(`\\b${H_WORD}\\b[^.;,]{0,30}?\\b${n}s?\\b`));
    const w = after?.[1] ?? before?.[1];
    if (w) return { name, side: toH(w) };
  }
  return { name };
}

/** Side of the occupied furniture where the standing person goes: 'left'/'right', or undefined (no usable hint). */
export function freeSpotSide(p: FreeSpotInput): 'left' | 'right' | undefined {
  const away = (h?: Horizontal) => (h === 'left' ? 'right' : h === 'right' ? 'left' : undefined);
  const furniture = occupiedFurniture(p.scene, p.objects);
  if (furniture.side && furniture.side !== 'center') return away(furniture.side);
  // guard.belongings (describe call): the carried items' horizontal third, then any item's.
  const sided = [...onFurniture(p.belongings ?? [], furniture.name), ...(p.belongings ?? [])].find((b) => b.position !== 'center');
  if (sided) return away(sided.position);
  const box = p.headBox;
  if (box && box.length === 4 && box.every((v) => Number.isFinite(v))) {
    const x = (box[0] + box[2]) / 2000; // head centre, 0..1 of the recent frame
    if (x < 0.45) return 'right';
    if (x > 0.55) return 'left';
  }
  return away(horizontalOf(p.position));
}

/** Belongings that sit on the occupied furniture or are bags/clothes (carried items), in describe order. */
function onFurniture(belongings: SceneBelonging[], furniture: string): SceneBelonging[] {
  return belongings.filter((b) => CARRIED.test(b.name) || new RegExp(`\\b${furniture}`).test(b.on));
}

/** True unless the planned action clearly seats the person (seated renders kept the belongings). */
export function isStandingAction(action?: string): boolean {
  if (!action) return true;
  const a = action.toLowerCase();
  if (/\b(stand|stands|standing|stood|walk|walks|walking|step|steps|stepping|stroll|strolls|leaves|heads?)\b/.test(a)) return true;
  return !/\b(sit|sits|sitting|seated|sat)\b/.test(a);
}

/** One sentence naming a concrete free spot for a STANDING behind-view person, beside the occupied furniture. */
export function behindViewFreeSpotSentence(p: FreeSpotInput = {}): string {
  const furniture = occupiedFurniture(p.scene, p.objects, p.belongings);
  const fromScene = (p.objects ?? []).map((o) => o.trim().toLowerCase()).filter((o) => CARRIED.test(o));
  const carried = (fromScene.length ? fromScene : onFurniture(p.belongings ?? [], furniture.name).map((b) => b.name)).slice(0, 4);
  const holder = carried.length ? `the ${furniture.name} with ${list(carried.map((o) => `the ${o}`))}` : `the ${furniture.name} and everything on it`;
  const hasDesk = /\b(desk|table)s?\b/i.test(p.scene ?? '') && furniture.name !== 'desk' && furniture.name !== 'table';
  const spot = hasDesk ? `in front of the empty part of the ${/\bdesks?\b/i.test(p.scene ?? '') ? 'desk' : 'table'}` : 'on the free floor';
  const side = freeSpotSide(p);
  const where = side
    ? `standing to the ${side.toUpperCase()} of the ${furniture.name}, ${spot}, not overlapping the ${furniture.name}; ${holder} stays fully visible to the ${side === 'left' ? 'right' : 'left'} of the person`
    : `standing beside the ${furniture.name} on its side farther from the centre of the image, ${spot}, not overlapping the ${furniture.name}; ${holder} stays fully visible next to the person`;
  return (
    `Free spot for the standing person: ${where}. ` +
    `If an empty ${furniture.name === 'chair' ? 'chair' : 'seat'} with nothing on it stands nearby, the person may sit on that empty one instead; never stand or sit on, in front of or in place of the ${furniture.name} that holds belongings.`
  );
}

/**
 * Objects the pre-publish inspection checks for (missing_belongings, 2026-10-19): belongings the source scene description
 * names in the singular ("a blue backpack", "a black jacket"; plural background clutter such as "shelves with boxes" is
 * skipped), at most `limit`. An object the planned action names, or one a source person holds or wears, may legitimately
 * move and is left out.
 */
export function inspectionBelongings(scene?: string, opts: { action?: string; people?: Array<{ holding?: string; worn?: string }>; belongings?: SceneBelonging[] } = {}, limit = 6): string[] {
  const moving = [opts.action ?? '', ...(opts.people ?? []).flatMap((p) => [p.holding ?? '', p.worn ?? ''])].join(' ').toLowerCase();
  const out: string[] = [];
  const nounOf = (n: string) => n.split(' ').pop()!;
  // guard.belongings first (the describe call lists them regardless of people), then the scene's singular objects.
  for (const b of opts.belongings ?? []) {
    if (out.length >= limit) return out;
    const noun = nounOf(b.name);
    if (!noun || new RegExp(`\\b${noun.replace(/[^a-z0-9]/g, '')}`).test(moving) || out.some((x) => nounOf(x) === noun)) continue;
    out.push(b.name);
  }
  if (!scene || out.length >= limit) return out;
  for (const m of scene.matchAll(ITEM_RE)) {
    const noun = m[3].toLowerCase();
    if (m[0].toLowerCase().replace(/\s+/g, ' ').endsWith(noun) === false) continue; // plural form
    if (new RegExp(`\\b${noun}`).test(moving)) continue;
    const name = [m[1], m[2], m[3]].filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ');
    const i = out.findIndex((x) => x === noun || x.endsWith(' ' + noun));
    if (i >= 0) { if (name.length > out[i].length) out[i] = name; continue; }
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}
