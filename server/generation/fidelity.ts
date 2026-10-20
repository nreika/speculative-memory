import {sharedOllamaContextLength} from "./sharedOllamaContext";
import type { PersonInfo } from './peopleDescribe';
import { withJapaneseSpan } from './spanFix';
import { handConflict, oneArmHoldingSentence, withoutHandCommitments, type HandConflict } from './handConflict';

export const FIXED_LIGHTING = 'Keep the exact input exposure, brightness, lighting colour, white balance, shadows and screen contents throughout the edit.';

/** Remove environmental colour/exposure edits, without discarding the person's action in the same sentence. */
export function withoutLightingChanges(text: string): string {
  const forbidden = /\b(?:light(?:ing)?|brightness|exposure|white balance|colou?r temperature|shadows?|lamps?|sunlight|daylight)\b|\b(?:brighter|dimmer|darker|warmer|cooler)\b/i;
  if (!forbidden.test(text)) return text;
  return text.split(/(?<=[.!?;])\s+|\s+and\s+|,\s*(?:and\s+)?/i)
    .filter(part => !forbidden.test(part))
    .map(part => part.trim().replace(/[.;]+$/, ''))
    .filter(Boolean).join('. ');
}

/** `action` (optional): the scene action; a both-hands object of the acting person is then listed as held with one arm
 * and the grip-keeping sentences are dropped (handConflict.ts). */
export function identityConstraints(people: PersonInfo[], count?: number, action?: string): string {
  const n = count ?? people.length;
  if (!Number.isInteger(n) || n < 1) return '';
  const conflict = action ? actionHandConflict(action, people) : null;
  const held = (p: PersonInfo) => conflict && conflict.person === p ? `the ${conflict.item}, now held against the body with one arm only${conflict.rest ? `; ${conflict.rest}` : ''}` : p.holding;
  const details = people.map((p, i) => `Person ${i + 1} at ${p.position || 'their original place'}: keep ${p.clothes || 'the same clothes'}, the exact hair shown in their identity reference, and all held or worn items${p.holding && !/^(?:nothing|none)$/i.test(p.holding) ? ` (${held(p)})` : ''}${p.worn ? ` (${p.worn})` : ''}.`).join(' ');
  const text = `Exactly ${n} existing person${n === 1 ? '' : 's'} remain visible, including partially visible people at the edges. Move each original person only once; keep the same identity and number. ${details} Every held or worn belonging visible in image1 remains with its original owner, with the same shape and size. Keep the input hand grip on each item. A hand holding an item keeps holding it, even during an expressive pose; when that hand moves, the item moves together with it; never add a hand. Keep each person's original face visibility: a head cut off by the frame stays cut off, and a hidden face stays hidden. Use image2/image3 only for identity; image1 alone determines the people count, camera, background and composition. Match references to the person with the same clothes; never copy one person's hair or face onto another.`;
  return conflict ? withoutHandCommitments(text) : text;
}

/** The acting person's both-hands object while the action needs a hand (null otherwise). */
export function actionHandConflict(prediction: string, people: PersonInfo[]): HandConflict | null {
  return handConflict(uniqueActionPerson(prediction, people), prediction);
}

const clothingWords = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => !['the','a','an'].includes(w));
const PERSON_WORDS = new Set(['person','woman','man','individual','actor','girl','boy','visitor','she','he']);

