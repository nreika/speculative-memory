import test from 'node:test';
import assert from 'node:assert/strict';
import {RemoteCameraStore,withRemoteCamera,jpegSize} from './remoteCamera';
import type {OperatorInputClient} from './operatorInput';
import {buildOperatorGenerationBody,type OperatorGenerationSettings} from './operatorGeneration';
import {captureInputIdentity} from './events/captureEvents';

const jpeg=(w:number,h:number,tag=0)=>Buffer.from([0xff,0xd8,0xff,0xc0,0x00,0x11,0x08,h>>8,h&255,w>>8,w&255,0x03,0x01,0x22,0x00,0x02,0x11,0x01,0x03,0x11,0x01,0xff,0xda,0x00,0x08,0x01,0x01,0x00,0x00,0x3f,0x00,tag,0xff,0xd9]);
const settings=():OperatorGenerationSettings=>({scenes:{a:{distanceSec:15,continuous:'',oneShot:''},b:{distanceSec:30,continuous:'',oneShot:''},c:{distanceSec:-110,continuous:'',oneShot:''}},presence:.7,tone:.4,vlmBackend:'local',imageBackend:'local',imageCount:1,notify:true,test:false,source:'browser'} as any);

function base(){
 const calls:string[]=[];
 const client:OperatorInputClient={readState:async()=>{calls.push('state');return {schema:1,inputKind:'test-replay',replay:null,history:'laptop history',sourceScope:'test:TSC-001',observedAtMs:1};},readPreview:async()=>{calls.push('preview');return {kind:'replay',dataUrl:'x',observedAtMs:1};},readFrame:async()=>{calls.push('frame');return {laptop:true} as any;},select:async r=>{calls.push('select:'+r.setId);return {requestId:r.requestId,setId:r.setId,state:{} as any};}};
 return {client,calls};
}

test('remote frame store: JPEG 1280x720 only, fresh until REMOTE_STALE_SEC then stale',()=>{
 let t=1_800_000_000_000;const store=new RemoteCameraStore({now:()=>t,staleSec:()=>30});
 assert.equal(store.state(),'none');assert.equal(store.fresh(),null);
 assert.deepEqual(jpegSize(jpeg(1280,720)),{width:1280,height:720});
 assert.throws(()=>store.setFrame(Buffer.from('not a jpeg'),'devicea1'),/JPEG/);
 assert.throws(()=>store.setFrame(jpeg(720,1280),'devicea1'),/1280x720/);
 assert.throws(()=>store.setFrame(Buffer.alloc(3*1024*1024),'devicea1'),/too large/);
 store.setFrame(jpeg(1280,720),'devicea1');assert.equal(store.state(),'fresh');
 t+=30_000;assert.equal(store.state(),'fresh');
 t+=1;assert.equal(store.state(),'stale');assert.equal(store.fresh(),null);assert.equal(store.status().ageSec,30);
});

test('input selection: laptop sources untouched until remote-device is selected; stale remote refuses frames',async()=>{
 let t=Date.parse('2026-10-19T01:00:00Z');const store=new RemoteCameraStore({now:()=>t,staleSec:()=>30});const {client,calls}=base();
 const input=withRemoteCamera(client,store);
 assert.deepEqual(await input.readFrame(),{laptop:true});await input.readPreview();await input.readState();assert.deepEqual(calls,['frame','preview','state']);
 await input.select({setId:'remote-device',requestId:'request-0001'});assert.equal(store.selected,true);assert.ok(!calls.includes('select:remote-device'),'laptop bridge is not told');
 await assert.rejects(input.readFrame(),/remote camera stale \(no frame received yet\)/);
 store.setFrame(jpeg(1280,720),'devicea1');
 const state=await input.readState();assert.equal(state.inputKind,'live-camera');assert.equal(state.sourceScope,'camera:remote');assert.equal(state.history,'laptop history');
 const frame:any=await input.readFrame();
 assert.equal(frame.sourceParams.sourceScope,'camera:remote');assert.equal(frame.sourceFrame.id,'camera:remote');assert.match(frame.suggestedCaptureId,/^remote-\d{13}-[a-f0-9]{8}$/);
 assert.equal(frame.sourceParams.capturedAt,new Date(t).toISOString());
 // Treated as live input: writes venue history, never test-isolated.
 const body=buildOperatorGenerationBody(frame,settings(),undefined,new Date(t+1000).toISOString());
 assert.equal(body.test,false);assert.equal(body.recordHistory,true);assert.equal(body.sourceScope,'camera:remote');
 assert.deepEqual(captureInputIdentity({sourceScope:'camera:remote'},false),{kind:'live-camera',id:'camera:remote'});
 assert.throws(()=>buildOperatorGenerationBody({...frame,suggestedCaptureId:'camera-'+frame.suggestedCaptureId.slice(7)},settings(),undefined,new Date(t).toISOString()),'remote frames keep their remote- id');
 t+=31_000;await assert.rejects(input.readFrame(),/remote camera stale \(last frame 31 s ago\)/);
 await input.select({setId:'camera',requestId:'request-0002'});assert.equal(store.selected,false);assert.ok(calls.includes('select:camera'));
 assert.deepEqual(await input.readFrame(),{laptop:true});
});

