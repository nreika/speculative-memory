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
function selectedFade(view={}) {
  if(view.fade===false)return 'none';
  return ['original','crossfade','none'].includes(view.fadeMode)?view.fadeMode:'original';
}
function finishCrossfade() {
  clearTimeout(crossTimer);crossTimer=null;
  if(outgoingLayer&&outgoingLayer!==activeLayer){outgoingLayer.hidden=true;outgoingLayer.style.opacity='0';outgoingLayer.style.transition='none';}
  outgoingLayer=null;activeLayer.style.transition='none';activeLayer.style.opacity='1';
}
function cancelOriginal() {clearTimeout(originalTimer);originalTimer=null;el.frames.style.transition='none';el.frames.style.opacity='1';}
function contentIdentity(content){return JSON.stringify([content.id,content.imageUrl,content.scope||'']);}
function imageIdentity(content,view){return JSON.stringify([contentIdentity(content),faceBlurKey(content,view)]);}
function originalFade(initial=false,imageChanged=false) {
  const fadeMs=timingMs('fadeDurationMs',FADE_MS),holdMs=timingMs('blackHoldMs',BLACK_HOLD_MS);
  if(effectMode!=='original'||!visible)return;
  const batch=latest?.fadeBatch;
  const valid=batch&&typeof batch.captureId==='string'&&batch.captureId&&Number.isSafeInteger(batch.completedAtMs)&&batch.completedAtMs>=0&&batch.captureId===visible.captureId;
  const imageTransition=imageChanged&&latest?.view?.fadeOnImageChange===true;
  const key=valid?batch.captureId:null;
  if(latest?.view?.visible===false){if(key){fadedBatches.add(key);if(fadedBatches.size>64)fadedBatches.delete(fadedBatches.values().next().value);}return;}
  if(!initial&&!imageTransition&&(!key||fadedBatches.has(key)))return;
  if(key){fadedBatches.add(key);if(fadedBatches.size>64)fadedBatches.delete(fadedBatches.values().next().value);}
  const currentOpacity=typeof getComputedStyle==='function'?getComputedStyle(el.frames).opacity:el.frames.style.opacity;
  const alpha=Math.max(0,Math.min(1,Number.parseFloat(currentOpacity)||0));
  clearTimeout(originalTimer);el.frames.style.transition='none';
  if(initial||alpha<=.001){
    el.frames.style.opacity='0';void el.frames.offsetWidth;
    el.frames.style.transition=`opacity ${fadeMs}ms linear`;el.frames.style.opacity='1';
    originalTimer=setTimeout(()=>{originalTimer=null;el.frames.style.transition='none';},fadeMs);
  }else{
    el.frames.style.opacity=currentOpacity||'1';void el.frames.offsetWidth;
    el.frames.style.transition=`opacity ${alpha*fadeMs}ms linear`;el.frames.style.opacity='0';
    originalTimer=setTimeout(()=>{
      // The completed batch is already decoded/displayed: hold black, then raise once.
      originalTimer=setTimeout(()=>{el.frames.style.transition=`opacity ${fadeMs}ms linear`;el.frames.style.opacity='1';originalTimer=setTimeout(()=>{originalTimer=null;el.frames.style.transition='none';},fadeMs);},holdMs);
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

function message(text) {
  const rendered = [text, displayStatusMessage(latest?.displayStatus, visible),faceBlurNotice(visible,latest?.view)].filter(Boolean).join('\n');
  el.connection.textContent = rendered;
  el.connection.hidden = !rendered;
}
function tick() {
  if (visible && clock) {
    const label = clock.known===false||visible.provenance==='uploaded'?temporalLabel(visible,0,false):visible.scope && visible.scope !== clock.scope ? {kind:'unknown',text:'前回scopeの画像を表示中'} : temporalLabel(visible, worldTime(clock, clockAt, performance.now()));
    document.body.dataset.kind = label.kind;
    el.badge.textContent = label.text;
  }
  if (lastContact && performance.now() - lastContact > 20000)
    message('Connection lost · last image retained');
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
  if(pendingImage?.identity===identity){pendingImage.value=value;pendingImage.receivedAt=lastContact;originalFade();message(visible?'Loading · previous image retained':'Loading image…');return;}
  const token=++loadToken,pending={identity,value,receivedAt:lastContact};pendingImage=pending;
  const image=new Image();
  message(visible?'Loading · previous image retained':'Loading image…');
  const failed=()=>{if(token!==loadToken)return;pendingImage=null;message('Image unavailable · '+(visible?'previous image retained':'waiting'));};
  image.onload=async()=>{
    try{if(image.decode)await image.decode();}catch{failed();return;}
    if(token!==loadToken||pendingImage!==pending)return;
    finishCrossfade();
    const incoming=activeLayer===el.frame?el['frame-next']:el.frame;
    incoming.style.transition='none';incoming.style.opacity='0';incoming.style.zIndex='2';
    try{incoming.src=faceBlurImage(image,pending.value.content,pending.value.view);}catch{failed();return;}
    incoming.hidden=false;
    try{if(incoming.decode)await incoming.decode();}catch{if(token===loadToken){incoming.hidden=true;failed();}return;}
    if(token!==loadToken||pendingImage!==pending)return;
    const previous=activeLayer,hadVisible=!!visible,snapshot=pending.value,contentChanged=!visible||contentIdentity(visible)!==contentIdentity(snapshot.content);
    activeLayer=incoming;pendingImage=null;visible=snapshot.content;visibleRenderKey=identity;clock=snapshot.clock;clockAt=pending.receivedAt;
    el.waiting.hidden=true;installCaption(visible);message('');
    if(hadVisible&&effectMode==='crossfade'&&latest?.view?.visible!==false){
      outgoingLayer=previous;previous.style.zIndex='1';previous.style.opacity='1';previous.hidden=false;
      const fadeMs=timingMs('fadeDurationMs',FADE_MS);
      void incoming.offsetWidth;incoming.style.transition=`opacity ${fadeMs}ms linear`;incoming.style.opacity='1';
      crossTimer=setTimeout(finishCrossfade,fadeMs);
    }else{previous.hidden=true;previous.style.opacity='0';incoming.style.opacity='1';originalFade(!hadVisible,contentChanged);}
  };
  image.onerror=failed;image.src=value.content.imageUrl;
}
async function fetchSnapshot() {
  if (busy || !api) return;
  busy = true;
  try {
    const response = await fetch(api, {cache:'no-store', signal:AbortSignal.timeout(8000)});
    if (!response.ok) throw new Error(`Display request failed (${response.status})`);
    accept(await response.json());
  } catch (error) {
    message(error.message);
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
  } catch (error) { message(error.message); }
}
el.fullscreen.onclick = fullscreen;
el.visual.ondblclick = fullscreen;
window.addEventListener('keydown', event => { if (event.key.toLowerCase() === 'f') fullscreen(); });
window.addEventListener('pointermove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer); idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
});
idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
