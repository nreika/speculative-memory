import {imageSize,headCropFor,parseHeadBox} from './referenceCrop';
import {createHash} from 'node:crypto';
import type {PersonInfo} from './peopleDescribe';
import {parseScenePersonReferences,type ObservedPersonReferences} from '../scenePersonReferenceAssets';
import {buildSceneReferenceCast,castImageBytes,composeSceneReferenceCastInstruction,type ScenePersonReference,type SourceIdentityImage,type SceneReferenceCast} from './sceneReferenceCast';
const sceneKeys=['gen_a','gen_b','gen_c'] as const;
export function validateSceneReferenceRequest(raw:unknown,options:{count:number;imageBackend:string;engine:string;mobile?:boolean;sceneModes?:Partial<Record<typeof sceneKeys[number],string>>}){
 const parsed=parseScenePersonReferences(raw);
 for(const key of sceneKeys){if(!parsed[key]?.length)continue;
  if(options.mobile||options.imageBackend!=='local'||options.engine!=='qwen21-turbo')throw Error('Additional person references require the production local Turbo engine');
  if(sceneKeys.indexOf(key)>=options.count)throw Error('Person reference scene is outside imageCount');
  if(options.sceneModes?.[key]==='asset_only')throw Error('Person references cannot be added in asset-only mode');
 }
 return parsed;
}
export interface SourceCastIdentityImage {imageDataUrl:string;sourceIndexes:number[];crop?:{x:number;y:number;width:number;height:number}}
/** Original portraits are never assigned to a person by their array slot alone. */
export function sourceCastIdentityImages(sourceImage:string,people:PersonInfo[],explicitPortraits:string[],size:{width:number;height:number}|null):SourceCastIdentityImage[]{
 if(explicitPortraits.length){
  if(people.length!==1)throw Error('Explicit original portraits require verified per-person bindings for a multi-person cast');
  return explicitPortraits.map(imageDataUrl=>({imageDataUrl,sourceIndexes:[0]}));
 }
 return size?people.flatMap((person,i)=>{const crop=usableHeadCrop(person.headBox,size);return crop?[{imageDataUrl:sourceImage,sourceIndexes:[i],crop}]:[];}):[];
}
/** A head box cut by the frame edge, or too small/flat to hold a face, is not an identity image:
 *  e.g. a 192x72 chin strip at the top edge was enlarged to 2048x768 and the added reference face
 *  was painted onto the original body. Such a person simply gets no identity crop. */
