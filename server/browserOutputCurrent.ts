/** Current sources for configurable outputs only. The TD test display namespace is unchanged. */
import{createHash}from'node:crypto';
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
 return {...content,caption:valid?match!.plannedDescription:'生成指示を確認できません。'};
}
export function browserOutputCurrent(rows:CaptureEvent[],nowMs:number,options:TdBrowserSnapshotOptions={}):Partial<Record<Key,BrowserDisplaySnapshot>>{
 const live=rows.filter(eligibleLive).sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt)||b.captureId.localeCompare(a.captureId)),latestLive=live[0];
 const fallback=options.updateMode??'all',result:Partial<Record<Key,BrowserDisplaySnapshot>>={};
 for(const key of ['now','a','b','c']as const){
  const test=tdBrowserSnapshot(key==='now'?'td-now':'td-'+key,rows,nowMs,options),testSelected=rows.find(r=>r.captureId===test?.content?.captureId),testRequest=rows.find(r=>r.captureId===test?.displayStatus?.requestedCaptureId);
  const selectedLive=live.find(row=>((row.browserFollow?.updateMode??fallback)==='each'||complete(row))&&!!saved(row,key)),liveContent=selectedLive?saved(selectedLive,key):undefined;
  let snapshot:BrowserDisplaySnapshot|undefined;
  if(liveContent&&newer(selectedLive,testSelected)){
   const content=instruction(liveContent,options);
   snapshot=buildBrowserDisplaySnapshot({id:'browser-source-'+key,label:key==='now'?'元映像':key.toUpperCase(),accent:'#397ad1',clock:{serverAnchorMs:0,worldAnchorMs:0,rate:1,scope:content.scope},selection:{mode:'pinned',contentId:content.id}},[content],nowMs);
  }else if(test?.content)snapshot=test;
  if(!snapshot)continue;
  if(latestLive&&newer(latestLive,testRequest)){
   const latestEach=(latestLive.browserFollow?.updateMode??fallback)==='each';
   const skippedHere=key!=='now'&&skippedSceneLetters(latestLive).has(key);
   const available=skippedHere?latestLive.result==='completed'||latestEach&&latestLive.result==='running':latestEach?!!saved(latestLive,key):complete(latestLive),failed=!available&&latestLive.result!=='running';
   const state=available?'completed':failed?'failed':'generating';
   const displayStatus={requestedCaptureId:latestLive.captureId,displayedCaptureId:null,state,error:failed?(latestLive.errorMessage||'saved image unavailable').slice(0,512):null,userMessage:available?null:failed?'今回の生成は失敗しました。前回の画像を表示中。':'生成中です。前回の画像を表示中。',lastSuccessAtMs:selectedLive?.endedAt&&Number.isFinite(Date.parse(selectedLive.endedAt))?Date.parse(selectedLive.endedAt):null}as const;
   snapshot={...snapshot,displayStatus};
  }else if(test?.displayStatus)snapshot={...snapshot,displayStatus:test.displayStatus};
  const fadeBatch=completedBrowserFadeBatch(rows.find(row=>row.captureId===snapshot.content?.captureId));
  result[key]={...snapshot,...(fadeBatch?{fadeBatch}:{}),revision:createHash('sha256').update(JSON.stringify({revision:snapshot.revision,status:snapshot.displayStatus,fadeBatch})).digest('hex').slice(0,20)};
 }
 // 2026-10-21: after an input switch (live camera <-> recorded set) a skipped scene kept showing the other input's image.
 // A/B/C must come from the same input as NOW (live, or the same recorded set); otherwise the scene is not shown.
 const family=(scope:unknown)=>{const s=String(scope??'');return s.startsWith('test:')?s.split(':').slice(0,2).join(':'):s.startsWith('live')?'live':s;};
 const nowFamily=result.now?.content?family(result.now.content.scope):null;
 if(nowFamily)for(const key of ['a','b','c']as const){const c=result[key]?.content;if(c&&family(c.scope)!==nowFamily)delete result[key];}
 return result;
}
export const browserOutputCurrentSnapshots=browserOutputCurrent;
