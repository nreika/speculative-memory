/** Append-only saved-frame metadata reader. It never infers capture time from savedAt/filenames. */
import fs from'node:fs/promises';import{createHash}from'node:crypto';
import{isBrowserDisplayImageUrl,type BrowserDisplayContent}from'./browserDisplay';
export type BrowserOutputRecording=BrowserDisplayContent&{recordingAutoScope?:string};
export const validRecordingScope=(value:unknown):value is string=>typeof value==='string'&&/^camera:[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value);
export function explicitRecordingTime(value:unknown):number|null{
 if(typeof value!=='string')return null;
 const fields=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);if(!fields)return null;
 const [year,month,day,hour,minute,second]=fields.slice(1).map(Number),leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 if(month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59)return null;
 const parsed=Date.parse(value);return Number.isSafeInteger(parsed)?parsed:null;
}
export interface BrowserOutputRecordingsOptions {recordingsFile:string;publicBaseUrl?:string;onParse?:(count:number)=>void}
export function createBrowserOutputRecordings(options:BrowserOutputRecordingsOptions){
 const contents=new Map<string,BrowserOutputRecording>();let offset=0,identity='',modified=-1,remainder=Buffer.alloc(0),inflight:Promise<BrowserOutputRecording[]>|undefined;
 let publicOrigin:string|undefined;try{publicOrigin=options.publicBaseUrl?new URL(options.publicBaseUrl).origin:undefined;}catch{}
 const parseRow=(raw:unknown):BrowserOutputRecording|null=>{
  const row=raw as Record<string,unknown>;if(!row||typeof row!=='object'||typeof row.filename!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,239}\.(?:png|jpe?g|webp)$/i.test(row.filename)||typeof row.url!=='string')return null;
  let imageUrl=row.url;
  if(!imageUrl.startsWith('/')){try{const url=new URL(imageUrl);if(!publicOrigin||url.origin!==publicOrigin||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)return null;imageUrl=url.pathname;}catch{return null;}}
  if(imageUrl!=='/captures/'+row.filename||!isBrowserDisplayImageUrl(imageUrl))return null;
  const capturedAt=explicitRecordingTime(row.capturedAt),known=row.source==='live-camera'&&capturedAt!==null&&validRecordingScope(row.sourceScope);
  const scope=known?row.sourceScope as string:'recordings:unknown';
  return {id:'recording:'+createHash('sha256').update(imageUrl).digest('hex').slice(0,32),scope,provenance:'actual',imageUrl,recordedAtMs:known?capturedAt:null,sourceRecordedAtMs:known?capturedAt:null,targetAtMs:null,generatedAtMs:null,distanceSecSigned:null,caption:known?'Camera frame':'Recorded frame (time and source unknown)',...(known?{recordingAutoScope:scope}:{})};
 };
 const read=async()=>{
  let stat;try{stat=await fs.stat(options.recordingsFile);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [...contents.values()].map(c=>({...c}));throw error;}
  const key=`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  if(key===identity&&stat.size===offset&&stat.mtimeMs===modified)return [...contents.values()].map(c=>({...c}));
  if(key!==identity||stat.size<offset||(stat.size===offset&&stat.mtimeMs!==modified)){contents.clear();offset=0;remainder=Buffer.alloc(0);}
  const handle=await fs.open(options.recordingsFile,'r');let parsed=0;
  try{
   while(offset<stat.size){const data=Buffer.alloc(Math.min(65536,stat.size-offset)),{bytesRead}=await handle.read(data,0,data.length,offset);if(!bytesRead)break;offset+=bytesRead;const combined=Buffer.concat([remainder,data.subarray(0,bytesRead)]);let start=0;
    for(let i=0;i<combined.length;i++)if(combined[i]===10){const line=combined.subarray(start,i).toString('utf8');start=i+1;if(!line.trim())continue;parsed++;try{const content=parseRow(JSON.parse(line));if(content)contents.set(content.imageUrl,content);}catch{}}
    remainder=Buffer.from(combined.subarray(start));
    if(remainder.length>1024*1024)remainder=Buffer.alloc(0); // Invalid torn metadata cannot grow without bound.
   }
  }finally{await handle.close();}
  identity=key;modified=stat.mtimeMs;options.onParse?.(parsed);return [...contents.values()].map(c=>({...c}));
 };
 return {readRecords():Promise<BrowserOutputRecording[]>{if(inflight)return inflight;inflight=read().finally(()=>{inflight=undefined;});return inflight;}};
}
