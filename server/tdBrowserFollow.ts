/** Authorized TD test captures publish complete batches (all) or individually saved screens (each).
 * The original image time and generated target times are never replaced with replay time.
 */
import {createHash} from 'node:crypto';
import {buildBrowserDisplaySnapshot,validateBrowserDisplayContents,type BrowserDisplaySnapshot,type BrowserDisplayContent} from './browserDisplay';
import type {CaptureEvent} from './events/captureEvents';
import {expectedSceneLetters,skippedSceneLetters} from './browserFade';
const keys:Record<string,string>={'td-now':'now','td-a':'gen_a','td-b':'gen_b','td-c':'gen_c'};
const runId=/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
function eligibleRequest(row:CaptureEvent):boolean {
 const meta=row.browserFollow;
 const captureScene=/^test-(TSC-00[1-3])-F[0-9]+(?:-[A-Za-z0-9_-]+)?$/.exec(row.captureId);
 if(row.source!=='test'||row.test!==true||!captureScene||!Number.isFinite(Date.parse(row.startedAt))||meta?.testSceneId!==captureScene?.[1]||typeof meta?.scope!=='string'||typeof meta.testRunId!=='string'||![32,36].includes(meta.testRunId.length)||!runId.test(meta.testRunId))return false;
 // Match the normalized history scope; a run id alone must not join a capture-isolated scope.
 const prefix=`test:${meta.testSceneId}:${encodeURIComponent(meta.testRunId)}:L`;
 if(!meta.scope.startsWith(prefix))return false;
 const loop=meta.scope.slice(prefix.length);
 return /^[1-9][0-9]*$/.test(loop)&&Number.isSafeInteger(Number(loop))&&String(Number(loop))===loop;
}
function completeBatch(row:CaptureEvent):BrowserDisplayContent[]|null {
 // Skipped scenes (G-24) are not part of the batch; their screens keep the previous image.
 const expected=['now',...expectedSceneLetters(row).map(k=>'gen_'+k)];
 if(row.result!=='completed'||!row.browserFollow||!row.browserBatch||row.browserBatch.length!==expected.length)return null;
 try {
  const batch=validateBrowserDisplayContents(row.browserBatch);
  if(!expected.every(key=>batch.filter(c=>c.sceneKey===key).length===1))return null;
  for(const content of batch){
   const key=content.sceneKey==='now'?'now':content.sceneKey!.slice(-1) as 'a'|'b'|'c';
   if(content.captureId!==row.captureId||content.scope!==row.browserFollow.scope||content.imageUrl!==row.images?.[key]||content.provenance!==(key==='now'?'actual':'generated'))return null;
  }
  return batch;
 }catch{return null;}
}
/** In each mode, the saved scene is an independent publication. Other unfinished
 * scenes never supply its image, clock or instruction identity. */
