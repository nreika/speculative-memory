import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {createPublicGateApp,startPublicGate} from './index';
import {createCookieSigner,createLoginLimiter} from './auth';
import {RemoteCameraStore} from '../remoteCamera';

// Synthetic values only (never real secrets).
const PASSWORD='synthetic-test-pass-123',SECRET='synthetic-cookie-secret-0123456789',TOKEN='synthetic-capture-token-abcdef0123';
const jpeg=(w:number,h:number)=>Buffer.from([0xff,0xd8,0xff,0xc0,0x00,0x11,0x08,h>>8,h&255,w>>8,w&255,0x03,0x01,0x22,0x00,0x02,0x11,0x01,0x03,0x11,0x01,0xff,0xda,0x00,0x08,0x01,0x01,0x00,0x00,0x3f,0x00,0x00,0xff,0xd9]);

async function fixture(){
 const seen:Array<{url:string;host?:string;cookie?:string;method:string}>=[];
 const upstream=http.createServer((req,res)=>{
  seen.push({url:req.url!,host:req.headers.host,cookie:req.headers.cookie,method:req.method!});
  const snap=(imageUrl:string,blur:boolean)=>JSON.stringify({schema:1,content:{imageUrl,...(blur?{faceRegions:[{x:.4,y:.2,width:.1,height:.15}],faceRegionStatus:'detected'}:{})},view:{faceBlur:{enabled:blur,strengthPx:12}}});
  res.setHeader('Set-Cookie','internal=1');
  if(req.url==='/api/displays/current-now')return res.setHeader('Content-Type','application/json'),res.end(snap('/captures/Gen_a_1.png',false));
  if(req.url==='/api/displays/blurred')return res.setHeader('Content-Type','application/json'),res.end(snap('/captures/Gen_b_2.jpg',true));
  if(req.url==='/api/td-control/outputs/1')return res.setHeader('Content-Type','application/json'),res.end(snap('/captures/browser-output-assets/u/x.webp',false));
  if(req.url?.startsWith('/captures/'))return res.setHeader('Content-Type','image/png'),res.end('ORIGINAL');
  res.setHeader('Content-Type','text/html');res.end('<html>'+req.url+'</html>');
 });
 await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
 let clock=Date.parse('2026-10-19T00:00:00Z');const now=()=>clock;
 const remote=new RemoteCameraStore({now});let blurCalls=0;const logs:string[]=[];
 const app=createPublicGateApp({password:PASSWORD,cookieSecret:SECRET,captureToken:TOKEN,upstreamPort:(upstream.address() as AddressInfo).port,remote,now,log:l=>logs.push(l),blur:async()=>{blurCalls++;return Buffer.from('BLURRED');}});
 const gate=app.listen(0,'127.0.0.1');await new Promise(r=>gate.once('listening',r));
 const base='http://127.0.0.1:'+(gate.address() as AddressInfo).port;
 const req=(p:string,init:RequestInit={})=>fetch(base+p,{redirect:'manual',...init});
 const login=async(password=PASSWORD,ip='203.0.113.5')=>req('/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Forwarded-For':ip},body:new URLSearchParams({password,next:'/display/current-now'}).toString()});
 const cookieOf=(r:Response)=>r.headers.get('set-cookie')!.split(';')[0];
 const raw=(p:string,cookie:string)=>new Promise<number>((resolve,reject)=>{const r=http.request(base+'/',{path:p,headers:{cookie}},res=>{res.resume();resolve(res.statusCode!);});r.on('error',reject);r.end();});
 return {seen,remote,logs,req,raw,login,cookieOf,advance:(ms:number)=>{clock+=ms;},blurCalls:()=>blurCalls,close:()=>{gate.close();upstream.close();}};
}