export const MIN_IDENTITY_CROP_PX=96;
export function usableHeadCrop(headBox:unknown,size:{width:number;height:number}){
 const box=parseHeadBox(headBox);if(!box)return undefined;
 const [x0,y0,x1,y1]=box,edge=8;
 if(x0<edge||y0<edge||x1>1000-edge||y1>1000-edge)return undefined;
 const crop=headCropFor(box,size.width,size.height);if(!crop)return undefined;
 const aspect=crop.width/crop.height;
 if(crop.width<MIN_IDENTITY_CROP_PX||crop.height<MIN_IDENTITY_CROP_PX||aspect<0.5||aspect>2)return undefined;
 return crop;
}
/** Same fixed camera at another time: a full frame with the source frame's aspect ratio. */
export function referencePlacement(ref:{width?:number;height?:number},source:{width:number;height:number}|null):'same-camera'|'appearance-only'{
 const w=Number(ref.width),h=Number(ref.height);
 if(!source||!(w>0&&h>0))return 'appearance-only';
 return Math.abs(w/h-source.width/source.height)<=0.01*(source.width/source.height)&&w>=source.width*0.5?'same-camera':'appearance-only';
}
export interface SceneReferenceArchiveMetadata {
 schema:1;originalSourceCount:number;expectedInventoryCount:number;
 allowedInventory:SceneReferenceCast['allowedInventory'];imageBindings:SceneReferenceCast['imageBindings'];
 references:Array<{contentId:string;sha256:string;peopleCount:number}>;
}
/** Explicit image-free exit whitelist. Never spread a resolved private reference into the archive. */
export function sceneReferenceArchiveMetadata(value:SceneReferenceArchiveMetadata):SceneReferenceArchiveMetadata {
 return {schema:1,originalSourceCount:value.originalSourceCount,expectedInventoryCount:value.expectedInventoryCount,
  allowedInventory:value.allowedInventory.map(p=>({id:p.id,origin:p.origin,personIndex:p.personIndex,imageNumber:p.imageNumber,...(p.contentId?{contentId:p.contentId}:{}),...(p.sha256?{sha256:p.sha256}:{})})),
  imageBindings:value.imageBindings.map(p=>({imageNumber:p.imageNumber,role:p.role,...(p.contentId?{contentId:p.contentId}:{}),...(p.sourceIndexes?{sourceIndexes:[...p.sourceIndexes]}:{})})),
  references:value.references.map(p=>({contentId:p.contentId,sha256:p.sha256,peopleCount:p.peopleCount}))};
}
/** Read-only source facts stay original-only. Cast permission and identity slots are scene-local. */
export function buildSceneReferenceInputs(args:{sourceImage:string;sourcePeople:PersonInfo[];sourceOk:boolean;references:NonNullable<ObservedPersonReferences['gen_a']>;identityImages:SourceCastIdentityImage[];predictionPrompt:string}){
 if(!args.references.length)return undefined;
 if(!args.sourceOk)throw Error('Original source person observation is unknown');
 if(1+args.identityImages.length+args.references.length>16)throw Error('Source, original identities and added references exceed sixteen image inputs');
 const originalSha=createHash('sha256').update(castImageBytes(args.sourceImage)).digest('hex');
 if(args.references.some(ref=>ref.sha256===originalSha))throw Error('Additional reference duplicates the source frame');
 const sourceIdentityImages:SourceIdentityImage[]=args.identityImages.map((p,i)=>({imageNumber:i+2,sourceIndexes:[...p.sourceIndexes]}));
 const sourceSize=imageSize(castImageBytes(args.sourceImage));
 const references:ScenePersonReference[]=args.references.map((ref,i)=>({contentId:ref.contentId,sha256:ref.sha256,imageDataUrl:ref.imageDataUrl,people:ref.people,imageNumber:2+args.identityImages.length+i,placement:referencePlacement(ref as {width?:number;height?:number},sourceSize)}));
 const cast=buildSceneReferenceCast(args.sourcePeople,references,sourceIdentityImages);
 const instruction=composeSceneReferenceCastInstruction({sourcePeople:args.sourcePeople,references,sourceIdentityImages,predictionPrompt:args.predictionPrompt});
 const fullRect=(size:{width:number;height:number}|null)=>{if(!size||![size.width,size.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=16384)||size.width*size.height>32*1024*1024)throw Error('Reference dimensions unknown; cannot create full-image crop');return {x:0,y:0,width:size.width,height:size.height};};
 // Existing face/hair crops stay untouched. Explicit whole-photo identities need measured PNG/JPEG size.
 // Additional references use the image decoder's pinned dimensions, including validated WebP.
 const crops=[...args.identityImages.map(p=>p.crop??fullRect(imageSize(castImageBytes(p.imageDataUrl)))),...args.references.map(ref=>fullRect(ref))];
 return {cast,instruction,references,sourceIdentityImages,
  referenceImages:[...args.identityImages.map(p=>p.imageDataUrl),...references.map(p=>p.imageDataUrl)],
  referenceCrops:crops,
  metadata:sceneReferenceArchiveMetadata({schema:1,originalSourceCount:cast.originalSourceCount,expectedInventoryCount:cast.expectedSceneTotal,allowedInventory:cast.allowedInventory,imageBindings:cast.imageBindings,references:references.map(p=>({contentId:p.contentId,sha256:p.sha256,peopleCount:p.people.length}))})};
}
