import type {PersonInfo} from './peopleDescribe';

/**
 * Held-object / hand-action conflict (2026-10-19, rulebook v19 third-hand images Gen_b_14-05-26 and Gen_b_14-06-42):
 * the action needed a free hand ("raises one hand lightly") while the same prompt kept the tablet "in both hands, with
 * the original hand grip" / "in the same hand". With both hands committed the image model adds a third hand.
 * When this conflict exists the holding sentences are rewritten so the object stays (held with one arm) and the other
 * hand performs the action. An object held in one hand, with the action able to use the other, keeps today's text.
 * Pure text; no model call.
 */

/** Gesture verbs that always use a hand. */
const HAND_GESTURE=/\b(?:wav(?:e|es|ed|ing)|point(?:s|ed|ing)?|beckon\w*|salut(?:e|es|ed|ing)|clap(?:s|ped|ping)?|high[- ]fiv\w*|thumbs?[- ]up|gestur(?:e|es|ed|ing)|touch(?:es|ed|ing)?|tap(?:s|ped|ping)?|reach(?:es|ed|ing)?|grab(?:s|bed|bing)?|pick(?:s|ed|ing)?\s+up|scratch\w*|cover(?:s|ed|ing)?\s+(?:the|his|her|their)\s+mouth)\b/i;
/** Verbs that use a hand only when a hand/arm/palm is named nearby ("lifts the tablet" with both hands is no conflict). */
const HAND_VERB=/\b(?:rais(?:e|es|ed|ing)|lift(?:s|ed|ing)?|plac(?:e|es|ed|ing)|put(?:s|ting)?|rest(?:s|ed|ing)?|extend(?:s|ed|ing)?|stretch(?:es|ed|ing)?|hold(?:s|ing)?\s+up|put(?:s|ting)?\s+up|lay(?:s|ing)?)\b(?:\s+\S+){0,4}?\s+(?:hands?|arms?|palms?|fingers?|fists?)\b/i;
/** The prediction asks for a hand (raise / wave / place / point / touch ...). Only the action text before
 * the "Hand use:" note is read (that note may name hands of a different kind). */
export function actionNeedsHand(action:string):boolean {
 const a=String(action??'').split(/\bHand use:/i)[0];
 return HAND_GESTURE.test(a)||HAND_VERB.test(a);
}

const BOTH_HANDS=/\b(?:in|with|using|between)\s+(?:both|two)\s+(?:hands|arms)\b|\bboth\s+(?:hands|arms)\b/i;
const ARMS_COMMITTED=/\barms?\s+(?:crossed|folded)\b|\b(?:crossed|folded)\s+arms\b|\bcross(?:es|ed|ing)?\s+(?:the|his|her|their)?\s*arms\b|\bhug(?:s|ged|ging)?\b|\bcradl\w*|\bembrac\w*|\bclutch\w*\s+(?:\S+\s+){0,3}?(?:to|against)\s+(?:the|his|her|their)?\s*chest\b/i;
const HAND_PHRASE=/\s*,?\s*(?:(?:held\s+)?(?:in|with|using|between)\s+(?:both|two|the\s+left|the\s+right|left|right|one)\s+(?:hands?|arms?)|(?:with\s+)?(?:(?:his|her|their)\s+)?arms?\s+(?:crossed|folded)|(?:hugged|cradled|clutched|held)\s+(?:to|against)\s+(?:the|his|her|their)?\s*(?:chest|body))\b/gi;

/** One holding entry per item ("black tablet in both hands and pen in right hand"). */
function holdingParts(holding:string):string[] {return holding.split(/(?<=\b(?:hands?|arms?|chest|body))\s+and\s+/i).map(s=>s.trim()).filter(Boolean);}
/** "black tablet in both hands" -> "black tablet". */
export function heldItemName(part:string):string {
 return part.replace(HAND_PHRASE,'').replace(/^(?:a|an|the)\s+/i,'').replace(/[\s,.;]+$/,'').trim();
}

export type HandConflict={person:PersonInfo;item:string;rest:string};
/** The holding of `person` commits both hands/arms to one object (both hands, arms crossed, hugging). */
export function bothArmsHolding(person:PersonInfo):{item:string;rest:string}|null {
 const holding=String(person.holding??'').trim();
 if(!holding||/^(?:nothing|none)$/i.test(holding))return null;
 const parts=holdingParts(holding);
 let idx=parts.findIndex(p=>BOTH_HANDS.test(p)||ARMS_COMMITTED.test(p));
 if(idx<0&&parts.length===1){
  const fact=(person.holdingFacts??[]).some(f=>f.hand==='both'&&f.evidence==='hand_supported');
  if(fact||ARMS_COMMITTED.test(person.pose??''))idx=0;
 }
 if(idx<0)return null;
 const item=heldItemName(parts[idx]);
 if(!item)return null;
 return {item,rest:parts.filter((_,i)=>i!==idx).join(' and ')};
}
/** The conflict for the action's person, or null (no hand action, or the object leaves a hand free). */
export function handConflict(person:PersonInfo|undefined,action:string):HandConflict|null {
 if(!person||!actionNeedsHand(action))return null;
 const held=bothArmsHolding(person);
 return held?{person,...held}:null;
}

