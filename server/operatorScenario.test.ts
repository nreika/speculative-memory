import test from 'node:test';
import assert from 'node:assert/strict';
import {createOperatorScenario,type OperatorPlan} from './operatorScenario';
const plan:OperatorPlan={version:1,id:'SCN-001',durationSec:180,loop:false,cues:[{id:'layout0',atSec:0,layout:['display_a','display_b','display_c','display_now']},{id:'p',atSec:5,prompts:{gen_a:'raise hand'}},{id:'g1',atSec:8,generate:true},{id:'layout75',atSec:75,layout:['display_b','display_now','display_a','display_c']},{id:'one',atSec:85,oneShot:{gen_b:'stand'}},{id:'g2',atSec:100,generate:true}]};
test('live play keeps clock responsive, generates twice and restores layout on Stop',async()=>{
 let clock=0;const layouts:any[]=[],calls:any[]=[];const s=createOperatorScenario({now:()=>clock,setLayout:x=>{layouts.push(x);},generate:async r=>{calls.push({r,snapshot:s.snapshot()});return {captureId:'c'+calls.length};}});
 s.load(plan,'SCN-001.csv');await s.play(false,['NOW','C','A','B']);clock=8;await s.tick();await Promise.resolve();assert.equal(calls.length,1);
 clock=75;await s.tick();assert.deepEqual(layouts.at(-1),['B','NOW','A','C']);
 clock=100;await s.tick();await Promise.resolve();assert.equal(calls.length,2);assert.equal(calls[1].snapshot.prompts.b,'stand');s.acknowledge(calls[1].snapshot.receipt);assert.equal(s.snapshot().prompts.b,'');
 clock=180;await s.tick();assert.equal(s.status().state,'completed');assert.equal(s.ownsLayout(),true);assert.equal(s.canGenerate(),false);
 await s.stop();assert.deepEqual(layouts.at(-1),['NOW','C','A','B']);assert.equal(s.ownsLayout(),false);
});
test('Preview never generates and pause excludes wall time',async()=>{
 let clock=0,calls=0;const s=createOperatorScenario({now:()=>clock,setLayout:()=>{},generate:async()=>{calls++;}});
 s.load(plan,'SCN-001.csv');await s.play(true,['A','B','C','NOW']);clock=6;s.pause();clock=60;await s.tick();assert.equal(s.status().elapsedSec,6);s.pause();clock=62;await s.tick();assert.equal(calls,0);assert.equal(s.status().skippedGenerations,1);
});
test('loading another plan clears previous run generation results',async()=>{
 let clock=0;const s=createOperatorScenario({now:()=>clock,setLayout:()=>{},generate:async()=>{throw Error('must not generate');}});
 s.load(plan,'old.csv');await s.play(true,['A','B','C','NOW']);clock=8;await s.tick();assert.equal(s.status().skippedGenerations,1);await s.stop();
 s.load({version:1,id:'mapping-only',durationSec:20,loop:false,cues:[{id:'note',atSec:0,note:'No generation'}]},'new.csv');
 const loaded=s.status();assert.equal(loaded.state,'ready');assert.equal(loaded.runId,'');assert.equal(loaded.requestedGenerations,0);assert.equal(loaded.skippedGenerations,0);assert.deepEqual(loaded.generationCues,[]);assert.equal(loaded.lastGenerationReason,'');
});

test('busy cue is recorded once and never automatically retried',async()=>{
 let clock=0,calls=0;const s=createOperatorScenario({now:()=>clock,setLayout:()=>{},generate:async()=>{calls++;throw Error('busy');}});
 s.load(plan,'SCN-001.csv');await s.play(false,['A','B','C','NOW']);clock=8;await s.tick();await Promise.resolve();await s.tick();assert.equal(calls,1);assert.equal(s.status().lastGenerationReason,'busy');
});
test('late catch-up skips old generations and applies only the final layout',async()=>{
 let clock=0,calls=0;const layouts:any[]=[];const s=createOperatorScenario({now:()=>clock,setLayout:x=>{layouts.push(x);},generate:async()=>{calls++;}});
 s.load(plan,'SCN-001.csv');await s.play(false,['A','B','C','NOW']);clock=101;await s.tick();assert.equal(calls,1);assert.equal(s.status().generationCues[0].skipped,'late');assert.equal(layouts.length,2);
});
test('asset_only without active image rejects before generation submission',async()=>{
 const s=createOperatorScenario({setLayout:()=>{},generate:async()=>{}});s.load({...plan,cues:[{id:'m',atSec:0,sceneModes:{gen_a:'asset_only'}}]},'m.csv');await s.play(false,['A','B','C','NOW']);assert.throws(()=>s.captureSnapshot(),/active image/);
});

