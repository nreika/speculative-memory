import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('./mapping.mjs',import.meta.url),'utf8')
 .replace(/^import .*;\r?\n/gm,'').split("$('save-preset').onclick=")[0];
function harness(){
 const context=vm.createContext({structuredClone,console});
 vm.runInContext(source+`
 buttons=()=>{};renderCards=()=>{};renderChannelFades=()=>{};previews=async()=>{};
 status=(text)=>{globalThis.message=text;};requestId=()=> 'test-request';
 globalThis.initial={revision:'r1',outputs:[{id:'screen-7',label:'Output 7',source:'now',fadeMode:'original',fade:true},{id:'screen-8',label:'Output 8',source:'now',fadeMode:'original',fade:true}],channelFadeModes:{}};
 adoptConfiguration(initial);selected={id:'chosen-image'};
 request=async(path,body)=>{globalThis.sent=structuredClone(body);return {...body,revision:'r2'};};
 `,context);
 return {run:code=>vm.runInContext(code,context),context};
}
test('assignment saves only the chosen image, preserving unrelated drafts',async()=>{
 const h=harness();h.run("applyMode='manual'"); // drafts exist only in manual mode
 h.run("outputs[0].label='Draft name';outputs[1].source='b';channelFadeModes['current-a']='none';channelFadeTimings['current-a'].fadeDurationMs=2000;dirty=true;");
 await h.run("assignImage('screen-7')");
 assert.equal(h.context.sent.outputs[0].source,'fixed');
 assert.equal(h.context.sent.outputs[0].contentId,'chosen-image');
 assert.equal(h.context.sent.outputs[0].label,'Output 7');
 assert.equal(h.context.sent.outputs[1].source,'now');
 assert.equal(h.context.sent.channelFadeModes['current-a'],'original');
 assert.equal(h.context.sent.channelFadeTimings['current-a'].fadeDurationMs,800);
 assert.equal(h.run('outputs[0].label'),'Draft name');
 assert.equal(h.run('outputs[1].source'),'b');
 assert.equal(h.run("channelFadeModes['current-a']"),'none');
 assert.equal(h.run("channelFadeTimings['current-a'].fadeDurationMs"),2000);
 assert.equal(h.run('dirty'),true);
 assert.equal(h.run('revision'),'r2');
});
test('assignment without other edits leaves nothing to Apply',async()=>{
 const h=harness();await h.run("assignImage('screen-7')");
 assert.equal(h.run('dirty'),false);
 assert.equal(h.run('savedOutputs[0].contentId'),'chosen-image');
 assert.match(h.context.message,/output updated/);
});
test('conflict or failed request keeps the draft and does not claim success',async()=>{
 const h=harness();h.run("request=async()=>{throw Error('Revision conflict');};outputs[1].label='Keep draft';dirty=true;");
 await h.run("assignImage('screen-7')");
 assert.equal(h.run('outputs[0].source'),'now');
 assert.equal(h.run('outputs[1].label'),'Keep draft');
 assert.equal(h.run('revision'),'r1');assert.equal(h.run('busy'),false);
 assert.match(h.context.message,/has not been confirmed/);
});
test('new output assignment persists that output without adding other draft outputs',async()=>{
 const h=harness();h.run("applyMode='manual'");h.run("outputs.push({id:'screen-9',label:'Output 9',source:'now',fadeMode:'original'},{id:'screen-10',label:'Output 10',source:'now'});dirty=true;");
 await h.run("assignImage('screen-9')");
 assert.deepEqual(Array.from(h.context.sent.outputs,x=>x.id),['screen-7','screen-8','screen-9']);
 assert.equal(h.run('outputs.length'),4);assert.equal(h.run('dirty'),true);
});
test('preset accepts saved output settings and rejects duplicates and unsupported files',()=>{
 const h=harness();
 const valid={schema:1,kind:'speculative-memory-output-mapping',outputs:[{id:'screen-7',label:'Output 7',source:'fixed',contentId:'image-id',fadeDurationMs:1200,blackHoldMs:300,faceBlur:{enabled:true,strengthPx:12}}]};
 h.context.input=JSON.stringify(valid);assert.equal(h.run('parsePreset(input).outputs[0].faceBlur.enabled'),true);
 h.context.input=JSON.stringify({...valid,outputs:[valid.outputs[0],valid.outputs[0]]});assert.throws(()=>h.run('parsePreset(input)'),/Invalid output/);
 h.context.input='{}';assert.throws(()=>h.run('parsePreset(input)'),/supported/);
});
test('auto mode saves an edit without Apply and records the new revision',async()=>{
 const h=harness();h.run("applyMode='auto';outputs[1].faceBlur={enabled:true,strengthPx:12};");
 await h.run("dirty=true;autoSave()");
 assert.equal(h.context.sent.outputs[1].faceBlur.enabled,true);
 assert.equal(h.run('revision'),'r2');assert.equal(h.run('dirty'),false);
 assert.match(h.context.message,/Saved/);
});
test('auto mode stops after a failed save and never retries over a conflict',async()=>{
 const h=harness();h.run("applyMode='auto';let calls=0;request=async()=>{calls++;throw Error('Revision conflict');};outputs[1].label='x';");
 await h.run("dirty=true;autoSave()");
 assert.equal(h.run('saveFailed'),true);await h.run("autoSave()");
 assert.equal(h.run('calls'),1);assert.match(h.context.message,/not saved/);
});
test('manual mode keeps edits as a draft until Apply',()=>{
 const h=harness();h.run("applyMode='manual';let calls=0;request=async()=>{calls++;return {};};outputs[1].label='draft';edited();");
 assert.equal(h.run('dirty'),true);assert.equal(h.run('calls'),0);assert.match(h.context.message,/Apply mapping/);
});
test('fixed scene label/text switches load with defaults and are saved with the mapping',async()=>{
 const h=harness();
 assert.equal(h.run("channelCaptions['current-now'].labels"),true);
 assert.equal(h.run("channelCaptions['current-a'].subtitles"),true);
 h.run("applyMode='auto';channelCaptions['current-a'].subtitles=false;");
 await h.run("dirty=true;autoSave()");
 assert.equal(h.context.sent.channelCaptions['current-a'].subtitles,false);
 assert.equal(h.context.sent.channelCaptions['current-now'].labels,true);
});
