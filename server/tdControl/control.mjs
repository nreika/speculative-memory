import {localImagePath,coneGeometry,generatingScene,completedConeResult,availableConeScenes} from './timeline.mjs';
const API='/api/td-control';
const $=id=>document.getElementById(id);
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
let coneScenes=null, coneRenderKey=null;
let coneCompleted=null, conePolling=false;
const personReferenceCatalog=new Map(),requestedPersonReferences=new Set();
let personReferenceFetching=false,personReferenceRetryAt=0;
function referenceIds(input){try{const ids=JSON.parse(input.value||'[]');return Array.isArray(ids)?ids:[];}catch{return [];}}
function editReferenceIds(input,ids){
  if(!dirty.size)baseRevision=latest?.settingsRevision;
  input.value=JSON.stringify(ids);dirty.add(input.dataset.setting);dirtyLabel();renderPersonReferences();
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
  article.innerHTML=`<div class="scene-header"><h3>${scene.toUpperCase()}</h3><span id="scene-time-${scene}">—</span></div><div class="scene-visual"><img id="scene-image-${scene}" alt="Scene ${scene.toUpperCase()} generated result" hidden><span id="scene-waiting-${scene}">Waiting for an image</span></div><div class="scene-content"><span class="description-label">Generation instruction</span><p id="scene-caption-${scene}" class="scene-caption">No generation instruction yet.</p><label class="distance-label">Time distance <span class="field-note">Past − / Future +</span><div class="distance-field"><input type="number" min="-3600" max="3600" step="1" data-setting="scenes.${scene}.distanceSec" form="settings-form" aria-label="${scene.toUpperCase()} time distance"><span>sec</span></div></label><label>Instructions · Continuous <span class="field-note">Every generation</span><textarea data-setting="scenes.${scene}.continuous" form="settings-form" maxlength="4000" aria-label="${scene.toUpperCase()} continuous prompt" placeholder="Add a direction…"></textarea></label><label>Instructions · One shot <span class="field-note">Next generation</span><textarea data-setting="scenes.${scene}.oneShot" form="settings-form" maxlength="4000" aria-label="${scene.toUpperCase()} one shot prompt" placeholder="For the next image only…"></textarea></label><p class="scenario-prompt" id="scenario-prompt-${scene}"></p></div>`;
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
const mappingLink=document.createElement('a');mappingLink.href='/control/mapping/';mappingLink.target='_blank';mappingLink.rel='noopener';mappingLink.className='mapping-link';mappingLink.textContent='Output mapping ↗';
document.querySelector('.outputs-panel').append(mappingLink);
for(let i=1;i<=10;i++)$('image-count').add(new Option(String(i),String(i)));
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
function get(object,path){return path.split('.').reduce((o,k)=>o?.[k],object);}
function set(object,path,value){const keys=path.split('.');let o=object;for(const k of keys.slice(0,-1))o=o[k]??=( {} );o[keys.at(-1)]=value;}
function value(el){return el.dataset.json?JSON.parse(el.value||'[]'):el.type==='checkbox'?el.checked:(el.type==='number'||el.type==='range')?Number(el.value):el.value;}
function field(path){return document.querySelector(`[data-setting="${path}"]`);}
function dirtyLabel(){
  $('apply').disabled=busy||!online||uncertain||!dirty.size;
  $('apply-top').disabled=$('apply').disabled;
  $('reload-settings').hidden=!dirty.size;
  $('dirty-message').textContent=dirty.size?'Unsaved changes · Apply to save':'Settings are in sync';
}
function rangeLabels(){for(const key of ['presence','tone','emptyRoomPersonChance'])if(field(key))$(key+'-value').textContent=Number(field(key).value).toFixed(2);}
function renderProgress(){
  const scene=generatingScene(latest?.capture,captureProgress?.active);
  for(const card of document.querySelectorAll('.scene[data-scene]')){
    card.classList.toggle('is-generating',card.dataset.scene===scene);
    card.setAttribute('aria-busy',card.dataset.scene===scene?'true':'false');
  }
}
document.addEventListener('input',event=>{
  const el=event.target.closest('[data-setting]');if(!el)return;
  if(!dirty.size)baseRevision=latest?.settingsRevision;
  dirty.add(el.dataset.setting);rangeLabels();dirtyLabel();renderCone();
});
document.addEventListener('change',event=>{
  const el=event.target.closest('[data-setting]');
  if(el){if(!dirty.size)baseRevision=latest?.settingsRevision;dirty.add(el.dataset.setting);dirtyLabel();}
});
function mmss(seconds){const n=Math.max(0,Math.floor(seconds||0));return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;}
function connection(connected,message){
  online=connected;document.body.classList.toggle('offline',!online);
  $('connection').textContent=message;$('connection-dot').className='dot '+(online?'online':'offline');
  dirtyLabel();updateButtons();
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
    el.disabled=blocked||(scenarioOwns&&(key==='mode'||key==='scenarioPreview'||key.startsWith('scenes.')));
  }
  $('pause-scenario').disabled=blocked||!['running','paused'].includes(latest?.scenario?.state);
  $('stop-scenario').disabled=blocked||!scenarioOwns;
  $('select-input').disabled=blocked||(!latest?.replay?.active&&latest?.runtime!=='native');
  renderPersonReferences();
  dirtyLabel();
}
// Scenario CSV format check: rendered from state, so the banner stays until a load without errors clears it.
let formatShown='';
function renderScenarioFormat(scenario){
  const box=$('scenario-format'),errors=scenario.formatErrors||[],warnings=scenario.formatWarnings||[],rows=errors.length?errors:warnings;
  box.hidden=!rows.length;
  if(!rows.length){formatShown='';return;}
  const key=[scenario.formatCheckedAt,scenario.formatFile,errors.length,warnings.length].join('|');
  if(key===formatShown)return;
  formatShown=key;box.open=true;
  const title=$('scenario-format-title'),panel=$('scenario-format-box');
  title.textContent=errors.length?`FORMAT ERROR · ${errors.length}`:`WARNING · ${warnings.length}`;
  Object.assign(title.style,{background:errors.length?'#c62828':'#f2c037',color:errors.length?'#fff':'#111',fontWeight:'700',padding:'3px 8px',borderRadius:'3px',fontSize:'11px',letterSpacing:'.04em',whiteSpace:'nowrap'});
  Object.assign(panel.style,{position:'fixed',bottom:'var(--bottom)',left:'15px',zIndex:'11',background:'#1c1c1c',border:'2px solid '+(errors.length?'#c62828':'#f2c037'),padding:'10px 12px',width:'min(560px,92vw)',maxHeight:'45vh',overflow:'auto',boxShadow:'0 -3px 10px #0008',fontSize:'12px'});
  const checked=scenario.formatCheckedAt?new Date(scenario.formatCheckedAt).toLocaleTimeString():'';
  $('scenario-format-file').textContent=`${scenario.formatFile||'CSV'} · ${checked}`+(errors.length?` · Not loaded${scenario.scenarioId?' (current plan: '+scenario.scenarioId+')':''}`+(warnings.length?` · +${warnings.length} warning${warnings.length===1?'':'s'}`:''):' · Loaded');
  const list=$('scenario-format-list');list.replaceChildren();Object.assign(list.style,{margin:'6px 0 0 16px',padding:'0',listStyle:'disc'});
  for(const issue of rows.slice(0,20)){const item=document.createElement('li');item.textContent=`${issue.row?'row '+issue.row:'file'}${issue.column?' ['+issue.column+']':''}: ${issue.message}`;list.append(item);}
  if(rows.length>20){const more=document.createElement('li');more.textContent=`…他 ${rows.length-20} 件`;list.append(more);}
}
function render(state){
  latest=state;
  connection(true,state.runtime==='native'?'Server connected':'TD connected');
  if($('notice').dataset.kind==='connection')$('notice').hidden=true;
  $('project-name').textContent=state.project;
  const isGenerating=['generating','requested'].includes(state.capture.phase);
  $('generation-state').textContent=isGenerating?'Generating':state.scenario.ownsLayout?'Scenario · '+state.scenario.state:state.settings.mode==='manual'?'Manual · Ready':state.submissionHold?'Auto paused':'Auto enabled';
  $('generation-state').classList.toggle('busy',isGenerating);
  $('generation-detail').textContent=isGenerating?`${mmss(state.capture.busyFor)} elapsed · ${state.settings.imageCount} images`:
    state.scenario.ownsLayout?'Stop the scenario to return to manual controls.':state.settings.mode==='manual'?'Generate runs once.':state.submissionHold?'Auto paused · Generate runs once.':state.settings.mode==='timer'?`Next generation in ${mmss(state.capture.nextTimerTickIn)}`:
    'Generates again after each result.';
  for(const el of document.querySelectorAll('[data-setting]')){
    const path=el.dataset.setting;if(dirty.has(path))continue;
    const x=get(state.settings,path);
    if(x===undefined)continue;
    if(el.dataset.json)el.value=JSON.stringify(x);else if(el.type==='checkbox')el.checked=!!x;else el.value=x;
  }
  if(!dirty.size)baseRevision=state.settingsRevision;
  renderPersonReferences();
  rangeLabels();
  const replay=state.replay;
  if(state.runtime==='native'&&!$('input-set').querySelector('option[value="camera"]'))$('input-set').add(new Option('Live camera','camera'));
  if(state.runtime==='native'&&!$('input-set').querySelector('option[value="remote-device"]'))$('input-set').add(new Option('Remote device (phone)','remote-device'));
  const remote=state.remoteCamera?.selected?state.remoteCamera:null;
  $('input-kind').textContent=remote?(remote.state==='fresh'?'REMOTE':'REMOTE · STALE'):replay.active?'TEST REPLAY':'CAMERA';
  const queued=state.pendingInput?.setId||'';
  if(inputSelection===null&&document.activeElement!==$('input-set'))$('input-set').value=queued||(remote?'remote-device':replay.pendingSet||(replay.cycle?'cycle':(replay.setId||(state.runtime==='native'&&!replay.active?'camera':'TSC-001'))));
  $('select-input').textContent=queued?'Queued…':'Switch';
  $('select-input').title=queued?`Queued: ${queued} · applied after the current generation (a new Switch replaces it)`:'Switch the input';
  $('input-detail').textContent=queued?`Queued… ${queued} · applied after the current generation`:remote?(remote.state==='none'?'Remote device · remote camera stale (no frame yet) · live input, writes venue history':`Remote device · last frame ${remote.ageSec} s ago${remote.state==='stale'?' · remote camera stale':''} · live input, writes venue history`):replay.pendingSet?`Switch to ${replay.pendingSet} after the current generation`:replay.active?`${replay.currentFrameId||replay.setId} · loop ${replay.loop||1}`:'Live camera';
  const library=state.scenarioLibrary.map(item=>item.file).join('|');
  if($('scenario-file').dataset.library!==library){
    const previous=$('scenario-file').value;$('scenario-file').replaceChildren();
    for(const item of state.scenarioLibrary)$('scenario-file').add(new Option(item.name,item.file));
    $('scenario-file').dataset.library=library;
    $('scenario-file').value=state.scenarioLibrary.some(x=>x.file===previous)?previous:state.scenario.file;
  }
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
$('input-set').addEventListener('change',()=>{inputSelection=$('input-set').value;});
$('select-input').onclick=async()=>{
  const selected=inputSelection||$('input-set').value;
  await perform('input.select',{setId:selected});
  if(latest?.pendingInput?.setId===selected||latest?.replay?.setId===selected||latest?.replay?.pendingSet===selected||(selected==='cycle'&&latest?.replay?.cycle)||(selected==='camera'&&latest?.runtime==='native'&&!latest?.replay?.active&&!latest?.remoteCamera?.selected)||(selected==='remote-device'&&latest?.remoteCamera?.selected)){
    inputSelection=null;render(latest);
  }
};
$('apply-layout').onclick=()=>perform('display.layout',{sources:[1,2,3,4].map(i=>$(`route-${i}`).value)});
$('upload-open').onclick=()=>$('scenario-upload').click();
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
    const loaded=await command('scenario.load',{file:result.file});render(loaded.state);$('scenario-file').value=result.file;notice('Scenario imported and loaded.');
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
          $('scene-waiting-'+scene).hidden=true;$('scene-caption-'+scene).textContent=content.caption;
          const distance=content.distanceSecSigned,known=typeof distance==='number'&&Number.isFinite(distance);
          document.querySelector(`[data-scene="${scene}"] h3`).textContent=scene.toUpperCase()+(known?' '+(distance<0?'PAST ':'FUTURE +')+distance+' sec':'');
          $('scene-time-'+scene).textContent='GENERATED';
        }
      }
    }
    renderCone();
  }catch{/* Generation settings remain usable when the image server is unavailable. */}
  finally{imagePolling=false;}
}
async function refreshConeResults(){
  if(conePolling)return;conePolling=true;
  try{
    coneCompleted=completedConeResult(await json('/api/events?limit=20'),coneCompleted);
    renderCone();
  }catch{/* Keep the completed cone; archive reads must not block Each-image updates. */}
  finally{conePolling=false;}
}
async function refreshInputPreview(){
  if(previewPolling||document.hidden)return;previewPolling=true;
  try{
    const frame=await json(API+'/input-preview');
    if(typeof frame.dataUrl!=='string'||frame.dataUrl.length>12*1024*1024||!/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(frame.dataUrl))throw Error('Invalid input preview');
    const image=$('input-preview');if(image.getAttribute('src')!==frame.dataUrl)image.src=frame.dataUrl;
    image.hidden=false;image.alt=frame.kind==='replay'?'Current replay input':'Current camera input';
    $('input-preview-label').textContent=frame.kind==='replay'?'Current replay':'Live';
    $('input-preview-label').title=frame.frameId||'Current camera input';
  }catch{$('input-preview').hidden=true;$('input-preview-label').textContent='Preview unavailable';}
  finally{previewPolling=false;}
}
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
function renderCone(){
  const svg=$('cone');if(!svg||!latest)return;
  coneScenes=coneCompleted?.scenes||null;
  // A first visit may arrive mid-batch or after a 1/2-image capture. Show available
  // matching images without treating an unobserved, possibly cancelled batch as complete.
  const visibleCone=coneScenes||availableConeScenes(displayedScenes);
  const source=visibleCone?.now?.content;
  const offsets={};
  for(const scene of scenes){
    const content=visibleCone?.[scene]?.content;
    offsets[scene]=coneMode==='settings'?Number(field('scenes.'+scene+'.distanceSec').value):source&&content?.captureId===source.captureId?content.distanceSecSigned:null;
  }
  const geometry=coneGeometry(offsets);
  $('cone-result').setAttribute('aria-pressed',coneMode==='result');
  $('cone-settings').setAttribute('aria-pressed',coneMode==='settings');
  $('cone-status').textContent=coneMode==='settings'?'Next capture · configured offsets':(['requested','generating'].includes(latest.capture.phase)?'Generating · showing available results':coneScenes?'Displayed results · relative to source':'Available results · completion unconfirmed');
  const renderKey=JSON.stringify([coneMode,source?.captureId,source?.imageUrl,offsets,
    scenes.map(scene=>[visibleCone?.[scene]?.content?.captureId,visibleCone?.[scene]?.content?.imageUrl])]);
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
    const matched=source&&row&&source.captureId===row.captureId;
    const x=point.x,y={a:28,b:82,c:136}[point.scene],color=colors[point.scene];
    svg.append(svgNode('line',{x1:500,y1:82,x2:x,y2:y,stroke:color,'stroke-width':2,'stroke-dasharray':coneMode==='settings'?'4 4':'none',opacity:'.8'}));
    svg.append(svgNode('line',{x1:point.axisX,y1:184,x2:x,y2:y+26,stroke:color,'stroke-width':'.7','stroke-dasharray':'2 4',opacity:'.28'}));
    svg.append(svgNode('rect',{x:x-40,y:y-22,width:80,height:44,rx:2,fill:'#0d1113',stroke:color,'stroke-width':1.3}));
    if(coneMode==='result'&&matched){
      try{svg.append(svgNode('image',{href:localImagePath(row.imageUrl),x:x-39,y:y-21,width:78,height:42,preserveAspectRatio:'xMidYMid meet'}));}catch{}
    }else svg.append(svgNode('text',{x,y:y+5,fill:color,'text-anchor':'middle','font-size':17},point.scene.toUpperCase()));
    svg.append(svgNode('text',{x,y:y+35,fill:color,'text-anchor':'middle','font-size':11},point.scene.toUpperCase()+'  '+(coneMode==='result'&&row&&!matched?'previous capture':point.label)));
  }
  svg.append(svgNode('rect',{x:458,y:57,width:84,height:50,rx:2,fill:'#101518',stroke:'#b9c4c7'}));
  if(coneMode==='result'&&source){try{svg.append(svgNode('image',{href:localImagePath(source.imageUrl),x:459,y:58,width:82,height:48,preserveAspectRatio:'xMidYMid meet'}));}catch{}}
  else svg.append(svgNode('text',{x:500,y:88,fill:'#b9c4c7','text-anchor':'middle','font-size':13},'INPUT'));
  svg.append(svgNode('text',{x:500,y:121,fill:'#d7dfe0','text-anchor':'middle','font-size':11},coneMode==='settings'?'SOURCE TIME':'SOURCE'));
}
