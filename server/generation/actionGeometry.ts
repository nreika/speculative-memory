/** Describe the final geometry of a requested action without adding another action or changing identity. */
export function visibleActionGeometry(action:string,sourcePose?:string):string {
 let out=action;
 const stand=/\b(?:stands?\s+up|rises?|gets?\s+up)\s+from\s+(?:the|their|a)\s+(?:chair|seat)\b/gi;
 if(stand.test(out)){
  stand.lastIndex=0;
  // A translation may say "from the chair" even when the observed source is
  // standing. Only a positively known seated source justifies seat-relative geometry.
  const seated=typeof sourcePose==='string'&&/\b(?:seated|sitting|sits)\b/i.test(sourcePose)&&!/\b(?:not|unknown|unclear|standing)\b/i.test(sourcePose);
  out=out.replace(stand,seated
   ? 'stands fully upright, hips clear of the seat and torso extended vertically, with shoulders and head visibly higher than in the seated input'
   : 'stands fully upright with the torso extended vertically');
  out+=' During this posture change, previously empty hands remain empty and may move or touch a support surface as required by the requested action. Items supported by furniture keep their original support; do not pick them up unless requested. Already-gripped items stay in the same occupied hands.';
 }
 // Refine an ALREADY-requested free-hand gesture; do not turn generic excitement into a new arm action.
 out=out.replace(/lifts the free hand visibly to shoulder height with an open palm/gi,'lifts the free hand away from the torso to shoulder height, with its bent elbow and empty open palm clearly visible against the room, separated from hair and clothing');
 return out;
}
