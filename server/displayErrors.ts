/** Browser-side display problems (timeouts, lost connection, slow/failed images, face blur, JS errors) -> logs/display-errors.jsonl. */
import fs from 'node:fs';
import path from 'node:path';

export const DISPLAY_ERROR_KINDS=['timeout','connection','http','slow-response','slow-image','image-error','face-blur-unavailable','js-error'] as const;
export interface DisplayErrorEntry{kind:string;detail:string;ms:number;count:number}
const SCREEN=/^(?:screen-[1-9][0-9]{0,2}|control-output-[1-4])$/;
const MAX_FILE_BYTES=20*1024*1024;

export function createDisplayErrorLog(options:{file:string;now?:()=>number;perMinute?:number}){
  const now=options.now??Date.now,perMinute=options.perMinute??120;
  let windowStart=0,windowCount=0,size=-1;
  const recent:{at:number;screen:string;kind:string;count:number;ms:number}[]=[];
  function sanitize(raw:unknown):DisplayErrorEntry[]{
    if(!Array.isArray(raw))return [];
    const out:DisplayErrorEntry[]=[];
    for(const row of raw.slice(0,20)){
      if(!row||typeof row!=='object')continue;const r=row as Record<string,unknown>;
      if(typeof r.kind!=='string'||!(DISPLAY_ERROR_KINDS as readonly string[]).includes(r.kind))continue;
      const detail=typeof r.detail==='string'?r.detail.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,200):'';
      const ms=Number.isFinite(r.ms)?Math.max(0,Math.min(3_600_000,Math.round(r.ms as number))):0;
      const count=Number.isInteger(r.count)?Math.max(1,Math.min(10_000,r.count as number)):1;
      out.push({kind:r.kind,detail,ms,count});
    }
    return out;
  }
  function record(screen:unknown,device:'tailnet'|'public',raw:unknown):{ok:boolean;accepted:number;status?:number}{
    if(typeof screen!=='string'||!SCREEN.test(screen))return {ok:false,accepted:0,status:400};
    const entries=sanitize(raw);if(!entries.length)return {ok:true,accepted:0};
    const t=now();if(t-windowStart>60_000){windowStart=t;windowCount=0;}
    if(windowCount+entries.length>perMinute)return {ok:false,accepted:0,status:429};
    windowCount+=entries.length;
    try{
      fs.mkdirSync(path.dirname(options.file),{recursive:true});
      if(size<0){try{size=fs.statSync(options.file).size;}catch{size=0;}}
      if(size>MAX_FILE_BYTES)return {ok:false,accepted:0,status:507};
      const lines=entries.map(e=>JSON.stringify({time:new Date(t).toISOString(),screen,device,...e})+'\n').join('');
      fs.appendFile(options.file,lines,()=>{});size+=Buffer.byteLength(lines);
    }catch{/* logging never breaks the display */}
    for(const e of entries)recent.push({at:t,screen,kind:e.kind,count:e.count,ms:e.ms});
    while(recent.length>200)recent.shift();
    return {ok:true,accepted:entries.length};
  }
  /** Short MAIN lines for the last 10 minutes, one per screen+kind with a total count. */
  function summary():string[]{
    const t=now(),groups=new Map<string,{screen:string;kind:string;count:number;maxMs:number;last:number}>();
    for(const e of recent){if(t-e.at>600_000)continue;const k=e.screen+'|'+e.kind,g=groups.get(k)??{screen:e.screen,kind:e.kind,count:0,maxMs:0,last:0};g.count+=e.count;g.maxMs=Math.max(g.maxMs,e.ms);g.last=Math.max(g.last,e.at);groups.set(k,g);}
    return [...groups.values()].sort((a,b)=>b.last-a.last).slice(0,6).map(g=>`${g.screen}: ${g.kind} x${g.count}${g.maxMs?` (max ${(g.maxMs/1000).toFixed(1)}s)`:''}`);
  }
  return {record,summary};
}
