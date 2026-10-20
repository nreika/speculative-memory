// Identity and temporal meaning are separate. Time never changes provenance.
export function validateSnapshot(value) {
  if (!value || value.schema !== 1 || typeof value.revision !== 'string' || !value.revision || value.revision.length > 128) throw new Error('Unsupported display snapshot');
  const {screen, clock, content} = value;
  if (!screen || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(screen.id)) throw new Error('Invalid screen');
  validateClock(clock);
  if (content !== null) {
    if (!content || typeof content.id !== 'string' || !content.id || !['actual', 'generated'].includes(content.provenance)) throw new Error('Invalid content provenance');
    let url; try { url = decodeURIComponent(content.imageUrl); } catch { throw new Error('Invalid media URL'); }
    if (typeof content.imageUrl !== 'string' || !url.startsWith('/captures/') || /[\\?#%\u0000-\u001f\u007f]/.test(url) || url.slice(1).split('/').some(p => !p || p === '.' || p === '..') || !/\.(png|jpe?g|webp|gif|avif)$/i.test(url)) throw new Error('Invalid media URL');
    for (const key of ['targetAtMs','recordedAtMs','generatedAtMs','sourceRecordedAtMs']) if (content[key] !== null && !Number.isSafeInteger(content[key])) throw new Error('Invalid content time');
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
  return clock;
}
// Opaque revision hashes have no order. Compare response time across scope changes.
export function shouldAcceptSnapshot(previous, incoming, screenId) {
  if (incoming.screen.id !== screenId) return false;
  return !previous || incoming.clock.serverNowMs >= previous.clock.serverNowMs;
}
export function displayStatusMessage(status, visible) {
  if (!status || !['failed','generating'].includes(status.state)) return '';
  const lead = status.userMessage || (status.state === 'failed' ? '今回表示不可・前回画像を表示中' : '生成中・前回画像を表示中');
  return lead + (visible ? '' : '（表示画像なし）');
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
export function temporalLabel(content, nowMs) {
  if (!content) return {kind:'empty', text:'Waiting for an image'};
  const timestamp=content.provenance==='actual'?content.recordedAtMs:content.targetAtMs;
  if (!Number.isFinite(timestamp)) return {kind:'unknown',text:content.provenance==='actual'?'RECORDED · time unknown':'GENERATED · target time unknown'};
  if (content.provenance === 'actual') {
    const age = nowMs - content.recordedAtMs;
    if (age < -1000) return {kind:'unknown',text:'RECORDED · clock mismatch'};
    return {kind:'actual',text:age<1000?'RECORDED NOW':`RECORDED PAST · ${duration(age/1000)} ago`};
  }
  const delta=content.targetAtMs-nowMs;
  if(Math.abs(delta)<500)return {kind:'generated-present',text:'GENERATED · target time now'};
  return delta>0?{kind:'generated-future',text:`GENERATED FUTURE · +${duration(delta/1000)}`}:{kind:'generated-past',text:`GENERATED PAST · ${duration(-delta/1000)} ago`};
}
export function captionLines(text, limit=180) {
  const clean=String(text||'').replace(/\s+/g,' ').trim().slice(0,limit);
  if(clean.length<45)return [clean,''];
  let at=Math.round(clean.length*.6);
  const nearby=[...clean].map((c,i)=>/[ 。、,;!?]/.test(c)?i+1:-1).filter(i=>i>clean.length*.4&&i<clean.length*.75);
  if(nearby.length)at=nearby.sort((a,b)=>Math.abs(a-at)-Math.abs(b-at))[0];
  return [clean.slice(0,at).trim(),clean.slice(at).trim()];
}
