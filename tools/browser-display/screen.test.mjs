import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as timeline from './timeline.mjs';
import * as faceBlur from './face-blur.mjs';
const script=fs.readFileSync(new URL('./screen.mjs',import.meta.url),'utf8').replace(/^import .*?;\r?\n/gm,'');
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function snapshot(id='image-1',time=1000,caption='caption'){
 return {schema:1,revision:'r'+time,screen:{id:'current-a',label:'A',accent:'#ffffff'},clock:{serverNowMs:time,worldNowMs:time,scope:'live',rate:1},content:{id,imageUrl:'/captures/'+id+'.png',scope:'live',provenance:'generated',recordedAtMs:null,sourceRecordedAtMs:null,targetAtMs:2000,generatedAtMs:900,caption}};
}
function harness(hidden=false){
 const nodes={},requests=[],images=[],intervals=new Map(),events={},documentEvents={},timeouts=[],timers=new Map();let sequence=0,now=10,sse=0;
 const makeNode=()=>({hidden:true,textContent:'',src:'',style:{},offsetWidth:1280,classList:{add(){},remove(){}},replaceWith(next){this.replacedBy=next;},decode:async()=>{}});
 const document={hidden,body:{dataset:{},classList:{add(){},remove(){}}},documentElement:{style:{setProperty(){}},requestFullscreen:async()=>{}},getElementById(id){return nodes[id]??=makeNode();},addEventListener(name,fn){documentEvents[name]=fn;}};
 const context=vm.createContext({...timeline,...faceBlur,document,location:{pathname:'/display/current-a'},performance:{now:()=>now++},AbortController,
  AbortSignal:{any:AbortSignal.any.bind(AbortSignal),timeout(ms){const controller=new AbortController();timeouts.push({ms,controller});return controller.signal;}},
  window:{addEventListener(name,fn){events[name]=fn;}},getComputedStyle:node=>({opacity:node.computedOpacity??node.style.opacity??'1'}),Image:class{constructor(){Object.assign(this,makeNode());images.push(this);}},EventSource:class{constructor(){sse++;throw Error('No streaming connections allowed');}},
  setInterval(fn,ms){const id=++sequence;intervals.set(id,{fn,ms});return id;},clearInterval(id){intervals.delete(id);},setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},
  fetch(url,options){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});const item={url,options,resolve:body=>resolve({ok:true,json:async()=>body}),reject};requests.push(item);options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});return promise;}
 });
 vm.runInContext(script,context);
 return {context,timers,current:()=>vm.runInContext('el.frame',context),back:()=>vm.runInContext("el['frame-next']",context),accept:data=>{context.incoming=data;vm.runInContext('accept(incoming)',context);},runTimer:ms=>{const entry=[...timers.entries()].find(([,t])=>t.ms===ms);assert.ok(entry,'timer '+ms);timers.delete(entry[0]);entry[1].fn();},nodes,requests,images,intervals,events,documentEvents,document,timeouts,sse:()=>sse,poll:()=>[...intervals.values()].find(i=>i.ms===1500)?.fn(),emit:name=>events[name]?.()};
}