function savedScene(row:CaptureEvent,scene:string):BrowserDisplayContent|undefined {
 if(!row.browserFollow||!Array.isArray(row.browserBatch)||row.browserBatch.length>4)return;
 const matches=row.browserBatch.filter(c=>c?.sceneKey===scene);
 if(matches.length!==1)return;
 try {
  const content=validateBrowserDisplayContents(matches)[0];
  const key=scene==='now'?'now':scene.slice(-1) as 'a'|'b'|'c';
  if(content.captureId!==row.captureId||content.scope!==row.browserFollow.scope||content.imageUrl!==row.images?.[key]||content.provenance!==(key==='now'?'actual':'generated'))return;
  return content;
 }catch{return;}
}
function selectSavedScene(rows:CaptureEvent[],scene:string,fallback:'each'|'all') {
 const relevant=rows.filter(eligibleRequest).sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt)||b.captureId.localeCompare(a.captureId));
 for(const row of relevant){const mode=row.browserFollow?.updateMode??fallback;if(mode==='all'&&!completeBatch(row))continue;const content=savedScene(row,scene);if(content)return {row,content};}
}
/** The latest valid request controls the status; only a complete batch controls the visible scope. */
export function selectTdBrowserRuns(rows:CaptureEvent[]) {
 const relevant=rows.filter(eligibleRequest)
  .sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt)||b.captureId.localeCompare(a.captureId));
 const latest=relevant[0];
 let selected:CaptureEvent|undefined,batch:BrowserDisplayContent[]=[];
 for(const row of relevant){const valid=completeBatch(row);if(valid){selected=row;batch=valid;break;}}
 return {latest,requestRun:latest?.browserFollow?.testRunId??null,requestScene:latest?.browserFollow?.testSceneId??null,selected,selectedCompletedRun:selected?.browserFollow?.testRunId??null,selectedCompletedScene:selected?.browserFollow?.testSceneId??null,batch};
}
export interface TdBrowserInstructionIdentity {captureId:string;sceneKey:string;imageUrl:string}
export interface TdBrowserInstruction extends TdBrowserInstructionIdentity {plannedDescription:string}
export type TdBrowserInstructionLookup=(identity:TdBrowserInstructionIdentity)=>TdBrowserInstruction|undefined;
export interface TdBrowserSnapshotOptions {instructionLookup?:TdBrowserInstructionLookup;updateMode?:'each'|'all';activeCapture?:{captureId:string;stage:string|null;imageCount:number}|null}
function projectInstruction(content:BrowserDisplayContent,lookup?:TdBrowserInstructionLookup):BrowserDisplayContent {
 if(content.provenance!=='generated'||content.sceneKey==='now')return content;
 const identity={captureId:content.captureId??'',sceneKey:content.sceneKey??'',imageUrl:content.imageUrl};
 let instruction:TdBrowserInstruction|undefined;
 try{instruction=lookup?.(identity);}catch{/* Missing archive evidence must not restore an image-description caption. */}
 const matches=identity.captureId&&identity.sceneKey&&instruction?.captureId===identity.captureId&&instruction.sceneKey===identity.sceneKey&&instruction.imageUrl===identity.imageUrl;
 const caption=matches&&typeof instruction?.plannedDescription==='string'&&instruction.plannedDescription.trim()?instruction.plannedDescription:'Generation instruction unavailable.';
 return {...content,caption};
}
export function tdBrowserSnapshot(screenId:string,rows:CaptureEvent[],nowMs:number,options:TdBrowserSnapshotOptions={}):BrowserDisplaySnapshot|undefined {
 const scene=keys[screenId];if(!scene)return undefined;
 const complete=selectTdBrowserRuns(rows),{latest,requestRun}=complete;
 const fallback=options.updateMode??'all',each=(latest?.browserFollow?.updateMode??fallback)==='each',partial=selectSavedScene(rows,scene,fallback);
 const selected=partial?.row;
 const selectedCompletedRun=selected?.browserFollow?.testRunId??null;
 const batch=partial?[partial.content]:[];
 const projectedBatch=batch.map(c=>c.sceneKey===scene?projectInstruction(c,options.instructionLookup):c);
 const content=projectedBatch.find(c=>c.sceneKey===scene),scope=content?.scope??latest?.browserFollow?.scope??'test:TSC-001:waiting';
 const snapshot=buildBrowserDisplaySnapshot({id:screenId,label:scene==='now'?'TD source':`TD ${scene.slice(-1).toUpperCase()}`,accent:screenId==='td-a'?'#cf7d28':screenId==='td-b'?'#b94383':screenId==='td-c'?'#397ad1':'#286078',clock:{serverAnchorMs:0,worldAnchorMs:0,rate:1,scope},selection:{mode:'pinned',contentId:content?.id??'waiting'}},projectedBatch,nowMs);
 const latestScene=each&&latest?savedScene(latest,scene):undefined;
 const skippedHere=!!latest&&scene!=='now'&&skippedSceneLetters(latest).has(scene.slice(-1) as 'a'|'b'|'c');
 const failed=skippedHere?latest!.result==='failed'||latest!.result==='cancelled':each?!!latest&&!latestScene&&latest.result!=='running':latest?.result==='failed'||latest?.result==='cancelled'||latest?.result==='completed'&&!completeBatch(latest);
 const state=each&&latestScene?'completed':failed?'failed':latest?.result==='running'?'generating':selected?'completed':'idle';
 const previousRun=!!content&&requestRun!==selectedCompletedRun;
 const displayStatus={requestedCaptureId:latest?.captureId??null,displayedCaptureId:null,state,error:failed?(latest?.errorMessage||(each?'saved image unavailable for this screen':'complete image batch unavailable')).slice(0,512):null,
  userMessage:failed?(previousRun?'Generation failed. Showing the previous session.':content?'Generation failed. Showing the previous image.':'Generation failed. No image yet.'):state==='generating'?(previousRun?'Generating…':content?'Generating…':'Generating…'):null,
  lastSuccessAtMs:selected?.endedAt?Date.parse(selected.endedAt):null} as const;
 return {...snapshot,displayStatus,revision:createHash('sha256').update(JSON.stringify({revision:snapshot.revision,displayStatus})).digest('hex').slice(0,20)};
}
