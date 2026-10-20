import {createHash} from 'node:crypto';
import type {BrowserDisplaySnapshot} from './browserDisplay';

type Regions={status:'detected'|'no-faces'|'unavailable'|'error';boxes:Array<{x:number;y:number;width:number;height:number}>};
/** Attaches display metadata only; disabled outputs do not invoke a detector. */
export function createBrowserFacePresentation(inspect:(url:string)=>Promise<Regions>){
 return async(snapshot:BrowserDisplaySnapshot):Promise<BrowserDisplaySnapshot>=>{
  if(!snapshot.content||!snapshot.view?.faceBlur?.enabled)return snapshot;
  let result:Regions;
  try{result=await inspect(snapshot.content.imageUrl);}catch{result={status:'error',boxes:[]};}
  const content={...snapshot.content,faceRegions:result.status==='detected'?result.boxes.map(box=>({...box})):[],faceRegionStatus:result.status};
  return {...snapshot,content,revision:createHash('sha256').update(JSON.stringify([snapshot.revision,content.faceRegions,content.faceRegionStatus,snapshot.view.faceBlur])).digest('hex').slice(0,24)};
 };
}
