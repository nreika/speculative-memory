import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createScenarioRunArchive,registerScenarioRunRoutes,csvSha256} from './scenarioRunArchive';
import {CaptureEventStore,type CaptureEvent} from './events/captureEvents';
import {registerEventRoutes} from './events/routes';

const temp=()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scenario-runs-'));return{dir,close(){assert.ok(path.basename(dir).startsWith('scenario-runs-'));fs.rmSync(dir,{recursive:true,force:true});}};};
const csv='seconds,action,target,value\n0,scenario,,SCN-SIMPLE-001\n0,mode,,timer\n240,end,,\n';

test('begin copies the exact CSV, writes a sidecar and a start row; finish updates sidecar and appends the end row',()=>{
 const t=temp();try{
  let clock=Date.parse('2026-10-20T07:36:26.000Z');const a=createScenarioRunArchive({logsDirectory:t.dir,now:()=>new Date(clock)});
  const started=a.begin({runId:'run1',scenarioId:'SCN-SIMPLE-001',file:'SCN-SIMPLE-001.csv',csvText:csv,outputsChanged:[{id:'screen-1',patch:{source:'a'}}]});
  assert.equal(started.csvFile,'2026-10-20T07-36-26-000Z_SCN-SIMPLE-001_run1.csv');assert.equal(started.sha256,csvSha256(csv));
  assert.equal(fs.readFileSync(path.join(t.dir,'scenario-runs',started.csvFile),'utf8'),csv);
  assert.equal(a.list()[0].endedAt,null);a.note('run1',{captureId:'cap-1'});a.note('run1',{captureId:'cap-1'});
  clock+=240000;const done=a.finish('run1',{endReason:'end',cuesApplied:12,cueIds:['row-0004'],settingsCues:[{cueId:'row-0008',change:'mode=timer'}],restored:['submissionHold=true']})!;
  assert.equal(done.endedAt,'2026-10-20T07:40:26.000Z');assert.deepEqual(done.captureIds,['cap-1']);assert.equal(done.outputsChanged.length,1);
  const sidecar=JSON.parse(fs.readFileSync(path.join(t.dir,'scenario-runs',started.csvFile.replace('.csv','.json')),'utf8'));
  assert.equal(sidecar.endReason,'end');assert.equal(sidecar.cuesApplied,12);assert.equal(sidecar.sha256,csvSha256(csv));
  const rows=fs.readFileSync(path.join(t.dir,'scenario-runs.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));assert.equal(rows.length,2);assert.equal(rows[1].endReason,'end');
  assert.equal(a.list().length,1);assert.equal(a.get('run1')!.endReason,'end');assert.equal(a.readCsv('run1'),csv);
  assert.equal(a.readCsv('../etc'),null);assert.equal(a.get('nope'),null);assert.equal(a.finish('run1',{endReason:'stop'}),null,'finish only once');
 }finally{t.close();}
});
test('a run left open by a restart is closed as error at startup; the CSV copy is never rewritten',()=>{
 const t=temp();try{
  const first=createScenarioRunArchive({logsDirectory:t.dir});first.begin({runId:'open1',scenarioId:'X',file:'x.csv',csvText:csv});
  const second=createScenarioRunArchive({logsDirectory:t.dir});second.closeInterrupted();
  const run=second.get('open1')!;assert.equal(run.endReason,'error');assert.ok(run.endedAt);assert.equal(second.readCsv('open1'),csv);
 }finally{t.close();}
});
test('routes: list, sidecar and exact CSV copy; unknown run is 404',()=>{
 const t=temp();try{
  const a=createScenarioRunArchive({logsDirectory:t.dir});a.begin({runId:'r2',scenarioId:'S',file:'s.csv',csvText:csv});
  const gets=new Map<string,Function>();registerScenarioRunRoutes({get:(route:string,fn:any)=>gets.set(route,fn)},a);
  const res=()=>{const r:any={headers:{},code:200,body:undefined,type:'',setHeader(k:string,v:string){r.headers[k]=v;},status(c:number){r.code=c;return r;},json(v:unknown){r.body=v;return r;},type_(v:string){r.type=v;return r;},send(v:unknown){r.body=v;return r;}};r.type=(v:string)=>{r.contentType=v;return r;};return r;};
  let r=res();gets.get('/api/scenario-runs')!({params:{}},r);assert.equal(r.body.runs[0].runId,'r2');
  r=res();gets.get('/api/scenario-runs/:runId/csv')!({params:{runId:'r2'}},r);assert.equal(r.body,csv);assert.match(r.contentType,/text\/plain/);
  r=res();gets.get('/api/scenario-runs/:runId')!({params:{runId:'r2'}},r);assert.equal(r.body.scenarioId,'S');
  r=res();gets.get('/api/scenario-runs/:runId/csv')!({params:{runId:'missing'}},r);assert.equal(r.code,404);
 }finally{t.close();}
});
test('timeline rows carry scenarioRun and the response lists scenario runs for History bands',()=>{
 const t=temp();try{
  const file=path.join(t.dir,'capture-events.jsonl');
  const row:CaptureEvent={captureId:'cap-1',startedAt:'2026-10-20T07:37:26.000Z',result:'completed',executionSource:'timer',scenarioRun:{runId:'r3',scenarioId:'SCN-SIMPLE-001',csvSha:csvSha256(csv)}};
  fs.writeFileSync(file,JSON.stringify(row)+'\n'+JSON.stringify({captureId:'cap-2',startedAt:'2026-10-20T08:00:00.000Z',result:'completed'})+'\n');
  const store=new CaptureEventStore(file),a=createScenarioRunArchive({logsDirectory:t.dir});a.begin({runId:'r3',scenarioId:'SCN-SIMPLE-001',file:'SCN-SIMPLE-001.csv',csvText:csv,startedAt:'2026-10-20T07:36:26.000Z'});a.finish('r3',{endReason:'end'});
  const gets=new Map<string,Function>();registerEventRoutes({get:(route:string,fn:any)=>gets.set(route,fn),post:()=>{}} as any,store,{scenarioRuns:a});
  let body:any;gets.get('/api/events/timeline')!({query:{}},{setHeader(){},json(v:unknown){body=v;},status(){return this;}});
  assert.deepEqual(body.events.find((e:any)=>e.captureId==='cap-1').scenarioRun,row.scenarioRun);assert.equal(body.events.find((e:any)=>e.captureId==='cap-2').scenarioRun,undefined);
  assert.equal(body.scenarioRuns.length,1);assert.equal(body.scenarioRuns[0].runId,'r3');assert.equal(body.scenarioRuns[0].sha256,csvSha256(csv));assert.equal(body.scenarioRuns[0].endReason,'end');
 }finally{t.close();}
});
