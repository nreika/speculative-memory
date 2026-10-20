import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {createTdDisplayTimingReader} from './tdDisplayTiming';
const secret='unit_test_private_token_never_published_123456';
const env={TD_CONTROL_BRIDGE_URL:'http://100.100.0.2:8767',TD_CONTROL_BRIDGE_TOKEN_FILE:path.resolve('private-unit-token')};
test('reader shares inflight fetch, TTL caches and forwards bearer only to configured upstream state',async()=>{
 let n=0,now=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const read=createTdDisplayTimingReader({env,now:()=>now,ttlMs:100,readToken:async()=>secret,fetch:async(url,options)=>{n++;assert.equal(url,'http://100.100.0.2:8767/api/td-control/state');assert.equal(options?.headers&&new Headers(options.headers).get('Authorization'),'Bearer '+secret);assert.equal(options?.redirect,'error');await gate;return Response.json({settings:{displayTiming:'each'}});}});
 const a=read(),b=read();assert.equal(a,b);release();assert.deepEqual(await Promise.all([a,b]),['each','each']);assert.equal(n,1);assert.equal(await read(),'each');assert.equal(n,1);now=101;assert.equal(await read(),'each');assert.equal(n,2);
});
test('invalid enum, transport error and rejected status keep last confirmed mode; unknown starts all',async()=>{
 let mode:any='typo',fail=false,status=200;const read=createTdDisplayTimingReader({env,ttlMs:0,readToken:async()=>secret,fetch:async()=>{if(fail)throw Error(secret);return Response.json({settings:{displayTiming:mode}},{status});}});
 assert.equal(await read(),'all');mode='each';assert.equal(await read(),'each');mode='all';assert.equal(await read(),'all');mode='each';assert.equal(await read(),'each');mode='typo';assert.equal(await read(),'each');fail=true;assert.equal(await read(),'each');fail=false;status=503;assert.equal(await read(),'each');
});
test('timeout returns last mode even if injected fetch ignores abort',async()=>{
 const read=createTdDisplayTimingReader({env,timeoutMs:10,readToken:async()=>secret,fetch:async()=>new Promise<Response>(()=>{})});const started=Date.now();assert.equal(await read(),'all');assert.ok(Date.now()-started<500);
});
test('bad configuration never reads private file or sends requests; secret errors never surface',async()=>{
 for(const url of ['http://127.0.0.1:3000','http://example.com:8767','http://100.100.0.2:8767/path','http://user@100.100.0.2:8767','http://100.100.0.2:8767/?query=1']){
  let calls=0;const read=createTdDisplayTimingReader({env:{...env,TD_CONTROL_BRIDGE_URL:url},readToken:async()=>{calls++;throw Error(secret);},fetch:async()=>{calls++;throw Error(secret);}});assert.equal(await read(),'all');assert.equal(calls,0);
 }
 const read=createTdDisplayTimingReader({env,readToken:async()=>{throw Error(secret);}});assert.equal(await read(),'all');
});

const state=(layout=['A','B','C','NOW'],visible=true)=>({settings:{displayTiming:'each',labels:true,subtitles:false,fade:true},display:{layout,visible},privateField:'not published'});
test('routing shares the same response/cache with mode and validates only whitelisted fields',async()=>{
 let calls=0,now=0,data:any=state();const read=createTdDisplayTimingReader({env,now:()=>now,ttlMs:100,readToken:async()=>secret,fetch:async()=>{calls++;return Response.json(data);}});
 const [mode,routing]=await Promise.all([read(),read.readRouting()]);assert.equal(mode,'each');assert.equal(calls,1);assert.deepEqual(routing,{slots:{'td-1':'a','td-2':'b','td-3':'c','td-4':'now'},view:{visible:true,labels:true,subtitles:false,fade:true}});assert.equal('privateField'in routing!,false);
 routing!.slots['td-1']='now';assert.equal((await read.readRouting())?.slots['td-1'],'a');assert.equal(calls,1);
 data=state(['NOW','C','A','B'],false);now=101;assert.equal(await read(),'each');assert.equal((await read.readRouting())?.slots['td-1'],'now');assert.equal((await read.readRouting())?.view.visible,false);assert.equal(calls,2);
});
test('missing or invalid routing stays unknown initially then retains last confirmed routing',async()=>{
 let now=0,data:any={settings:{displayTiming:'all'}};const read=createTdDisplayTimingReader({env,now:()=>now,ttlMs:1,readToken:async()=>secret,fetch:async()=>Response.json(data)});assert.equal(await read.readRouting(),undefined);
 data=state();now++;const previous=await read.readRouting();
 for(const invalid of [state(['A','B','C','D']),{...state(),settings:{...state().settings,labels:'true'}},{...state(),display:{layout:['A','B','C','NOW'],visible:1}}]){data=invalid;now++;assert.deepEqual(await read.readRouting(),previous);}
});
test('routing timeout retains confirmed state and a late response cannot alter cached values',async()=>{
 let now=0,late=false,release!:(value:Response)=>void;const read=createTdDisplayTimingReader({env,now:()=>now,ttlMs:100,timeoutMs:10,readToken:async()=>secret,fetch:async()=>late?new Promise<Response>(r=>release=r):Response.json(state())});
 const previous=await read.readRouting();late=true;now=101;assert.equal(await read(),'each');assert.deepEqual(await read.readRouting(),previous);release(Response.json(state(['NOW','NOW','NOW','NOW'],false)));await new Promise(r=>setTimeout(r,0));assert.deepEqual(await read.readRouting(),previous);
});
