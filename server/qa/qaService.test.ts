import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QaService } from './qaService';
import type { ImproverPaths } from './improver';
import type { LocalJudgeResult } from './localJudge';

function tmpPaths(): { paths: ImproverPaths; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qasvc-'));
  return {
    paths: { rulebookDir: path.join(root, 'rulebook'), logsDir: path.join(root, 'logs'), qaFile: path.join(root, 'logs', 'qa-local.jsonl') },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('QA only starts when the next capture is not expected within the job margin (timer captures are evenly spaced)', (t) => {
  const { paths, cleanup } = tmpPaths();
  const svc = new QaService({ isBusy: () => false, paths, autoImprove: false });
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  assert.equal(svc.idleWindow(), true, 'no history: only the busy gate applies');
  for (let i = 0; i < 4; i++) {
    now = 1_000_000 + i * 140_000;
    svc.interruptForCapture(true);
  }
  assert.equal(svc.nextStartEstimate(), 1_000_000 + 3 * 140_000 + 140_000);
  now = 1_000_000 + 3 * 140_000 + 40_000; // 100 s before the next one
  assert.equal(svc.idleWindow(), true);
  now = 1_000_000 + 3 * 140_000 + 140_000 - 11_000; // 11 s before: a 12 s job would collide
  assert.equal(svc.idleWindow(), false);
  now = 1_000_000 + 3 * 140_000 + 140_000 + 35_000; // timer stopped: overdue, no prediction
  assert.equal(svc.idleWindow(), true);
  // phone-lane captures do not count for the timer
  svc.interruptForCapture(false);
  assert.equal(svc.nextStartEstimate(), 1_000_000 + 3 * 140_000 + 140_000);
  // irregular starts = no estimate
  const svc2 = new QaService({ isBusy: () => false, paths, autoImprove: false });
  for (const t0 of [0, 30_000, 200_000, 230_000]) {
    now = 2_000_000 + t0;
    svc2.interruptForCapture(true);
  }
  assert.equal(svc2.nextStartEstimate(), null);
  cleanup();
});

test('a busy venue blocks QA even without a timer estimate', () => {
  const { paths, cleanup } = tmpPaths();
  let busy = true;
  const svc = new QaService({ isBusy: () => busy, paths, autoImprove: false });
  assert.equal(svc.idleWindow(), false);
  busy = false;
  assert.equal(svc.idleWindow(), true);
  cleanup();
});

test('a judged scene is logged (qa-local.jsonl), patched into prompts.json, and summarised on the capture event', async () => {
  const { paths, cleanup } = tmpPaths();
  const arch = fs.mkdtempSync(path.join(os.tmpdir(), 'qasvc-arch-'));
  fs.writeFileSync(path.join(arch, 'g_prompts.json'), JSON.stringify({ scenes: [{ sceneKey: 'gen_a' }, { sceneKey: 'gen_b' }] }));
  const imgA = path.join(arch, 'a.png');
  fs.writeFileSync(imgA, Buffer.from('iVBORw0KGgo=', 'base64'));
  const patches: any[] = [];
  const judge = async (): Promise<LocalJudgeResult> => ({ ok: false, score: 0.75, defects: [{ type: 'floating', where: 'desk', note: 'n' }], model: 'm', elapsedMs: 5000, inspectionVersion:'preservation-test', evidence:{pair:'raw-observation'} });
  const svc = new QaService({
    isBusy: () => false,
    paths,
    autoImprove: false,
    judge: judge as any,
    events: { patch: (id: string, f: any) => patches.push([id, f]) } as any,
  });
  for (const sceneKey of ['gen_a', 'gen_b']) {
    svc.enqueueScene({ captureId: 'td-1', sceneKey, nowPath: imgA, imagePath: imgA, predictionPrompt: 'p', archiveDir: arch, rulebookVersion: 3, sceneCount: 2 });
  }
  await svc.queue.idle();
  const rows = fs.readFileSync(paths.qaFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].rulebookVersion, 3);
  assert.equal(rows[0].ok, false);
  const doc = JSON.parse(fs.readFileSync(path.join(arch, 'g_prompts.json'), 'utf8'));
  assert.equal(doc.scenes[0].qaLocal.ok, false);
  assert.equal(rows[0].inspectionVersion,'preservation-test');
  assert.deepEqual(doc.scenes[0].qaLocal.evidence,{pair:'raw-observation'});
  assert.equal(doc.scenes[0].qaLocal.inspectionVersion,'preservation-test');
  assert.equal(doc.scenes[1].qaLocal.rulebookVersion, 3);
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0][1].qa.defects, { floating: 2 });
  assert.equal(patches[0][1].qa.defective, 2);
  // Test captures contribute to QA and improvement, retaining their provenance.
  svc.enqueueScene({ captureId: 'extras-test-1', sceneKey: 'gen_a', nowPath: imgA, imagePath: imgA, predictionPrompt: 'p', rulebookVersion: 3, sceneCount: 1, test: true });
  await svc.queue.idle();
  const all = fs.readFileSync(paths.qaFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(all.length, 3);
  assert.equal(all[2].test, true);
  assert.equal(all[2].captureId, 'extras-test-1');
  fs.rmSync(arch, { recursive: true, force: true });
  cleanup();
});

