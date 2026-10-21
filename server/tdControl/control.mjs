import {localImagePath,coneGeometry,generatingScene,completedConeResult,availableConeScenes,skipReasons} from './timeline.mjs';
const API='/api/td-control';
const $=id=>document.getElementById(id);
// Selection-safe text updates: polling re-renders every 2 s, and assigning textContent (even an identical
// value) replaces the text node and collapses the user's selection. Skip unchanged writes, and while a
// selection is inside the page defer writes to the selected element (max 15 s) so Ctrl+C still works.
const SELECTION_HOLD_MS=15000, pendingText=new Map();
let holdSince=0, holdTimer=null;
{
  const descriptor=Object.getOwnPropertyDescriptor(Node.prototype,'textContent');
  const selectedRange=()=>{const s=document.getSelection&&document.getSelection();return s&&!s.isCollapsed&&s.rangeCount?s.getRangeAt(0):null;};
  const holding=element=>{
    const range=selectedRange();if(!range||!document.body.contains(element))return false;
    if(!range.intersectsNode(element))return false;
    if(!holdSince)holdSince=Date.now();
    if(Date.now()-holdSince>SELECTION_HOLD_MS)return false;
    clearTimeout(holdTimer);holdTimer=setTimeout(flushPendingText,SELECTION_HOLD_MS+50);
    return true;
  };
  function flushPendingText(){
    holdSince=0;clearTimeout(holdTimer);
    for(const [element,value] of pendingText)descriptor.set.call(element,value);
    pendingText.clear();
  }
  Object.defineProperty(Element.prototype,'textContent',{configurable:true,enumerable:true,get(){return descriptor.get.call(this);},set(value){
    const text=String(value??'');
    if(descriptor.get.call(this)===text){pendingText.delete(this);return;}
    if(this.childElementCount===0&&holding(this)){pendingText.set(this,text);return;}
    pendingText.delete(this);descriptor.set.call(this,text);
  }});
  document.addEventListener('selectionchange',()=>{if(!selectedRange()&&pendingText.size)flushPendingText();else if(!selectedRange())holdSince=0;});
}
function addCopyButton(target,label){
  if(!target)return;
  const button=document.createElement('button');button.type='button';button.className='copy-btn';button.textContent='copy';button.setAttribute('aria-label','Copy '+label);
  let timer=null;
  button.onclick=async()=>{
    const text=target.innerText||target.textContent||'';
    try{await navigator.clipboard.writeText(text);button.textContent='copied';}
    catch{const range=document.createRange();range.selectNodeContents(target);const s=getSelection();s.removeAllRanges();s.addRange(range);try{document.execCommand('copy');button.textContent='copied';}catch{button.textContent='failed';}}
    clearTimeout(timer);timer=setTimeout(()=>{button.textContent='copy';},1500);
  };
  target.insertAdjacentElement('afterend',button);
}
let latest=null, baseRevision=null, busy=false, online=false, epoch=0, routingDirty=false;
let dirty=new Set(), polling=false, imagePolling=false, previewPolling=false, noticeTimer=null;
let uncertain=false;
function requestId(){
  if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
  const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
  const h=[...b].map(v=>v.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function markUncertain(error){if(error.indeterminate||error.name==='TimeoutError'||error instanceof TypeError){uncertain=true;$('uncertain-action').hidden=false;}}
const scenes=['a','b','c'];
const colors={a:'#ef9b4a',b:'#e877a9',c:'#6caef0'};
let coneMode='result', displayedScenes=null, captureProgress=null, inputSelection=null;
let coneScenes=null, coneRenderKey=null, coneLastNow=null, sceneSkips={};
let coneCompleted=null, conePolling=false;
const personReferenceCatalog=new Map(),requestedPersonReferences=new Set();
let personReferenceFetching=false,personReferenceRetryAt=0;
function referenceIds(input){try{const ids=JSON.parse(input.value||'[]');return Array.isArray(ids)?ids:[];}catch{return [];}}
function editReferenceIds(input,ids){
  if(!dirty.size)baseRevision=latest?.settingsRevision;
  input.value=JSON.stringify(ids);dirty.add(input.dataset.setting);dirtyLabel();renderPersonReferences();scheduleDirectionSave();
}
function personReferenceRow(scene,kind){
  const row=document.createElement('div');row.className='person-references';
  const path=`scenes.${scene}.${kind}PersonReferenceIds`,label=`${scene.toUpperCase()} ${kind==='continuous'?'Continuous':'One shot'}`;
  row.dataset.referencePath=path;
  const input=document.createElement('input');input.type='hidden';input.value='[]';input.dataset.setting=path;input.dataset.json='true';input.setAttribute('form','settings-form');
  const picker=document.createElement('input');picker.type='file';picker.accept='image/png,image/jpeg,image/webp';picker.multiple=true;picker.hidden=true;
  const add=document.createElement('button');add.type='button';add.textContent='+ Person image';add.setAttribute('aria-label',label+' add person image');add.title='Add people from these images alongside the SOURCE people. Apply to save.';add.onclick=()=>picker.click();
  const list=document.createElement('div');list.className='person-reference-list';list.setAttribute('aria-label',label+' added people');
  picker.onchange=async()=>{
    const files=[...picker.files];if(!files.length)return;
    if(busy||!online||uncertain||input.disabled){picker.value='';return;}
    busy=true;epoch++;updateButtons();
    try{
      const ids=[...referenceIds(input)];
      if(ids.length+files.length>15)throw Error('Use up to 15 reference images in one field.');
      for(const file of files){
        if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>8*1024*1024)throw Error('Use PNG, JPEG or WebP images up to 8 MB.');
        const imageDataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
        const data=await json('/api/browser-outputs/assets',{method:'POST',headers:{'Content-Type':'application/json','X-Control-Request':'1'},body:JSON.stringify({filename:file.name,imageDataUrl})});
        const item=data.item||data;if(typeof item.id!=='string')throw Error('The image upload did not return an ID.');
        personReferenceCatalog.set(item.id,item);if(!ids.includes(item.id))ids.push(item.id);
        editReferenceIds(input,ids);
      }
      notice('Person images added · SOURCE people stay in the scene. Apply to save.');
    }catch(error){notice(error.message,true);}finally{picker.value='';busy=false;updateButtons();void refresh();}
  };
  row.append(input,picker,add,list);return row;
}
function renderPersonReferences(){
  for(const row of document.querySelectorAll('.person-references')){
    const input=row.querySelector('[data-setting]'),list=row.querySelector('.person-reference-list'),ids=referenceIds(input);
    const signature=JSON.stringify(ids.map(id=>[id,personReferenceCatalog.get(id)]));
    if(list.dataset.signature!==signature){
      list.replaceChildren();list.dataset.signature=signature;
      for(const id of ids){
        const item=personReferenceCatalog.get(id),tag=document.createElement('span');tag.className='person-reference';tag.title=item?.label||id;
        if(item?.imageUrl){try{const image=document.createElement('img');image.src=localImagePath(item.imageUrl);image.alt=item.label||'Added person';tag.append(image);}catch{tag.append('Preview unavailable');}}
        else tag.append(item?.missing?'Image unavailable':'Loading…');
        const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','Remove '+(item?.label||id));remove.onclick=()=>editReferenceIds(input,referenceIds(input).filter(value=>value!==id));tag.append(remove);list.append(tag);
      }
    }
    for(const button of row.querySelectorAll('button'))button.disabled=input.disabled;
  }
  void loadPersonReferenceMetadata();
}
async function loadPersonReferenceMetadata(){
  if(personReferenceFetching||Date.now()<personReferenceRetryAt)return;
  const ids=[...new Set([...document.querySelectorAll('.person-references [data-setting]')].flatMap(referenceIds))].filter(id=>!personReferenceCatalog.has(id)&&!requestedPersonReferences.has(id)).slice(0,15);
  if(!ids.length)return;
  personReferenceFetching=true;for(const id of ids)requestedPersonReferences.add(id);
  try{
    const data=await json('/api/scene-person-references?'+new URLSearchParams({ids:ids.join(',')}));
    if(!Array.isArray(data.items)||!Array.isArray(data.missingIds))throw Error('Invalid reference metadata response.');
    for(const item of data.items||[])if(ids.includes(item.id))personReferenceCatalog.set(item.id,item);
    for(const id of data.missingIds)if(ids.includes(id))personReferenceCatalog.set(id,{missing:true});
    if(ids.some(id=>!personReferenceCatalog.has(id)))throw Error('Incomplete reference metadata response.');
    personReferenceRetryAt=0;
  }catch{for(const id of ids)requestedPersonReferences.delete(id);personReferenceRetryAt=Date.now()+5000;}
  finally{personReferenceFetching=false;renderPersonReferences();}
}
for(const scene of scenes){
  const article=document.createElement('article');
  article.className='scene panel';article.dataset.scene=scene;article.style.setProperty('--scene',colors[scene]);
  article.innerHTML=`<div class="scene-header"><h3>${scene.toUpperCase()}</h3><span id="scene-time-${scene}">—</span></div><div class="scene-visual"><img id="scene-image-${scene}" alt="Scene ${scene.toUpperCase()} generated result" hidden><span id="scene-waiting-${scene}">Waiting for an image</span></div><div class="scene-content"><span class="description-label">Generation instruction</span><p id="scene-caption-${scene}" class="scene-caption">No generation instruction yet.</p><div class="scene-notes" id="scene-notes-${scene}" aria-label="What happened in the last generation"></div><label class="distance-label">Time distance <span class="field-note">Past − / Future +</span><div class="distance-field"><input type="number" min="-3600" max="3600" step="1" data-setting="scenes.${scene}.distanceSec" form="settings-form" aria-label="${scene.toUpperCase()} time distance"><span>sec</span></div></label><label>Instructions · Continuous <span class="field-note">Every generation</span><textarea data-setting="scenes.${scene}.continuous" form="settings-form" maxlength="4000" aria-label="${scene.toUpperCase()} continuous prompt" placeholder="Add a direction…"></textarea></label><label>Instructions · One shot <span class="field-note">Next generation</span><textarea data-setting="scenes.${scene}.oneShot" form="settings-form" maxlength="4000" aria-label="${scene.toUpperCase()} one shot prompt" placeholder="For the next image only…"></textarea></label><p class="field-note direction-note" id="direction-note-${scene}"></p><p class="scenario-prompt" id="scenario-prompt-${scene}"></p></div>`;
  $('scene-cards').append(article);
  for(const [kind,key] of [['continuous','continuous'],['oneShot','oneShot']])article.querySelector(`[data-setting="scenes.${scene}.${key}"]`).closest('label').append(personReferenceRow(scene,kind));
  const indicator=document.createElement('span');indicator.className='generation-indicator';indicator.textContent='GENERATING';
  article.append(indicator);
  const distance=article.querySelector('.distance-label');
  distance.classList.add('world-row');distance.style.setProperty('--scene',colors[scene]);
  distance.firstChild.textContent='T DISTANCE '+scene.toUpperCase();
  $('world-distances').append(distance);
  article.append(article.querySelector('.scene-header'));
  article.insertBefore(article.querySelector('.scene-header'),article.querySelector('.scene-content'));
}
const sourcePanel=document.querySelector('.source-panel'),historyPanel=document.querySelector('.history-panel');
sourcePanel.classList.add('source-scene');sourcePanel.querySelector('h2').textContent='NOW';
sourcePanel.querySelector('.eyebrow').textContent='LAST SOURCE';
sourcePanel.append(historyPanel);
sourcePanel.insertBefore(sourcePanel.querySelector('.section-head'),sourcePanel.querySelector('#source-caption'));
$('scene-cards').prepend(sourcePanel);
$('scene-cards').insertBefore(document.querySelector('[data-scene="c"]'),document.querySelector('[data-scene="a"]'));
document.querySelector('.lower-grid').remove();
$('gui-fullscreen').onclick=async()=>{
  try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}
  catch(error){notice(error.message,true);}
};
document.addEventListener('fullscreenchange',()=>{$('gui-fullscreen').textContent=document.fullscreenElement?'Exit full screen · Esc':'Full screen';});
$('cone-result').onclick=()=>{coneMode='result';renderCone();};
$('cone-settings').onclick=()=>{coneMode='settings';renderCone();};
// Output mapping lives only in the top-right Mapping link (2026-10-21).
for(const [value,label] of [[1,'1 · A'],[2,'2 · A B'],[3,'3 · A B C']])$('image-count').add(new Option(label,String(value)));
for(let i=1;i<=4;i++){
  const card=document.createElement('div');card.className='output-card';
  card.innerHTML=`<a href="/control/output/${i}" target="_blank" rel="noopener">Output ${i}<span aria-hidden="true">↗</span></a><label>Source<select id="route-${i}" aria-label="Output ${i} source"></select></label>`;
  $('output-routes').append(card);
  for(const scene of ['A','B','C','NOW'])$(`route-${i}`).add(new Option(scene,scene));
  $(`route-${i}`).addEventListener('change',()=>{routingDirty=true;$('routing-status').textContent='Routing has unsaved changes.';});
}
function notice(message,error=false,kind='action'){
  clearTimeout(noticeTimer);$('notice').textContent=message;$('notice').className=error?'error':'';$('notice').hidden=false;
  $('notice').dataset.kind=kind;
  if(!error)noticeTimer=setTimeout(()=>{$('notice').hidden=true;},5500);
}
// Per-scene Presence / Tone (settings.scenes.<a|b|c>.presence/tone; absent = follow the global slider).
// data-override names the global key; data-inherited = currently showing the global value; data-cleared = Apply sends null (remove the override).
const sceneOverrideKeys=['presence','tone'];
for(const key of sceneOverrideKeys)for(const scene of scenes){
  const label=document.createElement('label');label.className='world-row range-label per-scene-row';
  label.innerHTML=`${key.toUpperCase()} ${scene.toUpperCase()} <output id="scene-${scene}-${key}-value"></output><input data-setting="scenes.${scene}.${key}" data-override="${key}" data-inherited="1" form="settings-form" type="range" min="0" max="1" step="0.01" aria-label="${key} for scene ${scene.toUpperCase()}">`;
  label.style.setProperty('--scene',colors[scene]);
  $('per-scene-params').append(label);
}
function overrideInputs(){return [...document.querySelectorAll('[data-override]')];}
let perSceneOpen=false;
$('per-scene-toggle').addEventListener('change',event=>{
  perSceneOpen=event.target.checked;$('per-scene-params').hidden=!event.target.checked;
  if(event.target.checked){for(const el of overrideInputs())if(el.dataset.cleared){delete el.dataset.cleared;dirty.delete(el.dataset.setting);}}
  else{if(!dirty.size)baseRevision=latest?.settingsRevision;for(const el of overrideInputs())if(get(latest?.settings,el.dataset.setting)!==undefined||dirty.has(el.dataset.setting)){el.dataset.cleared='1';el.dataset.inherited='1';dirty.add(el.dataset.setting);}}
  rangeLabels();dirtyLabel();
});
function get(object,path){return path.split('.').reduce((o,k)=>o?.[k],object);}
function set(object,path,value){const keys=path.split('.');let o=object;for(const k of keys.slice(0,-1))o=o[k]??=( {} );o[keys.at(-1)]=value;}
function value(el){return el.dataset.cleared?null:el.dataset.json?JSON.parse(el.value||'[]'):el.type==='checkbox'?el.checked:(el.type==='number'||el.type==='range')?Number(el.value):el.value;}
function field(path){return document.querySelector(`[data-setting="${path}"]`);}
function dirtyLabel(){
  $('apply').disabled=busy||!online||uncertain||!dirty.size;
  $('apply-top').disabled=$('apply').disabled;
  $('reload-settings').hidden=!dirty.size;
  $('dirty-message').textContent=dirty.size?'Unsaved changes · Apply to save':'Settings are in sync';
}
function rangeLabels(){
  for(const key of ['presence','tone','emptyRoomPersonChance'])if(field(key))$(key+'-value').textContent=Number(field(key).value).toFixed(2);
  // Inherited per-scene sliders follow the (possibly unsaved) global slider; the summary shows the effective value per scene.
  const summary=[];
  for(const el of overrideInputs()){
    const [,scene,key]=el.dataset.setting.split('.');
    if(el.dataset.inherited&&field(key))el.value=field(key).value;
    $(`scene-${scene}-${key}-value`).textContent=Number(el.value).toFixed(2)+(el.dataset.inherited?'·g':'');
    $(`scene-${scene}-${key}-value`).title=el.dataset.inherited?'Follows the global slider':'Scene override';
  }
  for(const key of sceneOverrideKeys){const vals=scenes.map(scene=>Number(field(`scenes.${scene}.${key}`).value).toFixed(2));if(new Set(vals).size>1)summary.push(`${key[0].toUpperCase()} ${vals.join('/')}`);}
  $('per-scene-effective').textContent=summary.length?summary.join(' · '):'A/B/C = global';
}
function renderProgress(){
  const scene=generatingScene(latest?.capture,captureProgress?.active);
  for(const card of document.querySelectorAll('.scene[data-scene]')){
    card.classList.toggle('is-generating',card.dataset.scene===scene);
    card.classList.toggle('is-pending',card.dataset.scene!==scene&&sceneStaleState(card.dataset.scene)==='pending');
    card.classList.toggle('is-previous',sceneStaleState(card.dataset.scene)==='previous');
    card.setAttribute('aria-busy',card.dataset.scene===scene?'true':'false');
  }
}
/** 'pending' = a generation is running and this panel still shows an earlier capture (frame blinks);
 *  'previous' = generation ended and the panel kept the earlier image (skipped / rejected scene); null = current. */