test('wrapped client keeps openPreviewStream and the real bridge live-camera state streams',async()=>{
 const {servePreviewStream}=await import('./operatorInput');
 const realState={schema:1,inputKind:'live-camera',sourceScope:'camera:main',observedAtMs:1,replay:{active:false,setId:null,cycle:false,pendingSet:null},history:'',camera:{index:1,ready:true,error:''}};
 const base:any={readState:async()=>realState,readPreview:async()=>({}),readFrame:async()=>({}),select:async()=>({}),openPreviewStream:async()=>new Response('--frame\r\n',{headers:{'content-type':'multipart/x-mixed-replace; boundary=frame'}})};
 const store=new RemoteCameraStore();const wrapped=withRemoteCamera(base,store);
 const chunks:Buffer[]=[];const res:any={code:0,headers:{},headersSent:false,status(n:number){res.code=n;return res;},setHeader(k:string,v:string){res.headers[k.toLowerCase()]=v;},flushHeaders(){res.headersSent=true;},json(b:any){res.body=b;res.headersSent=true;return res;},write(b:Buffer){chunks.push(b);return true;},end(){},on(){}};
 await servePreviewStream(wrapped,async()=>!store.selected&&(await wrapped.readState()).inputKind==='live-camera',{on(){}},res);
 assert.equal(res.code,200);assert.equal(Buffer.concat(chunks).toString(),'--frame\r\n');
});

test('single active remote device: first holds, second 409, stale replaced, release frees, status has holder',()=>{
 let t=1_800_000_000_000;const store=new RemoteCameraStore({now:()=>t,staleSec:()=>30});
 assert.equal(store.status().holder,null);
 store.setFrame(jpeg(1280,720,1),'aaaa1111-a');assert.equal(store.holder(),'aaaa1111-a');
 const s=store.status();assert.equal(s.holder,'aaaa1111-a');assert.equal(s.holderShort,'aaaa');
 t+=5_000;
 assert.throws(()=>store.setFrame(jpeg(1280,720,2),'bbbb2222-b'),(e:any)=>e.status===409&&e.detail.ageSec===5&&typeof e.detail.holderSince==='string');
 assert.equal(store.holder(),'aaaa1111-a');
 t+=20_000;store.setFrame(jpeg(1280,720,3),'aaaa1111-a');t+=30_001; // holder keeps slot while frames arrive, then goes stale
 assert.equal(store.holder(),null);store.setFrame(jpeg(1280,720,4),'bbbb2222-b');assert.equal(store.status().holder,'bbbb2222-b');
 assert.equal(store.release(),true);assert.equal(store.status().holder,null);assert.equal(store.state(),'none');
 store.setFrame(jpeg(1280,720,5),'aaaa1111-a');assert.equal(store.holder(),'aaaa1111-a');
 assert.throws(()=>store.setFrame(jpeg(1280,720,6),'x'),/client id/);
});
