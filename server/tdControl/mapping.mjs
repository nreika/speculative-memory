import {localImagePath} from './timeline.mjs';
const API='/api/browser-outputs';
const $=id=>document.getElementById(id);
const sources={now:'Current source',a:'Latest A',b:'Latest B',c:'Latest C','actual-past':'Recorded past','generated-history':'Generated history',fixed:'Fixed image'};
const fadeModes={original:'TD · black',crossfade:'Crossfade',none:'None'};
const directChannels=[
 ['current-now','NOW','/display/current-now'],['current-a','A','/display/current-a'],['current-b','B','/display/current-b'],['current-c','C','/display/current-c']
];
let outputs=[],revision=null,dirty=false,busy=false,selected=null,cursor=null,library=[];
// Every edit is saved automatically (no Apply step). saving: a save request is in flight;
// saveAgain: more edits arrived meanwhile; saveFailed: stop until Reload (never overwrite a conflict).
let saving=false,saveAgain=false,saveFailed=false,saveTimer=null;
const TYPING_SAVE_DELAY_MS=600;
// Two modes: 'auto' saves every edit immediately; 'manual' keeps edits as a draft until Apply mapping.
const MODE_KEY='speculative-memory.mapping.applyMode';
let applyMode=(()=>{try{return localStorage.getItem(MODE_KEY)==='manual'?'manual':'auto';}catch{return 'auto';}})();
let channelFadeModes={};
let channelFadeTimings={};
let channelFaceBlurs={};
// Fixed scenes / routing slots: label (badge) and text (subtitle) on or off, like the browser outputs.
let channelCaptions={};
let savedOutputs=[],savedChannelFadeModes={},savedChannelFadeTimings={},savedChannelFaceBlurs={},savedChannelCaptions={};
const catalog=new Map();
function requestId(){
 if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
 const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
 const h=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function status(text,error=false){$('map-status').textContent=text;$('map-status').classList.toggle('error',error);}
function edited(delayMs=0){
 dirty=true;
 if(applyMode==='manual'){buttons();status('Unsaved mapping · Apply mapping to update the outputs.');return;}
 if(saveFailed){status('Not saved · Reload, then make the change again.',true);return;}
 status('Saving…');clearTimeout(saveTimer);saveTimer=setTimeout(()=>void autoSave(),delayMs);
}
function snapshotDraft(){return {outputs:structuredClone(outputs),channelFadeModes:structuredClone(channelFadeModes),channelFadeTimings:structuredClone(channelFadeTimings),channelFaceBlurs:structuredClone(channelFaceBlurs),channelCaptions:structuredClone(channelCaptions)};}
function draftDiffers(sent){return JSON.stringify(sent)!==JSON.stringify(snapshotDraft());}
async function autoSave(){
 if(!dirty||saveFailed)return;
 if(saving||busy){saveAgain=true;return;}
 saving=true;const sent=snapshotDraft();
 try{
  const data=await request('',{baseRevision:revision,...sent,requestId:requestId()});
  revision=data.revision;
  savedOutputs=sent.outputs;savedChannelFadeModes=sent.channelFadeModes;savedChannelFadeTimings=sent.channelFadeTimings;savedChannelFaceBlurs=sent.channelFaceBlurs;savedChannelCaptions=sent.channelCaptions;
  dirty=draftDiffers(sent);
  if(!dirty){if(typeof document!=='undefined')for(const card of document.querySelectorAll('.mapping-card.is-dirty'))card.classList.remove('is-dirty');status('Saved · outputs updated.');void previews();}
 }catch(error){saveFailed=true;status(error.message+' — not saved. Reload before changing again.',true);}
 finally{saving=false;if(saveAgain&&!saveFailed){saveAgain=false;void autoSave();}}
}
function buttons(){for(const id of ['add-output','make-ten','reload-mapping','save-preset','load-preset'])$(id).disabled=busy;for(const el of document.querySelectorAll('#mapping-cards button, #mapping-cards input, #mapping-cards select, #channel-fades select, #channel-fades input'))el.disabled=busy;$('save-mapping').hidden=applyMode!=='manual';$('save-mapping').disabled=busy||saving||!dirty;$('make-ten').disabled=busy||outputs.length>=10;}
async function request(path='',body){
 const response=await fetch(API+path,{cache:'no-store',signal:AbortSignal.timeout(20000),...(body?{method:'POST',headers:{'Content-Type':'application/json','X-Control-Request':'1'},body:JSON.stringify(body)}:{})});
 const data=await response.json();if(!response.ok||data.ok===false)throw Error(data.error||`Request failed (${response.status})`);return data;
}
function node(tag,text,className){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;}
function select(options,value,change){const e=node('select');for(const [key,label] of Object.entries(options))e.add(new Option(label,key));e.value=value;e.onchange=()=>change(e.value);return e;}
function labeled(text,control){const label=node('label',text);label.append(control);return label;}
function timingFields(target,label){
 const fields=node('div',undefined,'fade-timings');
 for(const [key,text,fallback] of [['fadeDurationMs','Fade sec',800],['blackHoldMs','Black sec',120]]){
  const input=node('input');input.type='number';input.min='0';input.max='10';input.step='0.01';input.value=(target[key]??fallback)/1000;input.setAttribute('aria-label',label+' '+text);
  input.title=key==='fadeDurationMs'?'Seconds per direction for TD black; total duration for Crossfade.':'Seconds to hold black between fade out and fade in.';
  input.oninput=()=>{if(input.value===''||!input.checkValidity())return;target[key]=Math.round(Number(input.value)*1000);edited(TYPING_SAVE_DELAY_MS);};
  fields.append(labeled(text,input));
 }
 return fields;
}
function faceBlurFields(target,label){
 const fields=node('div',undefined,'face-blur-fields');
 const enabled=node('input');enabled.type='checkbox';enabled.checked=target.enabled===true;enabled.setAttribute('aria-label',label+' Face blur');
 enabled.onchange=()=>{target.enabled=enabled.checked;edited();};
 const strength=node('input');strength.type='number';strength.min='0';strength.max='40';strength.step='1';strength.value=target.strengthPx??12;strength.setAttribute('aria-label',label+' Face blur px');
 strength.oninput=()=>{if(strength.value===''||!strength.checkValidity())return;target.strengthPx=Number(strength.value);edited(TYPING_SAVE_DELAY_MS);};
 fields.append(labeled('Face blur',enabled),labeled('Blur px',strength));return fields;
}
function captionFields(target,label){
 const fields=node('div',undefined,'view-options channel-captions');
 for(const [key,text] of [['labels','Label'],['subtitles','Text']]){const check=node('input');check.type='checkbox';check.checked=target[key]!==false;check.setAttribute('aria-label',label+' '+text);check.onchange=()=>{target[key]=check.checked;edited();};fields.append(labeled(text,check));}
 return fields;
}
function adoptConfiguration(data){
 outputs=structuredClone(data.outputs).map(output=>({...output,fadeMode:fadeModes[output.fadeMode]?output.fadeMode:output.fade===false?'none':'original',fadeDurationMs:output.fadeDurationMs??800,blackHoldMs:output.blackHoldMs??120,faceBlur:{enabled:output.faceBlur?.enabled===true,strengthPx:output.faceBlur?.strengthPx??12}}));
 channelFadeModes=Object.fromEntries(directChannels.map(([key])=>[key,fadeModes[data.channelFadeModes?.[key]]?data.channelFadeModes[key]:'original']));
 channelFadeTimings=Object.fromEntries(directChannels.map(([key])=>[key,{fadeDurationMs:data.channelFadeTimings?.[key]?.fadeDurationMs??800,blackHoldMs:data.channelFadeTimings?.[key]?.blackHoldMs??120}]));
 channelFaceBlurs=Object.fromEntries(directChannels.map(([key])=>[key,{enabled:data.channelFaceBlurs?.[key]?.enabled===true,strengthPx:data.channelFaceBlurs?.[key]?.strengthPx??12}]));
 channelCaptions=Object.fromEntries(directChannels.map(([key])=>[key,{labels:data.channelCaptions?.[key]?.labels!==false,subtitles:data.channelCaptions?.[key]?.subtitles!==false}]));
 revision=data.revision;
 savedOutputs=structuredClone(outputs);savedChannelFadeModes=structuredClone(channelFadeModes);savedChannelFadeTimings=structuredClone(channelFadeTimings);savedChannelFaceBlurs=structuredClone(channelFaceBlurs);savedChannelCaptions=structuredClone(channelCaptions);
}
async function assignImage(outputId){
 if(busy)return;
 if(!selected){status('Select an image from the library first.');return;}
 const imageId=selected.id,draft=structuredClone(outputs),draftFades=structuredClone(channelFadeModes),draftTimings=structuredClone(channelFadeTimings),draftBlurs=structuredClone(channelFaceBlurs),draftCaptions=structuredClone(channelCaptions);
 const target=draft.find(output=>output.id===outputId);if(!target)return;
 const committed=structuredClone(savedOutputs);
 let output=committed.find(item=>item.id===outputId);
 if(!output){output=structuredClone(target);committed.push(output);}
 output.source='fixed';output.contentId=imageId;
 busy=true;buttons();status('Assigning image to '+target.label+'…');
 try{
  const data=await request('',{baseRevision:revision,outputs:committed,channelFadeModes:savedChannelFadeModes,channelFadeTimings:savedChannelFadeTimings,channelFaceBlurs:savedChannelFaceBlurs,channelCaptions:savedChannelCaptions,requestId:requestId()});
  adoptConfiguration(data);
  target.source='fixed';target.contentId=imageId;
  outputs=draft;channelFadeModes=draftFades;channelFadeTimings=draftTimings;channelFaceBlurs=draftBlurs;channelCaptions=draftCaptions;
  dirty=JSON.stringify(outputs)!==JSON.stringify(savedOutputs)||JSON.stringify(channelFadeModes)!==JSON.stringify(savedChannelFadeModes)||JSON.stringify(channelFadeTimings)!==JSON.stringify(savedChannelFadeTimings)||JSON.stringify(channelFaceBlurs)!==JSON.stringify(savedChannelFaceBlurs)||JSON.stringify(channelCaptions)!==JSON.stringify(savedChannelCaptions);
  renderChannelFades();renderCards();
  status('Image assigned to '+target.label+' · output updated.'+(dirty?(applyMode==='manual'?' Other changes are unsaved · Apply mapping to save them.':' Saving other changes…'):''));
  if(dirty&&applyMode==='auto')saveAgain=true;
  void previews();
 }catch(error){status(error.message+' — assignment has not been confirmed. Reload before retrying.',true);}
 finally{busy=false;buttons();if(saveAgain&&!saveFailed){saveAgain=false;void autoSave();}}
}
function renderChannelFades(){
 $('channel-fades').replaceChildren();
 for(const [index,title] of [[0,'Fixed scenes'],[4,'Routing slots']]){
  const group=node('div',undefined,'channel-fade-group');group.append(node('h3',title));
  for(const [key,label,url] of directChannels.slice(index,index+4)){
   const row=node('div',undefined,'channel-fade-row'),link=node('a',label+' ↗');link.href=url;link.target='_blank';link.rel='noopener';link.title=url;
   const input=select(fadeModes,channelFadeModes[key],value=>{channelFadeModes[key]=value;edited();});input.setAttribute('aria-label',key+' fade');
   row.append(link,input,timingFields(channelFadeTimings[key],key),faceBlurFields(channelFaceBlurs[key],key),captionFields(channelCaptions[key],key));group.append(row);
  }
  $('channel-fades').append(group);
 }
}
function safeImage(img,url){try{const path=localImagePath(url);if(img.getAttribute('src')!==path)img.src=path;img.hidden=false;}catch{img.removeAttribute('src');img.hidden=true;}}
function detail(item){
 if(!item)return 'No image selected';
 const stamp=item.provenance==='actual'?item.recordedAtMs:item.targetAtMs;
 const type=item.provenance==='uploaded'?'Imported image':item.provenance==='generated'?'Generated · target':item.provenance==='actual'?'Recorded':'Image · details unavailable';
 return `${item.label||item.id} · ${type}${Number.isSafeInteger(stamp)?' '+new Date(stamp).toLocaleString():''}`;
}
function renderPool(){
 $('image-pool').replaceChildren();
 for(const item of library){
  const button=node('button',undefined,'pool-image');button.type='button';button.setAttribute('aria-pressed',String(selected?.id===item.id));
  const img=node('img');img.alt=item.label||item.id;img.loading='lazy';safeImage(img,item.thumbnailUrl||item.imageUrl);
  button.append(img,node('span',item.label||item.id),node('small',item.provenance==='uploaded'?'Imported image':item.provenance==='generated'?'Generated':'Recorded'));
  button.onclick=()=>{selected=item;$('selected-image').textContent=detail(item)+' — click an output to assign.';renderPool();};
  $('image-pool').append(button);
 }
 $('more-images').hidden=!cursor;
}
function renderCards(){
 $('mapping-cards').replaceChildren();$('output-count').textContent=`${outputs.length} browser outputs`;
 for(const output of outputs){
  const card=node('article',undefined,'mapping-card');card.dataset.output=output.id;
  const head=node('header'),name=node('input');name.value=output.label;name.maxLength=80;name.setAttribute('aria-label',output.id+' name');
  name.oninput=()=>{output.label=name.value;edited(TYPING_SAVE_DELAY_MS);card.classList.add('is-dirty');};
  const open=node('a','Open ↗');open.href='/control/screen/'+output.id;open.target='_blank';open.rel='noopener';head.append(name,open);
  const assign=node('button',undefined,'output-image-button');assign.type='button';assign.setAttribute('aria-label','Assign selected image to '+output.label);
  const img=node('img');img.alt=output.label+' preview';img.id='preview-'+output.id;
  const fixed=catalog.get(output.contentId);if(fixed)safeImage(img,fixed.thumbnailUrl||fixed.imageUrl);else img.hidden=true;
  assign.append(img,node('span','Assign selected image'));
  assign.onclick=()=>assignImage(output.id);
  const assignment=node('p',output.source==='fixed'?detail(fixed||{id:output.contentId,provenance:'unknown'}):sources[output.source], 'assignment');
  assignment.id='assignment-'+output.id;
  const source=select(sources,output.source,value=>{if(value==='fixed'&&!output.contentId){if(!selected){status('Select an image before choosing Fixed image.',true);source.value=output.source;return;}output.contentId=selected.id;}if(value!=='fixed')delete output.contentId;if(['now','a','b','c','td-1','td-2','td-3','td-4'].includes(value))output.delaySec=0;output.source=value;edited();renderCards();});source.setAttribute('aria-label',output.label+' source');
  card.append(head,assign,assignment,labeled('Source',source));
  if(['actual-past','generated-history'].includes(output.source)){
   const delay=node('input');delay.type='number';delay.min='0';delay.max='86400';delay.step='1';delay.value=output.delaySec??30;delay.setAttribute('aria-label',output.label+' delay seconds');
   delay.oninput=()=>{if(delay.value===''||!delay.checkValidity())return;output.delaySec=Number(delay.value);edited(TYPING_SAVE_DELAY_MS);};card.append(labeled('Delay · sec',delay));
   if(output.source==='generated-history'){const scene=select({any:'Any scene',a:'A',b:'B',c:'C'},output.scene||'any',value=>{output.scene=value;edited();});card.append(labeled('Scene',scene));}
  }
  const flags=node('div',undefined,'view-options');
  for(const [key,label] of Object.entries({visible:'Show',labels:'Label',subtitles:'Text'})){const check=node('input');check.type='checkbox';check.checked=output[key]!==false;check.onchange=()=>{output[key]=check.checked;edited();};flags.append(labeled(label,check));}
  const fade=select(fadeModes,output.fadeMode,value=>{output.fadeMode=value;output.fade=value!=='none';edited();});fade.setAttribute('aria-label',output.id+' fade');
  card.append(labeled('Fade',fade),timingFields(output,output.id),faceBlurFields(output.faceBlur,output.id));
  const remove=node('button','Remove output','remove-output');remove.onclick=()=>{outputs=outputs.filter(x=>x.id!==output.id);edited();renderCards();};
  card.append(flags,remove);$('mapping-cards').append(card);
 }
 buttons();
}
async function previews(){
 await Promise.allSettled(outputs.map(async output=>{
  const observedRevision=revision;
  const snapshot=await request('/'+output.id);
  if(revision!==observedRevision)return;
  const image=$('preview-'+output.id);if(image&&snapshot.content)safeImage(image,snapshot.content.imageUrl);
  const label=$('assignment-'+output.id);
  if(snapshot.scenarioOverride){
   if(label)label.textContent='Scenario · '+(sources[snapshot.scenarioOverride.source]||snapshot.scenarioOverride.source);
   return;
  }
  if(output.source==='fixed'&&snapshot.content?.id===output.contentId){
   const item={...snapshot.content,label:snapshot.content.caption||output.contentId};catalog.set(output.contentId,item);
   if(label)label.textContent=detail(item);
  }else if(label){
   label.textContent=output.source==='fixed'?detail(catalog.get(output.contentId)||{id:output.contentId,provenance:'unknown'}):sources[output.source];
  }
 }));
}
async function load(){
 busy=true;buttons();
 try{const data=await request();adoptConfiguration(data);dirty=false;saveFailed=false;saveAgain=false;clearTimeout(saveTimer);renderChannelFades();renderCards();status(applyMode==='manual'?'Mapping loaded. Manual mode · edits wait for Apply mapping (image assignment still saves immediately).':'Mapping loaded. Auto mode · changes are saved and applied automatically.');void previews();}
 catch(error){status(error.message,true);}finally{busy=false;buttons();}
}
async function loadLibrary(more=false){
 $('refresh-library').disabled=true;$('more-images').disabled=true;
 try{const query=new URLSearchParams({kind:$('library-kind').value,limit:'20'});if(more&&cursor)query.set('cursor',cursor);
  const data=await request('/catalog?'+query);const items=data.items;
  for(const item of items)catalog.set(item.id,item);
  library=more?[...library,...items]:items;cursor=data.nextCursor;renderPool();
  if(!dirty){renderCards();void previews();}
 }catch(error){status(error.message,true);}finally{$('refresh-library').disabled=false;$('more-images').disabled=false;}
}
function add(){
 if(outputs.length>=64){status('64 outputs are configured.');return;}
 let number=1;while(outputs.some(x=>x.id==='screen-'+number))number++;
 outputs.push({id:'screen-'+number,label:'Output '+number,source:'now',delaySec:0,scene:'any',visible:true,labels:true,subtitles:true,fade:true,fadeMode:'original',fadeDurationMs:800,blackHoldMs:120,faceBlur:{enabled:false,strengthPx:12}});edited();
}
function parsePreset(text){
 const data=JSON.parse(text);
 if(data?.schema!==1||data?.kind!=='speculative-memory-output-mapping'||!Array.isArray(data.outputs)||data.outputs.length>64)throw Error('Not a supported Output mapping preset.');
 const ids=new Set();
 for(const output of data.outputs){
  if(!output||!/^screen-[1-9][0-9]{0,2}$/.test(output.id)||ids.has(output.id)||typeof output.label!=='string'||output.label.length>80||!Object.hasOwn(sources,output.source))throw Error('Invalid output in preset.');
  ids.add(output.id);
  if(output.source==='fixed'&&(typeof output.contentId!=='string'||!output.contentId||output.contentId.length>512))throw Error('Fixed image reference is missing.');
  if(output.fadeMode!==undefined&&!Object.hasOwn(fadeModes,output.fadeMode))throw Error('Invalid fade mode.');
  for(const field of ['fadeDurationMs','blackHoldMs'])if(output[field]!==undefined&&(!Number.isInteger(output[field])||output[field]<0||output[field]>10000))throw Error('Invalid fade timing.');
  if(output.faceBlur!==undefined&&(typeof output.faceBlur?.enabled!=='boolean'||!Number.isInteger(output.faceBlur.strengthPx)||output.faceBlur.strengthPx<0||output.faceBlur.strengthPx>40))throw Error('Invalid face blur setting.');
 }
 return data;
}
$('save-preset').onclick=()=>{
 const data={schema:1,kind:'speculative-memory-output-mapping',savedAt:new Date().toISOString(),outputs,channelFadeModes,channelFadeTimings,channelFaceBlurs,channelCaptions};
 const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
 const link=node('a');link.href=url;link.download='output-mapping-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 status('Preset saved · includes image references, not image files.');
};
$('load-preset').onclick=()=>$('preset-file').click();
$('preset-file').onchange=async event=>{
 const file=event.target.files[0];if(!file)return;
 try{
  if(file.size>131072)throw Error('Preset must be under 128 KB.');
  const data=parsePreset(await file.text());
  const baseline=[savedOutputs,savedChannelFadeModes,savedChannelFadeTimings,savedChannelFaceBlurs,savedChannelCaptions];
  adoptConfiguration({...data,revision});
  [savedOutputs,savedChannelFadeModes,savedChannelFadeTimings,savedChannelFaceBlurs,savedChannelCaptions]=baseline;
  renderChannelFades();renderCards();edited();
  status(applyMode==='manual'?'Preset loaded · review the mapping, then Apply mapping. Fixed images refer to this server’s library.':'Preset loaded · saving… Fixed images refer to this server’s library.');
 }catch(error){status(error.message,true);}finally{event.target.value='';}
};
$('add-output').onclick=()=>{add();renderCards();};
$('make-ten').onclick=()=>{while(outputs.length<10)add();renderCards();};
$('reload-mapping').onclick=load;

$('save-mapping').onclick=async()=>{
 if(!dirty||busy||saving)return;busy=true;buttons();
 try{const data=await request('',{baseRevision:revision,outputs,channelFadeModes,channelFadeTimings,channelFaceBlurs,channelCaptions,requestId:requestId()});adoptConfiguration(data);dirty=false;renderChannelFades();renderCards();status('Mapping applied. Generation settings are unchanged.');void previews();}
 catch(error){status(error.message+' — mapping has not been confirmed. Reload before retrying.',true);}finally{busy=false;buttons();}
};
$('apply-mode').value=applyMode;
$('apply-mode').onchange=()=>{
 applyMode=$('apply-mode').value==='manual'?'manual':'auto';try{localStorage.setItem(MODE_KEY,applyMode);}catch{}
 if(applyMode==='auto'&&dirty)edited();else{buttons();status(applyMode==='manual'?'Manual mode · edits wait for Apply mapping.':'Auto mode · changes are saved immediately.');}
};
$('refresh-library').onclick=()=>loadLibrary();$('library-kind').onchange=()=>loadLibrary();$('more-images').onclick=()=>loadLibrary(true);
$('import-images').onchange=async event=>{
 const files=[...event.target.files];if(!files.length)return;
 try{for(const file of files){if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>8*1024*1024)throw Error('Use PNG, JPEG or WebP images up to 8 MB.');
   const imageDataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
   const data=await request('/assets',{filename:file.name,imageDataUrl});const item=data.item||data;catalog.set(item.id,item);selected=item;
  }
  $('library-kind').value='uploaded';await loadLibrary();$('selected-image').textContent=detail(selected)+' — click an output to assign.';status(`${files.length} image(s) imported. Select an output to assign.`);
 }catch(error){status(error.message,true);}finally{event.target.value='';}
};
window.addEventListener('beforeunload',event=>{if(dirty||saving){event.preventDefault();event.returnValue='';}});
await load();await loadLibrary();
setInterval(()=>{if(!document.hidden&&!dirty&&!busy&&!saving)void previews();},5000);