test('public gate: unauthenticated access, login and cookie flags',async()=>{
 const f=await fixture();
 try{
  assert.equal(await (await f.req('/healthz')).text(),'ok');
  const page=await f.req('/display/current-now');assert.equal(page.status,303);assert.equal(page.headers.get('location'),'/login?next=/display/current-now');
  assert.equal((await f.req('/api/displays/current-now')).status,401);
  assert.equal((await f.req('/login')).status,200);
  assert.equal((await f.login('wrong-password-xx')).status,401);
  const ok=await f.login();assert.equal(ok.status,303);assert.equal(ok.headers.get('location'),'/display/current-now');
  const set=ok.headers.get('set-cookie')!;for(const flag of ['HttpOnly','Secure','SameSite=Strict','Path=/','Max-Age=43200'])assert.ok(set.includes(flag),flag);
  assert.ok(f.logs.every(l=>!l.includes('wrong-password-xx')),'login failures never log the input');
  const cookie=f.cookieOf(ok);
  assert.equal((await f.req('/display/current-now',{headers:{cookie}})).status,200);
  const api=await f.req('/api/displays/current-now',{headers:{cookie}});assert.equal(api.status,200);assert.equal(api.headers.get('set-cookie'),null);
  const last=f.seen.at(-1)!;assert.match(last.host!,/^localhost:\d+$/);assert.equal(last.cookie,undefined);
  for(const p of ['/display-assets/screen.css','/display-assets/screen.mjs','/display/face-blur.mjs','/control/output/1','/control/screen/screen-3','/control/player.css','/control/output.mjs','/api/td-control/outputs/1','/api/browser-outputs/screen-2'])assert.equal((await f.req(p,{headers:{cookie}})).status,200,p);
  // Tampered and expired cookies.
  assert.equal((await f.req('/api/displays/current-now',{headers:{cookie:cookie.slice(0,-2)+'xx'}})).status,401);
  f.advance(13*3600*1000);assert.equal((await f.req('/api/displays/current-now',{headers:{cookie}})).status,401);
 }finally{f.close();}
});

test('public gate: deny matrix (methods, listings, control main, internal APIs, traversal, query strings)',async()=>{
 const f=await fixture();
 try{
  const cookie=f.cookieOf(await f.login());const before=f.seen.length;
  for(const p of ['/control','/control/','/control/mapping','/control/history','/control/control.mjs','/display-assets/','/display-assets/screen.test.mjs','/display-assets/index.html','/captures/','/captures/latest.json','/captures/prediction_data.md','/captures/qa_flagged/x.png','/captures/browser-output-thumbnails/x.jpg','/api/td-control/state','/api/td-control/input-preview','/api/generate','/api/health','/api/browser-outputs','/api/browser-outputs/catalog','/api/displays/current-now/events','/api/events','/api/mobile/archive','/m','/logs','/@vite/client','/src/index.tsx','/catalog','/assets/x.js','/control/output/5'])
   assert.equal((await f.req(p,{headers:{cookie}})).status,404,p);
  for(const p of ['/display/current-now?x=1','/api/displays/current-now?cursor=1','/display/%2e%2e/control','/captures/..%2fsecret.png','/display/../control','/captures/a%5cb.png','/captures/a\\b.png','/display//x'])assert.equal(await f.raw(p,cookie),400,p);
  for(const [m,p] of [['POST','/display/current-now'],['POST','/api/generate'],['PUT','/api/displays/current-now'],['DELETE','/captures/Gen_a_1.png'],['POST','/api/td-control/action']])assert.equal((await f.req(p,{method:m,headers:{cookie}})).status,405,m+' '+p);
  assert.equal(f.seen.length,before,'denied requests never reach :3000');
 }finally{f.close();}
});

test('public gate: images only when referenced by a snapshot served in the last 30 minutes; face blur copies',async()=>{
 const f=await fixture();
 try{
  const cookie=f.cookieOf(await f.login());
  assert.equal((await f.req('/captures/Gen_a_1.png',{headers:{cookie}})).status,404,'not yet in a served snapshot');
  await f.req('/api/displays/current-now',{headers:{cookie}});
  const img=await f.req('/captures/Gen_a_1.png',{headers:{cookie}});assert.equal(img.status,200);assert.equal(await img.text(),'ORIGINAL');
  assert.equal((await f.req('/captures/Gen_a_1.png')).status,401,'still needs the cookie');
  assert.equal((await f.req('/captures/Gen_a_2.png',{headers:{cookie}})).status,404,'guessing another frame fails');
  await f.req('/api/td-control/outputs/1',{headers:{cookie}});
  assert.equal((await f.req('/captures/browser-output-assets/u/x.webp',{headers:{cookie}})).status,200);
  // Face blur on: blurred copy, cached, original never returned.
  await f.req('/api/displays/blurred',{headers:{cookie}});
  const blurred=await f.req('/captures/Gen_b_2.jpg',{headers:{cookie}});assert.equal(await blurred.text(),'BLURRED');assert.equal(blurred.headers.get('content-type'),'image/jpeg');
  await f.req('/captures/Gen_b_2.jpg',{headers:{cookie}});assert.equal(f.blurCalls(),1);
  f.advance(31*60*1000);const fresh=f.cookieOf(await f.login());
  assert.equal((await f.req('/captures/Gen_a_1.png',{headers:{cookie:fresh}})).status,404,'expired after 30 minutes');
 }finally{f.close();}
});

