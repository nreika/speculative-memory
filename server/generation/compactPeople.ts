import type {PersonInfo} from './peopleDescribe';
import {FIXED_LIGHTING,actionWithBelongings,withoutLightingChanges,uniqueActionPerson} from './fidelity';
import {visibleActionGeometry} from './actionGeometry';
import {handConflict,oneArmOwnerFact} from './handConflict';

/** Keep movement inflections consistent with peopleEditRegion's relocation bypass. */
export function isRelocationAction(action:string):boolean {
 return /\b(?:walk\w*|leav\w*|cross\w*|run(?:s|ning)?|step(?:s|ping)?)\b|\bmov(?:e|es|ing)\s+(?:to|toward|across)/i.test(action);
}

/** G-02 behind-view freeze: only for the recent-person-from-behind path. */
export const BACK_FACING_FREEZE='Their back remains toward the camera, with their face hidden.';
/** Ordinary occupied scenes: never reveal more face, but do not freeze the body back-facing (G-15 itself stays in noNewFaceRule). */
export const NO_MORE_FACE='Do not reveal more of the face than is visible in the input.';
function facingSentence(facing:string|undefined,behindView:boolean):string {
 const f=(facing??'').trim();
 if(!f||/^unknown$/i.test(f))return '';
 return /away|back/i.test(f)?(behindView?BACK_FACING_FREEZE:NO_MORE_FACE):'';
}

/** One action followed by source-specific constraints, without restating the same rules many times.
 * behindView: true only on the recent-person-from-behind path (G-02); it alone enables the back-facing freeze. */
/** references: identity references are actually attached (the Image2/image3 sentence is emitted only then). */
export function compactPeopleInstruction(people:PersonInfo[],count:number,prediction:string,behindView=false,references=false):string {
 const action=visibleActionGeometry(actionWithBelongings(withoutLightingChanges(prediction),people),uniqueActionPerson(prediction,people)?.pose);
 const relocation=isRelocationAction(action);
 // The actor whose action needs a hand that holds a both-hands object: no "same hand" sentence for that object.
 const conflict=handConflict(uniqueActionPerson(prediction,people),prediction);
 const holdingFact=(p:PersonInfo)=>{
  if(!p.holding)return '';
  if(conflict&&conflict.person===p)return `${oneArmOwnerFact(conflict.item)}${conflict.rest?` Keep ${conflict.rest} with this owner, in the same hand; the item moves together with that hand.`:''}`;
  return `Keep ${p.holding} with this owner, in the same hand; the item moves together with that hand.`;
 };
 const facts=people.map((p,i)=>`Original person ${i+1}: ${p.clothes}, ${p.position}${p.facing&&!/^unknown$/i.test(p.facing)?`, facing ${p.facing}`:''}. ${relocation?'Replace their old body completely at the new position.':`Keep this individual in the same ${p.position} area and replace only their current pose.`} ${holdingFact(p)} ${p.worn?`Keep ${p.worn} attached.`:''} ${facingSentence(p.facing,behindView)}`).join(' ');
 return `Edit the existing ${count===1?'single person':count+' people'} in image1. Replace the original pose with this action: ${action} Exactly ${count} original ${count===1?'person remains':'people remain'} in the entire image, each appearing once. ${facts}${references?' Image2/image3 are identity references for the SAME original people, showing face/hair only.':''} Preserve the visible face, hair length and hair colour; keep heads cut off by the original frame cut off. ${FIXED_LIGHTING} Keep the fixed camera, room architecture and screen contents exactly unchanged. Preserve unrelated objects. Existing movable furniture, including chairs, may move or rotate naturally when the requested action and visible physical support justify it; otherwise leave it in place. Preserve each original object's identity, count and real-world size. Each held object remains only with its original owner; never create another copy. Each person has two arms and two hands.`;
}