/** Resolve only an explicit, unambiguous clothing description; never guess from a colour on a nearby item. */
export function uniqueActionPerson(prediction: string, people: PersonInfo[]): PersonInfo | undefined {
  if (people.length === 1) return people[0];
  const wardrobes = people.map(p => new Set(clothingWords(p.clothes)));
  const vocabulary = new Set(wardrobes.flatMap(words => [...words]));
  const words = prediction.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const mentions = words.map((word, i) => PERSON_WORDS.has(word) ? i : -1).filter(i => i >= 0);
  // More than one mentioned person may mean multiple actors; do not freeze anyone in that case.
  if (mentions.length !== 1 || words.some(w => ['both','everyone','people','persons','they'].includes(w))) return;
  const subject = mentions[0], descriptor: string[] = [];
  const collect = (start: number, step: number) => {
    for (let i = start; i >= 0 && i < words.length; i += step) {
      const word = words[i];
      if (['the','a','an'].includes(word)) continue;
      if (!vocabulary.has(word)) break;
      descriptor.push(word);
    }
  };
  // "the red top person" and "the person in/wearing a red top" use the observed wardrobe vocabulary.
  collect(subject - 1, -1);
  if (words[subject+1] === 'in' || words[subject+1] === 'wearing') collect(subject + 2, 1);
  if (!descriptor.length) return;
  const candidates = people.filter((_, i) => descriptor.every(word => wardrobes[i].has(word)));
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Only observed hand-supported belongings or explicit holding text establish occupied sides. */
export function occupiedHandSides(person:PersonInfo):Array<'left'|'right'> {
 const sides=new Set<'left'|'right'>();
 for(const fact of person.holdingFacts??[])if(fact.evidence==='hand_supported'){
  if(fact.hand==='both'||fact.hand==='left')sides.add('left');if(fact.hand==='both'||fact.hand==='right')sides.add('right');
 }
 if(/\bin\s+both\s+hands\b/i.test(person.holding??'')){sides.add('left');sides.add('right');}
 else {if(/\b(?:in|with)\s+(?:the\s+)?left\s+hand\b/i.test(person.holding??''))sides.add('left');if(/\b(?:in|with)\s+(?:the\s+)?right\s+hand\b/i.test(person.holding??''))sides.add('right');}
 return [...sides];
}
/** A surface-contact observation is not a carried item. Only explicit, unambiguous
 * source hand contacts justify leaving that contact for a generic cheering pose.
 */
function surfaceContactCheering(person:PersonInfo):string|undefined {
 if(person.holding?.trim()&&!/^(nothing|none)$/i.test(person.holding.trim()))return;
 const facts=person.holdingFacts;
 if(!facts?.length||facts.some(f=>f.evidence!=='surface_contact'||!['left','right','both'].includes(f.hand)))return;
 const sides=new Set<'left'|'right'>();
 for(const f of facts){if(f.hand==='left'||f.hand==='both')sides.add('left');if(f.hand==='right'||f.hand==='both')sides.add('right');}
 if(!sides.size)return;
 const both=sides.size===2,side=sides.has('left')?'left':'right';
 const subject=both?'one empty hand':`the empty ${side} hand`;
 const other=both?'the other hand stays in its original supported-surface contact':'the other hand preserves its original contact or grip';
 return `lifts ${subject} away from its original surface contact to shoulder height, with a bent elbow and visibly empty open palm, while ${other}. The upper torso leans sideways into a clearly visible diagonal, with one shoulder distinctly higher than the other, in a lively cheering pose. Move that original arm to its new position; do not leave its old hand at the surface or create an extra arm or hand. Items supported by furniture remain supported; do not pick them up`;
}
function isPlainSourceCheering(prediction:string,person:PersonInfo):boolean {
 const match=prediction.trim().match(/^(.+?)\s+is cheering[.!?]?$/i);if(!match)return false;
 const normalized=(s:string)=>s.trim().replace(/\s+/g,' ').toLowerCase();
 const clothes=normalized(person.clothes).replace(/^(?:a|an|the)\s+/,'');
 const subjects=['the person','the person already in the photo',...(clothes?[`the person in the ${clothes}`,`the person in ${clothes}`,`the person wearing the ${clothes}`,`the person wearing ${clothes}`]:[])];
 return subjects.includes(normalized(match[1]));
}
/** Expressive movement uses only a uniquely identified actor's free hand. Ambiguous actions stay intact. */
export function actionWithBelongings(prediction: string, people: PersonInfo[]): string {
  const actor = uniqueActionPerson(prediction, people);
  const actors = actor ? [actor] : [];
  let out = prediction;
  for (const p of actors) {
    // No source contact evidence means no new arm action. Already concrete
    // cheering ("is cheering while ...") also retains the operator's details.
    const surfaceCheer=surfaceContactCheering(p);
    if(surfaceCheer&&isPlainSourceCheering(prediction,p))out=out.replace(/\bis cheering(?=\s*(?:[.!?]|$))/i,surfaceCheer);
    if (p.holding && !/^(nothing|none)$/i.test(p.holding)) {
      const bothOccupied=occupiedHandSides(p).length===2;
      const cheer=bothOccupied
        ? `leans the upper torso sideways into a clearly visible diagonal, with one shoulder distinctly higher than the other${/away|back/i.test(p.facing)?'':', with a visibly cheerful expression'}, while both occupied hands keep their original grips on the held items. Both elbows, gripping hands and the original held belongings move together with the leaning upper body, with continuous grip contact`
        : 'lifts the free hand visibly to shoulder height with an open palm, leans the upper body clearly to the side and smiles, while the occupied hand keeps its original grip on the held item';
      out = out.replace(/is cheering\.?/i,cheer+'.');
      // Both hands/arms on one object while the action needs a hand: the object stays, held with one arm (never a third hand).
      const conflict=handConflict(p,prediction);
      const keep=conflict
        ? ` ${oneArmHoldingSentence(conflict.item,prediction)}${conflict.rest?` The ${p.clothes || 'same'} person continuously keeps ${conflict.rest}, with the original hand grip.`:''}`
        : ` The ${p.clothes || 'same'} person continuously keeps ${p.holding}, with the original hand grip.`;
      out += `${keep} All their worn or hanging items stay attached and visible${p.worn ? ` (${p.worn})` : ''}.`;
    }
  }
  if (people.length > 1 && actors.length === 1) {
    for (const p of people.filter(p => p !== actors[0])) out += ` The other person (${p.clothes}) keeps the original posture, hand grips and belongings; only the named actor performs this action.`;
  }
  return out;
}

/** Observe each hand separately: a cup grip must not become an open-palm gesture. */
export const VISIBLE_HAND_SCHEMA = {
  type: 'object', properties: {
    visibility: { type: 'string', enum: ['visible', 'not_visible', 'unclear'] },
    height: { type: 'string', enum: ['shoulder_or_above', 'below_shoulder', 'unclear'] },
    contact: { type: 'string', enum: ['held_object', 'surface_contact', 'body_or_clothing', 'none', 'unclear'] },
    palm: { type: 'string', enum: ['open', 'not_open', 'unclear'] },
  }, required: ['visibility', 'height', 'contact', 'palm'], additionalProperties: false,
};
export const VISIBLE_PERSON_FIELDS = {
  posture: { type: 'string', enum: ['standing', 'seated', 'upper_body_only', 'unclear'] },
  leftHand: VISIBLE_HAND_SCHEMA, rightHand: VISIBLE_HAND_SCHEMA,
};
export const VISIBLE_HAND_INSTRUCTION = 'For each person observe their own leftHand and rightHand INDEPENDENTLY in the finished image. First set visibility (visible, not_visible, unclear). Visible requires identifiable hand/palm/fingers/fist pixels, not just a sleeve, elbow or an expected hand location. A hand outside the frame or completely behind a body/object is not_visible, never a free raised hand. For not_visible or unclear visibility, height/contact/palm must all be unclear. If an identifiable part of the hand is visible, use visible and keep only its unknown fields unclear. Each hand has height (shoulder_or_above, below_shoulder, unclear), contact (held_object, surface_contact, body_or_clothing, none, unclear), and palm (open, not_open, unclear). Height is that hand relative to that same person’s shoulders, not its position in the picture. Set each field for each hand separately: one hand on a keyboard or holding a cup says NOTHING about the other hand. A visible hand at shoulder/head height is shoulder_or_above even when the other hand stays on a desk or holds something. Use held_object ONLY for a clearly visible grip that supports a movable item IN the hand. The item itself must be distinctly visible, not just inferred from curled fingers. A closed or bent hand alone is NOT evidence of an object. A visibly empty raised fist is contact none and palm not_open; an open palm is NOT required for a free raised hand. Do not invent a hidden item inside a fist. If the hand interior or item is occluded and empty versus occupied is uncertain, use contact unclear. A cup/tablet/phone grip is held_object, even near the face, and is not an open palm. An object merely nearby is not evidence of a grip. Use surface_contact for a hand resting, pressing or typing ON a desk, keyboard, mouse, laptop, railing or another supported surface, WITHOUT a visible grip supporting that item in the hand. Touching or using a keyboard is NOT holding it. Do not invent a held item when fingers or the contact point are hidden. A hand touching or supporting the face, chin, cheek, mouth, head, shoulder, hair or clothing is body_or_clothing. Use none only when that hand is clearly empty and touching neither an object nor the body. Use palm open only when an extended palm/fingers are clearly visible; curved gripping fingers are not_open. For hidden, cropped or ambiguous parts use unclear ONLY for the unknown fields of that hand; still report the other hand’s visible height/contact. Never copy the other hand’s contact or infer a hidden hand from the original image or a planned action. Record only visible evidence; do not infer emotion, transitions or an object’s name. Choose standing/seated only when visible legs, pelvis or seat establish it; an upright chest or high head alone is upper_body_only, not proof of standing.';

export type VisibleHand = {visibility?:'visible'|'not_visible'|'unclear';height:string;contact:string;palm:string};
export function normalizeVisibleHand(value: unknown, requireVisibility = false): VisibleHand {
  const h = value as VisibleHand;
  if (!h || typeof h !== 'object' || !['shoulder_or_above','below_shoulder','unclear'].includes(h.height) || !['held_object','surface_contact','body_or_clothing','none','unclear'].includes(h.contact) || !['open','not_open','unclear'].includes(h.palm)) throw new Error('Generated caption: invalid hand evidence');
  if ((requireVisibility || h.visibility !== undefined) && !['visible','not_visible','unclear'].includes(h.visibility ?? '')) throw new Error('Generated caption: invalid hand visibility');
  if (h.visibility === 'not_visible' || h.visibility === 'unclear') return {visibility:h.visibility,height:'unclear',contact:'unclear',palm:'unclear'};
  return {...(h.visibility === undefined ? {} : {visibility:h.visibility}),height:h.height,contact:h.contact,palm:h.palm};
}

/** Describe observed geometry/contact, never the requested action or an unsupported gesture enum. */
export function descriptionFromVisibleFacts(value: unknown, distance: number, requireVisibility = false): string {
  const people = (value as { people?: unknown })?.people;
  // Match the combined inspection's limit, including extra/duplicate people.
  if (!Array.isArray(people) || people.length > 12) throw new Error('Generated caption: invalid people facts');
  const postures: Record<string, string> = { standing: '立っている', seated: '座っている', upper_body_only: '上半身が写っている', unclear: '写っている' };
  const phrases = people.map(p => {
    if (!p || typeof p !== 'object' || !Object.hasOwn(postures, p.posture)) throw new Error('Generated caption: unknown visible fact');
    // Historical coarse hands enums have no evidence for free vs occupied: use posture only.
    if (p.leftHand === undefined && p.rightHand === undefined && ['both_raised','one_raised','one_open','low_or_hidden','unclear'].includes(p.hands)) return postures[p.posture];
    const observed = [normalizeVisibleHand(p.leftHand, requireVisibility), normalizeVisibleHand(p.rightHand, requireVisibility)];
    const raised = observed.filter(h => h.height === 'shoulder_or_above' && h.contact === 'none').length;
    const holding = observed.filter(h => h.contact === 'held_object').length;
    const surface = observed.filter(h => h.contact === 'surface_contact').length;
    // Height remains useful even when contact is occupied or unknown. Describe that
    // geometry statically; a high cup grip is not evidence of a free-hand gesture.
    const highHolding = observed.some(h => h.height === 'shoulder_or_above' && h.contact === 'held_object');
    const highUnknown = observed.filter(h => h.height === 'shoulder_or_above' && h.contact === 'unclear').length;
    const contactPhrase = () => {
      if (raised === 2) return '両手を上げている';
      if (raised === 1) return holding ? (highHolding ? '片手を上げ、物を持つもう片方の手が肩以上の高さにある' : '片手を上げ、もう片方の手で物を持っている') : surface ? '片手を上げ、もう片方の手を物に添えている' : '片手を上げている';
      const touching = observed.filter(h => h.contact === 'body_or_clothing').length;
      if (touching) return holding && touching === 1 ? (highHolding ? '片手を体に添え、物を持つもう片方の手が肩以上の高さにある' : '片手を体に添え、もう片方の手で物を持っている') : '手を体に添えている';
      if (holding) return surface ? (highHolding ? '物を持つ片手が肩以上の高さにあり、もう片方の手を物に添えている' : '片手で物を持ち、もう片方の手を物に添えている') : highHolding ? '物を持つ手が肩以上の高さにある' : '物を持っている';
      const open = observed.filter(h => h.palm === 'open' && h.contact === 'none').length;
      if (open) return open === 2 ? '両手を開いている' : '片手を開いている';
      if (surface) return surface === 2 ? '両手を物に添えている' : '片手を物に添えている';
      return postures[p.posture];
    };
    const phrase = contactPhrase();
    return highUnknown ? `${phrase}。${highUnknown === 2 ? '両手' : '片手'}が肩以上の高さにある` : phrase;
  });
  const text = phrases.length === 0 ? '室内の様子が写っている。' : phrases.length === 1 ? (phrases[0] === postures.upper_body_only ? `人物の${phrases[0]}。` : `人物が${phrases[0]}。`) : `${phrases.length}人の人物が写っている。` + phrases.map((p, i) => `${i + 1}人目は${p}。`).join('');
  return withJapaneseSpan(text, distance);
}

export async function describeGeneratedImage(image: string, distance: number, signal?: AbortSignal): Promise<string> {
  const url = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const b64 = image.match(/^data:image\/[^;]+;base64,(.+)$/)?.[1];
  if (!b64) throw new Error('Generated caption: invalid image');
  const response = await fetch(`${url}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.VLM_MODEL, images: [b64], stream: false, think: false, format: { type: 'object', properties: { people: { type: 'array', maxItems: 8, items: { type: 'object', properties: VISIBLE_PERSON_FIELDS, required: ['posture','leftHand','rightHand'], additionalProperties: false } } }, required: ['people'], additionalProperties: false }, keep_alive: '5m',
      prompt: 'Look only at this finished image. Return JSON with a people array in left-to-right order; each person has posture, leftHand and rightHand. Count all actual visible people, including cropped people at edges; ignore images on screens or posters. Return an empty array for an empty room. ' + VISIBLE_HAND_INSTRUCTION,
      options: { temperature: 0, num_predict: 1024, num_ctx: sharedOllamaContextLength() } }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Generated caption: HTTP ${response.status}`);
  const json = await response.json() as { response?: string; done_reason?: string };
  if (json.done_reason === 'length') throw new Error('Generated caption truncated');
  return descriptionFromVisibleFacts(JSON.parse(json.response || '{}'), distance, true);
}
