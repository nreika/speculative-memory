import {validateBrowserDisplayContents,type BrowserDisplayFadeBatch} from './browserDisplay';
import type {CaptureEvent} from './events/captureEvents';

/** Generated scene letters a capture skipped (G-24: unoccupied scene with neither the recent person nor an object change). */
export function skippedSceneLetters(row:CaptureEvent|undefined):Set<'a'|'b'|'c'> {
 const out=new Set<'a'|'b'|'c'>();
 if(!row||!Array.isArray(row.skippedScenes))return out;
 for(const s of row.skippedScenes){const m=/^gen_([abc])$/.exec(String(s?.sceneKey??''));if(m)out.add(m[1] as 'a'|'b'|'c');}
 return out;
}
/** Generated letters a complete batch must contain: the first `count` scenes minus the skipped ones. */
export function expectedSceneLetters(row:CaptureEvent,count=3):Array<'a'|'b'|'c'> {
 const skipped=skippedSceneLetters(row);
 return (['a','b','c']as const).slice(0,count).filter(k=>!skipped.has(k));
}
/** A saved scene alone is not the TD batch-ready fade trigger. */
export function completedBrowserFadeBatch(row:CaptureEvent|undefined):BrowserDisplayFadeBatch|undefined {
 if(!row||row.result!=='completed'||!row.browserFollow||!row.endedAt)return;
 const completedAtMs=Date.parse(row.endedAt),startedAtMs=Date.parse(row.startedAt);
 if(!Number.isSafeInteger(completedAtMs)||completedAtMs<0||!Number.isSafeInteger(startedAtMs)||completedAtMs<startedAtMs||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(row.captureId))return;
 const skipped=skippedSceneLetters(row).size;
 const count=row.requestedCount??((row.browserBatch?.length??0)-1+skipped);
 if(!Number.isInteger(count)||count<1||count>3)return;
 const keys=['now',...expectedSceneLetters(row,count)];
 if(row.browserBatch?.length!==keys.length)return;
 try{
  const batch=validateBrowserDisplayContents(row.browserBatch);
  for(const key of keys){
   const matches=batch.filter(c=>c.sceneKey===(key==='now'?'now':'gen_'+key));
   if(matches.length!==1)return;
   const content=matches[0];
   if(content.captureId!==row.captureId||content.scope!==row.browserFollow.scope||content.imageUrl!==row.images?.[key]||content.provenance!==(key==='now'?'actual':'generated'))return;
  }
  return {captureId:row.captureId,completedAtMs};
 }catch{return;}
}
