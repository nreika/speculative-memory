/** Current sources for configurable outputs only. The TD test display namespace is unchanged. */
import{createHash}from'node:crypto';
import{displayImageUrl}from'./displayDerivatives';
import{buildBrowserDisplaySnapshot,validateBrowserDisplayContents,type BrowserDisplayContent,type BrowserDisplaySnapshot}from'./browserDisplay';
import{tdBrowserSnapshot,type TdBrowserSnapshotOptions}from'./tdBrowserFollow';
import type{CaptureEvent}from'./events/captureEvents';
import {completedBrowserFadeBatch,expectedSceneLetters,skippedSceneLetters} from './browserFade';
const scenes={now:'now',a:'gen_a',b:'gen_b',c:'gen_c'}as const;
type Key=keyof typeof scenes;
const newer=(a?:CaptureEvent,b?:CaptureEvent)=>!!a&&(!b||Date.parse(a.startedAt)>Date.parse(b.startedAt)||Date.parse(a.startedAt)===Date.parse(b.startedAt)&&a.captureId.localeCompare(b.captureId)>0);
function eligibleLive(row:CaptureEvent){
 const scope=row.browserFollow?.scope;
 return ['td-native','browser'].includes(row.source??'')&&row.test!==true&&!/test/i.test(row.captureId)&&Number.isFinite(Date.parse(row.startedAt))&&typeof scope==='string'&&!!scope&&!/[\u0000-\u001f\u007f]/.test(scope)&&!scope.startsWith('test:')&&row.browserFollow?.testSceneId==null&&row.browserFollow?.testRunId==null;
}
function saved(row:CaptureEvent,key:Key){
 if(!row.browserFollow||!Array.isArray(row.browserBatch)||row.browserBatch.length>4)return;
 const values=row.browserBatch.filter(c=>c?.sceneKey===scenes[key]);if(values.length!==1)return;
 try{const [content]=validateBrowserDisplayContents(values);if(content.captureId===row.captureId&&content.scope===row.browserFollow.scope&&content.imageUrl===row.images?.[key]&&content.provenance===(key==='now'?'actual':'generated'))return content;}catch{}
}
// A skipped scene (G-24) is absent from a complete batch: its screen keeps the previous capture's image and caption.
function complete(row:CaptureEvent){const keys=['now',...expectedSceneLetters(row)]as Key[];if(row.result!=='completed'||row.browserBatch?.length!==keys.length)return false;return keys.every(key=>!!saved(row,key));}
function instruction(content:BrowserDisplayContent,options:TdBrowserSnapshotOptions){
 if(content.provenance!=='generated')return content;
 const identity={captureId:content.captureId??'',sceneKey:content.sceneKey??'',imageUrl:content.imageUrl};let match;try{match=options.instructionLookup?.(identity);}catch{}
 const valid=match&&match.captureId===identity.captureId&&match.sceneKey===identity.sceneKey&&match.imageUrl===identity.imageUrl&&typeof match.plannedDescription==='string'&&match.plannedDescription.trim();
 return {...content,caption:valid?match!.plannedDescription:'Generation instruction unavailable.'};
}
/**
 * Per-scene notice (English). Only the scene being drawn says "Generating…", later scenes of the same capture say "Next",
 * a scene whose image of this capture is already there / not requested / skipped, and the NOW screen, say nothing.
 */
