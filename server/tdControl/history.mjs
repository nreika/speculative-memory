import {normalizeEvent,buildSections,buildSharedSections,connectionLayout,mixedConnectionLayout,verticalConnectionLayout,sourceConnectionPath,thumbnailGapPercent,elapsedLabel,secondsLabel,pendingRefreshIds,RecentHistoryGaps,SCENE_COLORS} from './history-model.mjs';
const $=id=>document.getElementById(id);
const records=new Map(),sectionNodes=new Map(),runOrigins=new Map();
const recentGaps=new RecentHistoryGaps();
let selected=null,reading=false,nextCursor=null,hasEarlier=false,origin=null,pendingCursor=0;
let crossLayer=null,shownEvents=[],focusedCaptureId=null,crossFrame=null;
const stamp=value=>Number.isFinite(value)?new Date(value).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',hour12:false}):'Unknown';
function node(tag,text,cls){const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(cls)element.className=cls;return element;}
function svg(tag,attributes){const element=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value] of Object.entries(attributes))element.setAttribute(key,String(value));return element;}
function number(value){return value===null?'–':String(value);}
function merge(rows){
  for(const raw of rows){const event=normalizeEvent(raw);if(event){const previous=records.get(event.id);if(previous&&!raw.timelineRunKey)event.session=previous.session;records.set(event.id,event);}}
}
function updateRuns(){
  const groups=new Map();
  for(const event of records.values()){
    if(!groups.has(event.session))groups.set(event.session,{key:event.session,label:event.label,first:event.start,last:event.start});
    const group=groups.get(event.session);group.first=Math.min(group.first,event.start);group.last=Math.max(group.last,event.start);
  }
  const runs=[...groups.values()].sort((a,b)=>b.last-a.last);
  if(!selected)selected=runs[0]?.key||null;
  const signature=JSON.stringify(runs.map(run=>[run.key,run.label]));
  if($('run-filter').dataset.signature!==signature){
    $('run-filter').replaceChildren(...runs.map(run=>{const option=node('option',run.label);option.value=run.key;option.title=run.key;return option;}));
    $('run-filter').dataset.signature=signature;
  }
  if(selected)$('run-filter').value=selected;
}
function makeImage(event,point,position){
  const button=node('button',undefined,'image-node');button.style.setProperty('--scene',SCENE_COLORS[point.key]);
  button.dataset.captureId=event.id;button.dataset.scene=point.key;button.dataset.status=event.status;
  button.style.left=position.x+'%';button.style.top=position.y+'px';
  const label=node('span',undefined,'node-label');
  const elapsed=point.time-origin;
  label.append(node('b',point.key==='now'?'SOURCE':point.key.toUpperCase()),node('span','T'+(elapsed>=0?'+':'')+elapsedLabel(elapsed)));
  if(point.key==='now'&&event.status!=='completed')label.append(node('span',event.status==='running'?'…':event.status==='failed'?'×':'·','status-mark'));
  button.append(label);
  if(point.url){const image=node('img');image.loading='lazy';image.decoding='async';image.src=point.url;image.alt=(point.key==='now'?'Source':point.key.toUpperCase())+' · '+event.id;button.append(image);}
  else button.append(node('span','No saved source image','placeholder'));
  button.title=(point.key==='now'?'Source input':point.key.toUpperCase()+' '+(point.offset>=0?'+':'')+point.offset+' sec')+' · '+event.status+' · '+secondsLabel(event.totalMs)+' · '+event.id;
  button.onclick=()=>showDetails(event,point);return button;
}
function highlight(id){focusedCaptureId=id;const root=$('sections');root.classList.toggle('has-focus',!!id);for(const item of root.querySelectorAll('[data-capture-id]'))item.classList.toggle('related',item.dataset.captureId===id);}
function timelinePlot(section,lanes={}){
  const vertical=$('view-mode').value==='vertical';
  const geometry=vertical?verticalConnectionLayout(section.events,origin,section,$('sections').clientWidth-30,lanes):mixedConnectionLayout(section.events,origin,section,thumbnailGapPercent($('sections').clientWidth-30,window.innerWidth),lanes);
  const scroll=node('div',undefined,'plot-scroll'),plot=node('div',undefined,vertical?'plot vertical-plot':'plot');plot.style.height=geometry.height+'px';if(vertical)plot.style.minWidth=geometry.width+'px';
  const lines=svg('svg',{viewBox:'0 0 1000 '+geometry.height,preserveAspectRatio:'none','aria-label':'Lines from source timestamp to generated image timestamps',role:'img'});
  for(let i=0;i<=6;i++){
    if(vertical){const y=geometry.top+(section.max-section.min)*geometry.scale*i/6;lines.append(svg('line',{x1:70/geometry.width*1000,y1:y,x2:1000,y2:y,stroke:'#233441','stroke-width':1}));const tick=node('span',elapsedLabel(section.min+(section.max-section.min)*i/6),'vertical-tick');tick.style.top=y+'px';plot.append(tick);}
    else lines.append(svg('line',{x1:80+140*i,y1:0,x2:80+140*i,y2:geometry.height,stroke:'#233441','stroke-width':1}));
  }
  for(const line of geometry.lines){
    const attributes={stroke:SCENE_COLORS[line.key],'stroke-width':2,'data-scene':line.key,'data-capture-id':line.captureId,'data-source-scene':'now'};
    lines.append(vertical?svg('path',{d:sourceConnectionPath({x:line.from.x*10,y:line.from.y},{x:line.to.x*10,y:line.to.y},line.key),fill:'none',...attributes}):svg('line',{x1:line.from.x*10,y1:line.from.y,x2:line.to.x*10,y2:line.to.y,...attributes}));
  }
  plot.append(lines);
  for(const point of geometry.nodes){const button=makeImage(point.event,point,point);button.onpointerenter=()=>highlight(point.event.id);button.onpointerleave=()=>highlight(null);button.onfocus=()=>highlight(point.event.id);button.onblur=()=>highlight(null);plot.append(button);}
  scroll.append(plot);
  const unknown=section.events.flatMap(event=>event.points.filter(point=>point.time===null).map(point=>({event,point})));
  if(unknown.length){const line=node('p','Stored time offset unavailable:','unknown');for(const {event,point} of unknown){const button=node('button',point.key.toUpperCase()+' · '+elapsedLabel(event.start-origin));button.onclick=()=>showDetails(event,point);line.append(button);}scroll.append(line);}
  return scroll;
}
function generationNode(event,section){
  const geometry=connectionLayout(event,origin,section);
  const article=node('article',undefined,'generation');article.dataset.captureId=event.id;
  const header=node('header',undefined,'generation-header');
  const badge=node('span',event.status.toUpperCase(),'badge '+event.status);
  header.append(node('strong','Elapsed '+elapsedLabel(event.start-origin)),badge,
    node('span',event.status==='running'?'In progress':secondsLabel(event.totalMs),'duration'),
    node('span','Requested '+number(event.requested)+' · saved '+number(event.saved)+' · eligible '+number(event.published),'counts'),
    node('span',event.input+' · Clock '+stamp(event.start)+' JST','identity'));
  article.append(header);
  const stages=node('div',undefined,'stages');
  for(const [name,ms] of event.stages)stages.append(node('span',name+' '+secondsLabel(ms)));
  article.append(stages);
  if(event.error)article.append(node('p',(event.errorStage?event.errorStage+' · ':'')+event.error,'error'));
  const scroll=node('div',undefined,'plot-scroll'),plot=node('div',undefined,'plot');plot.style.height=geometry.height+'px';
  const lines=svg('svg',{viewBox:'0 0 1000 '+geometry.height,preserveAspectRatio:'none','aria-label':'Lines from source timestamp to generated image timestamps',role:'img'});
  for(let i=0;i<=6;i++)lines.append(svg('line',{x1:80+140*i,y1:0,x2:80+140*i,y2:geometry.height,stroke:'#233441','stroke-width':1}));
  lines.append(svg('line',{x1:geometry.source.x*10,y1:0,x2:geometry.source.x*10,y2:geometry.source.y,stroke:'#a0b2be','stroke-width':1,'stroke-dasharray':'3 5',opacity:.4}));
  for(const line of geometry.lines)lines.append(svg('line',{x1:line.from.x*10,y1:line.from.y,x2:line.to.x*10,y2:line.to.y,stroke:SCENE_COLORS[line.key],'stroke-width':2,'data-scene':line.key}));
  plot.append(lines);for(const point of geometry.nodes)plot.append(makeImage(event,point,point));
  scroll.append(plot);article.append(scroll);
  const unknown=event.points.filter(point=>point.time===null);
  if(unknown.length){const line=node('p','Stored time offset unavailable:','unknown');for(const point of unknown){const button=node('button',point.key.toUpperCase()+' image');button.onclick=()=>showDetails(event,point);line.append(button);}article.append(line);}
  return article;
}