test('mapping-only plan generates zero, Preview still routes legacy slots, and Stop clears transient mapping',async()=>{let time=0,calls=0;const rows:any[]=[],layouts:any[]=[];const s=createOperatorScenario({now:()=>time,setLayout:l=>{layouts.push(l);},generate:async()=>{calls++;},outputMapping:{begin:async x=>{rows.push(['begin',x.preview]);},apply:async x=>{rows.push(['apply',x]);},stop:async()=>{rows.push(['stop']);}}});s.load({...plan,durationSec:3,cues:[{id:'p',atSec:0,layout:['B','C','A','NOW'],outputs:[{id:'screen-7',patch:{source:'b'}}]},{id:'q',atSec:1,outputs:[{id:'screen-7',patch:{visible:false}}]}]},'mapping.csv');await s.play(true,['A','B','C','NOW']);time=1;await s.tick();await s.stop();assert.equal(calls,0);assert.deepEqual(rows.map(r=>r[0]),['begin','apply','apply','stop']);assert.deepEqual(layouts,[['B','C','A','NOW'],['A','B','C','NOW']]);});
test('mapping conflict pauses clock and reports error without submitting generation',async()=>{let calls=0;const s=createOperatorScenario({setLayout:()=>{},generate:async()=>{calls++;},outputMapping:{begin:async()=>{},apply:async()=>{throw Error('manual conflict');},stop:async()=>{}}});s.load({...plan,cues:[{id:'p',atSec:0,outputs:[{id:'screen-7',patch:{visible:false}}],generate:true}]},'bad.csv');await assert.rejects(s.play(false,['A','B','C','NOW']),/manual/);assert.equal(s.status().state,'paused');assert.match(s.status().lastOutputError,/manual/);assert.equal(calls,0);await s.stop();});

const settingsPlan:OperatorPlan={version:1,id:'SCN-SETTINGS-001',durationSec:20,loop:false,cues:[{id:'d',atSec:0,settings:{scenes:{a:{distanceSec:10}}}},{id:'p',atSec:4,settings:{presence:.5}},{id:'h',atSec:12,hold:'pause'}]};
const settingsMock=(fail?:string)=>{const rows:any[]=[];return{rows,port:{begin:async(x:any)=>{rows.push(['begin',x.runId]);},apply:async(x:any)=>{if(fail&&JSON.stringify(x).includes(fail))throw Error('settings rejected');rows.push(['apply',x]);},stop:async()=>{rows.push(['stop']);return [] as string[];}}};};
test('Preview records setting cues as skipped(preview) with the change and never applies them',async()=>{let clock=0;const m=settingsMock(),s=createOperatorScenario({now:()=>clock,setLayout:()=>{},generate:async()=>{throw Error('must not generate');},settings:m.port});s.load(settingsPlan,'s.csv');await s.play(true,['A','B','C','NOW']);clock=12;await s.tick();const st=s.status();assert.deepEqual(m.rows,[]);assert.equal(st.skippedSettings,3);assert.equal(st.appliedSettings,0);assert.equal(st.lastSettingsSkipped,'preview');assert.deepEqual(st.settingsCues.map((r:any)=>[r.cueId,r.skipped,r.change]),[['d','preview','scenes.a.distanceSec=10'],['p','preview','presence=0.5'],['h','preview','generation.pause']]);await s.stop();assert.deepEqual(m.rows,[]);});
test('Live applies setting cues, a failing row is recorded alone and the run continues, end restores once',async()=>{let clock=0;const m=settingsMock('presence'),s=createOperatorScenario({now:()=>clock,setLayout:()=>{},generate:async()=>{},settings:m.port});s.load(settingsPlan,'s.csv');await s.play(false,['A','B','C','NOW']);clock=12;await s.tick();let st=s.status();assert.equal(st.state,'running');assert.equal(st.appliedSettings,2);assert.equal(st.failedSettings,1);assert.match(st.lastSettingsError,/^p \(presence=0\.5\): settings rejected/);assert.equal(st.settingsCues[1].status,'failed');clock=20;await s.tick();st=s.status();assert.equal(st.state,'completed');assert.deepEqual(m.rows.map(r=>r[0]),['begin','apply','apply','stop']);await s.stop();assert.equal(m.rows.length,4);});
test('settings plan refuses Live play without a settings port but Preview still runs',async()=>{const s=createOperatorScenario({setLayout:()=>{},generate:async()=>{}});s.load(settingsPlan,'s.csv');await assert.rejects(s.play(false,['A','B','C','NOW']),/settings control is unavailable/);await s.play(true,['A','B','C','NOW']);assert.equal(s.status().skippedSettings,1);await s.stop();});

test('output_* row aimed at a missing screen yields a non-fatal warning; channels and existing screens do not',async()=>{
 const {checkOperatorPlan}=await import('./operatorScenario');const os=await import('node:os'),fsp=await import('node:fs/promises'),pth=await import('node:path');
 const python=process.env.OPERATOR_TEST_PYTHON??pth.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
 const root=await fsp.mkdtemp(pth.join(os.tmpdir(),'scn-missing-screen-'));
 await fsp.writeFile(pth.join(root,'m.csv'),'seconds,action,target,value\n0,scenario,,MISSING-SCREEN\n0,output_visible,screen-2,true\n4,output_visible,screen-99,false\n4,output_labels,current-now,true\n8,end,,\n');
 const warn=(await checkOperatorPlan(root,'m.csv',python,async()=>['screen-1','screen-2'])).formatWarnings.filter(w=>w.message.includes('does not exist'));
 assert.deepEqual(warn.map(w=>[w.row,w.severity,w.message]),[[4,'warning','target screen-99 does not exist in the current browser outputs']]);
 assert.equal((await checkOperatorPlan(root,'m.csv',python)).formatWarnings.filter(w=>w.message.includes('does not exist')).length,0);
 assert.equal((await checkOperatorPlan(root,'m.csv',python,async()=>{throw Error('store down');})).plan.cues.length>0,true);
});