function sceneStaleState(scene){
  const content=displayedScenes?.[scene]?.content;if(!content||typeof content.captureId!=='string')return null;
  const generating=['requested','generating'].includes(latest?.capture?.phase);
  const reference=generating&&latest.capture.captureId?latest.capture.captureId:displayedScenes?.now?.content?.captureId;
  if(typeof reference!=='string'||!reference||content.captureId===reference)return null;
  return generating?'pending':'previous';
}
function skipLabel(scene){
  const reason=sceneSkips[scene];if(!reason)return 'previous';
  return (reason.startsWith('rejected:')?'rejected '+reason.slice(9):'skip '+reason).replace(/_/g,' ');
}
document.addEventListener('input',event=>{
  const el=event.target.closest('[data-setting]');if(!el)return;
  if(!dirty.size)baseRevision=latest?.settingsRevision;
  if(el.dataset.override){delete el.dataset.inherited;delete el.dataset.cleared;}
  dirty.add(el.dataset.setting);rangeLabels();dirtyLabel();renderCone();
});
document.addEventListener('change',event=>{
  const el=event.target.closest('[data-setting]');
  if(el){if(!dirty.size)baseRevision=latest?.settingsRevision;dirty.add(el.dataset.setting);dirtyLabel();if(isDirectionSetting(el.dataset.setting))scheduleDirectionSave();}
});
function mmss(seconds){const n=Math.max(0,Math.floor(seconds||0));return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;}
function connection(connected,message){
  online=connected;document.body.classList.toggle('offline',!online);
  $('connection').textContent=message;$('connection-dot').className='dot '+(online?'online':'offline');
  dirtyLabel();updateButtons();
}
// Directions (Instructions · Continuous / One shot and their person images) stay editable while a scenario owns the layout.
const isDirectionSetting=key=>/^scenes\.[abc]\.(continuous|oneShot|continuousPersonReferenceIds|oneShotPersonReferenceIds)$/.test(key||'');
let directionSaveTimer=null;
function scheduleDirectionSave(){
  if(!latest?.scenario?.ownsLayout||!dirty.size||[...dirty].some(path=>!isDirectionSetting(path)))return;
  clearTimeout(directionSaveTimer);
  directionSaveTimer=setTimeout(async()=>{
    if(busy||!online||uncertain){scheduleDirectionSave();return;}
    try{await apply();notice('Direction saved · applies at the next generation.');}catch(error){notice(error.message,true);}
  },1000);
}
function updateButtons(){
  const blocked=busy||!online||uncertain;
  const running=latest?.capture?.phase==='generating'||latest?.capture?.phase==='requested';
  const scenarioOwns=latest?.scenario?.ownsLayout;
  for(const id of ['run','pause-generation','generate','cancel','save-project','load-scenario','play-scenario','pause-scenario','stop-scenario','select-input','apply-layout','shuffle','reset-layout','show-outputs','hide-outputs','upload-open'])$(id).disabled=blocked;
  $('generate').disabled=blocked||running||scenarioOwns;
  $('generate').textContent=running?'Generating…':'Generate';
  $('generate').title=running?'A generation is already running':scenarioOwns?'The scenario controls generation':'Generate once with the current settings';
  $('run').disabled=blocked||scenarioOwns;
  $('cancel').hidden=!running;
  for(const id of ['apply-layout','shuffle','reset-layout'])$(id).disabled=blocked||scenarioOwns;
  for(const el of document.querySelectorAll('[data-setting]')){
    const key=el.dataset.setting;
    el.disabled=blocked||(scenarioOwns&&(key==='mode'||key==='scenarioPreview'||key.startsWith('scenes.')&&!isDirectionSetting(key)));
  }
  $('per-scene-toggle').disabled=blocked||!!scenarioOwns;
  $('pause-scenario').disabled=blocked||!['running','paused'].includes(latest?.scenario?.state);
  $('stop-scenario').disabled=blocked||!scenarioOwns;
  $('select-input').disabled=blocked||(!latest?.replay?.active&&latest?.runtime!=='native');
  renderPersonReferences();
  dirtyLabel();
}
// Scenario CSV format check: rendered from state, so the banner stays until a load without errors clears it.
let formatShown='',formatDismissed='';
function renderScenarioFormat(scenario){
  const box=$('scenario-format'),errors=scenario.formatErrors||[],warnings=scenario.formatWarnings||[],rows=[...errors,...warnings];
  const key=[scenario.formatCheckedAt,scenario.formatFile,errors.length,warnings.length].join('|');
  if(!scenario.formatCheckedAt||key===formatDismissed){box.hidden=true;formatShown='';return;}
  box.hidden=false;
  if(key===formatShown)return;
  formatShown=key;box.open=true;
  const colour=errors.length?'#c62828':warnings.length?'#f2c037':'#2e7d32';
  const title=$('scenario-format-title'),panel=$('scenario-format-box');
  title.textContent=errors.length?`Format check: ${errors.length} error${errors.length===1?'':'s'}`:`Format check: OK (${scenario.formatRows||0} rows, ${warnings.length} warning${warnings.length===1?'':'s'})`;
  Object.assign(title.style,{background:colour,color:errors.length||!warnings.length?'#fff':'#111',fontWeight:'700',padding:'3px 8px',borderRadius:'3px',fontSize:'11px',letterSpacing:'.04em',whiteSpace:'nowrap'});
  Object.assign(panel.style,{position:'fixed',bottom:'var(--bottom)',left:'15px',zIndex:'11',background:'#1c1c1c',border:'2px solid '+colour,padding:'10px 12px',width:'min(620px,92vw)',maxHeight:'45vh',overflow:'auto',boxShadow:'0 -3px 10px #0008',fontSize:'12px'});
  const checked=new Date(scenario.formatCheckedAt).toLocaleTimeString();
  $('scenario-format-file').textContent=`${scenario.formatFile||'CSV'} · ${checked}`+(errors.length?` · NOT loaded, not selectable for Play until fixed${scenario.scenarioId?' (still loaded: '+scenario.scenarioId+')':''}`+(warnings.length?` · +${warnings.length} warning${warnings.length===1?'':'s'}`:''):' · Loaded');
  const list=$('scenario-format-list');list.replaceChildren();Object.assign(list.style,{margin:'6px 0 0 16px',padding:'0',listStyle:'disc'});
  for(const issue of rows.slice(0,200)){
    const item=document.createElement('li');
    item.textContent=`${issue.severity==='warning'?'warning · ':''}${issue.row?'row '+issue.row:'file'}${issue.column?' ['+issue.column+']':''} · ${issue.message}`+(issue.text?` · ${issue.text}`:'');
    if(issue.severity==='warning')item.style.opacity='.8';
    list.append(item);
  }
  if(rows.length>200){const more=document.createElement('li');more.textContent=`… ${rows.length-200} more`;list.append(more);}
  let close=$('scenario-format-dismiss');
  // 2026-10-21: one click copies every listed issue (plus the file name and time) as plain text, for pasting into a chat or an AI.
  let copy=$('scenario-format-copy');
  if(!copy){copy=document.createElement('button');copy.id='scenario-format-copy';copy.type='button';copy.style.cssText='margin:8px 8px 0 0';panel.append(copy);}
  copy.textContent=`Copy ${rows.length} issue${rows.length===1?'':'s'}`;
  copy.onclick=async()=>{
    const text=[`${scenario.formatFile||'CSV'} · ${checked} · ${title.textContent}`,...rows.map(issue=>`${issue.severity==='warning'?'warning: ':'error: '}${issue.row?'row '+issue.row:'file'}${issue.column?' ['+issue.column+']':''} · ${issue.message}`+(issue.text?` · ${issue.text}`:''))].join('\n');
    try{await navigator.clipboard.writeText(text);copy.textContent='Copied';}catch{copy.textContent='Copy failed';}
    setTimeout(()=>{copy.textContent=`Copy ${rows.length} issue${rows.length===1?'':'s'}`;},1500);
  };
  if(!close){close=document.createElement('button');close.id='scenario-format-dismiss';close.type='button';close.textContent='Dismiss';close.style.cssText='margin-top:8px';close.onclick=()=>{formatDismissed=formatShown;formatShown='';box.hidden=true;};panel.append(close);}
}
function render(state){
  latest=state;
  connection(true,state.runtime==='native'?'Server connected':'TD connected');
  if($('notice').dataset.kind==='connection')$('notice').hidden=true;
  $('project-name').textContent=state.project;
  const isGenerating=['generating','requested'].includes(state.capture.phase);
  $('generation-state').textContent=isGenerating?'Generating':state.scenario.ownsLayout?'Scenario · '+state.scenario.state:state.settings.mode==='manual'?'Manual · Ready':state.submissionHold?'Auto paused':'Auto enabled';
  $('generation-state').classList.toggle('busy',isGenerating);
  // Remote device selected but the phone sends no frames: automatic generation is skipped, so say it prominently (status slot).
  const remoteStale=!!(state.remoteCamera&&state.remoteCamera.selected&&state.remoteCamera.state!=='fresh');
  $('generation-state').classList.toggle('remote-stale',remoteStale);
  if(remoteStale){const r=state.remoteCamera,mins=r.state==='none'?null:Math.max(1,Math.round((r.ageSec||0)/60));$('generation-state').textContent=mins===null?'Remote device: no frames yet — generation paused':`Remote device: no frames for ${mins} min — generation paused`;}
  $('generation-detail').textContent=isGenerating?`${mmss(state.capture.busyFor)} elapsed · ${state.settings.imageCount} images`:
    state.scenario.ownsLayout?'Stop the scenario to return to manual controls.':state.settings.mode==='manual'?'Generate runs once.':state.submissionHold?'Auto paused · Generate runs once.':state.settings.mode==='timer'?`Next generation in ${mmss(state.capture.nextTimerTickIn)}`:
    'Generates again after each result.';
  for(const el of document.querySelectorAll('[data-setting]')){
    const path=el.dataset.setting;if(dirty.has(path))continue;
    const x=get(state.settings,path);
    if(el.dataset.override){delete el.dataset.cleared;if(x===undefined){el.dataset.inherited='1';el.value=get(state.settings,el.dataset.override);}else{delete el.dataset.inherited;el.value=x;}continue;}
    if(x===undefined)continue;
    if(el.dataset.json)el.value=JSON.stringify(x);else if(el.type==='checkbox')el.checked=!!x;else el.value=x;
  }
  if(!dirty.size)baseRevision=state.settingsRevision;
  if(!overrideInputs().some(el=>dirty.has(el.dataset.setting))){const on=overrideInputs().some(el=>!el.dataset.inherited);$('per-scene-toggle').checked=on||perSceneOpen;$('per-scene-params').hidden=!$('per-scene-toggle').checked;}
  renderPersonReferences();
  rangeLabels();
  const replay=state.replay;
  if(state.runtime==='native'&&!$('input-set').querySelector('option[value="camera"]'))$('input-set').add(new Option('Live camera','camera'));
  if(state.runtime==='native'&&!$('input-set').querySelector('option[value="remote-device"]'))$('input-set').add(new Option('Remote device (phone)','remote-device'));
  const remote=state.remoteCamera?.selected?state.remoteCamera:null;
  const camSel=$('input-camera-index'),camIndex=Number.isInteger(state.cameraIndex)?state.cameraIndex:null;
  if(camIndex!==null&&document.activeElement!==camSel&&!camSel.dataset.touched)camSel.value=String(camIndex);
  $('input-kind').textContent=remote?(remote.state==='fresh'?'REMOTE':'REMOTE · STALE'):replay.active?'TEST REPLAY':'CAMERA';
  const queued=state.pendingInput?.setId||'';
  if(inputSelection===null&&document.activeElement!==$('input-set'))$('input-set').value=queued||(remote?'remote-device':replay.pendingSet||(replay.cycle?'cycle':(replay.setId||(state.runtime==='native'&&!replay.active?'camera':'TSC-001'))));
  camSel.hidden=$('input-set').value!=='camera';
  $('release-device').hidden=!remote;
  $('select-input').textContent=queued?'Queued…':'Switch';
  $('select-input').title=queued?`Queued: ${queued} · applied after the current generation (a new Switch replaces it)`:'Switch the input';
  $('input-detail').textContent=queued?`Queued… ${queued} · applied after the current generation`:remote?(remote.state==='none'?'Remote device · remote camera stale (no frame yet) · live input, writes venue history':`Remote device · ${remote.holderShort?'remote · '+remote.holderShort+' · ':''}last frame ${remote.ageSec} s ago${remote.state==='stale'?' · remote camera stale':''} · live input, writes venue history`):replay.pendingSet?`Switch to ${replay.pendingSet} after the current generation`:replay.active?`${replay.currentFrameId||replay.setId} · loop ${replay.loop||1}`:'Live camera';
  const library=state.scenarioLibrary.map(item=>item.file+(item.external?':'+item.external.approved:'')).join('|');
  if($('scenario-file').dataset.library!==library){
    const previous=$('scenario-file').value;$('scenario-file').replaceChildren();
    // External submissions (public /submit/): "external · <name> · <time>"; unapproved ones are listed but not selectable.
    for(const item of state.scenarioLibrary){
      const option=new Option(item.external?externalLabel(item.external)+(item.external.approved?'':' · not approved'):item.name,item.file);
      if(item.external&&!item.external.approved){option.disabled=true;option.className='unapproved';}
      $('scenario-file').add(option);
    }
    $('scenario-file').dataset.library=library;
    const selectable=file=>state.scenarioLibrary.some(x=>x.file===file&&(!x.external||x.external.approved));
    $('scenario-file').value=selectable(previous)?previous:state.scenario.file;
  }
  renderExternal(state.scenarioLibrary);
  const scenario=state.scenario;
  $('scenario-state').textContent=scenario.state;
  const previewOnly=!!state.settings.scenarioPreview;
  const playLabel=previewOnly?'Preview / Restart':'Play / Restart';
  if($('play-scenario').textContent!==playLabel)$('play-scenario').textContent=playLabel;
  $('play-scenario').title=previewOnly?'Preview the timeline without generating images':'Run scenario cues and generate images';
  if(scenario.ownsLayout&&scenario.previewOnly){
    $('generation-state').textContent='Scenario preview · '+scenario.state;
    const wouldChange=(scenario.settingsCues||[]).filter(row=>row.skipped==='preview').slice(-3).map(row=>row.change);
    $('generation-detail').textContent='No images are generated in preview. Stop to switch to live playback.'+(wouldChange.length?' · Settings not applied (preview): '+wouldChange.join(' / '):'');
  }
  if(scenario.ownsLayout&&!scenario.previewOnly&&!isGenerating){
    $('generation-state').textContent='Scenario live · '+scenario.state;
    $('generation-detail').textContent=`${scenario.requestedGenerations||0} generation requests`+(scenario.lastGenerationSkipped?' · Skipped: '+scenario.lastGenerationSkipped:'')+(scenario.lastSettingsError?' · Settings: '+scenario.lastSettingsError:'');
  }
  renderErrors(state);
  renderSceneNotes(state);
  const generationError=!isGenerating&&(state.errors||[]).find(error=>error.operator==='native'&&error.message);
  if(generationError){
    $('generation-state').textContent='Generation failed';
    $('generation-detail').textContent=generationError.message+' · Successful images retained';
    const message='Generation failed: '+generationError.message+'. Successfully published images remain displayed.';
    if($('notice').hidden||$('notice').dataset.kind!=='generation'||$('notice').textContent!==message)notice(message,true,'generation');
  }else if($('notice').dataset.kind==='generation')$('notice').hidden=true;
  $('scenario-elapsed').textContent=mmss(scenario.elapsedSec);$('scenario-duration').textContent='/ '+mmss(scenario.durationSec);
  $('scenario-progress').max=scenario.durationSec||1;$('scenario-progress').value=scenario.elapsedSec;
  $('scenario-instructions').textContent=scenario.instructions;
  $('scenario-message').textContent=scenario.status;
  renderScenarioFormat(scenario);
  const pauseLabel=scenario.state==='paused'?'Resume':'Pause';
  if($('pause-scenario').textContent!==pauseLabel)$('pause-scenario').textContent=pauseLabel;
  for(const scene of scenes)$('direction-note-'+scene).textContent=scenario.ownsLayout?'Editable during the scenario; applies at the next generation.':'';
  for(const scene of scenes)$('scenario-prompt-'+scene).textContent=scenario.prompts?.['gen_'+scene]?'Scenario: '+scenario.prompts['gen_'+scene]:'';
  $('history').textContent=state.history||'No observations yet.';
  const money=x=>typeof x==='number'&&Number.isFinite(x)?'¥'+x.toLocaleString('en-US',{maximumFractionDigits:1}):'—';
  $('cost-display').textContent=`Gemini ${money(state.cost?.todayJpy)} (${state.cost?.todayCalls??'—'} calls) / Total ${money(state.cost?.allTimeJpy)}`;
  if(!routingDirty)state.display.layout.forEach((source,i)=>$(`route-${i+1}`).value=source);
  if(!routingDirty)$('routing-status').textContent=scenario.ownsLayout?'Routing follows the scenario.':state.display.visible?'Outputs are visible.':'Outputs are hidden.';
  $('diagnostics').textContent=JSON.stringify({project:state.project,capture:state.capture,replay:state.replay,errors:state.errors},null,2);
  updateButtons();
  renderProgress();
  renderCone();
}
async function json(url,options={}){
  const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(30000),...options});
  let data;try{data=await response.json();}catch{const error=Error('The control service did not return JSON.');error.indeterminate=options.method==='POST';throw error;}
  if(!response.ok||data.ok===false){const error=Error(data.error||`Request failed (${response.status})`);error.indeterminate=data.indeterminate;throw error;}
  return data;
}
async function refresh(){
  if(polling||busy)return;polling=true;const version=epoch;
  try{
    const [state,progress]=await Promise.all([json(API+'/state'),json('/api/capture/status').catch(()=>null)]);
    if(version===epoch&&!busy){captureProgress=progress;render(state);}
  }
  catch(error){if(version===epoch&&!busy){captureProgress=null;renderProgress();connection(false,'Control disconnected');notice(error.message,true,'connection');}}
  finally{polling=false;}
}
async function command(action,data={},base){
  const payload={action,data,requestId:requestId()};if(base)payload.baseRevision=base;
  try{return await json(API+'/action',{method:'POST',headers:{'Content-Type':'application/json','X-Control-Request':'1'},body:JSON.stringify(payload)});}
  catch(error){markUncertain(error);throw error;}
}
async function apply(){
  if(!dirty.size)return;
  if(!$('settings-form').reportValidity())throw Error('Check the highlighted settings.');
  const patch={};for(const path of dirty)set(patch,path,value(field(path)));
  const result=await command('settings.apply',patch,baseRevision);
  dirty.clear();render(result.state);return result;
}
async function perform(action,data={},saveEdits=false){
  if(busy){notice('A command is still in progress. Please wait.',true);return;}
  if(!online){notice('The control server is disconnected. Commands are unavailable.',true);return;}
  if(uncertain){notice('Refresh state before sending another command.',true);return;}
  busy=true;epoch++;updateButtons();
  try{
    if(saveEdits)await apply();
    const result=await command(action,data);
    if(action.startsWith('display.'))routingDirty=false;
    render(result.state);notice(result.message);void refreshImages();
  }catch(error){notice(error.message,true);}
  finally{busy=false;updateButtons();refresh();}
}
$('settings-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy||!online||uncertain)return;busy=true;epoch++;updateButtons();
  try{await apply();notice('Settings applied.');}catch(error){notice(error.message,true);}
  finally{busy=false;updateButtons();refresh();}
});
$('reload-settings').onclick=()=>{dirty.clear();baseRevision=latest?.settingsRevision;render(latest);notice('Current TD settings reloaded.');};
$('recheck-state').onclick=async()=>{
  $('recheck-state').disabled=true;
  try{const state=await json(API+'/state');uncertain=false;$('uncertain-action').hidden=true;render(state);notice('Current TD state refreshed. Check it before your next command.');}
  catch(error){notice(error.message,true);}finally{$('recheck-state').disabled=false;}
};
for(const [id,action] of Object.entries({'run':'generation.resume','pause-generation':'generation.pause','generate':'generation.generate','cancel':'generation.cancel','save-project':'project.save','pause-scenario':'scenario.pause','stop-scenario':'scenario.stop','shuffle':'display.shuffle','reset-layout':'display.reset','show-outputs':'display.show','hide-outputs':'display.hide'}))$(id).onclick=()=>perform(action,{},id==='run'||id==='generate');
$('play-scenario').onclick=()=>perform('scenario.play',{},true);
$('load-scenario').onclick=()=>perform('scenario.load',{file:$('scenario-file').value});
$('input-set').addEventListener('change',()=>{inputSelection=$('input-set').value;$('input-camera-index').hidden=inputSelection!=='camera';});
$('input-camera-index').addEventListener('change',()=>{$('input-camera-index').dataset.touched='1';});
$('select-input').onclick=async()=>{
  const selected=inputSelection||$('input-set').value;
  await perform('input.select',selected==='camera'?{setId:selected,cameraIndex:Number($('input-camera-index').value)}:{setId:selected});delete $('input-camera-index').dataset.touched;
  if(latest?.pendingInput?.setId===selected||latest?.replay?.setId===selected||latest?.replay?.pendingSet===selected||(selected==='cycle'&&latest?.replay?.cycle)||(selected==='camera'&&latest?.runtime==='native'&&!latest?.replay?.active&&!latest?.remoteCamera?.selected)||(selected==='remote-device'&&latest?.remoteCamera?.selected)){
    inputSelection=null;render(latest);
  }
};
$('release-device').onclick=()=>perform('input.release',{});
$('apply-layout').onclick=()=>perform('display.layout',{sources:[1,2,3,4].map(i=>$(`route-${i}`).value)});
$('upload-open').onclick=()=>$('scenario-upload').click();
// External scenario submissions: Approve / Delete (POST /api/td-control/scenario-submission). Unapproved ones cannot be loaded or played.
function externalLabel(x){const d=new Date(x.submittedAt);const t=Number.isFinite(d.getTime())?d.toLocaleString('ja-JP',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'';return `external · ${x.name} · ${t}`;}
function renderExternal(library){
  let box=$('scenario-external');
  if(!box){
    box=document.createElement('details');box.id='scenario-external';box.className='scenario-external';
    box.innerHTML='<summary id="scenario-external-title"></summary><div><p class="subtle">External submissions (public /submit/). Approve to make one selectable for Load CSV / Play; Delete removes its import folder.</p><ul id="scenario-external-list"></ul></div>';
    $('scenario-upload').after(box);
  }
  const rows=library.filter(item=>item.external).sort((a,b)=>String(b.external.submittedAt).localeCompare(String(a.external.submittedAt)));
  const key=JSON.stringify(rows.map(r=>[r.file,r.external.approved,(r.external.formatWarnings||[]).length]));
  box.hidden=!rows.length;if(box.dataset.key===key)return;box.dataset.key=key;
  const pending=rows.filter(r=>!r.external.approved).length;
  $('scenario-external-title').textContent=pending?`External · ${pending} new`:`External · ${rows.length}`;
  box.classList.toggle('has-pending',pending>0);
  $('scenario-external-list').replaceChildren(...rows.slice(0,30).map(item=>{
    const x=item.external,li=document.createElement('li');li.className=x.approved?'approved':'pending';
    const label=document.createElement('span');label.textContent=externalLabel(x)+' · '+(x.scenarioId||item.name)+(x.approved?' · approved':'');const warnText=(x.formatWarnings||[]).map(w=>`row ${w.row} · ${w.message}`).join('\n');label.title=[x.note||'',warnText?'Format warnings:\n'+warnText:''].filter(Boolean).join('\n\n');
    li.append(label);
    if(x.note){const note=document.createElement('small');note.textContent=x.note;li.append(note);}
    if(x.formatWarnings?.length){const fw=document.createElement('small');fw.textContent=`Format warnings (${x.formatWarnings.length}): `+x.formatWarnings.slice(0,3).map(w=>`row ${w.row} · ${w.message}`).join(' | ')+(x.formatWarnings.length>3?' …':'');li.append(fw);}
    const actions=document.createElement('span');actions.className='external-actions';
    if(!x.approved){const ok=document.createElement('button');ok.type='button';ok.textContent='Approve';ok.onclick=()=>manageExternal('approve',x);actions.append(ok);}
    const del=document.createElement('button');del.type='button';del.textContent='Delete';del.onclick=()=>manageExternal('delete',x);actions.append(del);
    li.append(actions);return li;
  }));
}
async function manageExternal(action,x){
  if(busy||!online)return;
  if(action==='delete'&&!confirm(`Delete external scenario "${x.name}" (${x.scenarioId})? Its import folder is removed.`))return;
  busy=true;updateButtons();
  try{const result=await json(API+'/scenario-submission',{method:'POST',headers:{'Content-Type':'application/json','X-Control-Request':'1'},body:JSON.stringify({action,id:x.id})});notice(result.message||'Done.');}
  catch(error){notice(error.message,true);}
  finally{busy=false;updateButtons();refresh();}
}
function encode(raw){let s='';for(let i=0;i<raw.length;i+=16384)s+=String.fromCharCode(...raw.subarray(i,i+16384));return btoa(s);}
$('scenario-upload').onchange=async event=>{
  if(busy||!online||uncertain){event.target.value='';return;}
  const files=[...event.target.files];if(!files.length)return;
  const csv=files.filter(f=>f.name.toLowerCase().endsWith('.csv'));
  if(csv.length!==1){notice('Select one CSV and its PNG images together.',true);return;}
  busy=true;epoch++;updateButtons();
  try{
    const assets=[];let total=0;
    for(const file of files.filter(f=>f!==csv[0])){
      total+=file.size;if(file.size>8*1024*1024||total>24*1024*1024)throw Error('Images exceed 8 MB each / 24 MB total.');
      assets.push({name:file.name,base64:encode(new Uint8Array(await file.arrayBuffer()))});
    }
    if(csv[0].size>2*1024*1024)throw Error('CSV exceeds 2 MB.');
    const result=await json(API+'/scenario-upload',{method:'POST',headers:{'Content-Type':'application/json','X-Control-Request':'1'},body:JSON.stringify({csv:{name:csv[0].name,text:await csv[0].text()},assets})});
    const summary=`Format check: OK (${result.rows??0} rows, ${(result.formatWarnings||[]).length} warnings)`;
    try{const loaded=await command('scenario.load',{file:result.file});render(loaded.state);$('scenario-file').value=result.file;notice('Scenario imported and loaded. '+summary);}
    catch(loadError){$('scenario-file').value=result.file;notice(`Scenario imported. ${summary}. Not loaded: ${loadError.message}`,true);}
  }catch(error){markUncertain(error);notice(error.message,true);}
  finally{event.target.value='';busy=false;updateButtons();refresh();}
};
async function refreshImages(){
  if(imagePolling)return;imagePolling=true;
  try{
    const output=await json(API+'/outputs');
    displayedScenes=output.scenes;
    for(const scene of [...scenes,'now']){
      const content=output.scenes[scene]?.content;
      const image=scene==='now'?$('source-image'):$('scene-image-'+scene);
      if(content){
        const url=localImagePath(content.imageUrl);
        if(image.getAttribute('src')!==url)image.src=url;
        image.hidden=false;
        if(scene==='now'){
          $('source-caption').textContent=content.caption;
        }
        else{
          $('scene-waiting-'+scene).hidden=true;$('scene-caption-'+scene).textContent=content.caption;renderSceneDetails(scene);
          const distance=content.distanceSecSigned,known=typeof distance==='number'&&Number.isFinite(distance);
          document.querySelector(`[data-scene="${scene}"] h3`).textContent=scene.toUpperCase()+(known?' '+(distance<0?'PAST ':'FUTURE +')+distance+' sec':'');
          const stale=sceneStaleState(scene);
          $('scene-time-'+scene).textContent=stale==='pending'?'PREVIOUS · generating':stale==='previous'?'PREVIOUS · '+skipLabel(scene):'GENERATED';
        }
      }
    }
    renderProgress();renderCone();
  }catch{/* Generation settings remain usable when the image server is unavailable. */}
  finally{imagePolling=false;}
}
async function refreshConeResults(){
  if(conePolling)return;conePolling=true;
  try{
    const rows=await json('/api/events?limit=20');
    coneCompleted=completedConeResult(rows,coneCompleted);
    sceneSkips=skipReasons(rows,displayedScenes?.now?.content?.captureId);
    renderCone();
  }catch{/* Keep the completed cone; archive reads must not block Each-image updates. */}
  finally{conePolling=false;}
}
function setLiveLabel(){const i=latest?.cameraIndex;$('input-preview-label').textContent=Number.isInteger(i)?'Live · cam '+i:'Live';}
const STREAM_URL=API+'/input-preview/stream';
let previewStreaming=false,streamBlockedUntil=0;
function startPreviewStream(image){
  if(previewStreaming||Date.now()<streamBlockedUntil)return false;
  previewStreaming=true;
  image.onerror=()=>{ // 404/409/429/502 or dropped stream: back to 1 s polling, retry the stream after 30 s
    image.onerror=null;previewStreaming=false;streamBlockedUntil=Date.now()+30000;image.removeAttribute('src');refreshInputPreview();
  };
  image.src=STREAM_URL;image.hidden=false;image.alt='Current camera input (live stream)';
  setLiveLabel();$('input-preview-label').title='Live camera stream';
  return true;
}
async function refreshInputPreview(){
  if(previewStreaming){
    // Stream alive: no polling, unless the input is no longer the live camera.
    if(/^(REMOTE|TEST REPLAY)/.test($('input-kind').textContent||'')){const image=$('input-preview');image.onerror=null;previewStreaming=false;image.removeAttribute('src');}
    else return;
  }
  if(previewPolling||document.hidden)return;previewPolling=true;
  try{
    const frame=await json(API+'/input-preview');
    if(frame.kind==='camera'&&!/^REMOTE/.test($('input-kind').textContent||'')&&startPreviewStream($('input-preview')))return;
    if(typeof frame.dataUrl!=='string'||frame.dataUrl.length>12*1024*1024||!/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(frame.dataUrl))throw Error('Invalid input preview');
    const image=$('input-preview');if(image.getAttribute('src')!==frame.dataUrl)image.src=frame.dataUrl;
    image.hidden=false;image.alt=frame.kind==='replay'?'Current replay input':'Current camera input';
    if(frame.kind==='replay')$('input-preview-label').textContent='Current replay';else setLiveLabel();
    $('input-preview-label').title=frame.frameId||'Current camera input';
  }catch{$('input-preview').hidden=true;$('input-preview-label').textContent='Preview unavailable';}
  finally{previewPolling=false;}
}
for(const scene of scenes)addCopyButton($('scene-caption-'+scene),'scene '+scene+' instruction');
addCopyButton($('scenario-format-list'),'format errors');addCopyButton($('scenario-instructions'),'scenario instructions');addCopyButton($('source-caption'),'source caption');addCopyButton($('history'),'history text');addCopyButton($('diagnostics'),'connection diagnostics');addCopyButton($('error-list'),'errors');
connection(false,'Connecting to control…');refresh();refreshImages();refreshInputPreview();refreshConeResults();
setInterval(refresh,2000);setInterval(refreshImages,3000);setInterval(refreshConeResults,3000);
setInterval(refreshInputPreview,1000);
async function refreshServices(){
  if(document.hidden)return;
  try{
    const health=await json('/api/health');
    for(const [name,ok] of Object.entries({main:health.ok===true,comfy:health.comfyui===true,ollama:health.ollama===true})){
      const el=$('service-'+name);el.dataset.online=String(ok);el.title=ok?'Connected':'Unavailable';
    }
  }catch{for(const name of ['main','comfy','ollama']){$('service-'+name).dataset.online='unknown';$('service-'+name).title='Connection status unavailable';}}
}
refreshServices();setInterval(refreshServices,10000);

function svgNode(tag,attributes={},content){
  const node=document.createElementNS('http://www.w3.org/2000/svg',tag);
  for(const [key,value] of Object.entries(attributes))node.setAttribute(key,String(value));
  if(content!==undefined)node.textContent=content;
  return node;
}
function renderSceneNotes(state){
  lastCaptureScenes=state.captureScenes||{};for(const s of scenes)renderSceneDetails(s);
  const notes=state.sceneNotes||{};const clock=at=>{const d=new Date(at);return Number.isFinite(d.getTime())?d.toLocaleTimeString('ja-JP',{hour12:false}):'';};
  for(const scene of scenes){
    const box=$('scene-notes-'+scene);if(!box)continue;
    const blocks=[];
    for(const [label,entry] of [['Generating',notes.running],['Last run',notes.finished]]){
      if(!entry)continue;
      const rows=[...(entry.notes?.all||[]),...(entry.notes?.[scene]||[])].sort((x,y)=>Date.parse(x.at)-Date.parse(y.at));
      if(!rows.length&&label==='Generating')continue;
      blocks.push({head:`${label} ${clock(entry.startedAt)}${entry.result==='failed'?' · failed':''}`,rows:rows.length?rows:[{at:entry.endedAt||entry.startedAt,kind:'info',text:'No notes'}]});
    }
    const key=JSON.stringify(blocks);if(box.dataset.key===key)continue;box.dataset.key=key;box.replaceChildren();
    for(const block of blocks){const h=document.createElement('div');h.className='scene-notes-head';h.textContent=block.head;box.append(h);
      for(const row of block.rows){const line=document.createElement('div');line.className='scene-note is-'+row.kind;line.textContent=clock(row.at)+' '+row.text;box.append(line);}}
  }
}
// Real action + exact image prompt of the displayed scene image (same saved record that went to the image model).
let lastCaptureScenes={};
function renderSceneDetails(scene){
  const caption=$('scene-caption-'+scene);if(!caption)return;
  let box=$('scene-details-'+scene);
  if(!box){box=document.createElement('div');box.id='scene-details-'+scene;box.className='scene-details';caption.after(box);}
  const d=lastCaptureScenes['gen_'+scene]||{};
  const key=JSON.stringify([d.captureId,d.action,d.fullPrompt,d.references]);if(box.dataset.key===key)return;box.dataset.key=key;box.replaceChildren();
  if(!d.action&&!d.fullPrompt)return;
  if(d.action){const a=document.createElement('div');a.className='scene-action';const l=document.createElement('b');l.textContent='Action: ';a.append(l,document.createTextNode(d.action));box.append(a);}
  if(d.fullPrompt){const det=document.createElement('details');const sum=document.createElement('summary');sum.textContent='Full image prompt'+(d.references?' · '+d.references:'');const pre=document.createElement('pre');pre.textContent=d.fullPrompt;det.append(sum,pre);box.append(det);}
}
function renderErrors(state){
  const rows=Array.isArray(state.warnings)?state.warnings:[];
  const list=$('error-list');if(!list)return;
  const key=JSON.stringify(rows.map(row=>[row.at,row.count,row.message]));
  if(list.dataset.key===key)return;list.dataset.key=key;list.replaceChildren();
  const clock=at=>{const d=new Date(at);return Number.isFinite(d.getTime())?d.toLocaleTimeString('ja-JP',{hour12:false}):'';};
  for(const row of rows.slice(0,50)){
    const item=document.createElement('li');item.className='error-row '+(row.kind==='generation'?'is-error':row.kind==='skip'?'is-skip':row.kind==='external'?'is-info':'is-warning');
    item.textContent=clock(row.at)+'  '+row.message+(row.count>1?'  ×'+row.count:'');
    list.append(item);
  }
  const latestAge=rows[0]?Date.now()-Date.parse(rows[0].at):Infinity;
  $('error-summary').textContent=rows.length?`${rows.length} recent · newest ${clock(rows[0].at)}`:'No errors';
  $('error-panel').classList.toggle('has-recent',latestAge<10*60*1000);
}
function renderCone(){
  // 2026-10-21: the status names the current stage so the blink (only the scene image being generated) reads in sync.
  const coneStageLabel=stage=>{const m=/^scene([A-C])$/.exec(stage||'');return m?'scene '+m[1]+' image (blinking)':stage==='detect'?'reading the photo':stage==='plan'?'planning the scenes':'preparing';};
  const svg=$('cone');if(!svg||!latest)return;
  coneScenes=coneCompleted?.scenes||null;
  const generating=['requested','generating'].includes(latest.capture.phase);
  // Each output keeps its own capture id and recorded distance. A scene that still shows an earlier
  // capture stays where that capture put it (never "time unknown") and is marked instead.
  const visibleCone=displayedScenes?.now?.content?{now:displayedScenes.now,a:displayedScenes.a,b:displayedScenes.b,c:displayedScenes.c}:coneScenes;
  let source=visibleCone?.now?.content;
  // While a capture runs, its own fresh NOW waits until results arrive; any NOW from an earlier capture (including
  // one from a newly selected input) is shown at once. (2026-10-21: updating only when idle kept a stale live-camera
  // SOURCE forever under continuous generation.)
  const runningNow=generating&&source&&latest.capture.captureId&&source.captureId===latest.capture.captureId;
  if(runningNow&&coneLastNow&&coneLastNow.scope===source.scope)source=coneLastNow;
  else if(source&&!runningNow)coneLastNow=source;
  const offsets={},stale={};
  const reference=generating&&latest.capture.captureId?latest.capture.captureId:source?.captureId;
  for(const scene of scenes){
    const content=visibleCone?.[scene]?.content;
    const distance=content?.distanceSecSigned;
    // No image yet for this scene (e.g. right after an input switch): place it at its configured distance and mark it waiting.
    const configured=Number(field('scenes.'+scene+'.distanceSec').value);
    offsets[scene]=coneMode==='settings'||!content?(Number.isFinite(configured)?configured:null):typeof distance==='number'&&Number.isFinite(distance)?distance:null;
    stale[scene]=!content&&coneMode==='result'?'empty':content&&reference&&content.captureId!==reference?(generating?'pending':'previous'):null;
  }
  const geometry=coneGeometry(offsets);
  const coneGenerating=generatingScene(latest?.capture,captureProgress?.active);
  $('cone-result').setAttribute('aria-pressed',coneMode==='result');
  $('cone-settings').setAttribute('aria-pressed',coneMode==='settings');
  $('cone-status').textContent=coneMode==='settings'?'Next capture · configured offsets':generating?'Generating · '+(coneStageLabel(captureProgress?.active?.stage)):Object.values(stale).some(Boolean)?'Displayed results · marked scenes kept the previous image':coneScenes?'Displayed results · relative to source':'Available results · completion unconfirmed';
  // 2026-10-21: the generating scene is part of the key, so the blink moves from A to B to C as the stage changes.
  const renderKey=JSON.stringify([coneMode,source?.captureId,source?.imageUrl,offsets,stale,coneGenerating,
    scenes.map(scene=>[visibleCone?.[scene]?.content?.captureId,visibleCone?.[scene]?.content?.imageUrl,stale[scene]==='previous'?sceneSkips[scene]:null])]);
  if(renderKey===coneRenderKey)return;
  coneRenderKey=renderKey;
  svg.replaceChildren();
  svg.append(svgNode('path',{d:'M500 82 L960 8 L960 164 Z',fill:'#fff',opacity:'.025'}),svgNode('path',{d:'M500 82 L40 8 L40 164 Z',fill:'#6caef0',opacity:'.02'}));
  for(const end of [[40,8],[40,164],[960,8],[960,164]])svg.append(svgNode('line',{x1:500,y1:82,x2:end[0],y2:end[1],stroke:'#65727a','stroke-width':'.7',opacity:'.25'}));
  svg.append(svgNode('line',{x1:40,y1:184,x2:960,y2:184,stroke:'#516067','stroke-width':'1'}));
  for(const tick of geometry.ticks){
    svg.append(svgNode('line',{x1:tick.x,y1:179,x2:tick.x,y2:188,stroke:'#6b7a81'}),svgNode('text',{x:tick.x,y:205,fill:'#8f9da5','font-size':10,'text-anchor':'middle'},tick.label));
  }
  for(const point of geometry.points){
    const row=visibleCone?.[point.scene]?.content;
    const state=coneMode==='result'?stale[point.scene]:null;
    const x=point.x,y={a:28,b:82,c:136}[point.scene],color=colors[point.scene];
    svg.append(svgNode('line',{x1:500,y1:82,x2:x,y2:y,stroke:color,'stroke-width':2,'stroke-dasharray':coneMode==='settings'||state?'4 4':'none',opacity:state?'.45':'.8'}));
    svg.append(svgNode('line',{x1:point.axisX,y1:184,x2:x,y2:y+26,stroke:color,'stroke-width':'.7','stroke-dasharray':'2 4',opacity:'.28'}));
    const frame=svgNode('rect',{x:x-40,y:y-22,width:80,height:44,rx:2,fill:'#0d1113',stroke:color,'stroke-width':1.3});
    // 2026-10-21: only the scene being generated right now blinks (same source as the panel frame); other pending scenes stay dashed.
    if(point.scene===coneGenerating)frame.append(svgNode('animate',{attributeName:'stroke-width',values:'1.3;5;1.3',dur:'0.95s',repeatCount:'indefinite'}));
    svg.append(frame);
    if(coneMode==='result'&&row){
      try{svg.append(svgNode('image',{href:localImagePath(row.imageUrl),x:x-39,y:y-21,width:78,height:42,preserveAspectRatio:'xMidYMid meet',opacity:state==='previous'?'.6':'1'}));}catch{}
    }else svg.append(svgNode('text',{x,y:y+5,fill:color,'text-anchor':'middle','font-size':17},point.scene.toUpperCase()));
    const mark=state==='empty'?' · waiting for an image':state==='pending'?' · previous':state==='previous'?' · '+skipLabel(point.scene):'';
    svg.append(svgNode('text',{x,y:y+35,fill:color,'text-anchor':'middle','font-size':11},point.scene.toUpperCase()+'  '+point.label+mark));
  }
  svg.append(svgNode('rect',{x:458,y:57,width:84,height:50,rx:2,fill:'#101518',stroke:'#b9c4c7'}));
  if(coneMode==='result'&&source){try{svg.append(svgNode('image',{href:localImagePath(source.imageUrl),x:459,y:58,width:82,height:48,preserveAspectRatio:'xMidYMid meet'}));}catch{}}
  else svg.append(svgNode('text',{x:500,y:88,fill:'#b9c4c7','text-anchor':'middle','font-size':13},'INPUT'));
  svg.append(svgNode('text',{x:500,y:121,fill:'#d7dfe0','text-anchor':'middle','font-size':11},coneMode==='settings'?'SOURCE TIME':'SOURCE'));
}
// Manual / Guide versions (docs/versions.json via /control/versions.json).
if(typeof fetch==='function')fetch('/control/versions.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(v=>{if(!v)return;for(const [key,id,label] of [['manual','manual-link','Manual'],['guide','guide-link','Scenario Guide']]){const e=v[key],a=$(id);if(!e||!a)continue;a.textContent=label+' v'+e.version+' ↗';a.title=label+' version '+e.version+' · '+e.date;if(key==='manual'&&e.url)a.href=e.url;}}).catch(()=>{});
