import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthChecker, probe } from './routes.js';

const mk = (calls: string[], failUrl?: string, hang?: string) =>
  (async (url: string, init?: { signal?: AbortSignal }) => {
    calls.push(url);
    if (hang && url.includes(hang)) {
      return new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('abort'))));
    }
    if (failUrl && url.includes(failUrl)) throw new Error('down');
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;

test('both up, cached for 5 s then refreshed', async () => {
  const calls: string[] = [];
  let t = 1_000_000;
  const check = createHealthChecker({ fetchImpl: mk(calls), now: () => t, comfyUrl: () => 'http://c', ollamaUrl: () => 'http://o' });
  const a = await check();
  assert.deepEqual([a.ok, a.comfyui, a.ollama], [true, true, true]);
  assert.deepEqual(calls.sort(), ['http://c/queue', 'http://c/system_stats', 'http://o/api/tags']);
  t += 4900;
  await check();
  assert.equal(calls.length, 3);
  t += 200;
  await check();
  assert.equal(calls.length, 6);
});

test('errors give false flags, ok stays true', async () => {
  const check = createHealthChecker({ fetchImpl: mk([], 'system_stats'), comfyUrl: () => 'http://c', ollamaUrl: () => 'http://o' });
  const r = await check();
  assert.deepEqual([r.ok, r.comfyui, r.ollama], [true, false, true]);
});

test('non-2xx is false; timeout is false', async () => {
  const f = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
  assert.equal(await probe(f, 'http://x', 100), false);
  const start = Date.now();
  assert.equal(await probe(mk([], undefined, 'hang'), 'http://hang', 50), false);
  assert.ok(Date.now() - start < 1000);
});

test('Turbo default health checks selected 8001 independently from healthy legacy 8000',async()=>{
 const old=process.env.LOCAL_IMAGE_ENGINE;process.env.LOCAL_IMAGE_ENGINE='qwen21-turbo';
 try{
  const seen:string[]=[];
  const check=createHealthChecker({cacheMs:0,fetchImpl:async(url)=>{seen.push(String(url));if(String(url).includes(':8001'))throw Error('stopped');return Response.json({queue_running:[],queue_pending:[]});}});
  const result=await check();assert.equal(result.comfyui,false);assert.equal(result.localImageEngine,'qwen21-turbo');assert.equal(result.localImageEngineReachable,false);assert.equal(result.turbo?.reachable,false);assert.ok(seen.some(url=>url==='http://127.0.0.1:8001/system_stats'));
 }finally{if(old===undefined)delete process.env.LOCAL_IMAGE_ENGINE;else process.env.LOCAL_IMAGE_ENGINE=old;}
});

test('Turbo healthy and legacy stopped reports comfy connected and selected queue without duplicate probe',async()=>{
 const keys=['LOCAL_IMAGE_ENGINE','TURBO_CANDIDATE_URL','COMFYUI_URL'];const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{LOCAL_IMAGE_ENGINE:'qwen21-turbo',TURBO_CANDIDATE_URL:'http://127.0.0.1:8001',COMFYUI_URL:'http://127.0.0.1:8000'});
 try{
  const seen:string[]=[];const check=createHealthChecker({cacheMs:0,fetchImpl:async(input)=>{const url=String(input);seen.push(url);if(url.includes(':8000'))throw Error('legacy stopped');return Response.json({queue_running:[[0,'running']],queue_pending:[[1,'pending']]});}});
  const result=await check();assert.equal(result.comfyui,true);assert.equal(result.localImageEngineReachable,true);assert.equal(result.turbo?.reachable,true);assert.equal(result.comfyuiUrl,'http://127.0.0.1:8001');assert.deepEqual(result.comfyQueue,{running:1,pending:1});assert.ok(!seen.some(url=>url.includes(':8000')));assert.equal(seen.filter(url=>url==='http://127.0.0.1:8001/system_stats').length,1);assert.ok(seen.includes('http://127.0.0.1:8001/queue'));
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
