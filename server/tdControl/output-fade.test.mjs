import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./output.mjs',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').split('const api =')[0];
function harness(view){
 const elements={},timers=[];
 const context=vm.createContext({document:{getElementById:id=>elements[id]??={style:{opacity:'1'},offsetWidth:1}},location:{pathname:'/control/screen/screen-7'},getComputedStyle:el=>({opacity:el.style.opacity}),setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:()=>{},timers,view});
 vm.runInContext(source+`latest={view};visible={id:'image1',imageUrl:'/captures/one.png',captureId:'batch1'};effectMode='original';`,context);
 return {run:code=>vm.runInContext(code,context),timers,elements};
}
test('fixed assignment fades once on image change, not on unchanged polling',()=>{
 const h=harness({fadeOnImageChange:true,fadeDurationMs:1500,blackHoldMs:250});
 h.run('originalFade(false,true)');assert.equal(h.timers[0].ms,1500);assert.equal(h.elements.frames.style.opacity,'0');
 h.timers[0].fn();assert.equal(h.timers[1].ms,250);
 h.timers[1].fn();assert.equal(h.elements.frames.style.transition,'opacity 1500ms linear');
 const before=h.timers.length;h.run('originalFade()');assert.equal(h.timers.length,before);
});
test('Each image change waits for completed batch, completed batch is deduplicated',()=>{
 const h=harness({fadeOnImageChange:false});h.run('originalFade(false,true)');assert.equal(h.timers.length,0);
 h.run("latest.fadeBatch={captureId:'batch1',completedAtMs:10};originalFade();originalFade();");
 assert.equal(h.timers.length,1);assert.equal(h.timers[0].ms,800);
});
test('invalid timing falls back and zero duration is accepted',()=>{
 const h=harness({fadeOnImageChange:true,fadeDurationMs:-1});h.run('originalFade(false,true)');assert.equal(h.timers[0].ms,800);
 const zero=harness({fadeOnImageChange:true,fadeDurationMs:0});zero.run('originalFade(false,true)');assert.equal(zero.timers[0].ms,0);
});
