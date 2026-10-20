import path from 'node:path';
import {imageSize} from './generation/referenceCrop';
import type {Detection} from './generation/lightPeopleDetector';
import {composeScenarioInputs,type ScenarioCompositionResult,type CompositionRect,type ComposedScenarioInput} from './scenarioComposition';
import {detectPeople} from './generation/lightPeopleDetector';
import type {PeopleEditRegion} from './generation/peopleEditRegion';
import {ScenarioControlValidationError,type ValidatedScenarioControl,type ScenarioSceneKey,type ScenarioSceneMode} from './scenarioControl';
import {withoutLightingChanges} from './generation/fidelity';

/** A sibling scene's asset must not change this scene's generation geometry. */
export function scenarioNeedsFullFrame(mode:ScenarioSceneMode|undefined,input:Pick<ComposedScenarioInput,'editRectangles'>|undefined):boolean {
 return mode==='asset_only'||Boolean(input?.editRectangles.length);
}

export function validateScenarioSceneCount(control:ValidatedScenarioControl|undefined,count:number):void {
 if(!control)return;
 for(const key of new Set([...Object.keys(control.sceneElements),...Object.keys(control.sceneModes??{})]))if(key.charCodeAt(4)-97>=count)throw new ScenarioControlValidationError('scenarioControl.sceneElements.'+key,'scene is outside imageCount');
}
export interface ScenarioAssetCheck {imageSha256:string;peopleCount:number;elapsedMs:number;evidence:'CPU negative is not proof of no people'}
export async function prepareScenarioInputs(nowImage:string,control:ValidatedScenarioControl,signal?:AbortSignal,options:{detectAsset?:typeof detectPeople;compose?:typeof composeScenarioInputs;detectSource?:typeof detectPeople}={}):Promise<{composition:ScenarioCompositionResult;assetChecks:ScenarioAssetCheck[];sourceDetection?:Detection}> {
 const assetChecks:ScenarioAssetCheck[]=[];
 const unique=new Map(Object.values(control.sceneElements).flatMap(elements=>elements??[]).map(e=>[e.imageSha256,e]));
 for(const element of unique.values()){
  const detection=await(options.detectAsset??detectPeople)(element.image,signal);
  if(detection.count>0)throw new ScenarioControlValidationError('scenarioControl.sceneElements','person-containing assets are unsupported; source people remain the only allowed people');
  assetChecks.push({imageSha256:element.imageSha256,peopleCount:detection.count,elapsedMs:detection.elapsedMs,evidence:'CPU negative is not proof of no people'});
 }
 let sourceDetection:Detection|undefined;
 if(Object.values(control.sceneModes??{}).includes('asset_only')){
  const bytes=Buffer.from(nowImage.split(',')[1]??'','base64');const size=imageSize(bytes);if(!size)throw new ScenarioControlValidationError('image','asset_only requires known source dimensions');
  sourceDetection=await(options.detectSource??detectPeople)(nowImage,signal);
  assertAssetOnlyTargets(control,size,sourceDetection);
 }
 const pythonPath=process.env.SCENARIO_COMPOSITION_PYTHON||process.env.PEOPLE_DETECTOR_PYTHON||path.join(process.env.USERPROFILE||'','Documents/ComfyUI/.venv/Scripts/python.exe');
 const composition=await(options.compose??composeScenarioInputs)(nowImage,control,{pythonPath,signal});
 for(const [key,mode] of Object.entries(control.sceneModes??{}))if(mode==='asset_only'&&!composition.scenes[key as ScenarioSceneKey]?.editRectangles.length)throw new ScenarioControlValidationError('scenarioControl.sceneModes.'+key,'asset_only requires an applied visible asset');
 return {composition,assetChecks,sourceDetection};
}

