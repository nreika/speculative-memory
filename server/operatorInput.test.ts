import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createOperatorInputClient,OperatorInputError} from './operatorInput';

const secret='private_unit_test_token_not_for_logs_123456';
const env={TD_CONTROL_BRIDGE_URL:'http://100.100.0.2:8767',TD_CONTROL_BRIDGE_TOKEN_FILE:path.resolve('private-unit-token')};
const now=Date.parse('2026-10-18T12:00:00.000Z');
const run='1cbe83db49c342e992c32b98cebfd627';
// Synthetic 1x1 PNG fixture, no camera/photo/network access.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4l8AAAAASUVORK5CYII=','base64');
const dataUrl='data:image/png;base64,'+png.toString('base64');
const sha=createHash('sha256').update(png).digest('hex');
const state=():any=>({schema:1,inputKind:'test-replay',replay:{active:true,setId:'TSC-003',testRunId:run,currentFrameId:'TSC-003-F007',offsetSec:843.931,loop:1,cycle:false,pendingSet:null},history:{retained:1},sourceScope:'test:TSC-003',observedAtMs:now});
const frame=():any=>({schema:1,image:dataUrl,sha256:sha,sourceParams:{test:true,source:'test',recordHistory:false,testSceneId:'TSC-003',testFrameId:'TSC-003-F007',testRunId:run,testLoop:1,testSourceStartedAt:'2026-10-15T13:05:13.503Z'},sourceFrame:{id:'TSC-003-F007',file:'frames/TSC-003-F007.jpg',offsetSec:843.931,durationSec:140.452,originalCaptureId:'td-synthetic',originalStartedAt:'2026-10-15T13:05:13.503Z',sha256:sha,width:1,height:1,personVisibleReviewed:false},suggestedCaptureId:'test-TSC-003-F007-L001-1792322515117',state:state()});
const live=():any=>({schema:1,image:dataUrl,sha256:sha,sourceParams:{source:'live-camera',inputKind:'live-camera',sourceScope:'camera:main',capturedAt:new Date(now-500).toISOString()},sourceFrame:{id:'camera:main',sha256:sha,width:1,height:1},suggestedCaptureId:'camera-1792322515117-1234abcd',state:{schema:1,inputKind:'live-camera',replay:null,history:{},sourceScope:'camera:main',observedAtMs:now}});
const client=(get:()=>unknown,extra:any={})=>createOperatorInputClient({env,now:()=>now,readToken:async()=>secret,fetch:async()=>Response.json(get()),...extra});
const rejects=(promise:Promise<unknown>,code:string)=>assert.rejects(promise,(e:any)=>e instanceof OperatorInputError&&e.code===code&&!String(e).includes(secret)&&!String(e).includes(dataUrl));