test('test QA counts a duplicate person as defective even when the general judge said ok', async () => {
  const {paths,cleanup}=tmpPaths();
  const img=path.join(paths.logsDir,'test.png');
  fs.mkdirSync(paths.logsDir,{recursive:true});fs.writeFileSync(img,Buffer.from('fake'));
  const svc=new QaService({isBusy:()=>false,paths,autoImprove:false,
    judge:async()=>({ok:true,score:1,defects:[],model:'m',elapsedMs:1}),
    inspectPeople:async()=>({ok:false,sourceCount:1,outputToSource:[0,0],reason:'duplicate original person'})});
  svc.enqueueScene({captureId:'test-duplicate',sceneKey:'gen_a',nowPath:img,imagePath:img,predictionPrompt:'move',rulebookVersion:16,sceneCount:1,test:true,expectedPeople:1});
  await svc.queue.idle();
  const row=JSON.parse(fs.readFileSync(paths.qaFile,'utf8').trim());
  assert.equal(row.test,true);assert.equal(row.ok,false);assert.equal(row.defects[0].type,'fabricated_person');
  cleanup();
});

test('an unavailable identity inspection cannot become a passed test QA verdict', async () => {
  const {paths,cleanup}=tmpPaths();
  const img=path.join(paths.logsDir,'test.png');
  fs.mkdirSync(paths.logsDir,{recursive:true});fs.writeFileSync(img,Buffer.from('fake'));
  const svc=new QaService({isBusy:()=>false,paths,autoImprove:false,
    judge:async()=>({ok:true,score:1,defects:[],model:'m',elapsedMs:1}),
    inspectPeople:async()=>{throw new Error('offline');}});
  svc.enqueueScene({captureId:'test-unknown',sceneKey:'gen_a',nowPath:img,imagePath:img,predictionPrompt:'move',rulebookVersion:16,sceneCount:1,test:true,expectedPeople:1});
  await svc.queue.idle();
  const row=JSON.parse(fs.readFileSync(paths.qaFile,'utf8').trim());
  assert.equal(row.ok,null);assert.match(row.error,/unavailable/);
  cleanup();
});


test('incomplete general or person inspection stays unknown even if the other inspection finds a defect', async () => {
  for (const generalUnknown of [true,false]) {
    const {paths,cleanup}=tmpPaths();
    const img=path.join(paths.logsDir,'test.png');fs.mkdirSync(paths.logsDir,{recursive:true});fs.writeFileSync(img,'fake');
    const svc=new QaService({isBusy:()=>false,paths,autoImprove:false,
      judge:async()=>({ok:generalUnknown?null:false,score:generalUnknown?null:0.5,
        defects:generalUnknown?[]:[{type:'floating',where:'desk',note:'hovering cup'}],model:'m',elapsedMs:1}),
      inspectPeople:async()=>({ok:generalUnknown?false:null,sourceCount:1,outputToSource:[0,0],reason:generalUnknown?'duplicate':'unavailable'}),
    });
    svc.enqueueScene({captureId:'test-partial',sceneKey:'gen_a',nowPath:img,imagePath:img,predictionPrompt:'move',rulebookVersion:17,sceneCount:3,test:true,expectedPeople:1});
    await svc.queue.idle();
    const row=JSON.parse(fs.readFileSync(paths.qaFile,'utf8').trim());
    assert.equal(row.ok,null);assert.equal(row.score,null);assert.equal(row.defects.length,1);
    assert.equal(row.sceneCount,3);assert.equal(row.disposition,'accepted');
    cleanup();
  }
});