function sceneNotice(args:{key:Key;row:CaptureEvent;failed:boolean;available:boolean;skippedHere:boolean;active?:TdBrowserSnapshotOptions['activeCapture']}):string|null{
 const {key,row,failed,available,skippedHere}=args;
 if(available)return null;
 if(failed)return 'Generation failed. Showing the previous image.';
 if(key==='now')return null;
 const active=args.active&&args.active.captureId===row.captureId?args.active:null;
 const order=['a','b','c'],idx=order.indexOf(key),current=active&&/^scene[A-C]$/.test(active.stage??'')?order.indexOf(String(active.stage).slice(-1).toLowerCase()):-1;
 if(idx>=(active?.imageCount??3)||skippedHere)return null;
 if(current>=0)return idx===current?'Generating…':idx>current?'Next':null;
 return 'Preparing…';
}
export function browserOutputCurrent(rows:CaptureEvent[],nowMs:number,options:TdBrowserSnapshotOptions={}):Partial<Record<Key,BrowserDisplaySnapshot>>{
 const live=rows.filter(eligibleLive).sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt)||b.captureId.localeCompare(a.captureId)),latestLive=live[0];
 const fallback=options.updateMode??'all',result:Partial<Record<Key,BrowserDisplaySnapshot>>={};
 for(const key of ['now','a','b','c']as const){
  const test=tdBrowserSnapshot(key==='now'?'td-now':'td-'+key,rows,nowMs,options),testSelected=rows.find(r=>r.captureId===test?.content?.captureId),testRequest=rows.find(r=>r.captureId===test?.displayStatus?.requestedCaptureId);
  const selectedLive=live.find(row=>((row.browserFollow?.updateMode??fallback)==='each'||complete(row))&&!!saved(row,key)),liveContent=selectedLive?saved(selectedLive,key):undefined;
  let snapshot:BrowserDisplaySnapshot|undefined;
  if(liveContent&&newer(selectedLive,testSelected)){
   const instructed=instruction(liveContent,options),content=instructed.provenance==='generated'?{...instructed,imageUrl:displayImageUrl(instructed.imageUrl)}:instructed;
   snapshot=buildBrowserDisplaySnapshot({id:'browser-source-'+key,label:key==='now'?'Source':key.toUpperCase(),accent:'#397ad1',clock:{serverAnchorMs:0,worldAnchorMs:0,rate:1,scope:content.scope},selection:{mode:'pinned',contentId:content.id}},[content],nowMs);
  }else if(test?.content)snapshot=test.content.provenance==='generated'?{...test,content:{...test.content,imageUrl:displayImageUrl(test.content.imageUrl)}}:test;
  if(!snapshot)continue;
  if(latestLive&&newer(latestLive,testRequest)){
   const latestEach=(latestLive.browserFollow?.updateMode??fallback)==='each';
   const skippedHere=key!=='now'&&skippedSceneLetters(latestLive).has(key);
   const available=skippedHere?latestLive.result==='completed'||latestEach&&latestLive.result==='running':latestEach?!!saved(latestLive,key):complete(latestLive),failed=!available&&latestLive.result!=='running';
   const userMessage=sceneNotice({key,row:latestLive,failed,available,skippedHere,active:options.activeCapture});
   const state=failed?'failed':userMessage?'generating':'completed';
   const displayStatus={requestedCaptureId:latestLive.captureId,displayedCaptureId:null,state,error:state==='failed'?(latestLive.errorMessage||'saved image unavailable').slice(0,512):null,userMessage,lastSuccessAtMs:selectedLive?.endedAt&&Number.isFinite(Date.parse(selectedLive.endedAt))?Date.parse(selectedLive.endedAt):null}as const;
   snapshot={...snapshot,displayStatus};
  }else if(test?.displayStatus&&testRequest){
   // Test / replay captures (recorded input sets) use the same per-scene English notice as live ones.
   const st=test.displayStatus,failed=st.state==='failed',available=st.state==='completed'||st.state==='idle'||!!saved(testRequest,key);
   const userMessage=sceneNotice({key,row:testRequest,failed,available:available&&!failed,skippedHere:key!=='now'&&skippedSceneLetters(testRequest).has(key),active:options.activeCapture});
   snapshot={...snapshot,displayStatus:{...st,state:failed?'failed':userMessage?'generating':'completed',userMessage}};
  }else if(test?.displayStatus)snapshot={...snapshot,displayStatus:test.displayStatus};
  const fadeRow=rows.find(row=>row.captureId===snapshot.content?.captureId);
  const eachStart=Date.parse(fadeRow?.startedAt??'');
  // "each": the screen fades when its own image arrives, so the trigger exists from the capture's first saved image.
  const fadeBatch=completedBrowserFadeBatch(fadeRow)??(fadeRow&&(fadeRow.browserFollow?.updateMode??fallback)==='each'&&Number.isSafeInteger(eachStart)&&eachStart>=0?{captureId:fadeRow.captureId,completedAtMs:eachStart}:undefined);
  result[key]={...snapshot,...(fadeBatch?{fadeBatch}:{}),revision:createHash('sha256').update(JSON.stringify({revision:snapshot.revision,status:snapshot.displayStatus,fadeBatch})).digest('hex').slice(0,20)};
 }
 // 2026-10-21: after an input switch (live camera <-> recorded set) a skipped scene kept showing the other input's image.
 // A/B/C must come from the same input as NOW (live, or the same recorded set); otherwise the scene is not shown.
 const family=(scope:unknown)=>{const s=String(scope??'');return s.startsWith('test:')?s.split(':').slice(0,2).join(':'):s.startsWith('live')?'live':s;};
 const nowFamily=result.now?.content?family(result.now.content.scope):null;
 // 2026-10-21 (user): right after an input switch, show the new NOW on A/B/C until their own images arrive (not "Waiting for an image").
 if(nowFamily&&result.now)for(const key of ['a','b','c']as const){const c=result[key]?.content;if(!c||family(c.scope)!==nowFamily){const now=result.now;result[key]={...now,standInFor:key,revision:createHash('sha256').update(JSON.stringify([now.revision,'stand-in',key])).digest('hex').slice(0,20)} as any;}}
 return result;
}
export const browserOutputCurrentSnapshots=browserOutputCurrent;
