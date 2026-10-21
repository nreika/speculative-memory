import {validateSnapshot, worldTime, temporalLabel, captionLines, shouldAcceptSnapshot, validateClock, displayStatusMessage} from './timeline.mjs';
import {faceBlurKey,faceBlurImage,faceBlurNotice} from './face-blur.mjs';

const el = Object.fromEntries(['visual','frames','frame','frame-next','waiting','connection','caption','first-line','second-line','badge','fullscreen'].map(id => [id, document.getElementById(id)]));
const slot = location.pathname.match(/^\/control\/output\/([1-4])\/?$/)?.[1];
const screen = location.pathname.match(/^\/control\/screen\/(screen-[1-9][0-9]{0,2})\/?$/)?.[1];
const id = slot ? `control-output-${slot}` : screen;
let latest = null, visible = null, clock = null, clockAt = 0, loadToken = 0;
let visibleRenderKey=null;
let lastContact = 0, polling = null, busy = false, idleTimer = null;
const FADE_MS=800, BLACK_HOLD_MS=120;
function timingMs(key,fallback){const n=latest?.view?.[key];return Number.isInteger(n)&&n>=0&&n<=10000?n:fallback;}
let activeLayer=el.frame, outgoingLayer=null, crossTimer=null, originalTimer=null, effectMode='none', pendingImage=null;
const fadedBatches=new Set();
// ?debug=1 only: lightweight record of image switches and fades (window.__screenEvents) for scripts/screen-fade-check.mjs.
const debugEvents=/[?&]debug=1(?:&|$)/.test(String(location.search||''))?(globalThis.__screenEvents=[]):null;
function dbg(type,extra={}){if(!debugEvents)return;debugEvents.push({t:Date.now(),type,screen:id,...extra});if(debugEvents.length>400)debugEvents.shift();}
function selectedFade(view={}) {
  if(view.fade===false)return 'none';
  return ['original','crossfade','none'].includes(view.fadeMode)?view.fadeMode:'original';
}
function finishCrossfade() {
  clearTimeout(crossTimer);crossTimer=null;
  if(outgoingLayer&&outgoingLayer!==activeLayer){outgoingLayer.hidden=true;outgoingLayer.style.opacity='0';outgoingLayer.style.transition='none';}
  outgoingLayer=null;activeLayer.style.transition='none';activeLayer.style.opacity='1';
}
let pendingSwap=null;
function flushSwap(){const f=pendingSwap;pendingSwap=null;if(f)f();}
function cancelOriginal() {clearTimeout(originalTimer);originalTimer=null;el.frames.style.transition='none';el.frames.style.opacity='1';flushSwap();}
function contentIdentity(content){return JSON.stringify([content.id,content.imageUrl,content.scope||'']);}
function imageIdentity(content,view){return JSON.stringify([contentIdentity(content),faceBlurKey(content,view)]);}
// 2026-10-21: black fade with the image swap hidden inside it: fade the OLD image out, swap while black, hold, fade the new one in.
// `swap` (new image commit) runs at black; every early exit runs it immediately so the new image is never lost.
function originalFade(initial=false,imageChanged=false,swap=null,content=visible) {
  if(swap)flushSwap();else if(pendingSwap)return;
  const fadeMs=timingMs('fadeDurationMs',FADE_MS),holdMs=timingMs('blackHoldMs',BLACK_HOLD_MS);
  const done=()=>{if(swap)swap();};
  if(effectMode!=='original'||!content){done();return;}
  const batch=latest?.fadeBatch;
  const valid=batch&&typeof batch.captureId==='string'&&batch.captureId&&Number.isSafeInteger(batch.completedAtMs)&&batch.completedAtMs>=0&&batch.captureId===content.captureId;
  const imageTransition=imageChanged&&latest?.view?.fadeOnImageChange===true;
  const key=valid?batch.captureId:null;
  if(latest?.view?.visible===false){if(key){fadedBatches.add(key);if(fadedBatches.size>64)fadedBatches.delete(fadedBatches.values().next().value);}done();return;}
  if(!initial&&!imageTransition&&(!key||fadedBatches.has(key))){done();return;}
  if(key){fadedBatches.add(key);if(fadedBatches.size>64)fadedBatches.delete(fadedBatches.values().next().value);}
  dbg('fade-start',{captureId:content.captureId||null,sceneKey:content.sceneKey||null,initial,imageChanged});
  const currentOpacity=typeof getComputedStyle==='function'?getComputedStyle(el.frames).opacity:el.frames.style.opacity;
  const alpha=Math.max(0,Math.min(1,Number.parseFloat(currentOpacity)||0));
  clearTimeout(originalTimer);el.frames.style.transition='none';
  const fadeIn=()=>{el.frames.style.transition=`opacity ${fadeMs}ms linear`;el.frames.style.opacity='1';originalTimer=setTimeout(()=>{originalTimer=null;el.frames.style.transition='none';dbg('fade-end',{captureId:content.captureId||null,sceneKey:content.sceneKey||null});},fadeMs);};
  if(initial||alpha<=.001){
    done();
    el.frames.style.opacity='0';void el.frames.offsetWidth;
    fadeIn();
  }else{
    pendingSwap=swap;
    el.frames.style.opacity=currentOpacity||'1';void el.frames.offsetWidth;
    el.frames.style.transition=`opacity ${alpha*fadeMs}ms linear`;el.frames.style.opacity='0';
    originalTimer=setTimeout(()=>{
      // Black now: put the new image in place, hold black, then raise once.
      flushSwap();
      originalTimer=setTimeout(fadeIn,holdMs);
    },alpha*fadeMs);
  }
}
const api = slot ? `/api/td-control/outputs/${slot}` : screen ? `/api/browser-outputs/${screen}` : null;
function applyView() {
  const view=latest?.view||{};
  const mode=selectedFade(view);
  if(mode!==effectMode){finishCrossfade();cancelOriginal();effectMode=mode;}
  // HIDE is immediate, never exposes a newly decoded image through a fading parent.
  el.visual.style.opacity=view.visible===false?'0':'1';
  if(view.visible===false){finishCrossfade();cancelOriginal();}
  el.badge.hidden=view.labels===false;
  el['first-line'].hidden=view.subtitles===false||!el['first-line'].textContent;
  el['second-line'].hidden=view.subtitles===false;
  el.caption.hidden=!visible||view.visible===false||(view.labels===false&&view.subtitles===false);
}

