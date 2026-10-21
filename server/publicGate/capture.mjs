// Remote camera page: rear camera -> 1280x720 JPEG (q 0.8) -> POST /capture/frame every N seconds.
const $=id=>document.getElementById(id);
const video=$('video'),canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
let blockedAt=0,stream=null,timer=null,wake=null,facing='environment',lastSent=0,running=false;
const clientId=(()=>{try{let v=sessionStorage.getItem('capClientId');if(!v){v=Array.from(crypto.getRandomValues(new Uint8Array(12)),b=>b.toString(16).padStart(2,'0')).join('');sessionStorage.setItem('capClientId',v);}return v;}catch{return Array.from(crypto.getRandomValues(new Uint8Array(12)),b=>b.toString(16).padStart(2,'0')).join('');}})();
const fmtAge=ms=>ms<1000?'just now':Math.round(ms/1000)+' s ago';
function setState(text,cls=''){$('state').textContent=text;$('state').className=cls;}
async function status(){
  try{const r=await fetch('/capture/status',{cache:'no-store'});if(!r.ok)throw Error(r.status===401?'Session expired: open the capture link again':'HTTP '+r.status);const s=await r.json();
    if(!running&&s.intervalSec&&[5,10,20].includes(s.intervalSec)&&!$('interval').dataset.touched)$('interval').value=String(s.intervalSec);
    if(Date.now()-blockedAt<15000)return;
    setState(`${s.selected?'In use (Remote device selected)':'Standby (not selected in Control)'} · server: ${s.state}${s.ageSec!=null?' · last frame '+s.ageSec+' s ago':''}`,s.state==='stale'?'stale':'ok');
  }catch(e){setState(e.message,'error');}
}
async function lock(){try{if('wakeLock' in navigator&&document.visibilityState==='visible')wake=await navigator.wakeLock.request('screen');}catch{wake=null;}}
async function openCamera(){
  stream?.getTracks().forEach(t=>t.stop());
  stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:facing},width:{ideal:1280},height:{ideal:720}}});
  video.srcObject=stream;await video.play();
}
async function send(){
  if(!running||!video.videoWidth)return;
  const vw=video.videoWidth,vh=video.videoHeight,target=16/9;let sw=vw,sh=vh;
  if(vw/vh>target)sw=vh*target;else sh=vw/target; // centre-crop to 16:9 (portrait phones too)
  const ctx=canvas.getContext('2d');ctx.drawImage(video,(vw-sw)/2,(vh-sh)/2,sw,sh,0,0,1280,720);
  const image=canvas.toDataURL('image/jpeg',0.8);
  try{const r=await fetch('/capture/frame',{method:'POST',headers:{'Content-Type':'application/json','X-Capture-Request':'1'},body:JSON.stringify({image,clientId})});
    const body=await r.json().catch(()=>({}));if(r.status===409){blockedAt=Date.now();setState('Another device is sending. Waiting…','stale');return;}if(!r.ok)throw Error(body.error||('HTTP '+r.status));lastSent=Date.now();blockedAt=0;
    setState(body.selected?'In use (Remote device selected)':'Standby (not selected in Control)','ok');
  }catch(e){setState('Send failed: '+e.message,'error');}
}
function schedule(){clearInterval(timer);const sec=Number($('interval').value)||10;timer=setInterval(send,sec*1000);}
$('start').onclick=async()=>{
  try{await openCamera();running=true;await lock();schedule();void send();$('start').disabled=true;$('stop').disabled=false;}
  catch(e){setState('Camera unavailable: '+e.message,'error');}
};
$('stop').onclick=()=>{running=false;clearInterval(timer);stream?.getTracks().forEach(t=>t.stop());stream=null;wake?.release?.();wake=null;$('start').disabled=false;$('stop').disabled=true;};
$('flip').onclick=async()=>{facing=facing==='environment'?'user':'environment';if(running){try{await openCamera();}catch(e){setState('Camera unavailable: '+e.message,'error');}}};
$('interval').onchange=()=>{$('interval').dataset.touched='1';if(running)schedule();};
document.addEventListener('visibilitychange',async()=>{if(document.visibilityState==='visible'&&running){await lock();if(!stream||stream.getVideoTracks().every(t=>t.readyState==='ended')){try{await openCamera();}catch{}}void send();}});
setInterval(()=>{$('last').textContent=running?(lastSent?'Last sent '+fmtAge(Date.now()-lastSent):'Starting…'):'Not sending';},1000);
setInterval(status,5000);void status();
if(!('wakeLock' in navigator))$('state').textContent='Wake Lock unsupported: turn off auto-lock on this phone.';