test('public gate: login rate limit per IP (5 / 10 min) and global (50 / 10 min)',async()=>{
 const f=await fixture();
 try{
  for(let i=0;i<5;i++)assert.equal((await f.login('bad-password-'+i,'198.51.100.1')).status,401);
  assert.equal((await f.login(PASSWORD,'198.51.100.1')).status,429,'locked even with the right password');
  assert.equal((await f.login(PASSWORD,'198.51.100.2')).status,303,'other IPs unaffected');
  f.advance(10*60*1000+1);assert.equal((await f.login(PASSWORD,'198.51.100.1')).status,303,'window expires');
 }finally{f.close();}
 let t=0;const limiter=createLoginLimiter({now:()=>t});
 for(let i=0;i<50;i++)limiter.fail('10.0.0.'+i);assert.equal(limiter.blocked('192.0.2.1'),true);t+=10*60*1000+1;assert.equal(limiter.blocked('192.0.2.1'),false);
});

test('public gate: remote capture token, role separation and frame upload',async()=>{
 const f=await fixture();
 try{
  assert.equal((await f.req('/capture/')).status,401);
  assert.equal((await f.req('/capture/?token=wrong-token-wrong-token')).status,404);
  const ok=await f.req('/capture/?token='+TOKEN);assert.equal(ok.status,303);assert.equal(ok.headers.get('location'),'/capture/');
  assert.ok(ok.headers.get('set-cookie')!.includes('Path=/capture'));const cap=f.cookieOf(ok);
  assert.equal((await f.req('/capture/',{headers:{cookie:cap}})).status,200);
  assert.equal((await f.req('/display/current-now',{headers:{cookie:cap}})).status,303,'capture role cannot view');
  const view=f.cookieOf(await f.login());assert.equal((await f.req('/capture/',{headers:{cookie:view}})).status,401,'view role cannot capture');
  const post=(body:unknown,headers:Record<string,string>={})=>f.req('/capture/frame',{method:'POST',headers:{cookie:cap,'Content-Type':'application/json','X-Capture-Request':'1',...headers},body:JSON.stringify(body)});
  assert.equal((await post({image:'x'},{'X-Capture-Request':'0'})).status,403);
  assert.equal((await post({image:'data:image/jpeg;base64,'+jpeg(640,480).toString('base64')})).status,400,'must be 1280x720');
  const sent=await post({image:'data:image/jpeg;base64,'+jpeg(1280,720).toString('base64')});assert.equal(sent.status,200);assert.equal((await sent.json()).selected,false);
  assert.equal(f.remote.state(),'fresh');
  assert.equal((await post({image:'data:image/jpeg;base64,'+jpeg(1280,720).toString('base64')})).status,429,'one frame / 3 s');
  const status=await (await f.req('/capture/status',{headers:{cookie:cap}})).json();assert.equal(status.state,'fresh');
  assert.equal((await f.req('/capture/frame',{method:'GET',headers:{cookie:cap}})).status,405);
 }finally{f.close();}
});

test('public gate is inert without secrets; cookie signer rejects other roles',()=>{
 const logs:string[]=[];
 assert.equal(startPublicGate({PUBLIC_OUTPUT_PASSWORD:''} as any,l=>logs.push(l)),null);
 assert.equal(startPublicGate({PUBLIC_OUTPUT_PASSWORD:PASSWORD} as any,l=>logs.push(l)),null);
 assert.deepEqual(logs,['public gate disabled (no secrets)','public gate disabled (no secrets)']);
 const signer=createCookieSigner(SECRET);const value=signer.issue('view');
 assert.equal(signer.verify(value,'view'),true);assert.equal(signer.verify(value,'capture'),false);
 assert.equal(createCookieSigner(SECRET+'x').verify(value,'view'),false);
});