/** Keep an unknown occupied person's movement unrestricted; a target alone must never clip that person. */
export function mergeScenarioEditRegion(region:PeopleEditRegion|undefined,targets:CompositionRect[],size:{width:number;height:number},expectedPeople:number,mode?:ScenarioSceneMode):PeopleEditRegion|undefined {
 if(!targets.length){if(mode==='asset_only')throw new ScenarioControlValidationError('scenarioControl.sceneModes','asset_only requires an applied asset');return region;}
 if(expectedPeople>0&&!region&&mode!=='asset_only')return;
 if(targets.some(r=>![r.x,r.y,r.width,r.height].every(Number.isInteger)||r.x<0||r.y<0||r.width<1||r.height<1||r.x+r.width>size.width||r.y+r.height>size.height))throw new Error('Invalid scenario target edit region');
 if(mode==='asset_only')return {width:size.width,height:size.height,rectangles:targets.map(({x,y,width,height})=>({x,y,width,height}))};
 return {width:size.width,height:size.height,...region,rectangles:[...(region?.rectangles??[]),...targets]};
}
export function scenarioElementInstruction(control:ValidatedScenarioControl|undefined,key:ScenarioSceneKey):string|undefined {
 const elements=control?.sceneElements[key];
 if(!elements?.length)return;
 const instructions=elements.map(e=>withoutLightingChanges(e.instruction)).filter(Boolean);
 return 'The supplied image elements are already composited in image1. Preserve their visible content within the configured local areas. '+instructions.join(' ');
}
export function scenarioControlEcho(control:ValidatedScenarioControl|undefined) {
 return control?{version:control.version,scenarioId:control.scenarioId,runId:control.runId,elapsedSec:control.elapsedSec,cycle:control.cycle,cueIds:[...control.cueIds],...(control.sceneModes?{sceneModes:{...control.sceneModes}}:{})}:undefined;
}

export function validateScenarioModes(control:ValidatedScenarioControl|undefined,extras:Partial<Record<ScenarioSceneKey,string>>):void {
 for(const [key,mode] of Object.entries(control?.sceneModes??{}))if(mode==='asset_only'&&extras[key as ScenarioSceneKey]?.trim())throw new ScenarioControlValidationError('scenarioControl.sceneModes.'+key,'asset_only cannot be combined with a person-action sceneExtra; use people_and_assets');
}
export function assetOnlyEditInstruction():string {
 return 'Edit only the supplied non-person image elements inside their configured target areas. They are already composited in image1. Preserve their visible content and placement. Keep every original person, face, hairstyle, pose, hand position and held or worn belonging exactly unchanged. Keep all pixels outside the target areas, the fixed camera, furniture, screens and room unchanged. Do not create people or move them.';
}

/** Before raster composition, reject targets crossing detected body/hand areas (10% margin). */
export function assertAssetOnlyTargets(control:ValidatedScenarioControl,size:{width:number;height:number},detection:Detection):void {
 const boxes=[...detection.persons,...(detection.candidates??[])].map(p=>p.box);
 if(boxes.some(b=>b.length!==4||b.some(n=>!Number.isFinite(n))||b[2]<=b[0]||b[3]<=b[1]))throw new ScenarioControlValidationError('image','invalid source protection bounds');
 for(const [key,mode] of Object.entries(control.sceneModes??{}))if(mode==='asset_only')for(const e of control.sceneElements[key as ScenarioSceneKey]??[]){
  if(e.opacity===0)continue;const [x,y,w,h]=e.targetRect;const t=[Math.floor(x*size.width),Math.floor(y*size.height),Math.ceil((x+w)*size.width),Math.ceil((y+h)*size.height)];
  for(const b of boxes){const px=(b[2]-b[0])*.1,py=(b[3]-b[1])*.1;if(t[0]<b[2]+px&&t[2]>b[0]-px&&t[1]<b[3]+py&&t[3]>b[1]-py)throw new ScenarioControlValidationError('scenarioControl.sceneElements.'+key,'asset_only target overlaps a protected source person/hand area');}
 }
}

export function scenarioPeoplePolicy(mode:ScenarioSceneMode|undefined,rawCount:number,unoccupied:boolean,recentPersonAllowed:boolean) {
 const drawFromBehind=mode!=='asset_only'&&recentPersonAllowed;
 return {drawFromBehind,expectedPeople:drawFromBehind?1:unoccupied?0:rawCount};
}
