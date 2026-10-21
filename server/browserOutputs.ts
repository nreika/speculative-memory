/** Independent browser-output configuration. No generation, camera, TD routing or archive mutation. */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import type {Express} from 'express';
import {buildBrowserDisplaySnapshot,validateBrowserDisplayContents,isBrowserDisplayImageUrl,type BrowserDisplayContent,type BrowserDisplaySnapshot} from './browserDisplay';
import {renameRetry} from './renameRetry';
import {createSequenceLibrary,SEQUENCE_FOLDER,SEQUENCE_MAX_FRAMES,type SequenceLibrary} from './browserOutputSequences';

export const BROWSER_OUTPUT_MAX=64;
const SOURCES=['now','a','b','c','actual-past','generated-history','fixed','fixed-sequence','td-1','td-2','td-3','td-4'] as const;
export type BrowserOutputSource=typeof SOURCES[number];
export type BrowserOutputFadeMode='original'|'crossfade'|'none';
export const BROWSER_OUTPUT_FADE_CHANNELS=['current-now','current-a','current-b','current-c','control-output-1','control-output-2','control-output-3','control-output-4'] as const;
export type BrowserOutputFadeChannel=typeof BROWSER_OUTPUT_FADE_CHANNELS[number];
export type BrowserOutputFadeBatch={captureId:string;completedAtMs:number};
function channelModes(raw:unknown,base?:Record<BrowserOutputFadeChannel,BrowserOutputFadeMode>):Record<BrowserOutputFadeChannel,BrowserOutputFadeMode>{
 if(raw!==undefined&&(!plain(raw)||Object.entries(raw).some(([id,mode])=>!BROWSER_OUTPUT_FADE_CHANNELS.includes(id as BrowserOutputFadeChannel)||!['original','crossfade','none'].includes(mode as string))))throw new OutputError(400,'Invalid channel fade modes');
 return {...Object.fromEntries(BROWSER_OUTPUT_FADE_CHANNELS.map(id=>[id,'original'])),...base,...raw as object} as Record<BrowserOutputFadeChannel,BrowserOutputFadeMode>;
}
export interface BrowserOutputFadeTiming {fadeDurationMs:number;blackHoldMs:number}
function fadeTiming(raw:unknown,base:BrowserOutputFadeTiming={fadeDurationMs:800,blackHoldMs:120}):BrowserOutputFadeTiming{
 if(!plain(raw)||Object.keys(raw).some(k=>!['fadeDurationMs','blackHoldMs'].includes(k)))throw new OutputError(400,'Invalid fade timing');
 for(const value of Object.values(raw))if(!Number.isInteger(value)||value<0||value>10000)throw new OutputError(400,'Invalid fade timing');
 return {...base,...raw};
}
function channelTimings(raw:unknown,base?:Record<BrowserOutputFadeChannel,BrowserOutputFadeTiming>):Record<BrowserOutputFadeChannel,BrowserOutputFadeTiming>{
 if(raw!==undefined&&(!plain(raw)||Object.keys(raw).some(id=>!BROWSER_OUTPUT_FADE_CHANNELS.includes(id as BrowserOutputFadeChannel))))throw new OutputError(400,'Invalid channel fade timings');
 return Object.fromEntries(BROWSER_OUTPUT_FADE_CHANNELS.map(id=>[id,fadeTiming(raw===undefined||!Object.hasOwn(raw as object,id)?{}:(raw as Record<string,unknown>)[id],base?.[id])])) as Record<BrowserOutputFadeChannel,BrowserOutputFadeTiming>;
}
export interface BrowserOutputFaceBlur {enabled:boolean;strengthPx:number}
function faceBlur(raw:unknown,base:BrowserOutputFaceBlur={enabled:false,strengthPx:12}):BrowserOutputFaceBlur{
 if(raw===undefined)return {...base};
 if(!plain(raw)||Object.keys(raw).some(k=>!['enabled','strengthPx'].includes(k))||Object.hasOwn(raw,'enabled')&&typeof raw.enabled!=='boolean'||Object.hasOwn(raw,'strengthPx')&&(!Number.isInteger(raw.strengthPx)||raw.strengthPx<0||raw.strengthPx>40))throw new OutputError(400,'Invalid face blur');
 return {...base,...raw};
}
function channelBlurs(raw:unknown,base?:Record<BrowserOutputFadeChannel,BrowserOutputFaceBlur>):Record<BrowserOutputFadeChannel,BrowserOutputFaceBlur>{
 if(raw!==undefined&&(!plain(raw)||Object.keys(raw).some(id=>!BROWSER_OUTPUT_FADE_CHANNELS.includes(id as BrowserOutputFadeChannel))))throw new OutputError(400,'Invalid channel face blurs');
 return Object.fromEntries(BROWSER_OUTPUT_FADE_CHANNELS.map(id=>[id,faceBlur(raw===undefined?undefined:(raw as Record<string,unknown>)[id],base?.[id])])) as Record<BrowserOutputFadeChannel,BrowserOutputFaceBlur>;
}
/** Fixed scenes / routing slots: label badge and text subtitle on or off. Absent → both true. */
export interface BrowserOutputCaptions {labels:boolean;subtitles:boolean}
export type BrowserOutputChannelCaptions=Record<BrowserOutputFadeChannel,BrowserOutputCaptions>;
export function validateChannelCaptions(raw:unknown,base?:Partial<BrowserOutputChannelCaptions>):BrowserOutputChannelCaptions{
 if(raw!==undefined&&(!plain(raw)||Object.entries(raw).some(([id,value])=>!BROWSER_OUTPUT_FADE_CHANNELS.includes(id as BrowserOutputFadeChannel)||!plain(value)||Object.keys(value).some(k=>!['labels','subtitles'].includes(k))||Object.values(value).some(v=>typeof v!=='boolean'))))throw new OutputError(400,'Invalid channel captions');
 return Object.fromEntries(BROWSER_OUTPUT_FADE_CHANNELS.map(id=>{const value=raw===undefined?undefined:(raw as Record<string,{labels?:boolean;subtitles?:boolean}>)[id];return [id,{labels:value?.labels??base?.[id]?.labels??true,subtitles:value?.subtitles??base?.[id]?.subtitles??true}];})) as BrowserOutputChannelCaptions;
}
export interface BrowserOutputConfig {
 id:string;label:string;source:BrowserOutputSource;delaySec:number;scene:'a'|'b'|'c'|'any';
 contentId?:string;visible:boolean;labels:boolean;subtitles:boolean;fade:boolean;fadeMode?:BrowserOutputFadeMode;fadeDurationMs?:number;blackHoldMs?:number;faceBlur?:BrowserOutputFaceBlur;
 /** source 'fixed-sequence' only: folder under <data>/sequences, seconds per frame, 1-based start/end (end absent = last), loop. */
 sequenceFolder?:string;frameSec?:number;startFrame?:number;endFrame?:number;loop?:boolean;
 /** Server clock when the sequence was assigned or its settings changed; playback is computed from it. */
 sequenceStartedAtMs?:number;
}
const SEQUENCE_FIELDS=['sequenceFolder','frameSec','startFrame','endFrame','loop','sequenceStartedAtMs'] as const;
type SequenceFields=Pick<BrowserOutputConfig,typeof SEQUENCE_FIELDS[number]>;
/** Validates the fixed-sequence fields of one raw output (absent fields get defaults); other sources must not carry them. */
export function validateSequenceFields(v:Record<string,any>):SequenceFields{
 if(v.source!=='fixed-sequence'){if(SEQUENCE_FIELDS.some(k=>v[k]!==undefined))throw new OutputError(400,'Sequence fields require source fixed-sequence');return {};}
 if(typeof v.sequenceFolder!=='string'||!SEQUENCE_FOLDER.test(v.sequenceFolder))throw new OutputError(400,'Fixed sequence requires a folder name (A-Z a-z 0-9 _ -)');
 const frameSec=v.frameSec??30;if(typeof frameSec!=='number'||!Number.isFinite(frameSec)||frameSec<1||frameSec>86400)throw new OutputError(400,'Frame · sec must be from 1 to 86400');
 const startFrame=v.startFrame??1;if(!Number.isInteger(startFrame)||startFrame<1||startFrame>SEQUENCE_MAX_FRAMES)throw new OutputError(400,'Start frame must be a whole number from 1 to '+SEQUENCE_MAX_FRAMES);
 if(v.endFrame!==undefined&&(!Number.isInteger(v.endFrame)||v.endFrame<1||v.endFrame>SEQUENCE_MAX_FRAMES))throw new OutputError(400,'End frame must be a whole number from 1 to '+SEQUENCE_MAX_FRAMES);
 if(v.endFrame!==undefined&&v.endFrame<startFrame)throw new OutputError(400,'End frame must not be before Start frame');
 if(v.loop!==undefined&&typeof v.loop!=='boolean')throw new OutputError(400,'Loop must be true or false');
 if(v.sequenceStartedAtMs!==undefined&&(!Number.isSafeInteger(v.sequenceStartedAtMs)||v.sequenceStartedAtMs<0))throw new OutputError(400,'Invalid sequence start time');
 return {sequenceFolder:v.sequenceFolder,frameSec,startFrame,...(v.endFrame!==undefined?{endFrame:v.endFrame}:{}),loop:v.loop??true,sequenceStartedAtMs:v.sequenceStartedAtMs??0};
}
const sequenceKey=(o:BrowserOutputConfig|undefined)=>o?.source==='fixed-sequence'?JSON.stringify([o.sequenceFolder,o.frameSec,o.startFrame,o.endFrame??null,o.loop]):null;
/** Restarts playback (sequenceStartedAtMs=now) of every sequence output that is new or whose sequence settings changed; keeps it otherwise. */
export function stampSequenceStarts(outputs:BrowserOutputConfig[],previous:BrowserOutputConfig[],nowMs:number):BrowserOutputConfig[]{
 return outputs.map(o=>{if(o.source!=='fixed-sequence')return o;const before=previous.find(p=>p.id===o.id);return {...o,sequenceStartedAtMs:before&&sequenceKey(before)===sequenceKey(o)?before.sequenceStartedAtMs??0:nowMs};});
}
export interface BrowserOutputTdRouting {
 slots:Partial<Record<'td-1'|'td-2'|'td-3'|'td-4','now'|'a'|'b'|'c'>>;
 view:{visible:boolean;labels:boolean;subtitles:boolean;fade:boolean};
}
export interface BrowserOutputsCatalog {
 tdRouting?:BrowserOutputTdRouting;
 fadeBatches?:Record<string,BrowserOutputFadeBatch>;
 currentStatus?:Partial<Record<'now'|'a'|'b'|'c',NonNullable<BrowserDisplaySnapshot['displayStatus']>>>;
 standIn?:Partial<Record<'a'|'b'|'c',true>>;
 contents:BrowserDisplayContent[];
 current:Partial<Record<'now'|'a'|'b'|'c',string>>;
 sourceScopes:Partial<Record<'actual-past'|'generated-history',string>>;
 clocks:Record<string,{serverAnchorMs:number;worldAnchorMs:number;rate:number}>;
}
export interface BrowserOutputAssets {
 importImage(input:{filename:string;imageDataUrl:string}):Promise<BrowserDisplayContent>;
 resolve(urlPath:string):Promise<{absolutePath:string;contentType:string}|null>;
}
export interface BrowserOutputsOptions {
 configFile:string;loadCatalog:()=>Promise<BrowserOutputsCatalog>;assets?:BrowserOutputAssets;
 resolveContent?:(content:BrowserDisplayContent)=>Promise<BrowserDisplayContent>;
 presentSnapshot?:(snapshot:BrowserDisplaySnapshot)=>Promise<BrowserDisplaySnapshot>;
 thumbnails?:{thumbnailUrl:(imageUrl:string)=>string|null;resolveThumbnail:(urlPath:string)=>Promise<string|null>};
 allowedHosts?:string[];catalogTtlMs?:number;now?:()=>number;
 /** Fixed-sequence folders; default <directory of configFile>/sequences. */
 sequencesDirectory?:string;
 /** Serve the previous catalog while a refresh runs in the background (screens never wait for a rebuild). */
 staleWhileRevalidate?:boolean;
}
const idPattern=/^screen-[1-9][0-9]{0,2}$/;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,20);
const plain=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max=256):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
class OutputError extends Error {constructor(readonly status:number,message:string){super(message);}}
function fields(value:Record<string,unknown>,allowed:string[]) {
 if(Object.keys(value).some(k=>!allowed.includes(k)))throw new OutputError(400,'Unsupported configuration field');
}
export function validateBrowserOutputs(raw:unknown,base:BrowserOutputConfig[]=[]):BrowserOutputConfig[] {
 if(!Array.isArray(raw)||raw.length>BROWSER_OUTPUT_MAX)throw new OutputError(400,'Invalid output configuration');
 const ids=new Set<string>();
 return raw.map(v=>{
  if(!plain(v))throw new OutputError(400,'Invalid output');
  fields(v,['id','label','source','delaySec','scene','contentId','visible','labels','subtitles','fade','fadeMode','fadeDurationMs','blackHoldMs','faceBlur',...SEQUENCE_FIELDS]);
  if(typeof v.id!=='string'||!idPattern.test(v.id)||ids.has(v.id)||!text(v.label,128)||!SOURCES.includes(v.source)||!Number.isFinite(v.delaySec)||v.delaySec<0||v.delaySec>86400||!['a','b','c','any'].includes(v.scene)||!['visible','labels','subtitles'].every(k=>typeof v[k]==='boolean')||(v.fade!==undefined&&typeof v.fade!=='boolean')||(v.fadeMode!==undefined&&!['original','crossfade','none'].includes(v.fadeMode)))throw new OutputError(400,'Invalid output');
  if(/^td-[1-4]$/.test(v.source)&&v.delaySec!==0)throw new OutputError(400,'TD routing aliases require delaySec 0');
  if(v.source==='fixed'?!text(v.contentId):v.contentId!==undefined)throw new OutputError(400,'Fixed output requires a catalog contentId only');
  const sequence=validateSequenceFields(v);
  const fadeMode:BrowserOutputFadeMode=v.fade===false?'none':v.fadeMode??'original';
  const timing=fadeTiming({...('fadeDurationMs' in v?{fadeDurationMs:v.fadeDurationMs}:{}),...('blackHoldMs' in v?{blackHoldMs:v.blackHoldMs}:{})});
  ids.add(v.id);
  return {id:v.id,label:v.label,source:v.source,delaySec:v.delaySec,scene:v.scene,...(v.source==='fixed'?{contentId:v.contentId}:{}),...sequence,visible:v.visible,labels:v.labels,subtitles:v.subtitles,fade:fadeMode!=='none',fadeMode,...timing,faceBlur:faceBlur(v.faceBlur,base.find(o=>o.id===v.id)?.faceBlur)};
 });
}
function peer(address=''):boolean {
 address=address.replace(/^::ffff:/,'').replace(/^\[|\]$/g,'');
 if(address==='::1')return true;
 if(net.isIP(address)===4){const [a,b]=address.split('.').map(Number);return a===127||a===100&&b>=64&&b<=127;}
 return net.isIP(address)===6&&address.toLowerCase().startsWith('fd7a:115c:a1e0:');
}
export function browserOutputsAccess(req:{headers:Record<string,any>;socket:{remoteAddress?:string};method:string},allowedHosts:Set<string>):number|null {
 if(!allowedHosts.has(req.headers.host)||!peer(req.socket.remoteAddress))return 403;
 if(req.method==='POST'){
  if(req.headers['x-control-request']!=='1')return 403;
  if(String(req.headers['content-type']??'').split(';')[0].trim().toLowerCase()!=='application/json')return 415;
  if(!['http://'+req.headers.host,'https://'+req.headers.host].includes(req.headers.origin))return 403;
 }
 return null;
}
type TimelineField='recordedAtMs'|'generatedAtMs'|'targetAtMs';
type Pool={value:BrowserOutputsCatalog;contents:BrowserDisplayContent[];revision:string;byId:Map<string,BrowserDisplayContent>;timelines:Map<string,{items:BrowserDisplayContent[];unknown:boolean}>};
type Config={schema:1;revision:string;outputs:BrowserOutputConfig[];channelFadeModes:Record<BrowserOutputFadeChannel,BrowserOutputFadeMode>;channelFadeTimings:Record<BrowserOutputFadeChannel,BrowserOutputFadeTiming>;channelFaceBlurs:Record<BrowserOutputFadeChannel,BrowserOutputFaceBlur>;channelCaptions:BrowserOutputChannelCaptions};
export class BrowserOutputsStore {
 private config?:{value:Config;expires:number};private configFlight?:Promise<Config>;private configEpoch=0;
 private validatedContent=new WeakMap<object,BrowserDisplayContent>();private derived?:{src:unknown;base:BrowserDisplayContent[];byId:Map<string,BrowserDisplayContent>;idsHash:string};private pool?:{value:Pool;expires:number};private poolFlight?:Promise<Pool>;private poolEpoch=0;
 private writes:Promise<void>=Promise.resolve();
 private scenarioPreview?:{owner:string;baseRevision:string;outputs:BrowserOutputConfig[];channelCaptions?:BrowserOutputChannelCaptions};
 readonly now:()=>number;readonly ttl:number;readonly sequences:SequenceLibrary;
 constructor(private options:BrowserOutputsOptions){
  if(!path.isAbsolute(options.configFile))throw Error('Output config path must be absolute');
  this.now=options.now??Date.now;
  this.sequences=createSequenceLibrary({directory:options.sequencesDirectory??path.join(path.dirname(options.configFile),'sequences'),now:this.now});this.ttl=options.catalogTtlMs??1000;
  if(!Number.isFinite(this.ttl)||this.ttl<50||this.ttl>5000)throw Error('Invalid catalog TTL');
 }
 async configuration(force=false):Promise<Config>{
  if(!force&&this.config&&this.config.expires>this.now())return this.config.value;
  if(this.configFlight)return this.configFlight;
  const epoch=this.configEpoch;
  this.configFlight=(async()=>{
   let value:any;
   try{value=JSON.parse(await fs.readFile(this.options.configFile,'utf8'));}catch(e:any){if(e?.code==='ENOENT')value={schema:1,outputs:[]};else throw Error('Output configuration unavailable');}
   if(!plain(value)||value.schema!==1)throw Error('Output configuration unavailable');
   const outputs=validateBrowserOutputs(value.outputs),channelFadeModes=channelModes(value.channelFadeModes),channelFadeTimings=channelTimings(value.channelFadeTimings),channelFaceBlurs=channelBlurs(value.channelFaceBlurs),channelCaptions=validateChannelCaptions(value.channelCaptions),result:Config={schema:1,revision:hash({schema:1,outputs,channelFadeModes,channelFadeTimings,channelFaceBlurs,channelCaptions}),outputs,channelFadeModes,channelFadeTimings,channelFaceBlurs,channelCaptions};
   if(epoch!==this.configEpoch&&this.config)return this.config.value;
   if(this.scenarioPreview&&this.scenarioPreview.baseRevision!==result.revision)this.scenarioPreview=undefined;
   this.config={value:result,expires:this.now()+this.ttl};return result;
  })();
  try{return await this.configFlight;}finally{this.configFlight=undefined;}
 }
 async catalog():Promise<Pool>{
  if(this.pool&&this.pool.expires>this.now())return this.pool.value;
  if(this.options.staleWhileRevalidate&&this.pool){
   // 2026-10-21: a screen request never waits for the catalog rebuild: the previous catalog (at most one TTL + one rebuild old) is served.
   if(!this.poolFlight){const refresh=this.rebuildPool();this.poolFlight=refresh;void refresh.catch(()=>undefined).finally(()=>{if(this.poolFlight===refresh)this.poolFlight=undefined;});}
   return this.pool.value;
  }
  if(this.poolFlight)return this.poolFlight;
  const flight=this.rebuildPool();
  this.poolFlight=flight;
  try{return await flight;}finally{if(this.poolFlight===flight)this.poolFlight=undefined;}
 }
 private rebuildPool():Promise<Pool>{
  const epoch=this.poolEpoch;
  return (async()=>{
   const raw=await this.options.loadCatalog();
   if(!plain(raw)||!plain(raw.current)||!plain(raw.sourceScopes)||!plain(raw.clocks))throw Error('Catalog unavailable');
   // The catalog source keeps the same array while nothing changed: validate / index / sort / hash it once.
   let derived=this.derived;
   if(!derived||derived.src!==raw.contents){
    // Known-valid content objects (the source keeps them stable) are not validated again; only new ones are.
    const known=this.validatedContent,fresh:BrowserDisplayContent[]=[];for(const c of raw.contents as BrowserDisplayContent[])if(!known.has(c as object))fresh.push(c);
    if(fresh.length){const checked=validateBrowserDisplayContents(fresh);fresh.forEach((c,i)=>known.set(c as object,checked[i]));}
    const ids=new Set<string>(),validated=(raw.contents as BrowserDisplayContent[]).map(c=>{const v=known.get(c as object)!;if(ids.has(v.id))throw Error('Invalid display registry');ids.add(v.id);return v;}),time0=(c:BrowserDisplayContent)=>c.provenance==='actual'?c.recordedAtMs:c.provenance==='generated'?c.generatedAtMs:null;
    const base=validated.slice().sort((a,b)=>(time0(b)??-Infinity)-(time0(a)??-Infinity)||a.id.localeCompare(b.id));
    derived={src:raw.contents,base,byId:new Map(validated.map(c=>[c.id,c])),idsHash:hash(validated.map(c=>c.id+'|'+c.imageUrl+'|'+(c.thumbnailUrl??'')))};this.derived=derived;
   }
   const byId=derived.byId;let contents=derived.base;
   const current:BrowserOutputsCatalog['current']={};
   for(const key of ['now','a','b','c'] as const){const id=raw.current[key];if(id!==undefined){const c=byId.get(id);const stand=key!=='now'&&plain(raw.standIn)&&(raw.standIn as any)[key]===true&&c?.sceneKey==='now'&&c?.provenance==='actual';if(!c||(!stand&&(c.sceneKey!==(key==='now'?'now':'gen_'+key)||c.provenance!==(key==='now'?'actual':'generated'))))throw Error('Invalid current content');current[key]=id;}}
   const sourceScopes:BrowserOutputsCatalog['sourceScopes']={};
   for(const key of ['actual-past','generated-history'] as const){const scope=raw.sourceScopes[key];if(scope!==undefined){if(!text(scope))throw Error('Invalid source scope');sourceScopes[key]=scope;}}
   const clocks:BrowserOutputsCatalog['clocks']=Object.create(null);
   for(const [scope,clock]of Object.entries(raw.clocks)){
    if(!text(scope)||!plain(clock)||!Number.isSafeInteger(clock.serverAnchorMs)||!Number.isSafeInteger(clock.worldAnchorMs)||!Number.isFinite(clock.rate))throw Error('Invalid source clock');
    clocks[scope]={serverAnchorMs:clock.serverAnchorMs,worldAnchorMs:clock.worldAnchorMs,rate:clock.rate};
   }
   let tdRouting:BrowserOutputTdRouting|undefined;
   if(raw.tdRouting!==undefined){
    const td=raw.tdRouting;
    if(!plain(td)||!plain(td.slots)||!plain(td.view)||Object.keys(td).some(k=>!['slots','view'].includes(k))||Object.entries(td.slots).some(([k,v])=>!/^td-[1-4]$/.test(k)||!['now','a','b','c'].includes(v as string))||Object.keys(td.view).some(k=>!['visible','labels','subtitles','fade'].includes(k))||!['visible','labels','subtitles','fade'].every(k=>typeof td.view[k]==='boolean'))throw Error('Invalid TD routing');
    tdRouting={slots:{...td.slots},view:{visible:td.view.visible,labels:td.view.labels,subtitles:td.view.subtitles,fade:td.view.fade}};
   }
   const currentIds=new Set(Object.values(current));
   const time=(c:BrowserDisplayContent)=>c.provenance==='actual'?c.recordedAtMs:c.provenance==='generated'?c.generatedAtMs:null;
   if(currentIds.size){const head=contents.filter(c=>currentIds.has(c.id)),tail=contents.filter(c=>!currentIds.has(c.id));contents=[...head,...tail];}
   const fadeBatches:Record<string,BrowserOutputFadeBatch>=Object.create(null);
   if(raw.fadeBatches!==undefined){if(!plain(raw.fadeBatches))throw Error('Invalid fade batches');for(const [key,batch] of Object.entries(raw.fadeBatches)){if(!text(key)||!plain(batch)||batch.captureId!==key||!Number.isSafeInteger(batch.completedAtMs)||batch.completedAtMs<0)throw Error('Invalid fade batch');fadeBatches[key]={captureId:key,completedAtMs:batch.completedAtMs};}}
   const currentStatus:NonNullable<BrowserOutputsCatalog['currentStatus']>={};
   if(plain(raw.currentStatus))for(const key of ['now','a','b','c'] as const){const st=(raw.currentStatus as any)[key];if(plain(st)&&['idle','generating','completed','failed'].includes(st.state as string)){const s=(v:unknown)=>typeof v==='string'?v.slice(0,512):null;currentStatus[key]={state:st.state as any,requestedCaptureId:s(st.requestedCaptureId),displayedCaptureId:s(st.displayedCaptureId),error:s(st.error),userMessage:s(st.userMessage),lastSuccessAtMs:Number.isSafeInteger(st.lastSuccessAtMs)?st.lastSuccessAtMs as number:null};}}
   const standIn:NonNullable<BrowserOutputsCatalog['standIn']>={};if(plain(raw.standIn))for(const key of ['a','b','c'] as const)if((raw.standIn as any)[key]===true&&current[key])standIn[key]=true;
   const value={contents,current,sourceScopes,clocks,fadeBatches,currentStatus,standIn,...(tdRouting?{tdRouting}:{})},result:Pool={value,contents,revision:hash({contents:derived.idsHash,current}),byId,timelines:new Map()};
   if(epoch===this.poolEpoch)this.pool={value:result,expires:this.now()+this.ttl};return result;
  })();
 }
 invalidateCatalog(){this.pool=undefined;this.poolEpoch++;this.poolFlight=undefined;}
 private selectAt(pool:Pool,scope:string|undefined,provenance:string,scene:string|undefined,field:TimelineField,upper:number|null){
  const key=JSON.stringify([scope,provenance,scene,field]);let timeline=pool.timelines.get(key);
  if(!timeline){
   const entries=pool.contents.filter(c=>c.scope===scope&&c.provenance===provenance&&(!scene||c.sceneKey===scene));
   timeline={items:entries.filter(c=>c[field]!==null).sort((a,b)=>a[field]!-b[field]!||a.id.localeCompare(b.id)),unknown:entries.some(c=>c[field]===null)};
   pool.timelines.set(key,timeline);
  }
  let low=0,high=timeline.items.length;
  if(upper!==null)while(low<high){const mid=(low+high)>>>1;if(timeline.items[mid][field]!<=upper)low=mid+1;else high=mid;}
  return {content:upper===null?undefined:timeline.items[low-1],unknown:timeline.unknown};
 }
 async update(raw:unknown):Promise<Config>{
  if(!plain(raw))throw new OutputError(400,'JSON object required');
  fields(raw,['baseRevision','outputs','requestId','channelFadeModes','channelFadeTimings','channelFaceBlurs','channelCaptions']);
  if(!text(raw.baseRevision,64)||!text(raw.requestId,128))throw new OutputError(400,'Revision and requestId required');
  let outputs=validateBrowserOutputs(raw.outputs);channelModes(raw.channelFadeModes);channelTimings(raw.channelFadeTimings);channelBlurs(raw.channelFaceBlurs);validateChannelCaptions(raw.channelCaptions);
  let resolve!:(v:Config)=>void,reject!:(e:unknown)=>void;
  const result=new Promise<Config>((a,b)=>{resolve=a;reject=b;});
  this.writes=this.writes.then(async()=>{
   try{
    const current=await this.configuration(true);if(raw.baseRevision!==current.revision)throw new OutputError(409,'Configuration changed; reload before saving');
    outputs=stampSequenceStarts(validateBrowserOutputs(raw.outputs,current.outputs),current.outputs,this.now());
    await this.checkSequences(outputs,current.outputs);
    if(outputs.some(o=>o.source==='fixed')){const pool=await this.catalog();if(outputs.some(o=>o.source==='fixed'&&!pool.byId.has(o.contentId!)))throw new OutputError(400,'Unknown catalog contentId');}
    const channelFadeModes=channelModes(raw.channelFadeModes,current.channelFadeModes),channelFadeTimings=channelTimings(raw.channelFadeTimings,current.channelFadeTimings),channelFaceBlurs=channelBlurs(raw.channelFaceBlurs,current.channelFaceBlurs),channelCaptions=validateChannelCaptions(raw.channelCaptions,current.channelCaptions);
    const directory=path.dirname(this.options.configFile),temporary=path.join(directory,'.browser-outputs-'+randomUUID()+'.tmp');
    await fs.mkdir(directory,{recursive:true});
    let handle:Awaited<ReturnType<typeof fs.open>>|undefined;
    try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify({schema:1,outputs,channelFadeModes,channelFadeTimings,channelFaceBlurs,channelCaptions},null,2));await handle.sync();await handle.close();handle=undefined;await renameRetry(temporary,this.options.configFile);}
    catch(error){await handle?.close().catch(()=>undefined);await fs.unlink(temporary).catch(()=>undefined);throw error;}
    const next:Config={schema:1,revision:hash({schema:1,outputs,channelFadeModes,channelFadeTimings,channelFaceBlurs,channelCaptions}),outputs,channelFadeModes,channelFadeTimings,channelFaceBlurs,channelCaptions};this.scenarioPreview=undefined;this.configEpoch++;this.config={value:next,expires:this.now()+this.ttl};
    console.log(`[mapping] ${new Date().toISOString()} update origin=${String(raw.requestId).startsWith('scenario-')?'scenario':'ui'} rev ${current.revision.slice(0,8)} -> ${next.revision.slice(0,8)}`);
    resolve(next);
   }catch(error){reject(error);}
  });
  return result;
 }
 async setScenarioPreview(owner:string,baseRevision:string,rawOutputs:unknown,rawChannelCaptions?:unknown):Promise<void>{
  if(!text(owner,128))throw new OutputError(400,'Invalid preview owner');
  const config=await this.configuration(true),epoch=this.configEpoch;
  if(config.revision!==baseRevision){this.scenarioPreview=undefined;throw new OutputError(409,'Output mapping changed manually; preview was cleared');}
  if(this.scenarioPreview&&this.scenarioPreview.owner!==owner)throw new OutputError(409,'Another output preview is active');
  const previous=this.scenarioPreview?.baseRevision===baseRevision?this.scenarioPreview.outputs:config.outputs;
  const outputs=stampSequenceStarts(validateBrowserOutputs(rawOutputs,config.outputs),previous,this.now()),channelCaptions=rawChannelCaptions===undefined?undefined:validateChannelCaptions(rawChannelCaptions,config.channelCaptions);
  if(outputs.some(o=>o.source==='fixed')){const pool=await this.catalog();if(outputs.some(o=>o.source==='fixed'&&!pool.byId.has(o.contentId!)))throw new OutputError(400,'Unknown catalog contentId');}
  await this.checkSequences(outputs,previous);
  if(epoch!==this.configEpoch){this.scenarioPreview=undefined;throw new OutputError(409,'Output mapping changed manually; preview was cleared');}
  this.scenarioPreview={owner,baseRevision,outputs:structuredClone(outputs),...(channelCaptions?{channelCaptions}:{})};
 }
 /** A new or changed sequence output must name an existing folder with at least one frame (unchanged ones are not re-checked). */
 private async checkSequences(outputs:BrowserOutputConfig[],previous:BrowserOutputConfig[]){
  for(const o of outputs){
   if(o.source!=='fixed-sequence'||sequenceKey(previous.find(p=>p.id===o.id))===sequenceKey(o))continue;
   const folder=await this.sequences.folder(o.sequenceFolder!);
   if(!folder||!folder.frameCount)throw new OutputError(400,`Unknown or empty sequence folder: ${o.sequenceFolder}`);
  }
 }
 clearScenarioPreview(owner:string):void{if(this.scenarioPreview?.owner===owner)this.scenarioPreview=undefined;}
 /** Saved Label/Text switches for a fixed scene or routing slot; a Preview scenario's transient override wins. */
 async channelCaptions(id:string):Promise<BrowserOutputCaptions|undefined>{
  if(!BROWSER_OUTPUT_FADE_CHANNELS.includes(id as BrowserOutputFadeChannel))return undefined;
  const config=await this.configuration(),preview=this.scenarioPreview?.baseRevision===config.revision?this.scenarioPreview.channelCaptions:undefined;
  return {...(preview??config.channelCaptions)[id as BrowserOutputFadeChannel]};
 }
 async channelFaceBlur(id:string):Promise<BrowserOutputFaceBlur|undefined>{const blur=BROWSER_OUTPUT_FADE_CHANNELS.includes(id as BrowserOutputFadeChannel)?(await this.configuration()).channelFaceBlurs[id as BrowserOutputFadeChannel]:undefined;return blur?{...blur}:undefined;}
 async channelFadeTiming(id:string):Promise<BrowserOutputFadeTiming|undefined>{const timing=BROWSER_OUTPUT_FADE_CHANNELS.includes(id as BrowserOutputFadeChannel)?(await this.configuration()).channelFadeTimings[id as BrowserOutputFadeChannel]:undefined;return timing?{...timing}:undefined;}
 async channelFadeMode(id:string):Promise<BrowserOutputFadeMode|undefined>{return BROWSER_OUTPUT_FADE_CHANNELS.includes(id as BrowserOutputFadeChannel)?(await this.configuration()).channelFadeModes[id as BrowserOutputFadeChannel]:undefined;}
 async snapshot(id:string,at=this.now()):Promise<(BrowserDisplaySnapshot&{output:BrowserOutputConfig;view:{visible:boolean;labels:boolean;subtitles:boolean;fade:boolean;fadeMode:BrowserOutputFadeMode;fadeDurationMs:number;blackHoldMs:number;fadeOnImageChange:boolean;faceBlur:BrowserOutputFaceBlur};fadeBatch?:BrowserOutputFadeBatch;sequence?:{folder:string;frame:number;start:number;end:number;count:number;frameSec:number;loop:boolean;nextChangeAtMs:number|null};outputStatus:{state:'ready'|'not-ready'|'hidden';reason:string|null}})|null>{
  if(!idPattern.test(id))return null;
  const config=await this.configuration(),output=(this.scenarioPreview?.baseRevision===config.revision?this.scenarioPreview.outputs:config.outputs).find(o=>o.id===id);if(!output)return null;
  const pool=await this.catalog(),catalog=pool.value;
  const tdAlias=/^td-[1-4]$/.test(output.source);
  const source=tdAlias?catalog.tdRouting?.slots[output.source as keyof BrowserOutputTdRouting['slots']]:output.source;
  const desiredView={visible:output.visible,labels:output.labels,subtitles:output.subtitles,fade:output.fade};
  if(tdAlias)for(const key of ['visible','labels','subtitles','fade'] as const)desiredView[key]=desiredView[key]&&(catalog.tdRouting?.view[key]??false);
  let content:BrowserDisplayContent|undefined,scope:string|undefined,reason:string|null=null,sequence:NonNullable<Awaited<ReturnType<SequenceLibrary['current']>>>['sequence']|undefined;
  if(source===undefined)reason='td-routing-unavailable';
  else if(source==='fixed'){content=pool.byId.get(output.contentId!);scope=content?.scope;}
  else if(source==='fixed-sequence'){
   const now=await this.sequences.current({folder:output.sequenceFolder!,frameSec:output.frameSec??30,startFrame:output.startFrame,endFrame:output.endFrame,loop:output.loop,startedAtMs:output.sequenceStartedAtMs??0,nowMs:at});
   if(now){content=now.content;sequence=now.sequence;scope=content.scope;}else reason='sequence-unavailable';
  }
  else if(['now','a','b','c'].includes(source)){
   const key=source as 'now'|'a'|'b'|'c';content=catalog.current[key]?pool.byId.get(catalog.current[key]!):undefined;scope=content?.scope;
   if(content&&output.delaySec>0){
    const clock=catalog.clocks[content.scope],world=clock?clock.worldAnchorMs+(at-clock.serverAnchorMs)*clock.rate:null;
    const selection=this.selectAt(pool,scope,content.provenance,content.sceneKey??undefined,content.provenance==='actual'?'recordedAtMs':'generatedAtMs',world===null?null:world-output.delaySec*1000);
    content=selection.content;if(!content)reason=selection.unknown?'time-unknown':'no-eligible-content';
   }
  }else{
   scope=catalog.sourceScopes[source as 'actual-past'|'generated-history'];
   const clock=scope?catalog.clocks[scope]:undefined,world=clock?clock.worldAnchorMs+(at-clock.serverAnchorMs)*clock.rate:null;
   const actual=source==='actual-past';
   const selection=this.selectAt(pool,scope,actual?'actual':'generated',actual||output.scene==='any'?undefined:'gen_'+output.scene,actual?'recordedAtMs':'targetAtMs',world===null?null:world-output.delaySec*1000);
   content=selection.content;if(!content)reason=selection.unknown?'time-unknown':'no-eligible-content';
  }
  if(content)scope=content.scope;
  const clock=scope?catalog.clocks[scope]:undefined;
  if(!clock){if(source!=='fixed'&&source!=='fixed-sequence')content=undefined;if(!reason)reason='clock-unavailable';}
  if(!content&&!reason)reason='source-unavailable';
  if(content?.provenance==='generated'){
   let caption='Generation instruction unavailable.';
   try{
    const projected=await this.options.resolveContent?.({...content});
    if(projected&&['id','scope','imageUrl','captureId','sceneKey','provenance'].every(key=>(projected as any)[key]===(content as any)[key])&&typeof projected.caption==='string'&&projected.caption.trim()&&projected.caption.length<=8000)caption=projected.caption;
   }catch{/* Unavailable instruction evidence never falls back to an observed-image caption. */}
   content={...content,caption};
  }
  const visible=desiredView.visible&&!!content;
  const snapshot=buildBrowserDisplaySnapshot({id:output.id,label:output.label,accent:'#286078',clock:{...(clock??{serverAnchorMs:at,worldAnchorMs:at,rate:1}),scope:scope??'browser-output:waiting'},selection:{mode:'pinned',contentId:visible?content!.id:'not-ready'}},visible?[content!]:[],at);
  const clockKnown=!!clock&&content?.provenance!=='uploaded';
  if(!clockKnown)snapshot.temporalRelation='unknown';
  if(reason==='time-unknown')snapshot.selectionStatus='time-unknown';
  const outputStatus={state:!output.visible?'hidden':!source?'not-ready':!desiredView.visible?'hidden':content?'ready':'not-ready',reason:!output.visible?'hidden':reason??(!desiredView.visible?'hidden':null)} as const;
  const view={...desiredView,visible,fadeMode:desiredView.fade?(output.fadeMode??'original'):'none' as BrowserOutputFadeMode,fadeDurationMs:output.fadeDurationMs??800,blackHoldMs:output.blackHoldMs??120,fadeOnImageChange:output.source==='fixed'||output.source==='fixed-sequence',faceBlur:faceBlur(output.faceBlur)};
  const fadeBatch=content?.captureId?catalog.fadeBatches?.[content.captureId]:undefined;
  // Generating / failed notice for screens that follow the live NOW/A/B/C sources.
  const standInFor=(['a','b','c'] as const).includes(source as any)&&catalog.standIn?.[source as 'a'|'b'|'c']?source as 'a'|'b'|'c':undefined;
  const displayStatus=['now','a','b','c'].includes(source as string)&&!(output.delaySec>0)?catalog.currentStatus?.[source as 'now'|'a'|'b'|'c']:undefined;
  const scenarioOverride=this.scenarioPreview?.baseRevision===config.revision?{runId:this.scenarioPreview.owner,source:output.source}:undefined;
  const result={...snapshot,...(scenarioOverride?{scenarioOverride}:{}),clock:{...snapshot.clock,known:clockKnown},output,view,...(fadeBatch?{fadeBatch}:{}),...(displayStatus?{displayStatus}:{}),...(standInFor?{standInFor}:{}),...(sequence?{sequence}:{}),outputStatus,revision:hash({sequence,snapshotRevision:snapshot.revision,clockKnown,output,view,outputStatus,fadeBatch,displayStatus,standInFor,scenarioOverride})};
  if(!this.options.presentSnapshot)return result;
  const presented=await this.options.presentSnapshot(result);
  return {...result,...presented,output:result.output,view:result.view,outputStatus:result.outputStatus};
 }
 catalogItem(c:BrowserDisplayContent){
  const candidate=this.options.thumbnails?this.options.thumbnails.thumbnailUrl(c.imageUrl):c.thumbnailUrl??c.imageUrl;
  const scene=c.sceneKey==='now'?'now':/^gen_[abc]$/.test(c.sceneKey??'')?c.sceneKey!.slice(-1):null;
  const label=c.provenance==='uploaded'?(c.caption.trim()||'Uploaded image'):c.provenance==='actual'?(c.caption.trim()||`NOW · ${c.captureId??c.id}`):`Generated ${scene?.toUpperCase()??'image'} · ${c.captureId??c.id}`;
  return {id:c.id,contentId:c.id,label:label.slice(0,128),scene,scope:c.scope,provenance:c.provenance,imageUrl:c.imageUrl,thumbnailUrl:isBrowserDisplayImageUrl(candidate)?candidate:null,recordedAtMs:c.recordedAtMs,sourceRecordedAtMs:c.sourceRecordedAtMs,targetAtMs:c.targetAtMs,generatedAtMs:c.generatedAtMs,distanceSecSigned:c.distanceSecSigned??null,caption:c.provenance==='generated'?'Generation instruction unavailable.':c.caption,captureId:c.captureId??null,sceneKey:c.sceneKey??null};
 }
 async page(query:{cursor?:string;limit?:string;kind?:string}){
  const limit=query.limit===undefined?30:Number(query.limit),kind=query.kind??'all';
  if(!Number.isInteger(limit)||limit<1||limit>100||!['all','actual','generated','uploaded'].includes(kind))throw new OutputError(400,'Invalid catalog query');
  const pool=await this.catalog();let offset=0;
  if(query.cursor){try{const value=JSON.parse(Buffer.from(query.cursor,'base64url').toString());if(value.revision!==pool.revision||value.kind!==kind)throw new OutputError(409,'Catalog changed; reload first page');if(!Number.isSafeInteger(value.offset)||value.offset<0)throw Error();offset=value.offset;}catch(e){if(e instanceof OutputError)throw e;throw new OutputError(400,'Invalid cursor');}}
  const all=pool.contents.filter(c=>kind==='all'||c.provenance===kind);
  const items=all.slice(offset,offset+limit).map(c=>this.catalogItem(c));
  return {schema:1,revision:pool.revision,items,nextCursor:offset+limit<all.length?Buffer.from(JSON.stringify({revision:pool.revision,kind,offset:offset+limit})).toString('base64url'):null};
 }
}
export function registerBrowserOutputsRoutes(app:Pick<Express,'use'>,options:BrowserOutputsOptions){
 const store=new BrowserOutputsStore(options),allowedHosts=new Set(options.allowedHosts??['localhost:3000','127.0.0.1:3000']);
 for(const host of allowedHosts){const parsed=new URL('http://'+host);if(parsed.host!==host||parsed.port!=='3000'||parsed.pathname!=='/'||parsed.search||parsed.hash||parsed.username||parsed.password||!(parsed.hostname==='localhost'||peer(parsed.hostname)||/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(parsed.hostname)))throw Error('Invalid browser-output allowed Host');}
 app.use(async(req,res,next)=>{
  const url=new URL(req.originalUrl||req.url,'http://local'),route=url.pathname;
  if(route!=='/api/browser-outputs'&&!route.startsWith('/api/browser-outputs/')&&!route.startsWith('/captures/browser-output-assets/')&&!route.startsWith('/captures/browser-output-thumbnails/')&&!route.startsWith('/captures/sequences/'))return next();
  const forbidden=browserOutputsAccess(req as any,allowedHosts);if(forbidden)return res.status(forbidden).json({ok:false,error:'Browser-output access denied'});
  res.removeHeader('Access-Control-Allow-Origin');res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  try{
   if(req.method==='GET'&&route==='/api/browser-outputs'&&!url.search)return res.json(await store.configuration());
   if(req.method==='GET'&&route==='/api/browser-outputs/catalog'){
    if([...url.searchParams.keys()].some(k=>!['cursor','limit','kind'].includes(k))||[...url.searchParams.keys()].some(k=>url.searchParams.getAll(k).length!==1))throw new OutputError(400,'Unsupported catalog query');
    return res.json(await store.page({cursor:url.searchParams.get('cursor')??undefined,limit:url.searchParams.get('limit')??undefined,kind:url.searchParams.get('kind')??undefined}));
   }
   if(req.method==='GET'&&route.startsWith('/captures/browser-output-assets/')&&!url.search){
    const asset=await options.assets?.resolve(route);if(!asset)return res.status(404).json({ok:false,error:'Asset not found'});
    res.type(asset.contentType);return res.sendFile(asset.absolutePath);
   }
   if(req.method==='GET'&&route==='/api/browser-outputs/sequences'&&!url.search)return res.json({schema:1,directory:'sequences',sequences:await store.sequences.list()});
   if(req.method==='GET'&&route.startsWith('/captures/sequences/')&&!url.search){
    const frame=await store.sequences.resolve(route);if(!frame)return res.status(404).json({ok:false,error:'Frame not found'});
    res.type(frame.contentType);return res.sendFile(frame.absolutePath);
   }
   if(req.method==='GET'&&route.startsWith('/captures/browser-output-thumbnails/')&&!url.search){
    const file=await options.thumbnails?.resolveThumbnail(route);if(!file)return res.status(404).json({ok:false,error:'Thumbnail not found'});
    res.type('image/jpeg');return res.sendFile(file);
   }
   if(req.method==='GET'&&/^\/api\/browser-outputs\/screen-[1-9][0-9]{0,2}$/.test(route)&&!url.search){const snapshot=await store.snapshot(route.split('/').at(-1)!);return snapshot?res.json(snapshot):res.status(404).json({ok:false,error:'Output not found'});}
   if(req.method==='POST'&&(route==='/api/browser-outputs'||route==='/api/browser-outputs/assets'||route==='/api/browser-outputs/sequences')&&!url.search){
    let body:any=req.body;
    const max=route.endsWith('/assets')||route.endsWith('/sequences')?12*1024*1024:64*1024;
    if(body===undefined){const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const part=Buffer.from(chunk);size+=part.length;if(size>max)throw new OutputError(413,'Request too large');chunks.push(part);}try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{throw new OutputError(400,'Invalid JSON');}}
    else if(Buffer.byteLength(JSON.stringify(body))>max)throw new OutputError(413,'Request too large');
    if(route.endsWith('/sequences')){
     if(!plain(body))throw new OutputError(400,'JSON object required');fields(body,['folder','index','imageDataUrl']);
     if(typeof body.folder!=='string'||typeof body.imageDataUrl!=='string')throw new OutputError(400,'Invalid sequence import');
     try{return res.status(201).json({schema:1,...await store.sequences.importFrame({folder:body.folder,index:body.index,imageDataUrl:body.imageDataUrl})});}
     catch(e:any){if(e?.statusCode)throw new OutputError(e.statusCode,e.message);throw e;}
    }
    if(route.endsWith('/assets')){
     if(!options.assets)throw new OutputError(503,'Image import unavailable');
     if(!plain(body))throw new OutputError(400,'JSON object required');fields(body,['filename','imageDataUrl']);
     if(!text(body.filename,180)||typeof body.imageDataUrl!=='string')throw new OutputError(400,'Invalid image import');
     const content=validateBrowserDisplayContents([await options.assets.importImage({filename:body.filename,imageDataUrl:body.imageDataUrl})])[0];store.invalidateCatalog();
     return res.status(201).json({schema:1,item:store.catalogItem(content),contentId:content.id,content});
    }
    return res.json(await store.update(body));
   }
   return res.status(404).json({ok:false,error:'Unknown browser-output route'});
  }catch(error){const assetStatus=(error as {statusCode?:number})?.statusCode;const status=error instanceof OutputError?error.status:[400,413,415,422].includes(assetStatus??0)?assetStatus!:503;return res.status(status).json({ok:false,error:error instanceof OutputError?error.message:status<500?'Image import rejected':'Browser-output service unavailable'});}
 });
 return store;
}