test('rechecking one scene cannot impersonate completion of all expected scenes', async () => {
  const {paths,cleanup}=tmpPaths();
  const img=path.join(paths.logsDir,'test.png');fs.mkdirSync(paths.logsDir,{recursive:true});fs.writeFileSync(img,'fake');
  const patches:any[]=[];
  const svc=new QaService({isBusy:()=>false,paths,autoImprove:false,
    judge:async()=>({ok:true,score:1,defects:[],model:'m',elapsedMs:1}),
    events:{patch:(...args:any[])=>patches.push(args)} as any,
  });
  const job={captureId:'test-recheck',sceneKey:'gen_a',nowPath:img,imagePath:img,predictionPrompt:'move',rulebookVersion:17,sceneCount:3,test:true};
  for(let i=0;i<3;i++){svc.enqueueScene(job);await svc.queue.idle();}
  assert.equal(patches.length,0);
  for(const sceneKey of ['gen_b','gen_c']){svc.enqueueScene({...job,sceneKey});await svc.queue.idle();}
  assert.equal(patches.length,1);assert.equal(patches[0][1].qa.judged,3);
  cleanup();
});


test('composed preservation input and raw identity input remain separate',async()=>{
 const {paths,cleanup}=tmpPaths();const raw=path.join(paths.logsDir,'raw.png'),composed=path.join(paths.logsDir,'composed.png'),out=path.join(paths.logsDir,'out.png');fs.mkdirSync(paths.logsDir,{recursive:true});fs.writeFileSync(raw,'raw pixels');fs.writeFileSync(composed,'intentional prop');fs.writeFileSync(out,'generated');
 let preservation='',identity='';const svc=new QaService({isBusy:()=>false,paths,autoImprove:false,judge:(async(input:any)=>{preservation=input.nowImage;return {ok:true,score:1,defects:[],model:'stub',elapsedMs:1};})as any,inspectPeople:(async(source:string)=>{identity=source;return {ok:true,sourceCount:1,outputToSource:[0],reason:'stub'};})as any});
 svc.enqueueScene({captureId:'test-composed',sceneKey:'gen_a',nowPath:composed,identityNowPath:raw,imagePath:out,predictionPrompt:'p',rulebookVersion:17,sceneCount:1,expectedPeople:1,test:true});await svc.queue.idle();
 assert.equal(preservation,'data:image/png;base64,'+Buffer.from('intentional prop').toString('base64'));assert.equal(identity,'data:image/png;base64,'+Buffer.from('raw pixels').toString('base64'));cleanup();
});