let stamp=1000;
function value(id='one',view={},batch){const s=snapshot(id,stamp+=1500,id);s.content.captureId=id;s.view=view;if(batch)s.fadeBatch={captureId:id,completedAtMs:stamp};return s;}
async function load(h,data){h.accept(data);const image=h.images.at(-1);await image.onload();await flush();return image;}
const pendingTimers=(h,ms)=>[...h.timers.values()].filter(t=>t.ms===ms).length;
test('original first image raises; Each updates immediately; finished batch refades once',async()=>{
 const h=harness();await load(h,value());assert.equal(h.current().src,'/captures/one.png');assert.equal(h.nodes['fade-stage'].style.transition,'opacity 800ms linear');assert.equal(pendingTimers(h,920),0);
 await load(h,value('two'));assert.equal(h.current().src,'/captures/two.png');assert.equal(pendingTimers(h,920),0);
 h.accept(value('two',{},true));assert.equal(h.nodes['fade-stage'].style.opacity,'0');assert.equal(pendingTimers(h,920),1);
 h.accept(value('two',{},true));assert.equal(pendingTimers(h,920),1);h.runTimer(920);assert.equal(h.nodes['fade-stage'].style.opacity,'1');assert.equal(h.nodes['fade-stage'].style.transition,'opacity 800ms linear');
});
test('original uses current alpha, requires matching completed capture, and master false disables',async()=>{
 const h=harness();await load(h,value());h.nodes['fade-stage'].computedOpacity='.5';h.accept(value('one',{},true));assert.equal(pendingTimers(h,520),1);
 h.accept(value('one',{fade:false,fadeMode:'crossfade'},true));assert.equal(pendingTimers(h,520),0);assert.equal(h.nodes['fade-stage'].style.opacity,'1');
 await load(h,value('two',{fade:false,fadeMode:'original'},true));assert.equal(pendingTimers(h,920),0);assert.equal(h.current().src,'/captures/two.png');
 const bad=value('two',{},true);bad.fadeBatch.captureId='wrong';h.accept(bad);assert.equal(pendingTimers(h,520),0);
});
test('crossfade preloads then overlaps only two layers and commits metadata at completion',async()=>{
 const h=harness(),view={fadeMode:'crossfade'};await load(h,value('one',view));const first=h.current();await load(h,value('two',view));
 assert.equal(h.current(),first);assert.equal(first.hidden,false);assert.equal(first.style.opacity,'1');assert.equal(h.back().hidden,false);assert.equal(h.back().style.transition,'opacity 800ms linear');assert.equal(h.nodes['second-line'].textContent,'one');
 h.runTimer(800);assert.equal(first.hidden,true);assert.equal(h.current().src,'/captures/two.png');assert.equal(h.nodes['second-line'].textContent,'two');
});
test('new image mid-crossfade finishes previous transition then uses two stable layers',async()=>{
 const h=harness(),view={fadeMode:'crossfade'};await load(h,value('one',view));await load(h,value('two',view));const second=h.back();await load(h,value('three',view));
 assert.equal(h.current(),second);assert.equal(h.nodes['second-line'].textContent,'two');assert.equal(pendingTimers(h,800),1);h.runTimer(800);assert.equal(h.current().src,'/captures/three.png');
});
test('hidden display never exposes decoded images; show retains image without extra fade',async()=>{
 const h=harness();await load(h,value());h.accept(value('one',{visible:false}));assert.equal(h.nodes['display-stage'].style.opacity,'0');
 await load(h,value('two',{visible:false},true));assert.equal(h.nodes['display-stage'].style.opacity,'0');assert.equal(h.current().src,'/captures/two.png');assert.equal(pendingTimers(h,920),0);
 h.accept(value('two',{visible:true},true));assert.equal(h.nodes['display-stage'].style.opacity,'1');assert.equal(pendingTimers(h,920),0);
});
test('same pending image is not restarted and newest caption survives slow decode',async()=>{
 const h=harness();const first=value();h.accept(first);let resolve;h.images[0].decode=()=>new Promise(r=>resolve=r);const work=h.images[0].onload();
 const later=value();later.content.caption='latest caption';h.accept(later);assert.equal(h.images.length,1);resolve();await work;assert.equal(h.nodes['second-line'].textContent,'latest caption');
});
test('decode failure and superseded decode preserve previous visible image',async()=>{
 const h=harness();await load(h,value('one',{fadeMode:'none'}));h.accept(value('two'));const stale=h.images.at(-1);h.accept(value('three'));const newer=h.images.at(-1);
 await stale.onload();assert.equal(h.current().src,'/captures/one.png');newer.decode=async()=>{throw Error('decode');};await newer.onload();assert.equal(h.current().src,'/captures/one.png');assert.match(h.nodes.connection.textContent,/unavailable/);
});
test('null clears both layers and failed status retains the prior image',async()=>{
 const h=harness();await load(h,value());h.accept({...value(),displayStatus:{state:'failed',requestedCaptureId:'bad',displayedCaptureId:null,error:'failed',userMessage:'previous retained',lastSuccessAtMs:1000}});assert.equal(h.current().src,'/captures/one.png');
 h.accept({...value(),content:null});assert.equal(h.current().hidden,true);assert.equal(h.back().hidden,true);
});
test('finite GET polling has no persistent stream, no overlap, hides and resumes safely',async()=>{
 const h=harness();h.poll();assert.equal(h.requests.length,1);assert.equal(h.sse(),0);h.requests[0].resolve(value());await flush();h.poll();assert.equal(h.requests.length,2);
 h.document.hidden=true;h.documentEvents.visibilitychange();h.poll();assert.equal(h.requests.length,2);h.document.hidden=false;h.documentEvents.visibilitychange();await flush();assert.equal(h.requests.length,3);
});
test('invalid/unmatched batch cannot refade; legacy unknown mode defaults to original',async()=>{
 const h=harness();await load(h,value('one',{fadeMode:'unknown'}));const bad=value('one',{},true);bad.fadeBatch.completedAtMs=NaN;h.accept(bad);assert.equal(pendingTimers(h,920),0);h.accept(value('one',{},true));assert.equal(pendingTimers(h,920),1);
});

test('BFCache and eight-second errors release polling without duplicate intervals',async()=>{
 const h=harness();h.timeouts[0].controller.abort(Error('deadline'));await flush();h.poll();assert.equal(h.requests.length,2);
 h.emit('pagehide');await flush();assert.equal([...h.intervals.values()].filter(t=>t.ms===1500).length,0);h.emit('pageshow');h.emit('pageshow');assert.equal(h.requests.length,3);assert.equal([...h.intervals.values()].filter(t=>t.ms===1500).length,1);
});
test('ten display contexts use finite requests only',async()=>{
 const tabs=Array.from({length:10},()=>harness());for(const h of tabs){h.requests[0].resolve(value());}await flush();for(const h of tabs){h.poll();h.poll();assert.equal(h.requests.length,2);assert.equal(h.sse(),0);}
});
test('switching mode or hide cancels an active crossfade without stale timer commit',async()=>{
 const h=harness(),view={fadeMode:'crossfade'};await load(h,value('one',view));await load(h,value('two',view));h.accept(value('two',{visible:false,fadeMode:'none'}));assert.equal(pendingTimers(h,800),0);assert.equal(h.current().src,'/captures/two.png');assert.equal(h.nodes['display-stage'].style.opacity,'0');
});
