import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import path from 'node:path';
import type {PeopleIntegrity} from './peopleIntegrity';

export interface Detection {count:number;persons:{score:number;box:number[]}[];candidates?:{score:number;box:number[]}[];inferenceMs:number;elapsedMs:number}
let worker:ChildProcessWithoutNullStreams|undefined;
let seq=0;
const pending=new Map<number,{resolve:(v:Detection)=>void;reject:(e:Error)=>void;started:number;timer:ReturnType<typeof setTimeout>}>();
process.once('exit',()=>worker?.kill());
function start(){
 if(worker)return worker;
 const python=process.env.PEOPLE_DETECTOR_PYTHON||path.join(process.env.USERPROFILE||'','Documents/ComfyUI/.venv/Scripts/python.exe');
 const script=process.env.PEOPLE_DETECTOR_SCRIPT||path.resolve('scripts/light-detector.py');
 const child=spawn(python,['-u',script],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 worker=child;
 const fail=(error:Error)=>{if(worker!==child)return;worker=undefined;for(const [id,p] of pending){clearTimeout(p.timer);p.reject(error);pending.delete(id);}};
 child.on('error',fail);child.on('exit',()=>fail(new Error('CPU person detector exited')));
 child.stdin.on('error',fail);
 let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-2000);});
 createInterface({input:child.stdout}).on('line',line=>{
  try{const result=JSON.parse(line);const p=pending.get(result.id);if(!p)return;
   pending.delete(result.id);clearTimeout(p.timer);
   if(result.error||!Number.isInteger(result.count)||!Array.isArray(result.persons))p.reject(new Error(result.error||'Invalid detector result'));
   else p.resolve({...result,elapsedMs:Date.now()-p.started});
  }catch{fail(new Error('Invalid detector output '+stderr));child.kill();}
 });
 return child;
}
export async function detectPeople(image:string,signal?:AbortSignal):Promise<Detection>{
 signal?.throwIfAborted();
 const bare=image.match(/^data:image\/[^;]+;base64,(.+)$/)?.[1];if(!bare)throw new Error('Invalid detector image');
 const child=start(),id=++seq;
 const result=await new Promise<Detection>((resolve,reject)=>{
  const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CPU person detector timeout'));child.kill();},15000);
  pending.set(id,{resolve,reject,started:Date.now(),timer});
  child.stdin.write(JSON.stringify({id,image:bare})+'\n',error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error);}});
 });
 signal?.throwIfAborted();return result;
}
export function extraPeopleVerdict(detection:Detection,expected:number):PeopleIntegrity|null{
 // A count cannot establish identity. This is only an independent extra-person veto.
 if(detection.count<=expected)return null;
 return {ok:false,sourceCount:expected,outputToSource:Array(detection.count).fill(-1),reason:`CPU detector: expected ${expected} people, found ${detection.count}; ${detection.elapsedMs}ms`};
}
export function stopPeopleDetector(){worker?.kill();}

/** A narrow ambiguity classifier, never a count correction or identity verdict. */
export function classifySingleActorPartOverlap(d:Detection,expectedPeople:number,sourceActors:ReadonlyArray<{box:readonly number[]}>){
 if(expectedPeople!==1||sourceActors.length!==1||d.count!==2||d.persons.length!==2)return null;
 if(d.persons.some(p=>!Array.isArray(p.box)||p.box.length!==4))return null;
 const xywh=(b:readonly number[])=>b.length===4&&b.every(Number.isFinite)&&b[2]>0&&b[3]>0;
 const fromXYXY=(b:number[])=>[b[0],b[1],b[2]-b[0],b[3]-b[1]];
 const source=sourceActors[0].box;if(!xywh(source))return null;
 const persons=d.persons.map(p=>({score:p.score,box:fromXYXY(p.box)})).sort((a,b)=>b.score-a.score);
 if(persons.some(p=>!Number.isFinite(p.score)||p.score<.5||p.score>1||!xywh(p.box)))return null;
 const [primary,secondary]=persons;
 if(primary.score<.85||secondary.score>.65)return null;
 const area=(b:readonly number[])=>b[2]*b[3];
 const intersection=(a:readonly number[],b:readonly number[])=>Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));
 const distance=(a:readonly number[],b:readonly number[])=>Math.hypot(a[0]+a[2]/2-b[0]-b[2]/2,a[1]+a[3]/2-b[1]-b[3]/2)/Math.max(Math.hypot(a[2],a[3]),Math.hypot(b[2],b[3]));
 const overlap=intersection(primary.box,secondary.box),areaRatio=area(secondary.box)/area(primary.box),secondaryContained=overlap/area(secondary.box),normalizedCenterDistance=distance(primary.box,secondary.box);
 const sourceIntersection=intersection(source,primary.box),sourceOverlap=sourceIntersection/(area(source)+area(primary.box)-sourceIntersection),sourceCenterDistance=distance(source,primary.box);
 if(![overlap,areaRatio,secondaryContained,normalizedCenterDistance,sourceIntersection,sourceOverlap,sourceCenterDistance].every(Number.isFinite))return null;
 if(areaRatio>.35||secondaryContained<.70||normalizedCenterDistance>.40||sourceOverlap<.20||sourceCenterDistance>.45)return null;
 return {kind:'single-actor-part-overlap-uncertain',rawDetectorCount:d.count,primaryScore:primary.score,secondaryScore:secondary.score,primaryBox:primary.box,secondaryBox:secondary.box,areaRatio,secondaryContained,normalizedCenterDistance,sourceOverlap,sourceCenterDistance,countUncertain:true,identityProof:false,requiresInventoryConfirmation:true,thresholds:{minimumPrimaryScore:.85,secondaryScoreRange:[.5,.65],maximumAreaRatio:.35,minimumSecondaryContained:.70,maximumCenterDistance:.40,minimumSourceOverlap:.20,maximumSourceCenterDistance:.45}};
}

