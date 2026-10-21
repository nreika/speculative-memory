import {validateSnapshot, worldTime, temporalLabel, captionLines, shouldAcceptSnapshot, displayStatusMessage} from './timeline.mjs';
import {faceBlurKey,faceBlurImage,faceBlurNotice} from './face-blur.mjs';

const el = Object.fromEntries(['frame','frame-next','display-stage','fade-stage','waiting','connection','caption','first-line','second-line','badge','fullscreen'].map(id => [id, document.getElementById(id)]));
const id = location.pathname.match(/^\/display\/([A-Za-z0-9_-]{1,64})\/?$/)?.[1];
let latest = null, visible = null, clock = null, clockAt = 0, loadToken = 0;
let visibleRenderKey=null;
let lastContact = 0, polling = null, busy = false, idleTimer = null;
let activeRequest = null, pageActive = true, refreshAfterRequest = false, pendingImage = null;
let cross = null, fadeTimer = null, fadeVersion = 0, lastFadeId = null;
let shown = true, mode = 'original';
const FADE_MS = 800, BLACK_HOLD_MS = 120;
function timingMs(key,fallback){const n=latest?.view?.[key];return Number.isInteger(n)&&n>=0&&n<=10000?n:fallback;}
const api = id ? `/api/displays/${encodeURIComponent(id)}` : null;
const same = (a,b) => !!a && !!b && a.id === b.id && a.imageUrl === b.imageUrl;
function fadeMode(view) { return view?.fade === false ? 'none' : ['original','crossfade','none'].includes(view?.fadeMode) ? view.fadeMode : 'original'; }
// One notice at a time (English): error > face blur > image loading (after 1 s) > generating.
let errorNotice='',loadingSince=0;
function renderNotice() {
  const loading=loadingSince&&performance.now()-loadingSince>=1000?'Loading image…':'';
  const blur = faceBlurNotice(visible,latest?.view), info = /no face/i.test(blur) ? blur : '';
  const rendered = errorNotice||(info?'':blur)||loading||displayStatusMessage(latest?.displayStatus, visible)||info;
  el.connection.textContent = rendered; el.connection.hidden = !rendered;
}
function message(text) { errorNotice=text||''; renderNotice(); }
function setLoading(on) { loadingSince=on?(loadingSince||performance.now()):0; renderNotice(); }
function describeFetchError(error) {
  if(error?.name==='TimeoutError'||error?.name==='AbortError')return 'No response, retrying…';
  if(error instanceof TypeError)return 'Connection lost, reconnecting…';
  return 'Server error, retrying…';
}
function tick() {
  if (visible && clock) {
    const label = visible.scope && visible.scope !== clock.scope ? {kind:'unknown',text:'Showing the previous scope image'} : temporalLabel(visible, worldTime(clock, clockAt, performance.now()));
    document.body.dataset.kind = label.kind; document.body.dataset.scene = visible.provenance==='actual'?'now':(/^gen_([abc])$/.exec(visible.sceneKey||'')||[])[1]||''; el.badge.textContent = label.text;
  }
  if (lastContact && performance.now()-lastContact > 20000) message('Connection lost. Keeping the last image.');
  renderNotice();
}
function caption() {
  const [first,second] = captionLines(visible?.caption || '');
  el['first-line'].textContent = second ? first : ''; el['second-line'].textContent = second || first;
  applyViewFlags(); tick();
}
function applyViewFlags() {
  const view = latest?.view || {};
  el['display-stage'].style.opacity = shown ? '1' : '0';
  el.badge.hidden = view.labels === false;
  el['first-line'].hidden = view.subtitles === false || !el['first-line'].textContent;
  el['second-line'].hidden = view.subtitles === false;
  el.caption.hidden = !visible || !shown || (view.labels === false && view.subtitles === false);
}
function setOpacity(value,ms=0) {
  el['fade-stage'].style.transition = ms ? `opacity ${ms}ms linear` : 'none';
  el['fade-stage'].style.opacity = String(value);
}
function stopOriginal() { fadeVersion++; if(fadeTimer!==null)clearTimeout(fadeTimer); fadeTimer=null; }
function raiseOriginal() {
  stopOriginal(); setOpacity(0); void el['fade-stage'].offsetWidth; setOpacity(1,timingMs('fadeDurationMs',FADE_MS));
}
function refadeOriginal() {
  stopOriginal();
  const alpha = Math.max(0,Math.min(1,Number.parseFloat(getComputedStyle(el['fade-stage']).opacity)||0));
  if(alpha<=.001){raiseOriginal();return;}
  const fadeMs=timingMs('fadeDurationMs',FADE_MS),holdMs=timingMs('blackHoldMs',BLACK_HOLD_MS);
  const version=fadeVersion,down=alpha*fadeMs;
  setOpacity(0,down);
  fadeTimer=setTimeout(()=>{if(version!==fadeVersion)return;fadeTimer=null;setOpacity(1,fadeMs);},down+holdMs);
}
function takeBatch(pending) {
  const b=pending.fadeBatch,c=pending.content;
  if(!b || typeof b.captureId!=='string' || !b.captureId || b.captureId.length>256 || b.captureId!==c?.captureId || !Number.isSafeInteger(b.completedAtMs) || lastFadeId===b.captureId)return false;
  lastFadeId=b.captureId; return true;
}
function commit(pending) {
  visibleRenderKey=pending.renderKey;
  visible=pending.content; clock=pending.clock; clockAt=pending.clockAt;
  el.waiting.hidden=true; setLoading(false); caption(); message('');
}
function finishCross(commitNew=true) {
  if(!cross)return;
  const transition=cross; cross=null; clearTimeout(transition.timer);
  if(commitNew){
    transition.old.hidden=true; transition.old.style.opacity='1'; transition.old.style.zIndex='0';
    transition.next.style.transition='none'; transition.next.style.opacity='1'; transition.next.style.zIndex='1';
    transition.old.id='frame-next'; transition.next.id='frame';
    el.frame=transition.next; el['frame-next']=transition.old; commit(transition.pending);
  }else{
    transition.next.hidden=true; transition.next.style.transition='none'; transition.next.style.opacity='0';
    transition.old.style.opacity='1'; transition.old.style.zIndex='1';
  }
}
function adoptImage(image) {
  image.id='frame-next'; image.className='frame-layer'; image.alt=''; 
  image.style.transition='none'; image.style.opacity='0'; image.style.zIndex='2'; image.hidden=false;
  el['frame-next'].replaceWith(image); el['frame-next']=image;
}
function showDecoded(pending,image) {
  if(cross)finishCross();
  const first=!visible,changedBatch=takeBatch(pending);
  adoptImage(image);
  if(mode==='crossfade' && shown && !first){
    stopOriginal(); setOpacity(1);
    const old=el.frame; old.style.opacity='1'; old.style.zIndex='1';
    const fadeMs=timingMs('fadeDurationMs',FADE_MS);
    void image.offsetWidth; image.style.transition=`opacity ${fadeMs}ms linear`; image.style.opacity='1';
    const transition={old,next:image,pending,timer:null}; cross=transition;
    transition.timer=setTimeout(()=>{if(cross===transition)finishCross();},fadeMs);
    return;
  }
  const old=el.frame; old.hidden=true; old.style.opacity='1'; old.id='frame-next'; image.id='frame';
  image.style.opacity='1'; image.style.zIndex='1'; el.frame=image; el['frame-next']=old;
  commit(pending);
  if(mode==='original' && shown){if(first)raiseOriginal();else if(changedBatch)refadeOriginal();}
  else {stopOriginal();setOpacity(1);}
}
function accept(data) {
  const value=validateSnapshot(data);
  value.view=data.view; value.fadeBatch=data.fadeBatch;
  if(value.screen.id!==id)throw Error('Wrong screen response');
  if(!shouldAcceptSnapshot(latest,value,id))return;
  lastContact=performance.now();
  document.title=`${value.screen.label||id} — Speculative Memory`;
  if(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.screen.accent||''))document.documentElement.style.setProperty('--accent',value.screen.accent);
  const nextShown=value.view?.visible!==false,nextMode=fadeMode(value.view),viewChanged=shown!==nextShown || mode!==nextMode;
  latest=value;
  if(value.displayStatus?.state==='failed' && visible){
    pendingImage=null;loadToken++;finishCross(false);
    if(viewChanged){stopOriginal();setOpacity(1);} shown=nextShown;mode=nextMode;applyViewFlags();tick();message('');return;
  }
  if(viewChanged){finishCross();stopOriginal();setOpacity(1);}
  shown=nextShown;mode=nextMode;applyViewFlags();
  if(!value.content){
    loadToken++;pendingImage=null;finishCross(false);stopOriginal();setOpacity(1);visible=null;
    el.frame.hidden=true;el['frame-next'].hidden=true;el.caption.hidden=true;el.waiting.hidden=false;
    el.waiting.textContent=value.message||'Waiting for an image';message('');return;
  }
  const renderKey=JSON.stringify([value.content.id,value.content.imageUrl,faceBlurKey(value.content,value.view)]);
  const pending={content:value.content,view:value.view,renderKey,clock:value.clock,clockAt:lastContact,fadeBatch:value.fadeBatch};
  if(cross && cross.pending.renderKey===renderKey){cross.pending=pending;takeBatch(pending);return;}
  if(visible && visibleRenderKey===renderKey){
    if(pendingImage){loadToken++;pendingImage=null;} if(cross)finishCross(false);
    commit(pending);
    if(takeBatch(pending) && mode==='original' && shown)refadeOriginal();
    return;
  }
  if(pendingImage && pendingImage.renderKey===renderKey){Object.assign(pendingImage,pending);return;}
  const token=++loadToken; pendingImage=pending;
  const image=new Image();setLoading(true);
  const failed=()=>{if(token===loadToken && pendingImage===pending){pendingImage=null;setLoading(false);message(visible?'Image unavailable. Keeping the previous image.':'Image unavailable.');}};
  image.onload=async()=>{
    let rendered=image;
    try{await image.decode();const url=faceBlurImage(image,pending.content,pending.view);if(url!==image.src){rendered=new Image();rendered.src=url;await rendered.decode();}}catch{failed();return;}
    if(token!==loadToken || pendingImage!==pending)return;
    pendingImage=null;showDecoded(pending,rendered);
  };
  image.onerror=failed;image.src=value.content.imageUrl;
}

