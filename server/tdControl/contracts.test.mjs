import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {webcrypto} from 'node:crypto';
import {localImagePath,validateSnapshot,temporalLabel} from './timeline.mjs';
test('imported images have no fabricated recorded or generated time',()=>{
 const content={id:'asset-1',provenance:'uploaded',imageUrl:'/captures/browser-output-assets/123.png',targetAtMs:null,recordedAtMs:null,generatedAtMs:null,sourceRecordedAtMs:null};
 const snapshot={schema:1,revision:'upload',screen:{id:'screen-10'},clock:{serverNowMs:1000,worldNowMs:1000,rate:1,scope:'live'},content};
 assert.equal(validateSnapshot(snapshot),snapshot);
 assert.deepEqual(temporalLabel(content,900000),{kind:'uploaded',text:'IMPORTED IMAGE'});
 assert.deepEqual(temporalLabel(content,900000,false),{kind:'uploaded',text:'IMPORTED IMAGE'});
 assert.throws(()=>validateSnapshot({...snapshot,content:{...content,recordedAtMs:100}}));
});
test('unknown clock never invents an archive image age',()=>{
 assert.equal(temporalLabel({provenance:'generated',targetAtMs:1000},5000,false).text,'GENERATED · time reference unknown');
 assert.equal(temporalLabel({provenance:'actual',recordedAtMs:1000},5000,false).text,'RECORDED · time reference unknown');
});
test('acknowledged commands unlock controls while image refresh is pending',async()=>{
 const source=fs.readFileSync(new URL('./control.mjs',import.meta.url),'utf8');
 const definition=source.slice(source.indexOf('async function perform('),source.indexOf("$('settings-form').addEventListener"));
 let imageRequested=false;const locks=[];
 const context={busy:false,online:true,uncertain:false,epoch:0,notice(){},render(){},
  updateButtons(){locks.push(context.busy);},refresh(){},
  command:async()=>({state:{},message:'Stopped'}),
  refreshImages(){imageRequested=true;return new Promise(()=>{});}};
 vm.runInNewContext(definition+';this.perform=perform',context);
 const completed=await Promise.race([context.perform('scenario.stop').then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),100))]);
 assert.equal(imageRequested,true);assert.equal(completed,true);assert.equal(context.busy,false);assert.deepEqual(locks,[true,false]);
});
test('image URLs remain same-origin captures only',()=>{
 assert.equal(localImagePath('/captures/new.png'),'/captures/new.png');
 for(const value of ['http://example.com/a.png','//example.com/a.png','/captures/../private.png','/captures/%2e%2e/private.png','/captures/a.png?token=x','/captures/a%255c.png'])assert.throws(()=>localImagePath(value));
});
test('request ID works on HTTP tailnet without secure-context randomUUID',()=>{
 const source=fs.readFileSync(new URL('./control.mjs',import.meta.url),'utf8');const definition=source.slice(source.indexOf('function requestId(){'),source.indexOf('function markUncertain'));
 const id=vm.runInNewContext(definition+';requestId()',{crypto:{getRandomValues:b=>webcrypto.getRandomValues(b)}});
 assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
test('output preserves registry provenance/scope/time schema',()=>{
 const content={id:'new',provenance:'generated',imageUrl:'/captures/new.png',targetAtMs:2000,recordedAtMs:null,generatedAtMs:1500,sourceRecordedAtMs:1000,scope:'test:run'};
 const snapshot={schema:1,revision:'r1',screen:{id:'control-output-1'},clock:{serverNowMs:1500,worldNowMs:1500,rate:1,scope:'test:run'},content};
 assert.equal(validateSnapshot(snapshot),snapshot);assert.equal(snapshot.content.sourceRecordedAtMs,1000);
});
