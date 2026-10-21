import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type {AddressInfo} from 'node:net';
import {createOperatorLibrary} from './operatorLibrary';
import {createScenarioSubmissions,createScenarioSubmitRouter,parseMultipart,sanitizeFilename,SUBMISSION_SIDECAR} from './scenarioSubmit';
import {createNativeOperator} from './nativeOperator';
import type {OperatorInputClient} from './operatorInput';

const python=process.env.OPERATOR_TEST_PYTHON??path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const GOOD='seconds,action,target,value\n0,scenario,,SCN-EXT-TEST\n0,layout,,B|NOW|A|C\n10,end,,\n';
const PNG=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(32)]);

async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'scenario-submit-'));
 const library=createOperatorLibrary(root,python);const notes:string[]=[];
 const service=createScenarioSubmissions({root,library,onSubmitted:s=>notes.push(s.name)});
 const app=express();app.use(createScenarioSubmitRouter(()=>service));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
 const post=(form:FormData,headers:Record<string,string>={})=>fetch(base+'/api/scenario-submit',{method:'POST',headers:{'X-Submit-Request':'1',...headers},body:form});
 return {root,library,service,notes,base,post,close:async()=>{server.close();await fs.rm(root,{recursive:true,force:true});}};
}
const form=(o:{mode?:string;name?:string;note?:string;csv?:string|Buffer;csvName?:string;images?:{name:string;data:Buffer}[]}={})=>{
 const f=new FormData();if(o.mode)f.append('mode',o.mode);f.append('name',o.name??'Visitor A');if(o.note)f.append('note',o.note);
 f.append('csv',new Blob([o.csv??GOOD]),o.csvName??'my scenario.csv');for(const i of o.images??[])f.append('images',new Blob([i.data]),i.name);return f;
};

test('multipart parser and filename sanitising',()=>{
 const body=Buffer.from('--b\r\nContent-Disposition: form-data; name="name"\r\n\r\nX\r\n--b\r\nContent-Disposition: form-data; name="csv"; filename="a.csv"\r\nContent-Type: text/csv\r\n\r\nhello\r\n--b--\r\n');
 const parsed=parseMultipart(body,'multipart/form-data; boundary=b');
 assert.equal(parsed.fields.name,'X');assert.equal(parsed.files[0].data.toString(),'hello');
 assert.equal(sanitizeFilename('..\\..\\evil/../x y?.CSV',['.csv']),'x y_.csv');
 assert.equal(sanitizeFilename('.csv',['.csv']),null);assert.equal(sanitizeFilename('.hidden.csv',['.csv']),'f.hidden.csv');
 assert.equal(sanitizeFilename('_a.png',['.png']),'f_a.png');
});

test('submit: page, check without saving, validation errors, oversize, image magic, success with sidecar, rate limit',async()=>{
 const f=await fixture();
 try{
  const page=await fetch(f.base+'/submit/');assert.equal(page.status,200);assert.match(await page.text(),/Send a scenario/);
  assert.equal((await fetch(f.base+'/submit/other.html')).status,404);
  assert.equal((await fetch(f.base+'/api/scenario-submit',{method:'POST',body:form()})).status,403,'needs X-Submit-Request');
  assert.equal((await f.post(form(),{Origin:'https://evil.example'})).status,403);

  const checked=await f.post(form({mode:'check'}));const cj=await checked.json();
  assert.equal(checked.status,200,JSON.stringify(cj));assert.equal(cj.checked,true);assert.equal(cj.scenarioId,'SCN-EXT-TEST');
  assert.deepEqual((await f.library.list()),[],'check saves nothing');

  const bad=await f.post(form({csv:'seconds,action,target,value\n0,explode,,1\n'}));const bj=await bad.json();
  assert.equal(bad.status,400);assert.match(bj.error,/FORMAT ERROR/);assert.ok(bj.formatErrors.length>0);
  assert.equal((await f.post(form({name:''}))).status,400);
  assert.equal((await f.post(form({name:'x'.repeat(41)}))).status,400);
  assert.equal((await f.post(form({csv:Buffer.alloc(2*1024*1024+10,0x41)}))).status,413,'CSV > 2 MB');
  assert.equal((await f.post(form({images:[{name:'big.png',data:Buffer.concat([PNG,Buffer.alloc(5*1024*1024)])}]}))).status,413,'image > 5 MB');
  const fake=await f.post(form({images:[{name:'pic.png',data:Buffer.from('GIF89a not a png at all')}]}));
  assert.equal(fake.status,400);assert.match((await fake.json()).error,/not a real PNG/);
  assert.equal((await f.post(form({images:[{name:'x.gif',data:PNG}]}))).status,400);
  assert.deepEqual((await f.library.list()),[],'nothing stored by failures');

  const ok=await f.post(form({note:'hello operator',images:[{name:'unused.png',data:PNG}]}));const oj=await ok.json();
  assert.equal(ok.status,200,JSON.stringify(oj));assert.equal(oj.ok,true);assert.equal(oj.scenarioId,'SCN-EXT-TEST');assert.ok(Array.isArray(oj.warnings));
  const folder=path.join(f.root,'browser-imports',oj.id);
  const sidecar=JSON.parse(await fs.readFile(path.join(folder,SUBMISSION_SIDECAR),'utf8'));
  assert.equal(sidecar.origin,'external');assert.equal(sidecar.approved,false);assert.equal(sidecar.name,'Visitor A');assert.equal(sidecar.note,'hello operator');assert.ok(Date.parse(sidecar.submittedAt));
  assert.ok((await fs.readdir(folder)).includes('my scenario.csv'));
  assert.deepEqual(f.notes,['Visitor A']);
  f.library.forget();const rows=f.service.decorate(await f.library.list());
  assert.equal(rows.length,1);assert.equal(rows[0].external?.approved,false);assert.equal(rows[0].external?.name,'Visitor A');

  // 10 submissions per hour per key (the failed ones above count too): the next one is 429.
  let last=0;for(let i=0;i<12&&last!==429;i++)last=(await f.post(form({name:'R'+i}))).status;
  assert.equal(last,429);
  assert.equal((await f.post(form({mode:'check'}))).status,200,'checks have their own budget');
  // Another gate submitter (different X-Submit-Key from loopback) has its own budget.
  assert.equal((await f.post(form({name:'Other'}),{'X-Submit-Key':'abcdef0123456789abcdef0123456789'})).status,200);
 }finally{await f.close();}
});