import {createHash} from 'node:crypto';
import type {QaReferenceCastJob} from './qaService';
const referenceBytes=Buffer.from('private-reference-pixels');
const referenceMeta=():QaReferenceCastJob=>({sourcePeople:[{position:'center',pose:'seated',clothes:'white shirt',facing:'right'}],references:[{contentId:'upload-1',sha256:createHash('sha256').update(referenceBytes).digest('hex'),imageDataUrl:'data:image/png;base64,'+referenceBytes.toString('base64'),people:[{position:'left',pose:'standing',clothes:'blue shirt',facing:'front'}]}],distanceSec:15});
async function castServiceRun(config:{ids?:string[];observedCount?:number;observedOk?:boolean|null;general?:Partial<LocalJudgeResult>;inspectThrows?:boolean;expected?:number;mutate?:boolean;observedDefect?:string}={}){
 const {paths,cleanup}=tmpPaths();const img=path.join(paths.logsDir,'out.png');fs.mkdirSync(paths.logsDir,{recursive:true});fs.writeFileSync(img,'image');fs.writeFileSync(path.join(paths.logsDir,'cast_prompts.json'),JSON.stringify({scenes:[{sceneKey:'gen_b'}]}));
 const requests:any[]=[];let legacyCalls=0,referenceCalls=0;const meta=referenceMeta();
 const svc=new QaService({isBusy:()=>false,paths,autoImprove:false,
 judge:(async(args:any)=>{requests.push(args);return {ok:true,score:1,defects:[],model:'m',elapsedMs:1,...config.general};})as any,
 inspectPeople:async()=>{legacyCalls++;throw Error('legacy must not inspect explicit additions');},
 inspectReferenceCast:(async(_src:any,_out:any,people:any,refs:any)=>{referenceCalls++;if(config.inspectThrows)throw Error('offline');assert.equal(people[0].clothes,'white shirt');assert.equal(refs[0].contentId,'upload-1');return {ok:config.observedOk===undefined?true:config.observedOk,observedOriginalSourceCount:config.observedCount??1,outputToInventoryIds:config.ids??['ref:upload-1:0','source:0'],reason:'mock',...(config.observedDefect?{defect:config.observedDefect}:{}),imageDataUrl:'PRIVATE MUST NOT BE WRITTEN'};})as any});
 svc.enqueueScene({captureId:'cast-job',sceneKey:'gen_b',nowPath:img,imagePath:img,predictionPrompt:'add reference',archiveDir:paths.logsDir,rulebookVersion:1,sceneCount:1,expectedPeople:config.expected??1,referenceCast:meta});
 if(config.mutate){meta.sourcePeople[0].clothes='caller edit';meta.references[0].contentId='caller edit';}
 await svc.queue.idle();const raw=fs.readFileSync(paths.qaFile,'utf8'),row=JSON.parse(raw.trim()),archive=JSON.parse(fs.readFileSync(path.join(paths.logsDir,'cast_prompts.json'),'utf8'));cleanup();return {row,raw,archive,requests,legacyCalls,referenceCalls};
}
test('explicit reference job replaces source-only identity inspection and stores separate original/total/ID evidence without bytes',async()=>{
 const r=await castServiceRun({mutate:true});assert.equal(r.row.ok,true);assert.equal(r.legacyCalls,0);assert.equal(r.referenceCalls,1);assert.equal(r.requests.length,1);
 assert.deepEqual(r.requests[0].personInventory,{verified:true,originalSourceCount:1,expectedInventoryCount:2});
 assert.equal(r.row.referenceCastIntegrity.sourceCount,1);assert.equal(r.row.referenceCastIntegrity.expectedInventoryCount,2);
 assert.deepEqual(r.row.referenceCastIntegrity.outputToSource,[-1,0]);
 assert.doesNotMatch(r.raw+JSON.stringify(r.archive),/data:image|private-reference-pixels|PRIVATE MUST NOT BE WRITTEN|imageDataUrl/);
 assert.deepEqual(r.archive.scenes[0].qaLocal.referenceCastIntegrity,r.row.referenceCastIntegrity);
 assert.match(r.row.inspectionVersion,/reference-cast-v1$/);
});
test('false ok flag cannot authorize duplicate, unknown, missing, wrong-source-count or extra reference identities',async()=>{
 for(const config of [{ids:['source:0','source:0']},{ids:['source:0','unknown']},{ids:['source:0']},{ids:['source:0','ref:upload-1:0','ref:other:0']},{observedCount:2}]){
  const r=await castServiceRun(config);assert.equal(r.row.ok,false);assert.equal(r.requests[0].personInventory,undefined);assert.ok(r.row.defects.some((d:any)=>d.type==='fabricated_person'));
 }
});
test('reference-cast re-inspection carries the real pre-publish defect (framing_drift / extra_hand / missing_belongings), not fabricated_person',async()=>{
 for(const defect of ['framing_drift','extra_hand','missing_belongings']){
  const r=await castServiceRun({observedOk:false,observedDefect:defect});
  assert.equal(r.row.ok,false);assert.deepEqual(r.row.defects.map((d:any)=>d.type),[defect]);
 }
 const plain=await castServiceRun({observedOk:false});assert.deepEqual(plain.row.defects.map((d:any)=>d.type),['fabricated_person']);
});
test('unknown or unavailable cast inventory cannot pass and keeps general quality findings',async()=>{
 for(const config of [{observedOk:null},{inspectThrows:true}]){
  const r=await castServiceRun({...config,general:{ok:false,score:.75,defects:[{type:'anatomy',where:'hand',note:'malformed'}]}});
  assert.equal(r.row.ok,null);assert.equal(r.row.score,null);assert.equal(r.row.defects[0].type,'anatomy');assert.equal(r.requests[0].personInventory,undefined);assert.equal(r.legacyCalls,0);
 }
});
test('valid cast never overrides an object or anatomy failure; incomplete general QA remains unknown',async()=>{
 for(const ok of [false,null]){
  const r=await castServiceRun({general:{ok,score:ok===null?null:.5,defects:[{type:'lost_belongings',where:'cup',note:'missing'}]}});
  assert.equal(r.row.ok,ok);assert.equal(r.row.defects[0].type,'lost_belongings');
 }
});
test('job expectedPeople must remain original count rather than be inflated to allowed total',async()=>{
 const r=await castServiceRun({expected:2});assert.equal(r.referenceCalls,0);assert.equal(r.row.ok,null);assert.match(r.row.error,/original source count/);assert.equal(r.requests[0].personInventory,undefined);
});