async function fetchSnapshot() {
  if (busy || !api || !pageActive || document.hidden) return;
  busy = true;
  const controller = new AbortController();
  activeRequest = controller;
  try {
    const response = await fetch(api, {cache:'no-store', signal:AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])});
    if (!response.ok) throw new Error(`Display request failed (${response.status})`);
    const data = await response.json();
    if (!controller.signal.aborted && pageActive && !document.hidden) accept(data);
  } catch (error) {
    if (!controller.signal.aborted && pageActive && !document.hidden) message(describeFetchError(error));
  } finally {
    if (activeRequest === controller) activeRequest = null;
    busy = false;
    if (refreshAfterRequest) { refreshAfterRequest = false; void fetchSnapshot(); }
  }
}
function startPolling() {
  if (!api || !pageActive) return;
  if (!polling) polling = setInterval(fetchSnapshot, 1500);
  void fetchSnapshot();
}
if (!id) {
  el.waiting.textContent = 'Open a screen URL: /display/a';
} else {
  // Short requests release HTTP/1.1 connection slots shared by all display tabs.
  // The existing server SSE endpoint remains available to other clients.
  startPolling();
  setInterval(tick, 250);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) activeRequest?.abort();
    else if (busy) refreshAfterRequest = true;
    else void fetchSnapshot();
  });
  window.addEventListener('pagehide', () => {
    pageActive = false; refreshAfterRequest = false;
    if (polling) clearInterval(polling); polling = null;
    activeRequest?.abort();
  });
  window.addEventListener('pageshow', () => {
    if (pageActive) return;
    pageActive = true;
    if (busy) refreshAfterRequest = true;
    startPolling();
  });
}

async function fullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (error) { message(describeFetchError(error)); }
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
