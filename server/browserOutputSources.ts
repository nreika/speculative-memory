import {validateBrowserDisplayContents,type BrowserDisplayContent,type BrowserDisplaySnapshot} from './browserDisplay';
import type {CaptureEvent} from './events/captureEvents';
import {validRecordingScope,type BrowserOutputRecording} from './browserOutputRecordings';
import {completedBrowserFadeBatch} from './browserFade';
export interface BrowserOutputCatalog {
 contents:BrowserDisplayContent[];
 current:Partial<Record<'now'|'a'|'b'|'c',string>>;
 sourceScopes:Partial<Record<'actual-past'|'generated-history',string>>;
 clocks:Record<string,{serverAnchorMs:number;worldAnchorMs:number;rate:number}>;
 fadeBatches?:Record<string,NonNullable<BrowserDisplaySnapshot['fadeBatch']>>;
}
export interface BrowserOutputSourcesOptions {
 readEvents:()=>CaptureEvent[]|Promise<CaptureEvent[]>;
 readCurrent:()=>Partial<Record<'now'|'a'|'b'|'c',BrowserDisplaySnapshot|null|undefined>>|Promise<Partial<Record<'now'|'a'|'b'|'c',BrowserDisplaySnapshot|null|undefined>>>;
 readUploads?:()=>BrowserDisplayContent[]|Promise<BrowserDisplayContent[]>;
 readRecords?:()=>BrowserOutputRecording[]|Promise<BrowserOutputRecording[]>;
 thumbnailUrl?:(imageUrl:string)=>string|null;
}
/** Metadata only: no archive walks, inference, recording time inference, or new publication. */
export function createBrowserOutputSources(options:BrowserOutputSourcesOptions){
 return {async loadCatalog():Promise<BrowserOutputCatalog>{
  const [events,snapshots,uploads,records]=await Promise.all([options.readEvents(),options.readCurrent(),options.readUploads?.()??[],options.readRecords?.()??[]]);
  const contents=new Map<string,BrowserDisplayContent>(),current:BrowserOutputCatalog['current']={},clocks:BrowserOutputCatalog['clocks']={},sourceScopes:BrowserOutputCatalog['sourceScopes']={};
  const scopes=new Set<string>();
  for(const key of ['now','a','b','c']as const){
   const snapshot=snapshots[key];if(!snapshot?.content)continue;
   try{
    const [content]=validateBrowserDisplayContents([snapshot.content]);
    if(content.scope!==snapshot.clock.scope||!Number.isSafeInteger(snapshot.clock.serverNowMs)||!Number.isSafeInteger(snapshot.clock.worldNowMs)||!Number.isFinite(snapshot.clock.rate))continue;
    if(key==='now'?content.provenance!=='actual':content.provenance!=='generated')continue;
    contents.set(content.id,content);current[key]=content.id;scopes.add(content.scope);
    clocks[content.scope]??={serverAnchorMs:snapshot.clock.serverNowMs,worldAnchorMs:snapshot.clock.worldNowMs,rate:snapshot.clock.rate};
    if(key==='now')sourceScopes['actual-past']=content.scope;
    else sourceScopes['generated-history']??=content.scope;
   }catch{/* A malformed current source never widens a history scope. */}
  }
  for(const event of events){
   if(!event.browserFollow||!Array.isArray(event.browserBatch))continue;
   for(const raw of event.browserBatch){try{
    const [content]=validateBrowserDisplayContents([raw]);
    if(content.captureId!==event.captureId||content.scope!==event.browserFollow.scope)continue;
    const key=content.sceneKey==='now'?'now':/^gen_[abc]$/.test(content.sceneKey??'')?content.sceneKey!.slice(-1)as'a'|'b'|'c':null;
    if(!key||content.imageUrl!==event.images?.[key]||content.provenance!==(key==='now'?'actual':'generated'))continue;
    if(!contents.has(content.id))contents.set(content.id,content);
    // Historical fixed-pool images retain metadata, but no replay/live clock is guessed for their scope.
    const declared=(event.browserFollow as typeof event.browserFollow&{clock?:{scope?:string;serverAnchorMs:number;worldAnchorMs:number;rate:number}}).clock;
    if(declared&&(declared.scope===undefined||declared.scope===content.scope)&&Number.isSafeInteger(declared.serverAnchorMs)&&Number.isSafeInteger(declared.worldAnchorMs)&&Number.isFinite(declared.rate))clocks[content.scope]??={serverAnchorMs:declared.serverAnchorMs,worldAnchorMs:declared.worldAnchorMs,rate:declared.rate};
   }catch{/* Torn/legacy invalid entries cannot replace a confirmed image. */}}
  }
  for(const raw of uploads){try{
   const [content]=validateBrowserDisplayContents([raw]);
   if(content.provenance==='uploaded'&&content.scope==='uploaded'&&[content.recordedAtMs,content.sourceRecordedAtMs,content.targetAtMs,content.generatedAtMs].every(t=>t===null)){contents.set(content.id,content);clocks.uploaded??={serverAnchorMs:0,worldAnchorMs:0,rate:1};}
  }catch{/* Only the private upload registry can supply uploaded content. */}}
  const cameraScopes=new Set<string>();
  for(const raw of records){try{const [content]=validateBrowserDisplayContents([raw]);if(content.provenance!=='actual')continue;contents.set(content.id,content);
   if(raw.recordingAutoScope===content.scope&&validRecordingScope(content.scope)&&content.recordedAtMs!==null){cameraScopes.add(content.scope);clocks[content.scope]??={serverAnchorMs:0,worldAnchorMs:0,rate:1};}
  }catch{}}
  // Only explicit acquisition metadata binds live generation NOW to the 1-second camera recordings.
  const nowSnapshot=snapshots.now,nowContent=nowSnapshot?.content;
  if(nowContent?.provenance==='actual'&&current.now===nowContent.id&&nowContent.captureId&&nowSnapshot?.clock.rate===1&&nowSnapshot.clock.worldNowMs===nowSnapshot.clock.serverNowMs){
   const event=events.find(e=>e.captureId===nowContent.captureId&&e.browserFollow?.scope===nowContent.scope);
   const cameraScope=(event?.browserFollow as typeof event.browserFollow&{cameraScope?:string})?.cameraScope;
   if(event&&['td-native','browser'].includes(event.source??'')&&event.test!==true&&!/test/i.test(event.captureId)&&!nowContent.scope.startsWith('test:')&&validRecordingScope(cameraScope)){
    sourceScopes['actual-past']=cameraScope;clocks[cameraScope]={serverAnchorMs:nowSnapshot.clock.serverNowMs,worldAnchorMs:nowSnapshot.clock.worldNowMs,rate:1};
   }
  }
  const projected=[...contents.values()].map(content=>{const thumbnail=options.thumbnailUrl?.(content.imageUrl);return thumbnail?{...content,thumbnailUrl:thumbnail}:content;});
  const fadeBatches:NonNullable<BrowserOutputCatalog['fadeBatches']>=Object.create(null);
  for(const event of events){const batch=completedBrowserFadeBatch(event);if(batch)fadeBatches[batch.captureId]=batch;}
  return {contents:projected,current,sourceScopes,clocks,fadeBatches};
 }};
}