test('approve gate: unapproved external scenario cannot be loaded or played; approve enables, delete removes the folder',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'native-operator-submit-'));
 await fs.mkdir(path.join(directory,'scenarios'));
 await fs.writeFile(path.join(directory,'bootstrap-state.json'),JSON.stringify({schema:1,settings:{mode:'manual',intervalSec:70,imageCount:3,presence:.3,tone:.3,vlmBackend:'local',imageBackend:'local',displayTiming:'each',scenarioPreview:true,labels:false,subtitles:true,fade:false,scenes:{a:{distanceSec:15,continuous:'',oneShot:''},b:{distanceSec:30,continuous:'',oneShot:''},c:{distanceSec:-30,continuous:'',oneShot:''}}},display:{layout:['NOW','C','A','B'],visible:true},scenario:{file:'SCN-001.csv'},replay:{active:false},history:''}));
 await fs.writeFile(path.join(directory,'scenarios','SCN-001.csv'),'seconds,action,target,value\n0,scenario,,SCN-001\n0,layout,,B|NOW|A|C\n180,end,,\n');
 const state={schema:1 as const,inputKind:'live-camera' as const,replay:null,history:'',sourceScope:'camera:main',observedAtMs:Date.now()};
 const input:OperatorInputClient={readState:async()=>state as any,readPreview:async()=>{throw Error('unused');},readFrame:async()=>{throw Error('unused');},select:async r=>({...r,state}) as any};
 const op=await createNativeOperator({directory,python,input,isBusy:()=>false,capture:()=>({active:null}),cancel:()=>{},readScenes:async()=>({}),invokeGenerate:async()=>{throw Error('Unexpected generation');}});
 const act=(action:string,data:Record<string,unknown>={})=>op.handle({method:'POST',route:'/native/action',payload:{action,requestId:'r-'+Math.random(),data}}) as Promise<any>;
 try{
  const boundary='----t';const body=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nGuest\r\n--${boundary}\r\nContent-Disposition: form-data; name="csv"; filename="ext.csv"\r\n\r\n${GOOD}\r\n--${boundary}--\r\n`);
  const sub=await op.submissions.receive(body,'multipart/form-data; boundary='+boundary,'test') as any;
  const file=`browser-imports/${sub.id}/ext.csv`;
  const listed=(await op.state.snapshot() as any).scenarioLibrary.find((r:any)=>r.file===file);
  assert.equal(listed?.external?.approved,false);
  assert.ok((await op.state.snapshot() as any).warnings.some((w:any)=>w.message.startsWith('New external scenario: Guest')));
  const refused=await act('scenario.load',{file});assert.equal(refused.status,403);assert.match(refused.body.error,/not approved/);
  assert.equal((await op.state.snapshot() as any).scenario.file,'SCN-001.csv','nothing loaded');
  // Even if the plan were loaded some other way, Play re-checks approval.
  await assert.rejects(op.submissions.assertPlayable(file),/not approved/);
  const approved=await op.handle({method:'POST',route:'/api/td-control/scenario-submission',payload:{action:'approve',id:sub.id}}) as any;
  assert.equal(approved.body.ok,true);
  assert.equal((await act('scenario.load',{file})).body?.ok??true,true);
  assert.equal((await op.state.snapshot() as any).scenario.file,file);
  const busyDelete=await op.handle({method:'POST',route:'/api/td-control/scenario-submission',payload:{action:'delete',id:sub.id}}) as any;
  assert.equal(busyDelete.status,409,'loaded scenario cannot be deleted');
  await act('scenario.load',{file:'SCN-001.csv'});
  const deleted=await op.handle({method:'POST',route:'/api/td-control/scenario-submission',payload:{action:'delete',id:sub.id}}) as any;
  assert.equal(deleted.body.ok,true);
  await assert.rejects(fs.stat(path.join(directory,'scenarios','browser-imports',sub.id)));
 }finally{op.close();await new Promise(r=>setTimeout(r,25));await fs.rm(directory,{recursive:true,force:true});}
});
