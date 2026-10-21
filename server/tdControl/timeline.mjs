// Identity and temporal meaning are separate. Time never changes provenance.
export function generatingScene(capture, active){
  if(!capture||!['requested','generating'].includes(capture.phase)||!active||
     typeof capture.captureId!=='string'||!capture.captureId||capture.captureId!==active.captureId)return null;
  const match=/^scene([A-C])$/.exec(active.stage);
  return match?match[1].toLowerCase():null;
}
export function localImagePath(value){
  let decoded;try{decoded=decodeURIComponent(value);}catch{throw Error('Invalid media URL');}
  if(typeof value!=='string'||!decoded.startsWith('/captures/')||/[\\?#%\u0000-\u001f\u007f]/.test(decoded)||decoded.slice(1).split('/').some(p=>!p||p==='.'||p==='..')||!/\.(png|jpe?g|webp|gif|avif)$/i.test(decoded))throw Error('Invalid media URL');
  return value;
}
export function validateSnapshot(value) {
  if (!value || value.schema !== 1 || typeof value.revision !== 'string' || !value.revision || value.revision.length > 128) throw new Error('Unsupported display snapshot');
  const {screen, clock, content} = value;
  if (!screen || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(screen.id)) throw new Error('Invalid screen');
  validateClock(clock);
  if (content !== null) {
    if (!content || typeof content.id !== 'string' || !content.id || !['actual', 'generated', 'uploaded'].includes(content.provenance)) throw new Error('Invalid content provenance');
    let url; try { url = decodeURIComponent(content.imageUrl); } catch { throw new Error('Invalid media URL'); }
    if (typeof content.imageUrl !== 'string' || !url.startsWith('/captures/') || /[\\?#%\u0000-\u001f\u007f]/.test(url) || url.slice(1).split('/').some(p => !p || p === '.' || p === '..') || !/\.(png|jpe?g|webp|gif|avif)$/i.test(url)) throw new Error('Invalid media URL');
    for (const key of ['targetAtMs','recordedAtMs','generatedAtMs','sourceRecordedAtMs']) if (content[key] !== null && !Number.isSafeInteger(content[key])) throw new Error('Invalid content time');
    if(content.provenance==='uploaded'&&['targetAtMs','recordedAtMs','generatedAtMs','sourceRecordedAtMs'].some(key=>content[key]!==null))throw new Error('Imported images cannot have recorded or generated timestamps');
  }
  if (value.displayStatus !== undefined) {
    const s = value.displayStatus;
    if (!s || !['idle','generating','completed','failed'].includes(s.state)) throw new Error('Invalid display status');
    for (const key of ['requestedCaptureId','displayedCaptureId','error','userMessage']) if (s[key] !== null && typeof s[key] !== 'string') throw new Error('Invalid display status');
    if (s.lastSuccessAtMs !== null && !Number.isSafeInteger(s.lastSuccessAtMs)) throw new Error('Invalid display status time');
  }
  return value;
}
export function validateClock(clock) {
  if (!clock || !Number.isSafeInteger(clock.serverNowMs) || !Number.isSafeInteger(clock.worldNowMs) || !Number.isFinite(clock.rate) || typeof clock.scope !== 'string' || !clock.scope) throw new Error('Invalid display clock');
  if(clock.known!==undefined&&typeof clock.known!=='boolean')throw new Error('Invalid clock reference');
  return clock;
}
// Opaque revision hashes have no order. Compare response time across scope changes.
export function shouldAcceptSnapshot(previous, incoming, screenId) {
  if (incoming.screen.id !== screenId) return false;
  return !previous || incoming.clock.serverNowMs >= previous.clock.serverNowMs;
}
export function displayStatusMessage(status, visible) {
  if (!status || !['failed','generating'].includes(status.state)) return '';
  // Per-scene notices come from the server ("Generating…", "Next", ...); these are only fallbacks. English only.
  const lead = status.userMessage || (status.state === 'failed' ? 'Generation failed. Showing the previous image.' : 'Generating…');
  return lead + (visible ? '' : ' (no image yet)');
}
export function worldTime(clock, receivedAt, monotonicNow) {
  return clock.worldNowMs + Math.max(0, monotonicNow - receivedAt) * clock.rate;
}
export function duration(seconds) {
  const n = Math.max(0, Math.round(seconds));
  if (n < 60) return `${n} sec`;
  if (n < 3600) return `${Math.floor(n / 60)} min ${n % 60} sec`;
  return `${Math.floor(n / 3600)} hr ${Math.floor((n % 3600) / 60)} min`;
}
function temporalLabelCore(content, nowMs, known=true) {
  if (!content) return {kind:'empty', text:'Waiting for an image'};
  if (content.provenance === 'uploaded') return {kind:'uploaded', text:typeof content.sequenceLabel==='string'&&content.sequenceLabel?content.sequenceLabel.slice(0,128):'IMPORTED IMAGE'};
  if(!known)return {kind:'unknown',text:content.provenance==='actual'?'RECORDED · time reference unknown':'GENERATED · time reference unknown'};
  const timestamp=content.provenance==='actual'?content.recordedAtMs:content.targetAtMs;
  if (!Number.isFinite(timestamp)) return {kind:'unknown',text:content.provenance==='actual'?'RECORDED · time unknown':'GENERATED · target time unknown'};
  if (content.provenance === 'actual') {
    const age = nowMs - content.recordedAtMs;
    if (age < -1000) return {kind:'unknown',text:'RECORDED · clock mismatch'};
    return {kind:'actual',text:age<1000?'RECORDED NOW':`RECORDED PAST · ${duration(age/1000)} ago`};
  }
  // 2026-10-21: a generated scene is labelled by its distance from its source frame (what it depicts), not by the wall clock:
  // a +30 s image took ~60 s to generate, so against the clock every future image read 'GENERATED PAST'.
  const d=content.distanceSecSigned;
  const short=x=>{const n=Math.round(Math.abs(x));return n<60?n+'s':n%60?Math.floor(n/60)+'m'+(n%60)+'s':(n/60)+'m';};
  // How long ago the image was generated stays visible next to its distance (2026-10-21).
  // Tone / Presence the scene was generated with, e.g. 'T1.0 P0.7'.
  const tp=Number.isFinite(content.tone)||Number.isFinite(content.presence)?' · '+(Number.isFinite(content.tone)?'T'+content.tone.toFixed(1):'')+(Number.isFinite(content.tone)&&Number.isFinite(content.presence)?' ':'')+(Number.isFinite(content.presence)?'P'+content.presence.toFixed(1):''):'';
  const ago=Number.isFinite(content.generatedAtMs)?' · '+(nowMs-content.generatedAtMs<1000?'just now':duration((nowMs-content.generatedAtMs)/1000)+' ago'):'';
  if(typeof d==='number'&&Number.isFinite(d))return d===0?{kind:'generated-present',text:'NOW ±0s'+tp+ago}:d>0?{kind:'generated-future',text:`FUTURE +${short(d)}${tp}${ago}`}:{kind:'generated-past',text:`PAST −${short(d)}${tp}${ago}`};
  const delta=content.targetAtMs-nowMs;
  if(Math.abs(delta)<500)return {kind:'generated-present',text:'GENERATED · target time now'};
  return delta>0?{kind:'generated-future',text:`GENERATED FUTURE · +${duration(delta/1000)}`}:{kind:'generated-past',text:`GENERATED PAST · ${duration(-delta/1000)} ago`};
}
// 2026-10-21: scene letter in front of the label (A/B/C for gen_a/gen_b/gen_c, NOW for the recorded frame).
export function temporalLabel(content, nowMs, known=true) {
  const label=temporalLabelCore(content, nowMs, known);
  if(!content||content.provenance==='uploaded')return label;
  const scene=/^gen_([abc])$/.exec(String(content.sceneKey||''));
  const prefix=content.provenance==='actual'?'NOW':scene?scene[1].toUpperCase():'';
  return prefix?{...label,text:prefix+' · '+label.text}:label;
}
export function captionLines(text, limit=180) {
  const clean=String(text||'').replace(/\s+/g,' ').trim().slice(0,limit);
  if(clean.length<45)return [clean,''];
  let at=Math.round(clean.length*.6);
  const nearby=[...clean].map((c,i)=>/[ 。、,;!?]/.test(c)?i+1:-1).filter(i=>i>clean.length*.4&&i<clean.length*.75);
  if(nearby.length)at=nearby.sort((a,b)=>Math.abs(a-at)-Math.abs(b-at))[0];
  return [clean.slice(0,at).trim(),clean.slice(at).trim()];
}

// A cone describes one capture. Each-image cards may contain several captures in flight.
// The expected size must belong to this capture, never to currently edited settings.
export function availableConeScenes(incoming) {
  const id=incoming?.now?.content?.captureId;
  if(typeof id!=='string'||!id)return null;
  const result={now:incoming.now};
  for(const scene of ['a','b','c'])result[scene]=incoming?.[scene]?.content?.captureId===id?incoming[scene]:null;
  return result;
}
// Completion is authoritative even when Continuous starts another capture between polls.
export function completedConeResult(rows, previous=null) {
  let best=previous;
  if(!Array.isArray(rows))return best;
  for(const row of rows){
    try{
      if(row?.result!=='completed'||typeof row.captureId!=='string'||!row.captureId||
         typeof row.browserFollow?.scope!=='string'||!row.browserFollow.scope)continue;
      const ended=Date.parse(row.endedAt),started=Date.parse(row.startedAt);
      if(!Number.isFinite(started)||!Number.isFinite(ended)||ended<started||
         (best&&ended<=best.completedAtMs))continue;
      const images=row.images,items=row.browserBatch;
      if(!images||!Array.isArray(items)||items.length<2||items.length>4)continue;
      const count=items.length-1,letters=['a','b','c'].slice(0,count);
      const keys=['now',...letters];
      if(Object.keys(images).length!==keys.length||!keys.every(key=>typeof images[key]==='string'))continue;
      const result={now:null,a:null,b:null,c:null};
      for(const item of items){
        const key=item.sceneKey==='now'?'now':/^gen_[abc]$/.test(item.sceneKey)?item.sceneKey.slice(-1):null;
        if(!keys.includes(key)||result[key]||item.captureId!==row.captureId||
           item.id!==row.captureId+':'+item.sceneKey||item.scope!==row.browserFollow.scope||
           item.provenance!==(key==='now'?'actual':'generated')||item.imageUrl!==images[key]||
           !(item.distanceSecSigned===null||typeof item.distanceSecSigned==='number'&&Number.isFinite(item.distanceSecSigned)))throw Error('Invalid completed cone');
        localImagePath(item.imageUrl);result[key]={content:item};
      }
      if(!keys.every(key=>result[key]))continue;
      best={captureId:row.captureId,completedAtMs:ended,imageCount:count,scenes:result};
    }catch{/* Invalid or legacy partial archive rows cannot replace the last valid cone. */}
  }
  return best;
}

// Nonlinear time axis, with distances supplied by capture metadata or explicit settings.
// Unknown distances stay unknown; no inference from saved time or current controls.
export function coneGeometry(offsets) {
  const valid=Object.values(offsets).filter(x=>typeof x==='number'&&Number.isFinite(x));
  const range=Math.max(600,...valid.map(Math.abs));
  const position=x=>500+Math.sign(x)*Math.log1p(Math.abs(x))/Math.log1p(range)*450;
  const label=x=>x===0?'NOW':`${x>0?'+':'−'}${Math.abs(x)>=60&&Math.abs(x)%60===0?`${Math.abs(x)/60} min`:`${Math.abs(x)} sec`}`;
  const points=['a','b','c'].map((scene,index)=>{
    const d=offsets[scene];const known=typeof d==='number'&&Number.isFinite(d);
    const axisX=known?position(d):500;
    const x=!known?760+index*75:Math.abs(axisX-500)<92?500+(d<0?-110:110):axisX;
    return {scene,axisX,x,distance:known?d:null,label:known?label(d):'time unknown'};
  });
  const ticks=[-range,-60,-5,0,5,60,range].map(d=>({x:position(d),label:d===0?'SOURCE':label(d)}));
  return {points,ticks,range};
}

// Skip / rejection reasons recorded for the capture that produced the displayed NOW.
export function skipReasons(rows,captureId){
  const out={};if(!Array.isArray(rows)||typeof captureId!=='string'||!captureId)return out;
  // NOW changes when a capture starts; its skips are known only when it ends, so fall back to the latest ended row.
  const own=rows.find(r=>r?.captureId===captureId);
  const row=own?.endedAt?own:rows.find(r=>r?.endedAt&&Array.isArray(r.skippedScenes));
  for(const item of row?.skippedScenes||[]){
    const match=/^gen_([abc])$/.exec(item?.sceneKey||'');
    if(match&&typeof item.reason==='string'&&item.reason.length<=80)out[match[1]]=item.reason;
  }
  return out;
}