// One notice area, one message at a time (English). Priority: error > face blur > image loading (only after 1 s) > generating.
let errorNotice='',loadingSince=0,reportedBlur='';
function renderNotice() {
  const loading=loadingSince&&performance.now()-loadingSince>=1000?'Loading image…':'';
  const blur=faceBlurNotice(visible,latest?.view);
  if(/unavailable/.test(blur)&&visible&&reportedBlur!==visible.id){reportedBlur=visible.id;reportDisplayError({kind:'face-blur-unavailable',detail:String(visible.id).slice(0,80)});}
  // 'no face detected' is only information: it yields to loading / generating notices; 'unavailable' is a problem and outranks them.
  const info = /no face/i.test(blur) ? blur : '';
  // 'no face detected' is neither an error nor news: no badge for it on the screens (the server log has it).
  const rendered = errorNotice||(info?'':blur)||loading||displayStatusMessage(latest?.displayStatus, visible);
  if(el.connection.textContent!==rendered)el.connection.textContent = rendered;
  el.connection.hidden = !rendered;
}
// message(text): text is an error ('' clears it); loading is tracked separately by setLoading().
function message(text) { errorNotice=text||''; renderNotice(); }
function setLoading(on) { loadingSince=on?(loadingSince||performance.now()):0; renderNotice(); }
function describeFetchError(error) {
  if(error?.name==='TimeoutError'||error?.name==='AbortError')return {text:'No response, retrying…',kind:'timeout'};
  if(error instanceof TypeError)return {text:'Connection lost, reconnecting…',kind:'connection'};
  return {text:'Server error, retrying…',kind:'http'};
}
function tick() {
  if (visible && clock) {
    const label = clock.known===false||visible.provenance==='uploaded'?temporalLabel(visible,0,false):visible.scope && visible.scope !== clock.scope ? {kind:'unknown',text:'Showing the previous scope image'} : temporalLabel(visible, worldTime(clock, clockAt, performance.now()));
    document.body.dataset.kind = label.kind;
    if (latest?.standInFor) { const L = String(latest.standInFor).toUpperCase(); label.text = `${L} · NOW (waiting for ${L})`; }
    document.body.dataset.scene = visible.provenance==='actual'?'now':(/^gen_([abc])$/.exec(visible.sceneKey||'')||[])[1]||'';
    el.badge.textContent = label.text;
  }
  if (lastContact && performance.now() - lastContact > 20000)
    message('Connection lost. Keeping the last image.');
  renderNotice();
}
function installCaption(content) {
  const [first, second] = captionLines(content.caption);
  el['first-line'].textContent = second ? first : '';
  el['first-line'].hidden = !second;
  el['second-line'].textContent = second || first;
  el.caption.hidden = false;
  applyView();
  tick();
}
function accept(data) {
  const value = validateSnapshot(data);
  value.view=data.view;
  if (value.screen.id !== id) throw new Error('Wrong screen response');
  if (!shouldAcceptSnapshot(latest, value, id)) return;
  lastContact = performance.now();
  // A pending snapshot cannot change the clock attached to the visible image.
  // Same-scope clock updates are safe; a different scope commits with its image.
  if (!visible || (clock?.scope === value.clock.scope && value.clock.serverNowMs >= clock.serverNowMs)) { clock = value.clock; clockAt = lastContact; }
  document.title = `${value.screen.label || id} — Speculative Memory`;
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.screen.accent || ''))
    document.documentElement.style.setProperty('--accent', value.screen.accent);
  latest = value;
  applyView();
  if (value.displayStatus?.state === 'failed' && visible) { loadToken++;pendingImage=null;tick();message('');return; }
  if (!value.content) {
    loadToken++;pendingImage=null;finishCrossfade();cancelOriginal();visible=null;
    el.frame.hidden = true;el['frame-next'].hidden=true; el.caption.hidden = true; el.waiting.hidden = false;
    el.waiting.textContent = value.message || 'Waiting for an image';
    message(''); return;
  }
  if (visible && visibleRenderKey===imageIdentity(value.content,value.view)) {
    loadToken++;pendingImage=null;
    visible = value.content;
    if (clock?.scope !== value.clock.scope || value.clock.serverNowMs >= clock.serverNowMs) { clock = value.clock; clockAt = lastContact; }
    installCaption(visible);originalFade();message('');return;
  }
  const identity=imageIdentity(value.content,value.view);
  // Same pending image polls must not invalidate a slow load/decode.
  if(pendingImage?.identity===identity){pendingImage.value=value;pendingImage.receivedAt=lastContact;originalFade();setLoading(true);return;}
  const token=++loadToken,pending={identity,value,receivedAt:lastContact,startedAt:performance.now()};pendingImage=pending;
  const image=new Image();
  setLoading(true);
  const failed=()=>{if(token!==loadToken)return;pendingImage=null;setLoading(false);reportDisplayError({kind:'image-error',detail:String(value.content.imageUrl).slice(-80),ms:Math.round(performance.now()-pending.startedAt)});message(visible?'Image unavailable. Keeping the previous image.':'Image unavailable.');};
  image.onload=async()=>{
    try{if(image.decode)await image.decode();}catch{failed();return;}
    if(token!==loadToken||pendingImage!==pending)return;
    finishCrossfade();
    flushSwap();
    const incoming=activeLayer===el.frame?el['frame-next']:el.frame;
    incoming.style.transition='none';incoming.style.opacity='0';incoming.style.zIndex='2';
    try{incoming.src=faceBlurImage(image,pending.value.content,pending.value.view);}catch{failed();return;}
    incoming.hidden=false;
    try{if(incoming.decode)await incoming.decode();}catch{if(token===loadToken){incoming.hidden=true;failed();}return;}
    if(token!==loadToken||pendingImage!==pending)return;
    const previous=activeLayer,hadVisible=!!visible,snapshot=pending.value,contentChanged=!visible||contentIdentity(visible)!==contentIdentity(snapshot.content);
    const info={captureId:snapshot.content.captureId||null,sceneKey:snapshot.content.sceneKey||null,contentChanged,hadVisible,effectMode};
    dbg('arrived',info);
    const loadedMs=Math.round(performance.now()-pending.startedAt);if(loadedMs>=1000)reportDisplayError({kind:'slow-image',detail:String(snapshot.content.imageUrl).slice(-80),ms:loadedMs});
    const commit=()=>{setLoading(false);activeLayer=incoming;pendingImage=null;visible=snapshot.content;visibleRenderKey=identity;clock=snapshot.clock;clockAt=pending.receivedAt;el.waiting.hidden=true;installCaption(visible);message('');};
    if(hadVisible&&effectMode==='crossfade'&&latest?.view?.visible!==false){
      commit();dbg('swap',info);
      outgoingLayer=previous;previous.style.zIndex='1';previous.style.opacity='1';previous.hidden=false;
      const fadeMs=timingMs('fadeDurationMs',FADE_MS);
      void incoming.offsetWidth;incoming.style.transition=`opacity ${fadeMs}ms linear`;incoming.style.opacity='1';
      crossTimer=setTimeout(finishCrossfade,fadeMs);
    }else{
      const swap=()=>{commit();previous.hidden=true;previous.style.opacity='0';incoming.style.opacity='1';dbg('swap',info);};
      originalFade(!hadVisible,contentChanged,swap,snapshot.content);
    }
  };
  image.onerror=failed;image.src=value.content.imageUrl;
}
// Browser-side problems are sent to the server (logs/display-errors.jsonl): consecutive identical ones are folded into a count.
const errorQueue=[];let errorFlushTimer=null;
function reportDisplayError(entry) {
  const last=errorQueue[errorQueue.length-1];
  if(last&&last.kind===entry.kind&&last.detail===entry.detail){last.count=(last.count||1)+1;last.ms=Math.max(last.ms||0,entry.ms||0);}
  else errorQueue.push({...entry,count:1,at:Date.now()});
  if(errorQueue.length>20)errorQueue.shift();
  if(!errorFlushTimer)errorFlushTimer=setTimeout(flushDisplayErrors,3000);
}
function flushDisplayErrors() {
  errorFlushTimer=null;if(!errorQueue.length||!id)return;
  const body=JSON.stringify({screen:id,errors:errorQueue.splice(0)});
  try{fetch('/api/display-errors',{method:'POST',headers:{'Content-Type':'application/json','X-Control-Request':'1'},body,keepalive:true}).catch(()=>{});}catch{}
}
window.addEventListener('error',event=>reportDisplayError({kind:'js-error',detail:String(event.message||event.error).slice(0,200)}));
window.addEventListener('unhandledrejection',event=>reportDisplayError({kind:'js-error',detail:String(event.reason?.message||event.reason).slice(0,200)}));
let fetchStarted=0;
async function fetchSnapshot() {
  if (busy || !api) return;
  busy = true;fetchStarted=performance.now();
  try {
    const response = await fetch(api, {cache:'no-store', signal:AbortSignal.timeout(8000)});
    if (!response.ok) throw new Error(`Display request failed (${response.status})`);
    const json=await response.json();
    const took=performance.now()-fetchStarted;if(took>1000)reportDisplayError({kind:'slow-response',detail:'snapshot',ms:Math.round(took)});
    errorNotice='';
    accept(json);
  } catch (error) {
    const d=describeFetchError(error);message(d.text);reportDisplayError({kind:d.kind,detail:String(error?.message||error).slice(0,200),ms:Math.round(performance.now()-fetchStarted)});
  } finally { busy = false; }
}
function fallback() {
  if (!polling) polling = setInterval(fetchSnapshot, 1500);
}
if (!id) {
  el.waiting.textContent = 'Open an output URL: /control/output/1';
} else {
  fetchSnapshot();
  fallback();
  setInterval(tick, 250);
}
async function fullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (error) { message('Fullscreen unavailable'); }
}
el.fullscreen.onclick = fullscreen;
// Double-click / double-tap anywhere toggles every overlay (label, subtitles, notices, buttons) on this device only.
const INFO_KEY='sm-info-hidden';
function setInfoHidden(hidden){document.body.classList.toggle('info-hidden',hidden);try{localStorage.setItem(INFO_KEY,hidden?'1':'0');}catch{}}
try{if(localStorage.getItem(INFO_KEY)==='1')document.body.classList.add('info-hidden');}catch{}
document.addEventListener('dblclick',event=>{if(event.target?.closest?.('button'))return;setInfoHidden(!document.body.classList.contains('info-hidden'));});
window.addEventListener('keydown', event => { if (event.key.toLowerCase() === 'f') fullscreen(); });
window.addEventListener('pointermove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer); idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
});
idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
