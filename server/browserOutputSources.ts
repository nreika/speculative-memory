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
 /** Generation status of each live source (generating / failed / completed) so every screen showing it can say so. */
 currentStatus?:Partial<Record<'now'|'a'|'b'|'c',NonNullable<BrowserDisplaySnapshot['displayStatus']>>>;
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
 const validated=new WeakMap<object,BrowserDisplayContent>(),projectedOf=new WeakMap<BrowserDisplayContent,BrowserDisplayContent>();
 let lastProjected:BrowserDisplayContent[]|undefined,lastById=new Map<string,BrowserDisplayContent>();
 /** Capture events are cached by the store, so the same raw rows are validated once, not on every catalog build. */
 const validateOne=(raw:BrowserDisplayContent)=>{if(raw&&typeof raw==='object'){const hit=validated.get(raw);if(hit)return hit;const [content]=validateBrowserDisplayContents([raw]);validated.set(raw,content);return content;}return validateBrowserDisplayContents([raw])[0];};
 let lastCatalog:{events:unknown;key:string;value:BrowserOutputCatalog}|undefined;
 let recordCache:{sig:string;items:BrowserDisplayContent[];scopes:Set<string>}|undefined;
 const thumbs=new Map<string,string|null|undefined>();
 const thumbnailOf=(url:string)=>{if(!options.thumbnailUrl)return undefined;if(thumbs.has(url))return thumbs.get(url);const v=options.thumbnailUrl(url);if(thumbs.size>200000)thumbs.clear();thumbs.set(url,v);return v;};
 return {async loadCatalog():Promise<BrowserOutputCatalog>{
  const [events,snapshots,uploads,records]=await Promise.all([options.readEvents(),options.readCurrent(),options.readUploads?.()??[],options.readRecords?.()??[]]);
  // Nothing changed since the last build (same cached events array, same recordings / uploads / current snapshots): same catalog.
  const memoKey=JSON.stringify([records.length,records[0]?.id??'',records[records.length-1]?.id??'',uploads.map(u=>u.id),snapshots],(k,v)=>k==='serverNowMs'||k==='worldNowMs'||k==='revision'?undefined:v);
  if(lastCatalog&&lastCatalog.events===events&&lastCatalog.key===memoKey)return lastCatalog.value;
  const contents=new Map<string,BrowserDisplayContent>(),current:BrowserOutputCatalog['current']={},clocks:BrowserOutputCatalog['clocks']={},sourceScopes:BrowserOutputCatalog['sourceScopes']={};
  const scopes=new Set<string>(),currentStatus:NonNullable<BrowserOutputCatalog['currentStatus']>={};
  for(const key of ['now','a','b','c']as const){
   const snapshot=snapshots[key];if(!snapshot?.content)continue;
   if(snapshot.displayStatus)currentStatus[key]=snapshot.displayStatus;
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
    const content=validateOne(raw);
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
  // 2026-10-21: the camera recording log has ~30k rows and readRecords() returns fresh copies every call; validating them all on
  // every catalog build blocked the server ~0.4 s. The validated rows are reused while the log is unchanged (length + first/last id).
  const recordSig=records.length+'|'+(records[0]?.id??'')+'|'+(records[records.length-1]?.id??'');
  if(recordCache?.sig!==recordSig){
   const items:BrowserDisplayContent[]=[],scopes=new Set<string>();
   for(const raw of records){try{const [content]=validateBrowserDisplayContents([raw]);if(content.provenance!=='actual')continue;items.push(content);
    if(raw.recordingAutoScope===content.scope&&validRecordingScope(content.scope)&&content.recordedAtMs!==null)scopes.add(content.scope);
   }catch{}}
   recordCache={sig:recordSig,items,scopes};
  }
  for(const content of recordCache.items)contents.set(content.id,content);
  for(const scope of recordCache.scopes){cameraScopes.add(scope);clocks[scope]??={serverAnchorMs:0,worldAnchorMs:0,rate:1};}
  // Only explicit acquisition metadata binds live generation NOW to the 1-second camera recordings.
  const nowSnapshot=snapshots.now,nowContent=nowSnapshot?.content;
  if(nowContent?.provenance==='actual'&&current.now===nowContent.id&&nowContent.captureId&&nowSnapshot?.clock.rate===1&&nowSnapshot.clock.worldNowMs===nowSnapshot.clock.serverNowMs){
   const event=events.find(e=>e.captureId===nowContent.captureId&&e.browserFollow?.scope===nowContent.scope);
   const cameraScope=(event?.browserFollow as typeof event.browserFollow&{cameraScope?:string})?.cameraScope;
   if(event&&['td-native','browser'].includes(event.source??'')&&event.test!==true&&!/test/i.test(event.captureId)&&!nowContent.scope.startsWith('test:')&&validRecordingScope(cameraScope)){
    sourceScopes['actual-past']=cameraScope;clocks[cameraScope]={serverAnchorMs:nowSnapshot.clock.serverNowMs,worldAnchorMs:nowSnapshot.clock.worldNowMs,rate:1};
   }
  }
  // Projected rows keep their identity while unchanged, and an unchanged list keeps its array identity, so the consumer
  // (browserOutputs catalog) can skip re-validating and re-sorting ~40k rows on every poll (2026-10-21: 0.4 s event-loop stalls).
  const mapped=[...contents.values()].map(content=>{
   const known=projectedOf.get(content);if(known)return known;
   const thumbnail=thumbnailOf(content.imageUrl);const out=thumbnail?{...content,thumbnailUrl:thumbnail}:content;projectedOf.set(content,out);return out;
  });
  const projected=mapped.map(c=>{const p=lastById.get(c.id);return p&&p!==c&&JSON.stringify(p)===JSON.stringify(c)?p:c;});
  const same=!!lastProjected&&lastProjected.length===projected.length&&projected.every((c,i)=>c===lastProjected![i]);
  const result=same?lastProjected!:projected;
  if(!same){lastProjected=projected;lastById=new Map(projected.map(c=>[c.id,c]));}
  const fadeBatches:NonNullable<BrowserOutputCatalog['fadeBatches']>=Object.create(null);
  for(const event of events){const batch=completedBrowserFadeBatch(event);if(batch)fadeBatches[batch.captureId]=batch;}
  // 2026-10-21: Display timing "each": a screen fades (once) when its own new image arrives, not when the whole batch is complete.
  // The page fades once per captureId, so a per-capture trigger present from the first saved image makes each screen fade at its own arrival.
  for(const event of events){
   const started=Date.parse(event.startedAt);
   if(event.browserFollow?.updateMode==='each'&&!fadeBatches[event.captureId]&&Number.isSafeInteger(started)&&started>=0&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(event.captureId))fadeBatches[event.captureId]={captureId:event.captureId,completedAtMs:started};
  }
  const value={contents:result,current,sourceScopes,clocks,fadeBatches,currentStatus};
  lastCatalog={events,key:memoKey,value};
  return value;
 }};
}