/** How the free hand performs the action, for "the other hand ...". */
export function otherHandClause(action:string):string {
 const a=String(action??'').split(/\bHand use:/i)[0];
 const deg=(a.match(/\b(lightly|slightly|gently|high|briefly)\b/i)?.[1]??'').toLowerCase();
 const d=deg?` ${deg}`:'';
 if(/\bwav/i.test(a))return `waves${d}`;
 if(/\bpoint/i.test(a))return 'points';
 if(/\b(?:rais|lift|hold(?:s|ing)?\s+up|put(?:s|ting)?\s+up)/i.test(a))return `rises${d}`;
 if(/\b(?:plac|put|rest|lay)/i.test(a))return 'is placed as requested';
 if(/\btouch|\btap/i.test(a))return 'makes the requested touch';
 return 'performs the requested hand action';
}
/** The rewritten holding sentence, e.g. "The black tablet is now held against the body with one arm only; the other
 * hand rises lightly. Exactly two hands; no extra hand or arm." */
export function oneArmHoldingSentence(item:string,action:string):string {
 return `The ${item} is now held against the body with one arm only; the other hand ${otherHandClause(action)}. Exactly two hands; no extra hand or arm.`;
}
/** Short form for per-person fact lists ("Keep the black tablet with this owner, held against the body with one arm only."). */
export function oneArmOwnerFact(item:string):string {return `Keep the ${item} with this owner, held against the body with one arm only.`;}

/** Sentences that commit a hand the action needs; removed from fixed rule texts when a conflict exists. */
export const HAND_COMMITMENT=/\bin\s+both\s+hands\b|\boriginal\s+(?:hand\s+)?grips?\b|\bsame\s+hand\b|\binput\s+hand\s+grip\b/i;
/** Replacement for the fixed holdings rule's "same hand" sentence in the conflict case. */
export const ONE_ARM_RULE='An object that needed both hands is now held against the body with one arm, so the other hand is free for the requested action; never add a hand or arm.';
/** Drop every hand-commitment sentence of a fixed text and add ONE_ARM_RULE once (text unchanged when none matched). */
export function withoutHandCommitments(text:string|undefined):string {
 const t=String(text??'');
 const sentences=t.match(/[^.!?]+[.!?]*\s*/g)??[];
 const kept=sentences.filter(s=>!HAND_COMMITMENT.test(s));
 if(kept.length===sentences.length)return t;
 return (kept.join('').trim()+' '+ONE_ARM_RULE).trim();
}

/** The person holds the object with crossed arms / a hug / both arms (not just a two-hand grip). */
export function armsCrossedOrHug(person:PersonInfo):boolean {
 const holding=String(person.holding??''),pose=String(person.pose??'');
 return ARMS_COMMITTED.test(holding)||ARMS_COMMITTED.test(pose)||/\b(?:both|two)\s+arms\b/i.test(holding);
}
const RAISE_OR_WAVE=/\b(?:is\s+(?:raising|lifting|waving)|rais(?:e|es|ing)|lift(?:s|ing)?|wav(?:e|es|ing))\b/i;
/** The first sentence of the action, rewritten so the ARMS change (2026-10-19 third-hand follow-up): with both arms on one
 * object and a raise/wave action, the image model kept both arms on the object and drew a third hand. The action itself
 * (which the Main-change line repeats) now says "uncrosses the arms, keeps the <object> against the body with one arm,
 * and raises the other hand" (a two-hand grip: "takes one hand off the <object>, ..."). Unchanged otherwise. */
export function armsChangeAction(prediction:string,conflict:HandConflict|null):string {
 const text=String(prediction??'');
 if(!conflict)return text;
 const end=text.search(/[.!?](?=\s+["A-Z]|\s*$)/);
 const first=end<0?text:text.slice(0,end+1),rest=end<0?'':text.slice(end+1);
 const head=first.split(/\bHand use:/i)[0];
 if(/\bagainst the body with one arm\b/i.test(head))return text;
 const verb=head.match(RAISE_OR_WAVE);
 if(!verb||verb.index===undefined)return text;
 const subject=head.slice(0,verb.index).replace(/[\s,]+$/,'').trim()||'The person';
 const deg=(head.match(/\b(lightly|slightly|gently|high|briefly)\b/i)?.[1]??'').toLowerCase();
 const wave=/\bwav/i.test(head.slice(verb.index));
 const release=armsCrossedOrHug(conflict.person)?'uncrosses the arms':`takes one hand off the ${conflict.item}`;
 return `${subject} ${release}, keeps the ${conflict.item} against the body with one arm, and raises the other hand${wave?` to wave${deg?` ${deg}`:''}`:deg?` ${deg}`:''}; exactly two hands.${rest}`;
}
