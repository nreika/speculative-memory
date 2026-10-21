import {createHash} from 'node:crypto';
import type {PersonInfo} from './peopleDescribe';
import type {PeopleIntegrity} from './peopleIntegrity';
import {FIXED_LIGHTING,withoutLightingChanges,actionHandConflict} from './fidelity';
import {armsChangeAction,oneArmHoldingSentence} from './handConflict';

/** 2026-10-20: added reference people came out as miniatures standing on top of the desk monitors (20:34 live camera).
 *  Scale is judged from the input itself (floor, furniture, people at the same depth) so it holds for any camera height or angle. */
export const ADDED_PERSON_SCALE='Draw them at true adult size for their spot in this image, judged from the visible floor, furniture, doors and any existing people at the same depth (an adult is taller than a desk is high and much larger than a desk monitor at the same distance; nearer means larger). Their feet stand on the floor at that spot (the lower body may be hidden behind furniture). Never draw a small or miniature person, and never place a person on top of a desk, monitor or other furniture.';

export interface ScenePersonReference {
 contentId:string;imageDataUrl:string;people:PersonInfo[];imageNumber?:number;sha256:string;
 /** 'same-camera': a full frame from this fixed camera at another time, so its people keep their room position.
  *  'appearance-only': a portrait/crop/other view; the image carries appearance but no room position. */
 placement?:'same-camera'|'appearance-only';
}
export interface SourceIdentityImage {imageNumber:number;sourceIndexes:number[]}
export interface AllowedCastIdentity {
 id:string;origin:'source'|'reference';personIndex:number;imageNumber:number;contentId?:string;sha256?:string;
}
export interface SceneReferenceCast {
 originalSourceCount:number;expectedSceneTotal:number;allowedInventory:AllowedCastIdentity[];
 imageBindings:Array<{imageNumber:number;role:'source-scene'|'source-identity'|'added-people';contentId?:string;sourceIndexes?:number[]}>;
}
export interface ReferenceCastIntegrity extends PeopleIntegrity {
 originalSourceCount:number;observedOriginalSourceCount:number|null;expectedInventoryCount:number;
 outputToInventoryIds:string[];allowedInventory:AllowedCastIdentity[];
}
const idPattern=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const plain=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const imageNumber=(x:unknown):x is number=>Number.isInteger(x)&&Number(x)>=2&&Number(x)<=16;
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
function validatePeople(value:unknown):asserts value is PersonInfo[] {
 if(!Array.isArray(value)||value.length>8)throw Error('Invalid cast people');
 for(const p of value){
  if(!plain(p)||['position','pose','clothes','facing'].some(k=>typeof p[k]!=='string'||String(p[k]).length>256))throw Error('Invalid cast person description');
  for(const k of ['hair','holding','worn'])if(p[k]!==undefined&&(typeof p[k]!=='string'||String(p[k]).length>512))throw Error('Invalid cast person detail');
 }
}
/** Validate private, pinned image bytes. This does not certify distinct human identities. */
export function castImageBytes(data:unknown):Buffer {
 if(typeof data!=='string'||data.length>12*1024*1024)throw Error('Invalid cast image');
 const m=/^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
 if(!m)throw Error('Invalid cast image');
 const bytes=Buffer.from(m[1],'base64');
 if(!bytes.length||bytes.length>8*1024*1024||bytes.toString('base64')!==m[1])throw Error('Invalid cast image bytes');
 return bytes;
}
/** Roster contains no image bytes or arbitrary caller fields; source faces keep reserved slots. */
export function buildSceneReferenceCast(sourcePeople:PersonInfo[],references:ScenePersonReference[],sourceIdentityImages:SourceIdentityImage[]=[]):SceneReferenceCast {
 validatePeople(sourcePeople);
 if(!Array.isArray(references)||references.length<1||references.length>15||!Array.isArray(sourceIdentityImages)||sourceIdentityImages.length>15)throw Error('Invalid cast references');
 const inventory:AllowedCastIdentity[]=sourcePeople.map((_,i)=>({id:'source:'+i,origin:'source',personIndex:i,imageNumber:1}));
 const bindings:SceneReferenceCast['imageBindings']=[{imageNumber:1,role:'source-scene'}],usedSlots=new Set([1]),ids=new Set<string>(),hashes=new Set<string>();
 for(const image of sourceIdentityImages){
  if(!plain(image)||!imageNumber(image.imageNumber)||usedSlots.has(image.imageNumber)||!Array.isArray(image.sourceIndexes)||!image.sourceIndexes.length||new Set(image.sourceIndexes).size!==image.sourceIndexes.length||image.sourceIndexes.some(i=>!Number.isInteger(i)||Number(i)<0||Number(i)>=sourcePeople.length))throw Error('Invalid source identity image binding');
  usedSlots.add(image.imageNumber);bindings.push({imageNumber:image.imageNumber,role:'source-identity',sourceIndexes:[...image.sourceIndexes]});
 }
 // Reserve explicit reference slots before assigning omitted ones, independently of array order.
 for(const ref of references)if(ref?.imageNumber!==undefined){if(!imageNumber(ref.imageNumber)||usedSlots.has(ref.imageNumber))throw Error('Reference image slot collision');usedSlots.add(ref.imageNumber);}
 for(const ref of references){
  if(!plain(ref)||typeof ref.contentId!=='string'||!idPattern.test(ref.contentId)||ids.has(ref.contentId))throw Error('Invalid or duplicate reference contentId');
  ids.add(ref.contentId);validatePeople(ref.people);if(!ref.people.length)throw Error('A person reference requires an observed person');
  const bytes=castImageBytes(ref.imageDataUrl),sha=createHash('sha256').update(bytes).digest('hex');
  if(typeof ref.sha256!=='string'||!/^([a-f0-9]{64})$/i.test(ref.sha256)||ref.sha256.toLowerCase()!==sha||hashes.has(sha))throw Error('Reference image hash mismatch or duplicate image');
  hashes.add(sha);
  let slot=ref.imageNumber;
  if(slot===undefined){slot=Array.from({length:15},(_,i)=>i+2).find(n=>!usedSlots.has(n));if(slot===undefined)throw Error('No cast image slot available');usedSlots.add(slot);}
  bindings.push({imageNumber:slot,role:'added-people',contentId:ref.contentId});
  ref.people.forEach((_,i)=>inventory.push({id:'ref:'+ref.contentId+':'+i,origin:'reference',personIndex:i,imageNumber:slot!,contentId:ref.contentId,sha256:sha}));
 }
 bindings.sort((a,b)=>a.imageNumber-b.imageNumber);
 // The encoder consumes a dense ordered image list, not the names of empty slots.
 if(bindings.some((b,i)=>b.imageNumber!==i+1))throw Error('Image bindings must be contiguous; omit imageNumber for automatic slots');
 return freeze({originalSourceCount:sourcePeople.length,expectedSceneTotal:inventory.length,allowedInventory:inventory,imageBindings:bindings});
}
/** A matching head count alone never grants permission: every allowed identity must occur once. */
export function parseSceneReferenceCastIntegrity(raw:unknown,cast:SceneReferenceCast):ReferenceCastIntegrity {
 if(!cast||!Number.isInteger(cast.originalSourceCount)||cast.originalSourceCount<0||!Number.isSafeInteger(cast.expectedSceneTotal)||cast.expectedSceneTotal<1||!Array.isArray(cast.allowedInventory)||cast.allowedInventory.length!==cast.expectedSceneTotal||new Set(cast.allowedInventory.map(x=>x.id)).size!==cast.expectedSceneTotal||cast.allowedInventory.filter(x=>x.origin==='source').length!==cast.originalSourceCount||cast.allowedInventory.some(x=>x.origin==='source'?x.id!=='source:'+x.personIndex||!Number.isInteger(x.personIndex)||x.personIndex<0||x.personIndex>=cast.originalSourceCount:x.origin!=='reference'||!idPattern.test(x.contentId??'')||!Number.isInteger(x.personIndex)||x.personIndex<0||x.id!==`ref:${x.contentId}:${x.personIndex}`))throw Error('Invalid reference cast roster');
 const base={sourceCount:cast.originalSourceCount,originalSourceCount:cast.originalSourceCount,expectedInventoryCount:cast.expectedSceneTotal,allowedInventory:cast.allowedInventory.map(x=>({...x}))};
 const unknown=(reason:string):ReferenceCastIntegrity=>({...base,ok:null,observedOriginalSourceCount:null,outputToSource:[],outputToInventoryIds:[],reason});
 let value:unknown=raw;try{if(typeof value==='string')value=JSON.parse(value);}catch{return unknown('Invalid reference inventory answer');}
 if(!plain(value)||!Number.isSafeInteger(value.originalSourceCount)||Number(value.originalSourceCount)<0||!Array.isArray(value.people)||value.people.length>cast.expectedSceneTotal+1||value.people.some(p=>!plain(p)||typeof p.inventoryId!=='string'||p.inventoryId.length>160))return unknown('Incomplete reference inventory answer');
 const allowed=new Map(cast.allowedInventory.map(x=>[x.id,x]));
 const mapped=value.people.map(p=>allowed.has(p.inventoryId)?p.inventoryId:'unknown');
 const ok=value.originalSourceCount===cast.originalSourceCount&&mapped.length===cast.expectedSceneTotal&&new Set(mapped).size===cast.expectedSceneTotal&&mapped.every(id=>allowed.has(id));
 return {...base,ok,observedOriginalSourceCount:Number(value.originalSourceCount),outputToInventoryIds:mapped,outputToSource:mapped.map(id=>{const member=allowed.get(id);return member?.origin==='source'?member.personIndex:-1;}),reason:ok?'Every source and explicitly referenced identity appears once':'Missing, duplicate, unrequested or uncertain cast identity'};
}
/** Dedicated positive instruction: never appends the legacy SAME-original/count-only constraints. */
export function composeSceneReferenceCastInstruction(args:{sourcePeople:PersonInfo[];references:ScenePersonReference[];sourceIdentityImages?:SourceIdentityImage[];predictionPrompt:string}):string {
 const cast=buildSceneReferenceCast(args.sourcePeople,args.references,args.sourceIdentityImages);
 if(typeof args.predictionPrompt!=='string'||args.predictionPrompt.length>8000)throw Error('Invalid cast action');
 const plainAction=withoutLightingChanges(args.predictionPrompt).trim();if(!plainAction)throw Error('Missing cast action');
 // A source person's both-hands object while the action needs a hand: carried on one arm, never a third hand.
 const conflict=actionHandConflict(plainAction,args.sourcePeople);
 const action=armsChangeAction(plainAction,conflict);
 const carrying=(p:PersonInfo)=>conflict&&conflict.person===p?`, carrying the ${conflict.item} against the body with one arm only${conflict.rest?` and ${conflict.rest}`:''}`:p.holding?`, carrying ${p.holding}`:'';
 const facts=(p:PersonInfo)=>`${p.clothes||'appearance as pictured'}, ${p.position||'position unknown'}, ${p.facing&&p.facing!=='unknown'?p.facing:'direction unknown'}${p.hair?`, hair: ${p.hair}`:''}${carrying(p)}${p.worn?`, wearing ${p.worn}`:''}`;
 const originals=args.sourcePeople.map((p,i)=>`${'source:'+i}: image1 original person ${i+1}, ${facts(p)}. Preserve this original individual's identity, visible face/hair, face visibility, clothing and original belongings; their requested pose may change. source:${i} keeps only image1's own face, hair and clothing; never give source:${i} a face, hairstyle, headwear, clothing or belongings from any reference image.`);
 // Where the added body goes. Without an explicit spot the model tends to repaint the only body it has.
 const sourceSpots=args.sourcePeople.map(p=>p.position).filter(Boolean).join('; ')||'their image1 positions';
 const placement=(ref:ScenePersonReference,p:PersonInfo,n:number)=>ref.placement==='same-camera'
  ?`image${n} is a full frame from this same fixed camera at another time: place this person where they stand in image${n}${p.position?` (${p.position})`:''}, at that spot's real size, as a separate full body next to the image1 people.`
  :`image${n} shows this person's appearance only, not a room position: place them as a separate, complete person (head, body, arms and legs) at a free floor or seat area of the image1 room, apart from the source people at ${sourceSpots}; they must not overlap, replace or merge with any source person. ${ADDED_PERSON_SCALE}`;
 const refs=args.references.flatMap(ref=>ref.people.map((p,i)=>{const member=cast.allowedInventory.find(x=>x.id===`ref:${ref.contentId}:${i}`)!;return `${member.id}: image${member.imageNumber}, reference person ${i+1} identified by the following observed facts, ${facts(p)}. Add this specific individual once as a real person sharing the image1 room; ${placement(ref,p,member.imageNumber)} Synthesize their pose, scale and occlusion in the same photograph. Preserve this reference individual's identity and visible appearance; their face and hair stay on this added person only. Do not paste a rectangular photo or import the reference room/background.`;}));
 const identityImages=cast.imageBindings.filter(b=>b.role==='source-identity').map(b=>`image${b.imageNumber} supplies identity detail only for ${b.sourceIndexes!.map(i=>'source:'+i).join(', ')}; it grants no additional person.`);
 return `Use image1 as the scene, camera and original-person source. Requested action: ${action} Exactly ${cast.expectedSceneTotal} people are permitted: retain all ${cast.originalSourceCount} source people once and add only the ${cast.expectedSceneTotal-cast.originalSourceCount} explicitly referenced people once. ${[...originals,...identityImages,...refs].join(' ')} Keep identities separate; do not merge faces, transfer hair/clothes/belongings, retain an old body beside its moved copy, or invent another individual. Each person has exactly two arms and two hands; ${conflict?oneArmHoldingSentence(conflict.item,action)+' ':''}a held movable object may be put down or moved, and objects seen earlier in this room may appear, but never an object that was never in this room, a duplicate copy, or an added hand. Do not expose a hidden original face just to show the action. Preserve unrelated objects and original belongings; existing movable chairs may move naturally when the action requires it. ${FIXED_LIGHTING} Preserve the fixed camera, room structure and screen contents. The scene contains only this allowed cast; all other reference portraits or implied people are excluded.`;
}
