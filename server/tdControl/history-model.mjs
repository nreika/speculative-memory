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
// Server-made 320px preview (captures/thumbs/<name>.jpg); anything else is ignored.
export function thumbFor(value){
  if(typeof value!=='string'||!/^\/captures\/thumbs\/[A-Za-z0-9][A-Za-z0-9_.-]{0,239}\.jpg$/.test(value)||value.includes('..'))return null;
  return value;
}
/** History pages loaded so far and the result window cap (rows kept, 200 per page). */
export function pageCounter(pages,rows,windowRows){
  return 'Page '+pages+' · '+rows+' records loaded'+(Number.isFinite(windowRows)?' · window last '+windowRows:'');
}
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
    const thumbUrl=url?thumbFor(row.thumbUrls?.[key]):null;
    const offset=key==='now'?0:finite(content?.distanceSecSigned)?content.distanceSecSigned:null;
    const time=offset===null?null:start+offset*1000;
    const unitOf=v=>finite(v)&&v>=0&&v<=1?v:null,idx=['a','b','c'].indexOf(key);
    const tone=key==='now'?null:unitOf(content?.tone)??unitOf(Array.isArray(row.sceneTone)?row.sceneTone[idx]:row.sceneTone?.[key])??unitOf(row.tone);
    points.push({key,url,thumbUrl,offset,tone,time:Number.isSafeInteger(time)?time:null,
      caption:typeof content?.caption==='string'?content.caption:'',
      recordedAtMs:finite(content?.sourceRecordedAtMs)?content.sourceRecordedAtMs:null,
      generatedAtMs:finite(content?.generatedAtMs)?content.generatedAtMs:null,
      targetAtMs:finite(content?.targetAtMs)?content.targetAtMs:null});
  }
  if(!points.some(point=>point.key==='now'))points.unshift({key:'now',url:null,thumbUrl:null,offset:0,tone:null,time:start,caption:'',recordedAtMs:null,generatedAtMs:null,targetAtMs:null});
  return {id:row.captureId,start,end:Number.isFinite(end)&&end>=start?end:null,status,session,label,
    totalMs:finite(row.totalMs)&&row.totalMs>=0?row.totalMs:null,
    requested:count(row.requestedCount),saved:count(row.savedCount),published:count(row.publishedCount),
    input:row.inputIdentity?.id||scene||'Unknown input',mode:row.executionSource||'Unknown',
    error:typeof row.errorMessage==='string'?row.errorMessage:'',errorStage:row.errorStage||null,
    stages:[['Recognition',row.detectDescribeMs],['Plan',row.planMs],['A',row.sceneAMs],['B',row.sceneBMs],['C',row.sceneCMs]],points,
    scenarioRun:row.scenarioRun&&typeof row.scenarioRun.runId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(row.scenarioRun.runId)?{runId:row.scenarioRun.runId,scenarioId:String(row.scenarioRun.scenarioId??''),csvSha:String(row.scenarioRun.csvSha??'')}:null};
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
  const lines=points.filter(point=>point.key!=='now'&&sourceById.has(point.event.id)).map(point=>({key:point.key,captureId:point.event.id,from:sourceById.get(point.event.id),to:point,offset:0}));
  spreadOverlaps(lines,10);
  return {nodes:points,lines,height:Math.max(120,base-16),laneCounts};
}
// Vertical view: a generated image sits at x = SOURCE x +/- (TONE_BASE + tone * TONE_RANGE) px.
// A and B go right, C goes left. Cards that would collide step outward by LANE_STEP px.
export const TONE_BASE=130,TONE_RANGE=300,LANE_STEP=128,TONE_UNKNOWN=.5;
const CARD_W=122,CARD_H=96;
// lanes: minimum lane count per side ({c:left,a:right}), shared by every section so SOURCE keeps the same x everywhere.
export function verticalConnectionLayout(events,origin,section,plotWidth=900,lanes={}){
  const scale=.004,top=48,points=events.flatMap(event=>event.points.filter(point=>finite(point.time)).map(point=>({...point,event,id:event.id+':'+point.key,y:top+(point.time-origin-section.min)*scale})));
  const leftSpace=TONE_BASE+TONE_RANGE+Math.max(0,(lanes.c??0)-1)*LANE_STEP,rightSpace=TONE_BASE+TONE_RANGE+Math.max(0,Math.max(lanes.a??0,lanes.b??0)-1)*LANE_STEP;
  const sourceX=90+leftSpace,width=Math.max(640,plotWidth,sourceX+rightSpace+70),height=Math.max(160,(section.max-section.min)*scale+top*2);
  const placed=[];let leftLanes=0,rightLanes=0;
  for(const point of points.filter(point=>point.key==='now'))point.px=sourceX,point.lane=0,placed.push(point);
  const generated=points.filter(point=>point.key!=='now').sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id));
  for(const point of generated){
    const sign=point.key==='c'?-1:1,known=finite(point.tone),tone=known?point.tone:TONE_UNKNOWN;point.toneKnown=known;point.tone=tone;
    const base=TONE_BASE+tone*TONE_RANGE;let lane=0;
    for(;;lane++){
      const px=sourceX+sign*(base+lane*LANE_STEP);
      if(!placed.some(other=>Math.abs(other.px-px)<CARD_W&&Math.abs(other.y-point.y)<CARD_H)){point.px=px;break;}
    }
    point.lane=lane;placed.push(point);
    if(sign<0)leftLanes=Math.max(leftLanes,lane+1);else rightLanes=Math.max(rightLanes,lane+1);
  }
  const laneCounts={c:leftLanes,now:1,a:rightLanes,b:0};
  for(const point of points)point.x=point.px/width*100;
  const sourceById=new Map(points.filter(point=>point.key==='now').map(point=>[point.event.id,point]));
  const lines=points.filter(point=>point.key!=='now'&&sourceById.has(point.event.id)).map(point=>({key:point.key,captureId:point.event.id,from:sourceById.get(point.event.id),to:point,offset:0}));
  spreadOverlaps(lines,width/100);
  return {width,height,scale,top,laneCounts,nodes:points,lines};
}
/** Give lines that lie on top of each other (collinear, overlapping extents) a perpendicular offset in px, alternating around the original. xScale converts line x units to px. */
export function spreadOverlaps(lines,xScale=1,step=6,tolerance=1.5){
  const pts=lines.map(line=>({ax:line.from.x*xScale,ay:line.from.y,bx:line.to.x*xScale,by:line.to.y}));
  const parent=lines.map((_,i)=>i),find=i=>parent[i]===i?i:(parent[i]=find(parent[i]));
  const dist=(l,x,y)=>{const dx=l.bx-l.ax,dy=l.by-l.ay,len=Math.hypot(dx,dy)||1;return Math.abs(dx*(y-l.ay)-dy*(x-l.ax))/len;};
  const extent=(l,x,y)=>{const dx=l.bx-l.ax,dy=l.by-l.ay,len2=dx*dx+dy*dy||1;return ((x-l.ax)*dx+(y-l.ay)*dy)/len2;};
  for(let i=0;i<lines.length;i++)for(let j=i+1;j<lines.length;j++){
    const p=pts[i],q=pts[j];
    if(dist(p,q.ax,q.ay)>tolerance||dist(p,q.bx,q.by)>tolerance)continue;
    const t1=extent(p,q.ax,q.ay),t2=extent(p,q.bx,q.by),lo=Math.max(0,Math.min(t1,t2)),hi=Math.min(1,Math.max(t1,t2));
    if(hi-lo>1e-6)parent[find(j)]=find(i);
  }
  const groups=new Map();
  lines.forEach((line,i)=>{const root=find(i);if(!groups.has(root))groups.set(root,[]);groups.get(root).push(line);});
  for(const group of groups.values()){
    if(group.length<2)continue;
    group.forEach((line,i)=>{line.offset=(i-(group.length-1)/2)*step;});
  }
  return lines;
}
function segmentHitsBox(a,b,box){
  for(let i=1;i<100;i++){const t=i/100,x=a.x+(b.x-a.x)*t,y=a.y+(b.y-a.y)*t;if(x>box.left&&x<box.right&&y>box.top&&y<box.bottom)return true;}
  return false;
}
/** Straight SOURCE -> generated connector. `offset` shifts the whole segment perpendicular to itself (px). If `avoid` (a box) is crossed, one elbow beside the box keeps two straight segments. */
export function sourceConnectionPath(from,to,key,avoid=null,offset=0){
  const dx=to.x-from.x,dy=to.y-from.y,len=Math.hypot(dx,dy)||1,ox=-dy/len*offset,oy=dx/len*offset;
  const a={x:from.x+ox,y:from.y+oy},b={x:to.x+ox,y:to.y+oy},f=n=>Math.round(n*100)/100;
  if(avoid&&segmentHitsBox(a,b,avoid)){
    const candidates=[{x:avoid.right+24,y:avoid.top-24},{x:avoid.left-24,y:avoid.bottom+24},{x:avoid.left-24,y:avoid.top-24},{x:avoid.right+24,y:avoid.bottom+24}];
    const elbow=candidates.find(c=>!segmentHitsBox(a,c,avoid)&&!segmentHitsBox(c,b,avoid))||candidates[0];
    return `M ${f(a.x)} ${f(a.y)} L ${f(elbow.x)} ${f(elbow.y)} L ${f(b.x)} ${f(b.y)}`;
  }
  return `M ${f(a.x)} ${f(a.y)} L ${f(b.x)} ${f(b.y)}`;
}
// G-27 scenario CSV runs: which CSV drove which stretch of the timeline.
const RUN_ID=/^[A-Za-z0-9_-]{1,64}$/;
export function clockLabel(ms){
  if(!finite(ms))return '--:--:--';
  return new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tokyo',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(ms));
}
/** Valid runs, oldest first. A run whose CSV sha differs from the first run of the same scenario id is marked revised (修正版). */
export function normalizeScenarioRuns(rows,nowMs=Date.now()){
  const runs=[];
  for(const row of Array.isArray(rows)?rows:[]){
    if(!row||typeof row.runId!=='string'||!RUN_ID.test(row.runId)||typeof row.scenarioId!=='string')continue;
    const start=Date.parse(row.startedAt);if(!Number.isFinite(start))continue;
    const ended=typeof row.endedAt==='string'?Date.parse(row.endedAt):NaN,running=!Number.isFinite(ended);
    runs.push({runId:row.runId,scenarioId:row.scenarioId.slice(0,80)||'scenario',file:typeof row.file==='string'?row.file:'',sha:typeof row.sha256==='string'?row.sha256:'',
      start,end:running?Math.max(start,nowMs):Math.max(start,ended),running,endReason:typeof row.endReason==='string'?row.endReason:null,cuesApplied:Number.isInteger(row.cuesApplied)?row.cuesApplied:null});
  }
  runs.sort((a,b)=>a.start-b.start||a.runId.localeCompare(b.runId));
  const firstSha=new Map();
  for(const run of runs){if(!firstSha.has(run.scenarioId))firstSha.set(run.scenarioId,run.sha);run.revised=!!run.sha&&firstSha.get(run.scenarioId)!==run.sha;}
  for(const run of runs)run.label=run.scenarioId+' '+clockLabel(run.start)+'–'+(run.running?'running':clockLabel(run.end))+(run.revised?' (revised)':'');
  return runs;
}
/** Runs shown for one history session: tagged by one of its captures, or overlapping its time span. */
export function runsForSession(runs,events){
  if(!events.length)return [];
  const tagged=new Set(events.map(event=>event.scenarioRun?.runId).filter(Boolean));
  let first=Infinity,last=-Infinity;for(const event of events){first=Math.min(first,event.start);last=Math.max(last,event.end??event.start);}
  return runs.filter(run=>tagged.has(run.runId)||run.start<=last&&run.end>=first);
}
/** Greedy lanes so overlapping runs never share a row. */
function lanesFor(items,startKey,endKey){
  const ends=[];for(const item of items){let lane=ends.findIndex(end=>item[startKey]>=end);if(lane<0)lane=ends.length;ends[lane]=item[endKey];item.lane=lane;}
  return ends.length;
}
/** Horizontal views: left/right in % of the plot width (same scale as plotPosition), clipped to the section. */
export function runBandLayout(runs,origin,section){
  const low=origin+section.min,high=origin+section.max,bands=[];
  for(const run of runs){
    if(run.end<low||run.start>high)continue;
    const from=Math.max(run.start,low),to=Math.min(run.end,high);
    bands.push({run,left:plotPosition(from,origin,section),right:plotPosition(to,origin,section),clippedStart:run.start<low,clippedEnd:run.end>high});
  }
  return {bands,lanes:lanesFor(bands,'left','right')};
}
/** Vertical view: top/height in px on the same y scale as verticalConnectionLayout. */
export function verticalRunBandLayout(runs,origin,section,geometry){
  const low=origin+section.min,high=origin+section.max,bands=[];
  const y=time=>geometry.top+(time-origin-section.min)*geometry.scale;
  for(const run of runs){
    if(run.end<low||run.start>high)continue;
    const top=y(Math.max(run.start,low)),bottom=y(Math.min(run.end,high));
    bands.push({run,top,height:Math.max(4,bottom-top),bottom:top+Math.max(4,bottom-top),clippedStart:run.start<low,clippedEnd:run.end>high});
  }
  return {bands,lanes:lanesFor(bands,'top','bottom')};
}
