import {classifySingleActorCountAmbiguity,extraPeopleVerdict,type Detection} from './lightPeopleDetector';
import type {PeopleIntegrity} from './peopleIntegrity';

/** An overlapping part is uncertain evidence, never a corrected/certified count.
 * Reuse the existing inventory once; unknown, duplicates and missing people still fail.
 */
export async function inspectCountedImage(options:{
 detection:Detection;expectedPeople:number;sourceActors?:Array<{box:[number,number,number,number]}>;
 allowPartOverlap:boolean;inspect:()=>Promise<PeopleIntegrity>;
}){
 const {detection,expectedPeople}=options;
 const overlap=options.allowPartOverlap&&options.sourceActors
  ?classifySingleActorCountAmbiguity(detection,expectedPeople,options.sourceActors):null;
 const extra=extraPeopleVerdict(detection,expectedPeople);
 if(extra&&!overlap)return extra;
 // This is the same mandatory identity/caption call used on ordinary successful images.
 const verdict=await options.inspect();
 const strict=verdict.ok===true&&verdict.sourceCount===1&&Array.isArray(verdict.outputToSource)&&verdict.outputToSource.length===1&&verdict.outputToSource[0]===0;
 const checked=overlap&&!strict?{...verdict,ok:verdict.ok===null?null:false,reason:verdict.reason||'Single-person inventory could not be confirmed'}:verdict;
 return {...checked,detector:{count:detection.count,inferenceMs:detection.inferenceMs,elapsedMs:detection.elapsedMs,
  ...(overlap?{rawCountUnchanged:true,countAmbiguity:overlap,vetoDeferredToExistingInventory:true}:{} )}};
}
