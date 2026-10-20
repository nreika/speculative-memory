import {localImagePath} from './timeline.mjs';

export const SCENE_COLORS={now:'#c6d1d8',a:'#ef9b4a',b:'#e877a9',c:'#6caef0'};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const count=value=>Number.isInteger(value)&&value>=0?value:null;
export function jstDay(ms){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ms));
  const value=type=>parts.find(part=>part.type===type).value;
  return value('year')+'-'+value('month')+'-'+value('day');
}
export function pendingRefreshIds(events,freshIds,cursor=0,maximum=3){
  const pending=events.filter(event=>event.status==='running'&&!freshIds.has(event.id));
  if(!pending.length)return {ids:[],cursor:0};
  const length=Math.min(maximum,pending.length),ids=[];
  for(let i=0;i<length;i++)ids.push(pending[(cursor+i)%pending.length].id);
  return {ids,cursor:(cursor+length)%pending.length};
}
// Keep each gap's original boundary: newly merged head rows are not proof that
// the missing interval below them has been read. Historical paging is separate.
export class RecentHistoryGaps{
  constructor(){this.jobs=[];}
  get cursor(){return this.jobs[0]?.cursor??null;}
  observeHead(page,knownIds){
    if(!knownIds.size||!page.events.length||!page.nextCursor||page.events.some(row=>knownIds.has(row.captureId)))return;
    if(!this.jobs.some(job=>job.cursor===page.nextCursor))this.jobs.push({cursor:page.nextCursor,boundary:new Set(knownIds),seen:new Set([page.nextCursor])});
  }
  acceptPage(cursor,page){
    const job=this.jobs[0];if(!job||job.cursor!==cursor)throw Error('Unexpected recent-history cursor');
    if(page.events.some(row=>job.boundary.has(row.captureId))||page.nextCursor===null){this.jobs.shift();return;}
    if(job.seen.has(page.nextCursor))throw Error('The log server repeated a recent-history cursor');
    job.cursor=page.nextCursor;job.seen.add(page.nextCursor);
  }
}
export function elapsedLabel(ms){
  if(!finite(ms))return 'Unknown';
  const seconds=Math.round(Math.abs(ms)/1000),h=Math.floor(seconds/3600),m=Math.floor(seconds/60)%60,s=seconds%60;
  return (ms<0?'−':'')+(h?String(h)+':':'')+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
}
export function secondsLabel(ms){return finite(ms)&&ms>=0?(ms/1000).toFixed(1)+' sec':'Unknown';}
export function normalizeEvent(row){
  if(!row||typeof row.captureId!=='string'||!row.captureId||typeof row.startedAt!=='string')return null;
  const start=Date.parse(row.startedAt);if(!Number.isFinite(start))return null;
  const end=typeof row.endedAt==='string'?Date.parse(row.endedAt):NaN;
  const status=['running','completed','failed','cancelled'].includes(row.result)?row.result:'unknown';
  const run=row.inputIdentity?.runId||row.browserFollow?.testRunId;
  const scene=row.inputIdentity?.sceneId||row.browserFollow?.testSceneId;
  const day=jstDay(start);
  const session=typeof row.timelineRunKey==='string'&&row.timelineRunKey?row.timelineRunKey:run?'test:'+String(run):String(row.browserFollow?.scope||row.source||'legacy')+':'+day;
  const label=run?(scene||'Test')+' · '+String(run).slice(0,8):row.test?'Test · '+day:'Live · '+day;
  const scope=row.browserFollow?.scope;
  const points=[];
  for(const key of ['now','a','b','c']){
    const image=row.images?.[key];let url=null;
    if(typeof image==='string'){try{url=localImagePath(image);}catch{continue;}}
    const sceneKey=key==='now'?'now':'gen_'+key;
    const matching=(Array.isArray(row.browserBatch)?row.browserBatch:[]).filter(item=>item?.sceneKey===sceneKey);
    const content=matching.length===1?matching[0]:null;
    if(matching.length&&(!content||content.captureId!==row.captureId||content.imageUrl!==url||
       content.provenance!==(key==='now'?'actual':'generated')||scope&&content.scope!==scope))continue;
    if(key!=='now'&&!url)continue;
    const offset=key==='now'?0:finite(content?.distanceSecSigned)?content.distanceSecSigned:null;
    const time=offset===null?null:start+offset*1000;
    points.push({key,url,offset,time:Number.isSafeInteger(time)?time:null,
      caption:typeof content?.caption==='string'?content.caption:'',
      recordedAtMs:finite(content?.sourceRecordedAtMs)?content.sourceRecordedAtMs:null,
      generatedAtMs:finite(content?.generatedAtMs)?content.generatedAtMs:null,
      targetAtMs:finite(content?.targetAtMs)?content.targetAtMs:null});
  }
  if(!points.some(point=>point.key==='now'))points.unshift({key:'now',url:null,offset:0,time:start,caption:'',recordedAtMs:null,generatedAtMs:null,targetAtMs:null});
  return {id:row.captureId,start,end:Number.isFinite(end)&&end>=start?end:null,status,session,label,
    totalMs:finite(row.totalMs)&&row.totalMs>=0?row.totalMs:null,
    requested:count(row.requestedCount),saved:count(row.savedCount),published:count(row.publishedCount),
    input:row.inputIdentity?.id||scene||'Unknown input',mode:row.executionSource||'Unknown',
    error:typeof row.errorMessage==='string'?row.errorMessage:'',errorStage:row.errorStage||null,
    stages:[['Recognition',row.detectDescribeMs],['Plan',row.planMs],['A',row.sceneAMs],['B',row.sceneBMs],['C',row.sceneCMs]],points};
}
export function buildSections(events,origin,windowSec=120){
  const span=windowSec*1000;if(!finite(origin)||!finite(span)||span<=0)return [];
  const groups=new Map();
  for(const event of [...events].sort((a,b)=>a.start-b.start||a.id.localeCompare(b.id))){
    const start=Math.floor((event.start-origin)/span)*span;
    if(!groups.has(start))groups.set(start,{start,end:start+span,events:[],min:start,max:start+span});
    const group=groups.get(start);group.events.push(event);
    for(const point of event.points)if(finite(point.time)){
      group.min=Math.min(group.min,point.time-origin);group.max=Math.max(group.max,point.time-origin);
    }
  }
  return [...groups.values()].sort((a,b)=>a.start-b.start);
}
export function buildSharedSections(events,origin,windowSec=120){
  const span=windowSec*1000;if(!finite(origin)||!finite(span)||span<=0)return [];
  const groups=new Map();
  for(const event of events)for(const point of event.points){
    // Unknown offsets remain with their source for access through the detail UI;
    // they never receive an invented position on the elapsed axis.
    const start=Math.floor(((finite(point.time)?point.time:event.start)-origin)/span)*span;
    if(!groups.has(start))groups.set(start,{start,end:start+span,min:start,max:start+span,byId:new Map()});
    const group=groups.get(start);
    if(!group.byId.has(event.id))group.byId.set(event.id,{...event,points:[]});
    group.byId.get(event.id).points.push(point);
  }
  return [...groups.values()].sort((a,b)=>a.start-b.start).map(({byId,...group})=>({...group,events:[...byId.values()]}));
}
export function plotPosition(time,origin,section){
  return 8+84*(time-origin-section.min)/(section.max-section.min||1);
}
export function connectionLayout(event,origin,section){
  const sourceX=plotPosition(event.start,origin,section);
  const nodes=event.points.filter(point=>finite(point.time)).map(point=>{
    const x=plotPosition(point.time,origin,section);
    const y=point.key==='now'?140:point.key==='a'?50:point.key==='c'?230:Math.abs(x-sourceX)<13?320:140;
    return {...point,x,y};
  });
  const source=nodes.find(point=>point.key==='now');
  return {nodes,source,lines:nodes.filter(point=>point.key!=='now').map(point=>({key:point.key,from:{x:source.x,y:source.y},to:{x:point.x,y:point.y}})),
    height:nodes.some(point=>point.y===320)?370:280};
}
export function thumbnailGapPercent(plotWidth,viewportWidth){
  return (Math.max(104,Math.min(116,viewportWidth*.08))+12)/Math.max(560,plotWidth)*100;
}
// lanes: minimum lane count per pool, shared by every section so rows line up across sections.
export function mixedConnectionLayout(events,origin,section,gap=13,lanes={}){
  const points=events.flatMap(event=>event.points.filter(point=>finite(point.time)).map(point=>({...point,event,id:event.id+':'+point.key,x:plotPosition(point.time,origin,section)})));
  const pools={future:[],source:[],past:[]};
  for(const point of points)pools[point.key==='now'?'source':point.offset<0?'past':'future'].push(point);
  let base=50;const laneCounts={};
  for(const [name,pool] of Object.entries(pools)){
    const lastX=[];
    pool.sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id));
    // SOURCE stays on one straight row; only generated images get extra lanes when they collide.
    for(const point of pool){let lane=pool===pools.source?0:lastX.findIndex(x=>point.x-x>=gap);if(lane<0)lane=lastX.length;lastX[lane]=point.x;point.y=base+lane*96;}
    laneCounts[name]=lastX.length;const used=Math.max(lastX.length,lanes[name]??0);
    if(used)base+=used*96+16;
  }
  const sourceById=new Map(pools.source.map(point=>[point.event.id,point]));
  return {nodes:points,lines:points.filter(point=>point.key!=='now'&&sourceById.has(point.event.id)).map(point=>({key:point.key,captureId:point.event.id,from:sourceById.get(point.event.id),to:point})),height:Math.max(120,base-16),laneCounts};
}
// lanes: minimum column count per key, shared by every section so SOURCE keeps the same x everywhere.
export function verticalConnectionLayout(events,origin,section,plotWidth=900,lanes={}){
  const scale=.004,top=48,points=events.flatMap(event=>event.points.filter(point=>finite(point.time)).map(point=>({...point,event,id:event.id+':'+point.key,y:top+(point.time-origin-section.min)*scale})));
  let columns=0;const laneCounts={};
  for(const key of ['c','now','a','b']){
    const lastY=[];
    for(const point of points.filter(point=>point.key===key).sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id))){
      // SOURCE stays in one straight column; only generated images get extra lanes when they collide.
      let lane=key==='now'?0:lastY.findIndex(y=>point.y-y>=96);if(lane<0)lane=lastY.length;
      lastY[lane]=point.y;point.column=columns+lane;
    }
    laneCounts[key]=lastY.length;columns+=Math.max(lastY.length,lanes[key]??0);
  }
  const width=Math.max(640,plotWidth,90+columns*128),height=Math.max(160,(section.max-section.min)*scale+top*2);
  for(const point of points)point.x=(80+(point.column+.5)*(width-90)/Math.max(1,columns))/width*100;
  const sourceById=new Map(points.filter(point=>point.key==='now').map(point=>[point.event.id,point]));
  return {width,height,scale,top,laneCounts,nodes:points,lines:points.filter(point=>point.key!=='now'&&sourceById.has(point.event.id)).map(point=>({key:point.key,captureId:point.event.id,from:sourceById.get(point.event.id),to:point}))};
}
export function sourceConnectionPath(from,to,key,avoid=null){
  // Bend across the source's time row first, then approach the target vertically.
  // A symmetric curve would still pass through A when A is halfway to B.
  if(Math.abs(to.y-from.y)<1){
    const clearance=key==='b'?84:64,gutter=from.y>=100?from.y-clearance:Math.max(from.y,to.y)+clearance;
    return `M ${from.x} ${from.y} L ${from.x} ${gutter} L ${to.x} ${gutter} L ${to.x} ${to.y}`;
  }
  if(avoid){
    let intersects=false;
    for(let i=1;i<100;i++){
      const t=i/100,u=1-t,x=u**3*from.x+(1-u**3)*to.x,y=(1-t**3)*from.y+t**3*to.y;
      if(x>avoid.left&&x<avoid.right&&y>avoid.top&&y<avoid.bottom){intersects=true;break;}
    }
    if(intersects){const gutter=avoid.left-24;return `M ${from.x} ${from.y} L ${gutter} ${from.y} L ${gutter} ${to.y} L ${to.x} ${to.y}`;}
  }
  const bendY=from.y;
  return `M ${from.x} ${from.y} C ${to.x} ${bendY} ${to.x} ${bendY} ${to.x} ${to.y}`;
}
