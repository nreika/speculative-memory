import test from 'node:test';import assert from 'node:assert/strict';import {deflateSync}from'node:zlib';
import {tryAssetOnlyCpuResult}from'./assetOnlyFastPath';import {restoreAssetOnlySourceFrame}from'./scenarioFrame';import {decodePng}from'./qa/gridDetect';
function png(w:number,h:number,pixel:(x:number,y:number)=>number[]){const chunk=(t:string,d:Buffer)=>{const b=Buffer.alloc(d.length+12);b.writeUInt32BE(d.length);b.write(t,4);d.copy(b,8);let crc=0xffffffff;for(const v of b.subarray(4,-4)){crc^=v;for(let i=0;i<8;i++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}b.writeUInt32BE((crc^0xffffffff)>>>0,b.length-4);return b;};const hd=Buffer.alloc(13);hd.writeUInt32BE(w);hd.writeUInt32BE(h,4);hd[8]=8;hd[9]=6;const rows=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++)Buffer.from(pixel(x,y)).copy(rows,y*(w*4+1)+1+x*4);return'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',hd),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]).toString('base64');}
const raw=png(8,8,()=>[12,34,56,255]),composed=png(8,8,(x,y)=>[x*20,y*20,55,128]);const rects=[{x:2,y:3,width:2,height:2}];const mask=png(8,8,(x,y)=>{const v=x>=2&&x<4&&y>=3&&y<5?255:0;return[v,v,v,255];});
const pixels=(s:string)=>decodePng(Buffer.from(s.split(',')[1],'base64'))!.data;
test('fully protected edit union makes final independent of every generated pixel',async()=>{
 const fast=await tryAssetOnlyCpuResult(raw,composed,mask,rects);assert.ok(fast);assert.equal(fast.proof.generatedContributionPixels,0);
 for(const color of [[1,2,3,255],[200,220,240,255]]){const old=await restoreAssetOnlySourceFrame(raw,png(8,4,()=>color),rects,{composedImageDataUrl:composed,protectedCoreMaskDataUrl:mask});assert.deepEqual(pixels(fast.imageDataUrl),pixels(old.imageDataUrl));}
});
test('alpha and feather pixels are copied once, not applied a second time',async()=>{
 const feather=png(8,8,(x,y)=>{const v=x>=2&&x<4&&y>=3&&y<5?1:0;return[v,v,v,0];});const fast=await tryAssetOnlyCpuResult(raw,composed,feather,rects);assert.ok(fast);
 const a=pixels(fast.imageDataUrl);assert.deepEqual([...a.subarray((3*8+2)*4,(3*8+2)*4+4)],[40,60,55,128]);assert.deepEqual([...a.subarray(0,4)],[12,34,56,255]);
});
test('a single transparent/unprotected hole keeps normal generation',async()=>{
 const hole=png(8,8,(x,y)=>{const v=x>=2&&x<4&&y>=3&&y<5&&!(x===2&&y===3)?255:0;return[v,v,v,255];});assert.equal(await tryAssetOnlyCpuResult(raw,composed,hole,rects),null);
});
test('overlap is a union and a protected pixel outside edit areas rejects proof',async()=>{
 const rs=[{x:2,y:3,width:2,height:2},{x:3,y:3,width:2,height:2}],union=png(8,8,(x,y)=>{const v=x>=2&&x<5&&y>=3&&y<5?255:0;return[v,v,v,255];});const fast=await tryAssetOnlyCpuResult(raw,composed,union,rs);assert.ok(fast);assert.equal(fast.proof.allowedPixels,6);assert.equal(await tryAssetOnlyCpuResult(raw,composed,union,rects),null);
});
test('no mask, invalid rectangles, image sizes or malformed data never skip diffusion',async()=>{
 assert.equal(await tryAssetOnlyCpuResult(raw,composed,'',rects),null);assert.equal(await tryAssetOnlyCpuResult(raw,composed,mask,[]),null);
 assert.equal(await tryAssetOnlyCpuResult(raw,composed,mask,[{x:-1,y:0,width:1,height:1}]),null);assert.equal(await tryAssetOnlyCpuResult(raw,png(4,4,()=>[0,0,0,255]),mask,rects),null);assert.equal(await tryAssetOnlyCpuResult('bad',composed,mask,rects),null);
});
test('an aborted request never becomes a successful CPU output',async()=>{const c=new AbortController();c.abort();await assert.rejects(()=>tryAssetOnlyCpuResult(raw,composed,mask,rects,{signal:c.signal}),{name:'AbortError'});});

test('production asset-only proof returns through orchestrator without model HTTP calls and honest trace',async t=>{
 const {generateImage}=await import('./generation/orchestrator');const prev=process.env.LOCAL_IMAGE_ENGINE;process.env.LOCAL_IMAGE_ENGINE='qwen21-turbo';let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('No model request permitted');});const trace:any={};
 try{const out=await generateImage({originalImageDataUrl:composed,predictionPrompt:'asset only',assetOnlyInstruction:'Only the supplied local asset.',assetOnlyFrame:{rawImageDataUrl:raw,protectedCoreMaskDataUrl:mask,rectangles:rects},localImageEngine:'qwen21-turbo',imageBackend:'local',trace});assert.equal(calls,0);assert.equal(trace.seed,null);assert.equal(trace.turboCandidate,undefined);assert.equal(trace.sourceFrameRestoration.modelExecuted,false);assert.equal(trace.sourceFrameRestoration.executionMode,'cpu-only-assets-only');assert.equal(pixels(out).length,8*8*4);}finally{if(prev===undefined)delete process.env.LOCAL_IMAGE_ENGINE;else process.env.LOCAL_IMAGE_ENGINE=prev;}
});

test('failed proof and ordinary generation both retain the original model route',async t=>{
 const {generateImage}=await import('./generation/orchestrator');const prev={...process.env};process.env.LOCAL_IMAGE_ENGINE='qwen21-turbo';delete process.env.TURBO_CPU_PYTHON;let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('Expected model path reached');});
 try{
  const hole=png(8,8,()=>[0,0,0,255]);await assert.rejects(()=>generateImage({originalImageDataUrl:composed,predictionPrompt:'asset only',assetOnlyInstruction:'Only local asset.',assetOnlyFrame:{rawImageDataUrl:raw,protectedCoreMaskDataUrl:hole,rectangles:rects},localImageEngine:'qwen21-turbo',imageBackend:'local'}),/TURBO_CPU_PYTHON/);
  await assert.rejects(()=>generateImage({originalImageDataUrl:raw,predictionPrompt:'The person moves.',localImageEngine:'qwen21-turbo',imageBackend:'local'}),/TURBO_CPU_PYTHON/);assert.equal(calls,0);
 }finally{for(const key of ['LOCAL_IMAGE_ENGINE','TURBO_CPU_PYTHON','TURBO_CPU_WORKER','TURBO_CANDIDATE_ARTIFACT_DIR']){if(prev[key]===undefined)delete process.env[key];else process.env[key]=prev[key];}}
});