function resetLayout(){highlight(null);sectionNodes.clear();crossLayer=null;$('sections').replaceChildren();}
function scheduleCrossConnections(){if(crossFrame!==null)return;crossFrame=requestAnimationFrame(()=>{crossFrame=null;drawCrossConnections();});}
function drawCrossConnections(){
  if(crossLayer){crossLayer.remove();crossLayer=null;}
  if(!['shared','vertical'].includes($('view-mode').value))return;
  const root=$('sections'),buttons=[...root.querySelectorAll('.image-node')];
  // Resolve the folded chart geometry before connecting across windows. Image
  // aspect ratios are reserved in CSS, so decoding does not shift the endpoints.
  for(const button of buttons)button.getBoundingClientRect();
  const rootRect=root.getBoundingClientRect(),byId=new Map(buttons.map(button=>[button.dataset.captureId+':'+button.dataset.scene,button]));
  const layer=svg('svg',{'class':'cross-section-lines',viewBox:'0 0 '+root.clientWidth+' '+root.scrollHeight,'aria-label':'Source connections across time windows',role:'img'});
  const center=element=>{const r=element.getBoundingClientRect();return {x:r.left-rootRect.left+r.width/2,y:r.top-rootRect.top+r.height/2};};
  for(const event of shownEvents){
    const source=byId.get(event.id+':now');if(!source)continue;
    for(const point of event.points){
      if(point.key==='now')continue;const target=byId.get(event.id+':'+point.key);
      if(!target||source.closest('.time-section')===target.closest('.time-section'))continue;
      const from=center(source),to=center(target);
      const a=point.key==='b'?byId.get(event.id+':a'):null,ar=a?.getBoundingClientRect();
      const avoid=ar?{left:ar.left-rootRect.left,right:ar.right-rootRect.left,top:ar.top-rootRect.top,bottom:ar.bottom-rootRect.top}:null;
      const attributes={stroke:SCENE_COLORS[point.key],'stroke-width':2,'data-scene':point.key,'data-capture-id':event.id,'data-source-scene':'now','data-cross-window':'true'};
      layer.append($('view-mode').value==='vertical'?svg('path',{d:sourceConnectionPath(from,to,point.key,avoid),fill:'none',...attributes}):svg('line',{x1:from.x,y1:from.y,x2:to.x,y2:to.y,...attributes}));
    }
  }
  layer.style.height=root.scrollHeight+'px';root.append(layer);crossLayer=layer;highlight(focusedCaptureId);
}
function render(){
  updateRuns();const run=[...records.values()].filter(event=>event.session===selected);
  const nextOrigin=runOrigins.get(selected)??null;
  if(origin!==nextOrigin){origin=nextOrigin;resetLayout();}
  const status=$('status-filter').value,events=run.filter(event=>status==='all'||event.status===status);
  shownEvents=events;
  const groups=($('view-mode').value==='generations'?buildSections:buildSharedSections)(events,origin,Number($('section-size').value));
  // Same lane/column counts in every section so SOURCE stays on one straight line through the whole run.
  const lanes={};
  if($('view-mode').value!=='generations')for(const group of groups){
   const counts=($('view-mode').value==='vertical'?verticalConnectionLayout(group.events,origin,group,$('sections').clientWidth-30):mixedConnectionLayout(group.events,origin,group,thumbnailGapPercent($('sections').clientWidth-30,window.innerWidth))).laneCounts;
   for(const [key,count] of Object.entries(counts))lanes[key]=Math.max(lanes[key]??0,count);
  }
  const wanted=new Set();
  for(const group of groups){
    wanted.add(group.start);let entry=sectionNodes.get(group.start);
    const range=JSON.stringify([group.min,group.max,origin]);
    if(!entry){
      const element=node('section',undefined,'time-section'),heading=node('div',undefined,'section-title'),axis=node('div',undefined,'axis'),chart=node('div');
      heading.append(node('h2',elapsedLabel(group.start)+' — '+elapsedLabel(group.end)),node('span',($('view-mode').value==='vertical'?'Time flows ↓':$('view-mode').value==='shared'?'Shared timeline →':'By generation')+' · SOURCE → A / B / C'));
      axis.hidden=$('view-mode').value==='vertical';
      element.append(heading,axis,chart);entry={element,axis,chart,range:null,content:null};sectionNodes.set(group.start,entry);
    }
    if(entry.range!==range){
      entry.axis.replaceChildren();for(let i=0;i<=6;i++){const time=group.min+(group.max-group.min)*i/6,tick=node('span',elapsedLabel(time),'tick');tick.style.left=(8+84*i/6)+'%';entry.axis.append(tick);}entry.range=range;
    }
    const content=JSON.stringify([group.events,range,$('view-mode').value,lanes]);
    if(entry.content!==content){highlight(null);entry.chart.replaceChildren(...($('view-mode').value==='generations'?group.events.map(event=>generationNode(event,group)):[timelinePlot(group,lanes)]));entry.content=content;}
    const index=groups.indexOf(group);if($('sections').children[index]!==entry.element)$('sections').insertBefore(entry.element,$('sections').children[index]||null);
  }
  for(const [key,entry] of sectionNodes)if(!wanted.has(key)){entry.element.remove();sectionNodes.delete(key);}
  drawCrossConnections();
  $('empty').hidden=groups.length>0;
  $('empty').textContent=events.length&&origin===null?'The run start has not been verified by the log server.':'No records in this view.';
  const successful=run.filter(event=>event.status==='completed'&&event.points.filter(point=>point.key!=='now'&&point.url).length===3&&event.totalMs!==null);
  const average=successful.length?successful.reduce((sum,event)=>sum+event.totalMs,0)/successful.length:null;
  $('summary').textContent=events.length+' generation attempts · '+run.filter(event=>event.status==='completed').length+' completed · '+run.filter(event=>event.status==='failed').length+' failed'+(average!==null?' · 3-image average '+secondsLabel(average):'');
  $('anchor').textContent=origin===null?'':'Elapsed 00:00 = '+stamp(origin)+' JST · first generation recorded for this run (server-verified). Original recording timestamps are shown in image details.';
  $('older').disabled=reading||!hasEarlier;
  if($('follow').checked)window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'});
}
async function readJson(url){const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('Log server returned '+response.status);return response.json();}
async function timelinePage(limit,cursor=null){
  const page=await readJson('/api/events/timeline?limit='+limit+(cursor?'&cursor='+encodeURIComponent(cursor):''));
  if(page?.schema!==1||!Array.isArray(page.events)||!Array.isArray(page.runOrigins)||!(page.nextCursor===null||typeof page.nextCursor==='string'))throw Error('Invalid timeline response');
  return page;
}
function mergePage(page){
  for(const run of page.runOrigins)if(typeof run.key==='string'&&Number.isSafeInteger(run.startedAtMs))runOrigins.set(run.key,run.startedAtMs);
  merge(page.events);
}
async function refreshPending(freshIds){
  const pending=pendingRefreshIds([...records.values()],freshIds,pendingCursor);pendingCursor=pending.cursor;
  const replies=await Promise.allSettled(pending.ids.map(id=>readJson('/api/events/'+encodeURIComponent(id))));
  for(const reply of replies)if(reply.status==='fulfilled')merge([reply.value]);
  if(replies.length)render();
}
async function refresh(earlier=false){
  if(reading)return;reading=true;$('older').disabled=true;
  try{
    const initial=!records.size,knownIds=new Set(records.keys());
    const page=await timelinePage(earlier||initial?200:20,earlier?nextCursor:null);
    if(!initial&&!earlier)recentGaps.observeHead(page,knownIds);
    mergePage(page);
    if(initial||earlier){nextCursor=page.nextCursor;hasEarlier=nextCursor!==null;}
    $('notice').textContent=recentGaps.cursor?'Catching up on recent generation records…':'';
    render();
    // At most two 200-row gap pages per poll. Retain the independent continuation
    // cursor across polls, even when newer generations arrive during backfill.
    const started=performance.now();
    for(let count=0;!earlier&&recentGaps.cursor&&count<2&&performance.now()-started<8000;count++){
      const cursor=recentGaps.cursor,missing=await timelinePage(200,cursor);
      recentGaps.acceptPage(cursor,missing);mergePage(missing);
    }
    $('notice').textContent=recentGaps.cursor?'Catching up on recent generation records…':'';
    render();
    await refreshPending(new Set(page.events.map(row=>row.captureId)));
  }catch(error){$('notice').textContent=error.message+' · Existing history retained.';}
  finally{reading=false;$('older').disabled=!hasEarlier;}
}
function showDetails(event,point){
  $('dialog-title').textContent=(point.key==='now'?'SOURCE':point.key.toUpperCase())+' · '+event.status.toUpperCase();
  const image=$('detail-image');image.hidden=!point.url;if(point.url)image.src=point.url;else image.removeAttribute('src');
  $('detail-caption').textContent=point.caption||'No saved caption for this image.';
  const facts=[['Generation ID',event.id],['Input ID',event.input],['Elapsed request time',elapsedLabel(event.start-origin)],['Generation requested',stamp(event.start)+' JST'],['Generation ended',event.end===null?'Not ended / unknown':stamp(event.end)+' JST'],['Total generation duration',secondsLabel(event.totalMs)],...event.stages.map(([stage,ms])=>[stage+' duration',secondsLabel(ms)]),['Position on this timeline',point.time===null?'Unknown offset':elapsedLabel(point.time-origin)],['Stored relative offset',point.offset===null?'Unknown':point.offset+' sec'],['Original recording timestamp',point.recordedAtMs===null?'Unknown':stamp(point.recordedAtMs)+' JST'],['Saved image generated at',point.generatedAtMs===null?'Not a generated image / unknown':stamp(point.generatedAtMs)+' JST'],['Execution mode',event.mode],['Requested / saved / display-eligible',number(event.requested)+' / '+number(event.saved)+' / '+number(event.published)]];
  $('detail-facts').replaceChildren(...facts.flatMap(([key,value])=>[node('dt',key),node('dd',value)]));
  $('detail-error').textContent=event.error;
  $('image-dialog').showModal();
}
$('close-dialog').onclick=()=>$('image-dialog').close();
$('image-dialog').onclick=event=>{if(event.target===$('image-dialog'))$('image-dialog').close();};
$('run-filter').onchange=()=>{selected=$('run-filter').value;resetLayout();render();};
$('status-filter').onchange=()=>{resetLayout();render();};
$('section-size').onchange=()=>{resetLayout();render();};
$('view-mode').onchange=()=>{resetLayout();render();};
$('older').onclick=()=>{$('follow').checked=false;refresh(true);};
$('latest').onclick=()=>window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'});
$('follow').onchange=()=>{if($('follow').checked)window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'});};
window.addEventListener('wheel',event=>{if(event.deltaY<0)$('follow').checked=false;},{passive:true});
window.addEventListener('keydown',event=>{if(['PageUp','Home','ArrowUp'].includes(event.key))$('follow').checked=false;});
window.addEventListener('resize',()=>requestAnimationFrame(()=>{resetLayout();render();}));
$('sections').addEventListener('scroll',scheduleCrossConnections,true);
refresh();setInterval(()=>{if(!document.hidden)refresh();},4000);
