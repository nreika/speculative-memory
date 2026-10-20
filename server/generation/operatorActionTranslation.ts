/** Keep image-space actor location separate from anatomical hand laterality. Pure text only. */
export type ActorImagePosition='left'|'right'|'center';
export function operatorActorPosition(text:string):{position?:ActorImagePosition;actionText:string}{
 const match=String(text).match(/^(?:画面|画像|写真)(?:の)?(左|右|中央)(?:側)?(?:に(?:いる|写っている|見える))?の?(?:人物|人|男性|女性)(?:が|は)?[、,\s]*/);
 if(!match)return {actionText:text};
 const actionText=text.slice(match[0].length).trim();
 // Never turn an incomplete subject into an instruction with a fabricated action.
 return actionText?{position:({左:'left',右:'right',中央:'center'} as const)[match[1] as '左'|'右'|'中央'],actionText}:{actionText:text};
}
export function personAtImagePosition<T extends {position:string}>(people:readonly T[],position:ActorImagePosition):T|undefined{
 const patterns={left:/\bleft\b|左/,right:/\bright\b|右/,center:/\bcent(?:er|re)\b|中央|真ん中/};
 const found=people.filter(person=>patterns[position].test(person.position)&&!Object.entries(patterns).some(([key,re])=>key!==position&&re.test(person.position)));
 return found.length===1?found[0]:undefined;
}
export function translatedOperatorAction(original:string,translated:string,position?:ActorImagePosition):string{
 let action=translated.trim();
 // A location subject accidentally rendered as a hand modifier is not the action.
 if(position)action=action.replace(/^(?:the\s+)?(?:left|right)[ -]hand(?:ed)?\s+person\s+/i,'');
 const explicit={left:/左(?:の)?(?:手|腕)|\bleft[ -](?:hand|arm)\b/i.test(original),right:/右(?:の)?(?:手|腕)|\bright[ -](?:hand|arm)\b/i.test(original)};
 const paired=/(?:反対|もう片方|他方)の手|両手|\b(?:other|opposite) hand\b|\bboth hands\b/i.test(original);
 const generic=new Map<string,string>();
 action=action.replace(/\b(left|right)[ -]hand(s?)\b/gi,(whole,rawSide:string,plural:string)=>{
  const side=rawSide.toLowerCase() as 'left'|'right';if(explicit[side])return whole;
  if(plural)return 'hands';
  if(!generic.has(side))generic.set(side,paired&&(generic.size>0||explicit.left||explicit.right)?'the other hand':'one hand');
  return generic.get(side)!;
 });
 return action.replace(/(^|[,;]\s*|\band\s+)(one hand|the other hand|left hand|right hand)\s+(slightly\s+)?(raises|places|rests|moves|lowers|lifts)(?=\s|[,;.]|$)/gi,(_all,prefix,hand,degree,verb)=>`${prefix}${degree??''}${verb} ${hand}`);
}
export function positionedActorSubject(position:ActorImagePosition,clothes?:string):string{
 const location=position==='center'?'in the center of the image':`on the ${position} side of the image`;
 return `The existing person ${location}${clothes?.trim()?` wearing ${clothes.trim().replace(/^(?:a|an|the)\s+/i,'')}`:''}`;
}