/** Near-duplicate body boxes can be an NMS boundary or two overlapping people.
 * This classification permits mandatory inventory inspection, never count success. */
export function classifySingleActorNearDuplicateOverlap(d:Detection,expectedPeople:number,sourceActors:ReadonlyArray<{box:readonly number[]}>){
 if(expectedPeople!==1||sourceActors.length!==1||d.count!==2||d.persons.length!==2)return null;
 if(d.persons.some(p=>!Array.isArray(p.box)||p.box.length!==4))return null;
 const valid=(b:readonly number[])=>b.length===4&&b.every(Number.isFinite)&&b[2]>0&&b[3]>0;
 const source=sourceActors[0].box;if(!valid(source))return null;
 const persons=d.persons.map(p=>({score:p.score,box:[p.box[0],p.box[1],p.box[2]-p.box[0],p.box[3]-p.box[1]]})).sort((a,b)=>b.score-a.score);
 if(persons.some(p=>!Number.isFinite(p.score)||p.score<.5||p.score>1||!valid(p.box)))return null;
 const [primary,secondary]=persons;if(primary.score<.70||secondary.score<.60)return null;
 const area=(b:readonly number[])=>b[2]*b[3];
 const intersection=(a:readonly number[],b:readonly number[])=>Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));
 const distance=(a:readonly number[],b:readonly number[])=>Math.hypot(a[0]+a[2]/2-b[0]-b[2]/2,a[1]+a[3]/2-b[1]-b[3]/2)/Math.max(Math.hypot(a[2],a[3]),Math.hypot(b[2],b[3]));
 const largerHeight=Math.max(primary.box[3],secondary.box[3]),topDifference=Math.abs(primary.box[1]-secondary.box[1])/largerHeight,bottomDifference=Math.abs(primary.box[1]+primary.box[3]-secondary.box[1]-secondary.box[3])/largerHeight;
 const heightRatio=secondary.box[3]/primary.box[3],areaRatio=area(secondary.box)/area(primary.box),overlap=intersection(primary.box,secondary.box),boxIou=overlap/(area(primary.box)+area(secondary.box)-overlap),normalizedCenterDistance=distance(primary.box,secondary.box);
 const sourceIntersection=intersection(source,primary.box),sourceOverlap=sourceIntersection/(area(source)+area(primary.box)-sourceIntersection),sourceCenterDistance=distance(source,primary.box);
 if(![largerHeight,topDifference,bottomDifference,heightRatio,areaRatio,overlap,boxIou,normalizedCenterDistance,sourceIntersection,sourceOverlap,sourceCenterDistance].every(Number.isFinite))return null;
 if(topDifference>.10||bottomDifference>.10||heightRatio<.8||heightRatio>1.25||boxIou<.40||normalizedCenterDistance>.25||areaRatio<.5||areaRatio>1||sourceOverlap<.20||sourceCenterDistance>.45)return null;
 return {kind:'near-duplicate-body-overlap-uncertain',rawDetectorCount:d.count,primaryScore:primary.score,secondaryScore:secondary.score,primaryBox:primary.box,secondaryBox:secondary.box,topDifference,bottomDifference,heightRatio,areaRatio,boxIou,normalizedCenterDistance,sourceOverlap,sourceCenterDistance,countUncertain:true,identityProof:false,requiresInventoryConfirmation:true,thresholds:{minimumPrimaryScore:.70,minimumSecondaryScore:.60,maximumAlignedEdgeDifference:.10,heightRatioRange:[.8,1.25],minimumBoxIou:.40,maximumCenterDistance:.25,areaRatioRange:[.5,1],minimumSourceOverlap:.20,maximumSourceCenterDistance:.45}};
}

/** Keep both narrow deferrals explicit; extraPeopleVerdict itself remains strict. */
export function classifySingleActorCountAmbiguity(d:Detection,expectedPeople:number,sourceActors:ReadonlyArray<{box:readonly number[]}>){
 return classifySingleActorPartOverlap(d,expectedPeople,sourceActors)??classifySingleActorNearDuplicateOverlap(d,expectedPeople,sourceActors);
}
