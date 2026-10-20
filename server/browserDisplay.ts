/** Read-only browser display contract. No capture, generation, clock inference or file publication. */
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {Express,Request,Response} from 'express';

export interface BrowserDisplayContent {
 id:string;scope:string;provenance:'actual'|'generated'|'uploaded';imageUrl:string;
 thumbnailUrl?:string;
 /** Explicit capture setting, never inferred from timestamps. Missing legacy values normalize to null. */
 distanceSecSigned?:number|null;
 targetAtMs:number|null;recordedAtMs:number|null;generatedAtMs:number|null;sourceRecordedAtMs:number|null;caption:string;
 captureId?:string|null;sceneKey?:string|null;
 faceRegions?:Array<{x:number;y:number;width:number;height:number}>;
 faceRegionStatus?:'detected'|'no-faces'|'unavailable'|'error';
}
export type BrowserDisplaySelection = {mode:'pinned';contentId:string}|{mode:'recorded-offset';offsetMs:number}|{mode:'latest-generated'};
export interface BrowserDisplayScreen {
 id:string;label:string;accent:string;
 clock:{serverAnchorMs:number;worldAnchorMs:number;rate:number;scope:string};
 selection:BrowserDisplaySelection;
}
export interface BrowserDisplaySettings {schema:1;screens:BrowserDisplayScreen[]}
export interface BrowserDisplayStatus {
 requestedCaptureId:string|null;displayedCaptureId:string|null;state:'idle'|'generating'|'completed'|'failed';
 error:string|null;userMessage:string|null;lastSuccessAtMs:number|null;
}
export type BrowserFadeMode='original'|'crossfade'|'none';
export interface BrowserDisplayFadeBatch {captureId:string;completedAtMs:number}
export interface BrowserDisplaySnapshot {
 schema:1;revision:string;displayStatus?:BrowserDisplayStatus;screen:{id:string;label:string;accent:string};
 scenarioOverride?:{runId:string;source:import('./browserOutputs').BrowserOutputSource};
 view?:{visible:boolean;labels:boolean;subtitles:boolean;fade:boolean;fadeMode?:BrowserFadeMode;fadeDurationMs?:number;blackHoldMs?:number;fadeOnImageChange?:boolean;faceBlur?:{enabled:boolean;strengthPx:number}};
 fadeBatch?:BrowserDisplayFadeBatch;
 clock:{serverNowMs:number;worldNowMs:number;rate:number;scope:string;known?:boolean};
 content:BrowserDisplayContent|null;selection:BrowserDisplaySelection;
 temporalRelation:'past'|'present'|'future'|'unknown';
 selectionStatus:'selected'|'content-missing'|'time-unknown'|'no-eligible-content';
}
export interface BrowserDisplayOptions {
 settingsFile:string;
 snapshotProvider?:(screenId:string,nowMs:number)=>BrowserDisplaySnapshot|null|undefined|Promise<BrowserDisplaySnapshot|null|undefined>;
 contents?:BrowserDisplayContent[]|(()=>BrowserDisplayContent[]|Promise<BrowserDisplayContent[]>);
 contentsFile?:string;
 now?:()=>number;heartbeatMs?:number;
 statusProvider?:(screenId:string,snapshot:BrowserDisplaySnapshot)=>BrowserDisplayStatus|Promise<BrowserDisplayStatus>;
}
const plain=(x:unknown):x is Record<string,any>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const text=(x:unknown,max=256):x is string=>typeof x==='string'&&x.length>0&&x.length<=max&&!/[\u0000-\u001f\u007f]/.test(x);
const time=(x:unknown):x is number|null=>x===null||(typeof x==='number'&&Number.isSafeInteger(x));
const screenId=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(x);
export function isBrowserDisplayImageUrl(value:unknown):value is string {
 if(typeof value!=='string'||value.length>2048||!value.startsWith('/captures/')||/[\\?#\u0000-\u0020\u007f]/.test(value))return false;
 let decoded:string;try{decoded=decodeURIComponent(value);}catch{return false;}
 if(/[\\?#%\u0000-\u001f\u007f]/.test(decoded)||decoded.split('/').some(p=>p==='.'||p==='..'||p==='')){
  // Leading slash is required; empty intermediate segments are forbidden.
  if(decoded.slice(1).split('/').some(p=>!p||p==='.'||p==='..')||/[\\?#%\u0000-\u001f\u007f]/.test(decoded))return false;
 }
 return decoded.startsWith('/captures/')&&/\.(?:png|jpe?g|webp|gif|avif)$/i.test(decoded);
}
export function validateBrowserDisplaySettings(raw:unknown):BrowserDisplaySettings {
 if(!plain(raw)||raw.schema!==1||!Array.isArray(raw.screens)||raw.screens.length>100)throw Error('Invalid display settings');
 const ids=new Set<string>();const screens=raw.screens.map((s:any):BrowserDisplayScreen=>{
  if(!plain(s)||!screenId(s.id)||ids.has(s.id)||!text(s.label,128)||typeof s.accent!=='string'||!/^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(s.accent)||!plain(s.clock)||!Number.isSafeInteger(s.clock.serverAnchorMs)||!Number.isSafeInteger(s.clock.worldAnchorMs)||!Number.isFinite(s.clock.rate)||!text(s.clock.scope)||!plain(s.selection))throw Error('Invalid display screen');
  ids.add(s.id);let selection:BrowserDisplaySelection;
  if(s.selection.mode==='pinned'&&text(s.selection.contentId))selection={mode:'pinned',contentId:s.selection.contentId};
  else if(s.selection.mode==='recorded-offset'&&Number.isSafeInteger(s.selection.offsetMs)&&s.selection.offsetMs>=0)selection={mode:'recorded-offset',offsetMs:s.selection.offsetMs};
  else if(s.selection.mode==='latest-generated')selection={mode:'latest-generated'};
  else throw Error('Invalid display selection');
  return {id:s.id,label:s.label,accent:s.accent,clock:{serverAnchorMs:s.clock.serverAnchorMs,worldAnchorMs:s.clock.worldAnchorMs,rate:s.clock.rate,scope:s.clock.scope},selection};
 });return {schema:1,screens};
}
export function validateBrowserDisplayContents(raw:unknown):BrowserDisplayContent[] {
 if(!Array.isArray(raw)||raw.length>100000)throw Error('Invalid display registry');
 const ids=new Set<string>();return raw.map((c:any)=>{
  if(!plain(c)||!text(c.id)||ids.has(c.id)||!text(c.scope)||!['actual','generated','uploaded'].includes(c.provenance)||!isBrowserDisplayImageUrl(c.imageUrl)||!['targetAtMs','recordedAtMs','generatedAtMs','sourceRecordedAtMs'].every(k=>time(c[k]))||typeof c.caption!=='string'||c.caption.length>8000)throw Error('Invalid display content');
  if(c.provenance==='uploaded'&&['targetAtMs','recordedAtMs','generatedAtMs','sourceRecordedAtMs'].some(k=>c[k]!==null))throw Error('Uploaded image times are unknown');
  if(c.thumbnailUrl!==undefined&&!isBrowserDisplayImageUrl(c.thumbnailUrl))throw Error('Invalid content thumbnail');
  for(const k of ['captureId','sceneKey'])if(c[k]!==undefined&&c[k]!==null&&!text(c[k]))throw Error('Invalid content lineage');
  const distanceSecSigned=c.distanceSecSigned??null;
  if(distanceSecSigned!==null&&(typeof distanceSecSigned!=='number'||!Number.isFinite(distanceSecSigned)||c.provenance!=='generated'))throw Error('Invalid explicit scene distance');
  ids.add(c.id);
  // Whitelist fields: private paths/extra archive metadata never reach clients.
  return {id:c.id,scope:c.scope,provenance:c.provenance,imageUrl:c.imageUrl,...(c.thumbnailUrl!==undefined?{thumbnailUrl:c.thumbnailUrl}:{}),distanceSecSigned,targetAtMs:c.targetAtMs,recordedAtMs:c.recordedAtMs,generatedAtMs:c.generatedAtMs,sourceRecordedAtMs:c.sourceRecordedAtMs,caption:c.caption,...(c.captureId!==undefined?{captureId:c.captureId}:{}),...(c.sceneKey!==undefined?{sceneKey:c.sceneKey}:{})};
 });
}
export function validateBrowserDisplayStatus(raw:unknown):BrowserDisplayStatus {
 if(!plain(raw)||!['idle','generating','completed','failed'].includes(raw.state)||!time(raw.lastSuccessAtMs))throw Error('Invalid display status');
 for(const key of ['requestedCaptureId','displayedCaptureId','error','userMessage'])if(raw[key]!==null&&!text(raw[key],key==='userMessage'?2000:512))throw Error('Invalid display status');
 return {requestedCaptureId:raw.requestedCaptureId,displayedCaptureId:raw.displayedCaptureId,state:raw.state,error:raw.error,userMessage:raw.userMessage,lastSuccessAtMs:raw.lastSuccessAtMs};
}
export function buildBrowserDisplaySnapshot(screen:BrowserDisplayScreen,contents:BrowserDisplayContent[],serverNowMs:number):BrowserDisplaySnapshot {
 if(!Number.isSafeInteger(serverNowMs))throw Error('Invalid server time');
 const worldNowMs=Math.round(screen.clock.worldAnchorMs+(serverNowMs-screen.clock.serverAnchorMs)*screen.clock.rate);
 if(!Number.isSafeInteger(worldNowMs))throw Error('Clock out of range');
 const pool=contents.filter(c=>c.scope===screen.clock.scope),selection=screen.selection;
 let content:BrowserDisplayContent|null=null,selectionStatus:BrowserDisplaySnapshot['selectionStatus']='no-eligible-content';
 if(selection.mode==='pinned'){
  content=pool.find(c=>c.id===selection.contentId)||null;selectionStatus=content?'selected':'content-missing';
 }else if(selection.mode==='recorded-offset'){
  const actual=pool.filter(c=>c.provenance==='actual');
  content=actual.filter(c=>c.recordedAtMs!==null&&c.recordedAtMs<=worldNowMs-selection.offsetMs).sort((a,b)=>b.recordedAtMs!-a.recordedAtMs!||a.id.localeCompare(b.id))[0]||null;
  selectionStatus=content?'selected':actual.some(c=>c.recordedAtMs===null)?'time-unknown':'no-eligible-content';
 }else{
  const generated=pool.filter(c=>c.provenance==='generated');
  content=generated.filter(c=>c.generatedAtMs!==null).sort((a,b)=>b.generatedAtMs!-a.generatedAtMs!||a.id.localeCompare(b.id))[0]||null;
  selectionStatus=content?'selected':generated.some(c=>c.generatedAtMs===null)?'time-unknown':'no-eligible-content';
 }
 const at=content?(content.provenance==='actual'?content.recordedAtMs:content.targetAtMs):null;
 const temporalRelation:BrowserDisplaySnapshot['temporalRelation']=at===null?'unknown':at<worldNowMs?'past':at>worldNowMs?'future':'present';
 // Revision is an opaque content/config hash, not a timestamp or claimed sequence.
 const revision=createHash('sha256').update(JSON.stringify({screen,content,selectionStatus,temporalRelation})).digest('hex').slice(0,20);
 return {schema:1,revision,screen:{id:screen.id,label:screen.label,accent:screen.accent},clock:{serverNowMs,worldNowMs,rate:screen.clock.rate,scope:screen.clock.scope},content,selection,temporalRelation,selectionStatus};
}
export class BrowserDisplayStore {
 private settingsCache?:{key:string;value:BrowserDisplaySettings};
 constructor(private options:BrowserDisplayOptions){
  if(!options.settingsFile||(!options.contents&&!options.contentsFile)||!!options.contents===!!options.contentsFile)throw Error('Provide settingsFile and exactly one registry source');
 }
 private async settings(){
  const stat=await fs.stat(this.options.settingsFile),key=`${stat.mtimeMs}:${stat.size}`;
  if(this.settingsCache?.key===key)return this.settingsCache.value;
  const value=validateBrowserDisplaySettings(JSON.parse(await fs.readFile(this.options.settingsFile,'utf8')));
  this.settingsCache={key,value};return value;
 }
 async snapshot(id:string){
  if(!screenId(id))return null;
  const custom=await this.options.snapshotProvider?.(id,this.options.now?.()??Date.now());
  if(custom!==undefined)return custom;
  const screen=(await this.settings()).screens.find(s=>s.id===id);if(!screen)return null;
  const raw=this.options.contentsFile?JSON.parse(await fs.readFile(this.options.contentsFile,'utf8')):typeof this.options.contents==='function'?await this.options.contents():this.options.contents;
  const snapshot=buildBrowserDisplaySnapshot(screen,validateBrowserDisplayContents(raw),this.options.now?.()??Date.now());
  if(!this.options.statusProvider)return snapshot;
  const displayStatus=validateBrowserDisplayStatus(await this.options.statusProvider(id,snapshot));
  // Status annotates authoritative published content. It cannot publish a failed
  // image or change a pinned id; provider must supply actual displayed lineage.
  return {...snapshot,displayStatus,revision:createHash('sha256').update(JSON.stringify({revision:snapshot.revision,displayStatus})).digest('hex').slice(0,20)};
 }
}
export function registerBrowserDisplayRoutes(app:Pick<Express,'get'>,options:BrowserDisplayOptions){
 const store=new BrowserDisplayStore(options),clients=new Set<()=>void>();
 const heartbeatMs=options.heartbeatMs??2000;if(!Number.isInteger(heartbeatMs)||heartbeatMs<50||heartbeatMs>60000)throw Error('Invalid display heartbeat');
 const initial=async(req:Request,res:Response)=>{
  try{const value=await store.snapshot(String(req.params.screenId));if(!value){res.status(404).json({error:'display_not_found'});return null;}return value;}
  catch{res.status(503).json({error:'display_configuration_unavailable'});return null;}
 };
 app.get('/api/displays/:screenId',async(req,res)=>{const value=await initial(req,res);if(value)res.setHeader('Cache-Control','no-store').json(value);});
 app.get('/api/displays/:screenId/events',async(req,res)=>{
  const first=await initial(req,res);if(!first||res.destroyed||res.writableEnded)return;
  res.status(200);res.setHeader('Content-Type','text/event-stream; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();
  let revision=first.revision,closed=false,busy=false;
  const send=(event:string,value:unknown)=>{if(!closed&&!res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`))close();};
  const close=()=>{if(closed)return;closed=true;clearInterval(timer);clients.delete(close);if(!res.writableEnded)res.end();};
  const tick=async()=>{if(busy||closed)return;busy=true;try{
   const value=await store.snapshot(String(req.params.screenId));if(closed)return;
   if(!value){send('unavailable',{schema:1,error:'display_not_found'});close();return;}
   if(value.revision!==revision){send('snapshot',value);revision=value.revision;}
   send('heartbeat',{schema:1,revision,clock:value.clock});
  }catch{send('unavailable',{schema:1,error:'display_configuration_unavailable'});close();}finally{busy=false;}};
  const timer=setInterval(()=>void tick(),heartbeatMs);timer.unref();clients.add(close);res.once('close',close);send('snapshot',first);
 });
 return {store,close:()=>{for(const close of [...clients])close();}};
}