test('fixed GET endpoints and bearer; preview has no schema; frame is deeply pinned',async()=>{
 const urls:string[]=[];let wire=frame();const c=client(()=>wire,{fetch:async(url:any,options:any)=>{urls.push(String(url));assert.equal(new Headers(options.headers).get('authorization'),'Bearer '+secret);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');return Response.json(wire);}});
 const f=await c.readFrame();assert.equal(f.sha256,sha);assert.ok(Object.isFrozen(f)&&Object.isFrozen(f.sourceParams)&&Object.isFrozen(f.state.replay));wire.sourceParams.testFrameId='mutated';assert.equal(f.sourceParams.testFrameId,'TSC-003-F007');
 wire=state();await c.readState();wire={kind:'replay',setId:'TSC-003',frameId:'TSC-003-F009',loop:1,observedAtMs:now,dataUrl};await c.readPreview();assert.deepEqual(urls.map(x=>new URL(x).pathname),['/api/input/frame','/api/input/state','/api/input/preview']);
});
test('replay source, run, loop, frame, timestamp, dimensions and SHA must agree',async()=>{
 const mutations=[(f:any)=>f.sha256='a'.repeat(64),(f:any)=>f.sourceFrame.sha256='a'.repeat(64),(f:any)=>f.sourceFrame.width=2,(f:any)=>f.sourceFrame.id='TSC-003-F008',(f:any)=>f.sourceParams.testRunId='a'.repeat(32),(f:any)=>f.sourceParams.testLoop=2,(f:any)=>f.sourceParams.testSceneId='TSC-002',(f:any)=>f.sourceParams.testSourceStartedAt='2026-10-16T00:00:00Z',(f:any)=>f.sourceParams.recordHistory=true,(f:any)=>f.state.replay.active=false,(f:any)=>f.suggestedCaptureId='test-unrelated',(f:any)=>f.sourceFrame.file='../secret.png'];
 for(const mutate of mutations){const f=frame();mutate(f);await rejects(client(()=>f).readFrame(),'INVALID_RESPONSE');}
});
test('malformed, foreign media and oversized dimensions are rejected',async()=>{
 for(const value of ['data:image/svg+xml;base64,AAAA','data:image/png;base64,AAAA',dataUrl+'\n']){const f=frame();f.image=value;await rejects(client(()=>f).readFrame(),'INVALID_RESPONSE');}
 const b=Buffer.from(png);b.writeUInt32BE(9000,16);const f=frame();f.image='data:image/png;base64,'+b.toString('base64');f.sha256=f.sourceFrame.sha256=createHash('sha256').update(b).digest('hex');f.sourceFrame.width=9000;await rejects(client(()=>f).readFrame(),'INVALID_RESPONSE');
});
test('JPEG marker dimensions and hash are validated without invoking image decoders',async()=>{
 const b=Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,2,0,3,1,1,0x11,0,0xff,0xd9]);const f=frame();f.image='data:image/jpeg;base64,'+b.toString('base64');f.sha256=f.sourceFrame.sha256=createHash('sha256').update(b).digest('hex');f.sourceFrame.width=3;f.sourceFrame.height=2;assert.equal((await client(()=>f).readFrame()).sourceFrame.height,2);
});
test('live frame accepts confirmed contract but rejects stale, future and replay contamination',async()=>{
 assert.equal((await client(live).readFrame()).sourceParams.source,'live-camera');
 for(const mutate of [(f:any)=>f.sourceParams.capturedAt=new Date(now-2001).toISOString(),(f:any)=>f.sourceParams.capturedAt=new Date(now+2001).toISOString(),(f:any)=>f.sourceParams.test=true,(f:any)=>f.state.sourceScope='other',(f:any)=>f.sourceFrame.id='other']){const f=live();mutate(f);await rejects(client(()=>f).readFrame(),'INVALID_RESPONSE');}
 assert.equal((await client(()=>({kind:'camera',observedAtMs:now,dataUrl})).readPreview()).kind,'camera');
});
test('select emits finite validated payload exactly once and accepts naked state',async()=>{
 let calls=0;const c=client(state,{fetch:async(url:any,options:any)=>{calls++;assert.equal(new URL(String(url)).pathname,'/api/input/select');assert.equal(options.method,'POST');assert.equal(new Headers(options.headers).get('x-control-request'),'1');assert.deepEqual(JSON.parse(options.body),{setId:'cycle',requestId:'request_1234'});return Response.json(state());}});
 const result=await c.select({setId:'cycle',requestId:'request_1234'});assert.equal(result.requestId,'request_1234');assert.equal(result.state.inputKind,'test-replay');assert.equal(calls,1);
 for(const payload of [{setId:'other',requestId:'request_1234'},{setId:'camera',requestId:'x'},{setId:'camera',requestId:'request_1234',url:'http://elsewhere'}])await rejects(c.select(payload as any),'CONFIGURATION');assert.equal(calls,1);
});
test('select timeout after dispatch is indeterminate with no retry',async()=>{
 let calls=0;const c=client(state,{timeoutMs:10,fetch:async()=>{calls++;return new Promise<Response>(()=>{});}});await rejects(c.select({setId:'camera',requestId:'request_1234'}),'INDETERMINATE');assert.equal(calls,1);
});
test('late authorization cannot dispatch mutation after timeout',async()=>{
 let calls=0,release!:(s:string)=>void;const c=client(state,{timeoutMs:10,readToken:()=>new Promise<string>(r=>release=r),fetch:async()=>{calls++;return Response.json(state());}});await rejects(c.select({setId:'camera',requestId:'request_1234'}),'TIMEOUT');release(secret);await new Promise(r=>setTimeout(r,5));assert.equal(calls,0);
});
test('select transport, 5xx and malformed success are indeterminate; 4xx is explicit rejection',async()=>{
 for(const fetcher of [async()=>{throw Error(secret);},async()=>Response.json({error:secret},{status:503}),async()=>Response.json({bad:secret})])await rejects(client(state,{fetch:fetcher}).select({setId:'TSC-001',requestId:'request_1234'}),'INDETERMINATE');
 await rejects(client(state,{fetch:async()=>Response.json({error:secret},{status:400})}).select({setId:'camera',requestId:'request_1234'}),'HTTP_REJECTED');
});
test('GET timeouts, HTTP errors, invalid JSON and body limits never expose private payload',async()=>{
 await rejects(client(state,{timeoutMs:10,fetch:async()=>new Promise<Response>(()=>{})}).readFrame(),'TIMEOUT');
 await rejects(client(state,{fetch:async()=>Response.json({error:secret},{status:503})}).readFrame(),'HTTP_REJECTED');
 await rejects(client(state,{fetch:async()=>new Response(secret)}).readState(),'INVALID_RESPONSE');
 await rejects(client(state,{fetch:async()=>new Response('{}',{headers:{'content-length':String(49*1024*1024)}})}).readState(),'INVALID_RESPONSE');
});
test('bad bridge configuration fails before reading token or fetching',async()=>{
 for(const url of ['http://127.0.0.1:8767','http://100.63.0.1:8767','http://100.128.0.1:8767','https://100.77.14.9:8767','http://100.77.14.9:8767/other','http://user@100.77.14.9:8767','http://100.77.14.9:8767/?q=1']){let calls=0;const c=client(state,{env:{...env,TD_CONTROL_BRIDGE_URL:url},readToken:async()=>{calls++;return secret;},fetch:async()=>{calls++;return Response.json(state());}});await rejects(c.readState(),'CONFIGURATION');assert.equal(calls,0);}
});
test('token read failure and malformed token are sanitized and never dispatched',async()=>{
 for(const readToken of [async()=>{throw Error(secret);},async()=>secret+'\ninvalid']){let calls=0;const c=client(state,{readToken,fetch:async()=>{calls++;return Response.json(state());}});await rejects(c.readState(),'AUTH_UNAVAILABLE');assert.equal(calls,0);}
});

test('live-camera state with the bridge idle replay object is accepted and normalised (2026-10-19 camera switch 504)',async()=>{
 const live={schema:1,inputKind:'live-camera',sourceScope:'camera:main',observedAtMs:1792417190738,replay:{active:false,setId:null,cycle:false,pendingSet:null},history:'',camera:{index:0,ready:true,error:''}};
 const state=await client(()=>live).readState();
 assert.equal(state.inputKind,'live-camera');assert.equal(state.replay,null);
 const bad={...live,replay:{active:true,setId:null,cycle:false,pendingSet:null}};
 await assert.rejects(client(()=>bad).readState(),OperatorInputError);
});
