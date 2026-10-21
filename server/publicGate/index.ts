/**
 * Public output gate (docs/PUBLIC-OUTPUT-AND-REMOTE-CAMERA-DESIGN-2026-10-19.md).
 * A second Express app bound ONLY to 127.0.0.1:PUBLIC_GATE_PORT (3443) for Tailscale Funnel. Everything outside the
 * allow-list is 404/405; allowed requests are forwarded over loopback to :3000 with Host rewritten to localhost:3000,
 * so the main server's own Host/peer/path checks still apply. Inert (no listener) when the secrets are unset.
 */
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createCookieSigner,createLoginLimiter,createPasswordVerifier,cookieHeader,readCookie,safeEqualString,VIEW_COOKIE,CAPTURE_COOKIE,SESSION_MS} from './auth';
import {remoteCamera as defaultRemote,RemoteFrameError,REMOTE_MAX_FRAME_BYTES,type RemoteCameraStore} from '../remoteCamera';

type Box={x:number;y:number;width:number;height:number};
export interface BlurSpec{strengthPx:number;status:string;regions:Box[]}
export type BlurRenderer=(bytes:Buffer,regions:Box[],strengthPx:number,format:'png'|'jpeg'|'webp')=>Promise<Buffer>;
export interface PublicGateOptions{
 password:string;cookieSecret:string;captureToken?:string;
 upstreamPort?:number;remote?:RemoteCameraStore;now?:()=>number;recentMs?:number;
 blur?:BlurRenderer;log?:(line:string)=>void;
}

const here=path.dirname(fileURLToPath(import.meta.url));
const PAGE=[/^\/display\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/?$/,/^\/control\/screen\/screen-[1-9][0-9]{0,2}\/?$/];
const ASSETS=new Set(['/display/face-blur.mjs',...['screen.css','screen.mjs','timeline.mjs','face-blur.mjs'].map(f=>'/display-assets/'+f),...['player.css','output.mjs','timeline.mjs','face-blur.mjs'].map(f=>'/control/'+f)]);
const API=[/^\/api\/displays\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,/^\/api\/browser-outputs\/screen-[1-9][0-9]{0,2}$/];
const IMAGE=[/^\/captures\/(?:display\/)?[A-Za-z0-9][A-Za-z0-9_.-]{0,239}\.(?:png|jpe?g|webp)$/i,/^\/captures\/browser-output-assets\/[A-Za-z0-9][A-Za-z0-9/_.-]{0,400}\.(?:png|jpe?g|webp)$/i];
export const isGatePage=(p:string)=>PAGE.some(r=>r.test(p));
export const isGateImage=(p:string)=>IMAGE.some(r=>r.test(p))&&!p.includes('/browser-output-thumbnails/')&&!p.split('/').some(s=>s==='.'||s==='..');
const escapeHtml=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const format=(p:string)=>/\.png$/i.test(p)?'png':/\.webp$/i.test(p)?'webp':'jpeg';
const mime={png:'image/png',jpeg:'image/jpeg',webp:'image/webp'} as const;

/** Default renderer: scripts/face-blur-render.py in the CPU face-detector venv (cv2). */
export function pythonBlurRenderer(python:string,worker:string,timeoutMs=15000):BlurRenderer{
 let active=0;const waiters:Array<()=>void>=[];
 return async(bytes,regions,strengthPx,fmt)=>{
  if(active>=2)await new Promise<void>(r=>waiters.push(r));else active++;
  try{
   return await new Promise<Buffer>((resolve,reject)=>{
    const child=spawn(python,['-u',worker],{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',done=false;
    const finish=(e:Error|null,b?:Buffer)=>{if(done)return;done=true;clearTimeout(timer);e?reject(e):resolve(b!);};
    const timer=setTimeout(()=>{child.kill();finish(Error('blur timeout'));},timeoutMs);
    child.stderr.resume();child.on('error',()=>finish(Error('blur unavailable')));child.stdin.on('error',()=>finish(Error('blur failed')));
    child.stdout.on('data',c=>{out+=String(c);if(out.length>64*1024*1024){child.kill();finish(Error('blur output too large'));}});
    child.on('close',()=>{try{const r=JSON.parse(out);if(typeof r.image!=='string')throw Error();finish(null,Buffer.from(r.image,'base64'));}catch{finish(Error('blur failed'));}});
    child.stdin.end(JSON.stringify({image:bytes.toString('base64'),regions,strengthPx,format:fmt}));
   });
  }finally{const next=waiters.shift();if(next)next();else active--;}
 };
}

export function createPublicGateApp(options:PublicGateOptions){
 const verify=createPasswordVerifier(options.password),now=options.now??Date.now,signer=createCookieSigner(options.cookieSecret,now);
 const limiter=createLoginLimiter({now}),remote=options.remote??defaultRemote,upstreamPort=options.upstreamPort??3000,recentMs=options.recentMs??30*60*1000;
 const captureToken=options.captureToken&&options.captureToken.length>=16?options.captureToken:undefined;
 const log=options.log??((line:string)=>console.warn(line));
 const blur=options.blur??pythonBlurRenderer(process.env.FACE_DETECTOR_PYTHON||path.join(process.env.USERPROFILE||'','claude-code/runtime-face-detector/Scripts/python.exe'),path.resolve('scripts/face-blur-render.py'));
 /** Image URLs that appeared in a snapshot this gate served in the last 30 minutes (+ face-blur spec of that output). */
 const recent=new Map<string,{until:number;blur:BlurSpec|null}>();
 const blurCache=new Map<string,Buffer>();
 const lastErrorReportAt=new Map<string,number>();
 const lastFrameAt=new Map<string,number>();
 const loginHtml=fs.readFileSync(path.join(here,'login.html'),'utf8');

 const noteSnapshot=(value:any)=>{
  const content=value?.content,url=content?.imageUrl;if(typeof url!=='string'||!isGateImage(url))return;
  const t=now();for(const [k,v] of recent)if(v.until<=t)recent.delete(k);
  const fb=value?.view?.faceBlur;
  const spec:BlurSpec|null=fb?.enabled===true?{strengthPx:Number.isInteger(fb.strengthPx)&&fb.strengthPx>0&&fb.strengthPx<=40?fb.strengthPx:12,status:String(content.faceRegionStatus??'unknown'),regions:Array.isArray(content.faceRegions)?content.faceRegions.filter((b:any)=>b&&[b.x,b.y,b.width,b.height].every(Number.isFinite)).slice(0,64).map((b:any)=>({x:b.x,y:b.y,width:b.width,height:b.height})):[]}:null;
  const old=recent.get(url);
  // Conservative: once an output with face blur referenced the image, keep blurring it for the window.
  recent.set(url,{until:t+recentMs,blur:spec??(old&&old.until>t?old.blur:null)});
  while(recent.size>5000)recent.delete(recent.keys().next().value!);
 };
 const clientIp=(req:express.Request)=>{const f=String(req.headers['x-forwarded-for']??'').split(',')[0].trim();return f&&f.length<64?f:(req.socket.remoteAddress??'unknown');};
 const security=(res:express.Response)=>{res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');};
 const deny=(res:express.Response,status:number,text=status===404?'Not found':status===405?'Method not allowed':status===400?'Bad request':status===401?'Login required':'Denied')=>{res.status(status).type('text/plain').send(text);};
 const loginPage=(res:express.Response,status:number,next:string,error='')=>{
  res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  res.status(status).type('html').send(loginHtml.replace('{{NEXT}}',escapeHtml(next)).replace('{{ERROR}}',error?`<p class="error">${escapeHtml(error)}</p>`:''));
 };
 const readBody=async(req:express.Request,max:number):Promise<Buffer|null>=>{
  const declared=Number(req.headers['content-length']);if(Number.isFinite(declared)&&declared>max)return null;
  const chunks:Buffer[]=[];let size=0;for await(const c of req){const b=Buffer.from(c);size+=b.length;if(size>max)return null;chunks.push(b);}return Buffer.concat(chunks);
 };
 const upstream=(method:string,route:string,accept:string|undefined)=>new Promise<http.IncomingMessage>((resolve,reject)=>{
  const r=http.request({host:'127.0.0.1',port:upstreamPort,method,path:route,headers:{host:'localhost:'+upstreamPort,accept:accept&&accept.length<512?accept:'*/*','user-agent':'speculative-memory-public-gate'}},resolve);
  r.on('error',reject);r.setTimeout(15000,()=>r.destroy(Error('upstream timeout')));r.end();
 });
 const PASS=['content-type','content-length','etag','last-modified','content-security-policy'];
 const forward=async(req:express.Request,res:express.Response,route:string,mode:'stream'|'snapshot')=>{
  let up:http.IncomingMessage;
  try{up=await upstream(req.method,route,req.headers.accept);}catch{return deny(res,502,'Upstream unavailable');}
  const status=up.statusCode??502;
  if(status>=300&&status<400){up.resume();return deny(res,404);}
  res.status(status);
  if(mode==='snapshot'&&req.method==='GET'&&status===200){
   const chunks:Buffer[]=[];let size=0;
   for await(const c of up){size+=c.length;if(size>8*1024*1024){up.destroy();return deny(res,502,'Upstream response too large');}chunks.push(c);}
   const body=Buffer.concat(chunks);try{noteSnapshot(JSON.parse(body.toString('utf8')));}catch{/* non-JSON: nothing to allow */}
   res.type(String(up.headers['content-type']??'application/json'));return res.send(body);
  }
  for(const h of PASS){const v=up.headers[h];if(v!==undefined)res.setHeader(h,v as string);}
  if(req.method==='HEAD'){up.resume();return res.end();}
  up.pipe(res);
 };
 const serveBlurred=async(req:express.Request,res:express.Response,route:string,spec:BlurSpec)=>{
  if(spec.status==='no-faces')return forward(req,res,route,'stream');
  // Fail closed: blur is on but face regions are unknown -> do not publish the original.
  if(spec.status!=='detected'||!spec.regions.length)return deny(res,503,'Face blur unavailable');
  let up:http.IncomingMessage;try{up=await upstream('GET',route,'image/*');}catch{return deny(res,502,'Upstream unavailable');}
  if(up.statusCode!==200){up.resume();return deny(res,up.statusCode===404?404:502);}
  const key=JSON.stringify([route,up.headers.etag??'',up.headers['last-modified']??'',spec.strengthPx,spec.regions]);
  let out=blurCache.get(key);
  if(out)up.resume();
  else{
   const chunks:Buffer[]=[];let size=0;for await(const c of up){size+=c.length;if(size>24*1024*1024){up.destroy();return deny(res,502,'Image too large');}chunks.push(c);}
   try{out=await blur(Buffer.concat(chunks),spec.regions,spec.strengthPx,format(route));}catch{return deny(res,503,'Face blur unavailable');}
   blurCache.set(key,out);while(blurCache.size>48)blurCache.delete(blurCache.keys().next().value!);
  }
  res.status(200).type(mime[format(route)]).setHeader('Content-Length',String(out.length));
  return req.method==='HEAD'?res.end():res.end(out);
 };
 const validNext=(value:unknown)=>typeof value==='string'&&value.length<200&&isGatePage(value)?value:'/display/current-now';
 const viewer=(req:express.Request)=>signer.verify(readCookie(req.headers.cookie,VIEW_COOKIE),'view');
 const capturer=(req:express.Request)=>signer.verify(readCookie(req.headers.cookie,CAPTURE_COOKIE),'capture');

 const app=express();app.disable('x-powered-by');app.set('etag',false);
 app.use(async(req,res)=>{
  security(res);
  const raw=req.originalUrl||req.url;
  if(raw.length>1024||/[%\\\u0000-\u001f\u007f]/.test(raw)||raw.includes('..')||raw.includes('//')||!raw.startsWith('/'))return deny(res,400);
  const q=raw.indexOf('?'),route=q<0?raw:raw.slice(0,q),query=q<0?'':raw.slice(q+1),params=new URLSearchParams(query);
  const method=req.method;

  if(route==='/healthz'){if(method!=='GET'&&method!=='HEAD')return deny(res,405);if(query)return deny(res,400);return res.type('text/plain').send('ok');}
  if(route==='/'){if(method!=='GET'&&method!=='HEAD')return deny(res,405);return res.redirect(303,'/login');}
  if(route==='/login'){
   if(method==='GET'||method==='HEAD'){if([...params.keys()].some(k=>k!=='next')||params.getAll('next').length>1)return deny(res,400);return loginPage(res,200,validNext(params.get('next')));}
   if(method!=='POST')return deny(res,405);if(query)return deny(res,400);
   const ip=clientIp(req);
   if(limiter.blocked(ip))return loginPage(res,429,'/display/current-now','Too many attempts. Try again in 10 minutes.');
   if(String(req.headers['content-type']??'').split(';')[0].trim().toLowerCase()!=='application/x-www-form-urlencoded')return deny(res,415,'Form required');
   const body=await readBody(req,4096);if(!body)return deny(res,413,'Too large');
   const form=new URLSearchParams(body.toString('utf8')),next=validNext(form.get('next'));
   if(await verify(form.get('password'))){res.setHeader('Set-Cookie',cookieHeader(VIEW_COOKIE,signer.issue('view'),'/',SESSION_MS/1000));return res.redirect(303,next);}
   limiter.fail(ip);log(`[public-gate] login failed ip=${ip} at=${new Date(now()).toISOString()}`);
   return loginPage(res,401,next,'Wrong password.');
  }
  if(route==='/logout'){
   if(method!=='POST')return deny(res,405);
   res.setHeader('Set-Cookie',[cookieHeader(VIEW_COOKIE,'','/',0),cookieHeader(CAPTURE_COOKIE,'','/capture',0)]);return res.redirect(303,'/login');
  }
  if(route==='/capture'||route.startsWith('/capture/')){
   if(!captureToken)return deny(res,404);
   if(route==='/capture'){if(method!=='GET'&&method!=='HEAD')return deny(res,405);return res.redirect(303,'/capture/'+(query?'?'+query:''));}
   if(route==='/capture/frame'){
    if(method!=='POST')return deny(res,405);if(query)return deny(res,400);
    if(!capturer(req))return deny(res,401);
    if(req.headers['x-capture-request']!=='1')return deny(res,403,'Missing capture header');
    if(String(req.headers['content-type']??'').split(';')[0].trim().toLowerCase()!=='application/json')return deny(res,415,'JSON required');
    const cookie=readCookie(req.headers.cookie,CAPTURE_COOKIE)!,last=lastFrameAt.get(cookie)??0;
    if(now()-last<3000)return res.status(429).json({ok:false,error:'At most one frame every 3 s'});
    const body=await readBody(req,REMOTE_MAX_FRAME_BYTES);if(!body)return res.status(413).json({ok:false,error:'Frame too large (2 MB max)'});
    let image:unknown;try{image=JSON.parse(body.toString('utf8'))?.image;}catch{return res.status(400).json({ok:false,error:'Invalid JSON'});}
    const m=typeof image==='string'?/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(image):null;if(!m)return res.status(400).json({ok:false,error:'image must be a JPEG data URL'});
    try{const frame=remote.setFrame(Buffer.from(m[1],'base64'));lastFrameAt.set(cookie,now());while(lastFrameAt.size>1000)lastFrameAt.delete(lastFrameAt.keys().next().value!);
     return res.json({ok:true,receivedAt:new Date(frame.receivedAtMs).toISOString(),selected:remote.selected});}
    catch(error){return res.status(error instanceof RemoteFrameError?error.status:400).json({ok:false,error:error instanceof Error?error.message:'Invalid frame'});}
   }
   if(method!=='GET'&&method!=='HEAD')return deny(res,405);
   if(route==='/capture/'&&params.has('token')){
    if([...params.keys()].length!==1||params.getAll('token').length!==1)return deny(res,400);
    const ip=clientIp(req);if(limiter.blocked(ip))return deny(res,429,'Too many attempts');
    if(!safeEqualString(params.get('token'),captureToken)){limiter.fail(ip);log(`[public-gate] capture token rejected ip=${ip}`);return deny(res,404);}
    // Lax (2026-10-21): links opened from a chat app or QR code are cross-site navigations; with Strict the browser
    // dropped the cookie on the redirect and the phone saw 401. Frame POSTs stay same-origin only (Lax is not sent cross-site on POST).
    res.setHeader('Set-Cookie',cookieHeader(CAPTURE_COOKIE,signer.issue('capture'),'/capture',SESSION_MS/1000,'Lax'));
    return res.redirect(303,'/capture/');
   }
   if(query)return deny(res,400);
   if(!['/capture/','/capture/capture.mjs','/capture/status'].includes(route))return deny(res,404);
   if(!capturer(req))return deny(res,401,'Open the capture link (with its token) on this device first.');
   if(route==='/capture/status')return res.json({ok:true,...remote.status()});
   if(route==='/capture/capture.mjs')return res.type('text/javascript; charset=utf-8').sendFile(path.join(here,'capture.mjs'));
   res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
   return res.type('html').sendFile(path.join(here,'capture.html'));
  }

  // The only other POST: viewers report browser-side display problems (timeouts, slow images, ...) to the local log.
  if(route==='/api/display-errors'){
   if(method!=='POST')return deny(res,405);if(query)return deny(res,400);
   if(!viewer(req))return deny(res,401);
   if(req.headers['x-control-request']!=='1')return deny(res,403,'Missing header');
   if(String(req.headers['content-type']??'').split(';')[0].trim().toLowerCase()!=='application/json')return deny(res,415,'JSON required');
   const key=readCookie(req.headers.cookie,VIEW_COOKIE)??clientIp(req),last=lastErrorReportAt.get(key)??0;
   if(now()-last<1500)return res.status(429).json({ok:false});
   const body=await readBody(req,8192);if(!body)return res.status(413).json({ok:false});
   lastErrorReportAt.set(key,now());while(lastErrorReportAt.size>1000)lastErrorReportAt.delete(lastErrorReportAt.keys().next().value!);
   try{
    const status=await new Promise<number>((resolve,reject)=>{
     const r=http.request({host:'127.0.0.1',port:upstreamPort,method:'POST',path:'/api/display-errors',headers:{host:'localhost:'+upstreamPort,'content-type':'application/json','content-length':String(body.length),'x-control-request':'1','user-agent':'speculative-memory-public-gate'}},up=>{up.resume();resolve(up.statusCode??502);});
     r.on('error',reject);r.setTimeout(5000,()=>r.destroy(Error('upstream timeout')));r.end(body);
    });
    return res.status(status<300?200:status).json({ok:status<300});
   }catch{return deny(res,502,'Upstream unavailable');}
  }
  if(method!=='GET'&&method!=='HEAD')return deny(res,405);
  if(query)return deny(res,400);
  const page=isGatePage(route),asset=ASSETS.has(route),api=API.some(r=>r.test(route)),image=isGateImage(route);
  if(!page&&!asset&&!api&&!image)return deny(res,404);
  if(!viewer(req))return page?res.redirect(303,'/login?next='+route):deny(res,401);
  if(image){
   const entry=recent.get(route);
   if(!entry||entry.until<=now())return deny(res,404);
   if(entry.blur)return serveBlurred(req,res,route,entry.blur);
   return forward(req,res,route,'stream');
  }
  return forward(req,res,route,api?'snapshot':'stream');
 });
 return app;
}

/** Called once from server.ts. Never throws; returns null when disabled. */
export function startPublicGate(env:NodeJS.ProcessEnv=process.env,log:(line:string)=>void=line=>console.log(line)):http.Server|null{
 try{
  if(String(env.PUBLIC_GATE_ENABLED??'true').toLowerCase()==='false'){log('public gate disabled (PUBLIC_GATE_ENABLED=false)');return null;}
  if(!env.PUBLIC_OUTPUT_PASSWORD||!env.PUBLIC_COOKIE_SECRET){log('public gate disabled (no secrets)');return null;}
  const port=Number(env.PUBLIC_GATE_PORT||3443);
  if(!Number.isInteger(port)||port<1024||port>65535||port===Number(env.PORT||3000)){log('public gate disabled (invalid PUBLIC_GATE_PORT)');return null;}
  const app=createPublicGateApp({password:env.PUBLIC_OUTPUT_PASSWORD,cookieSecret:env.PUBLIC_COOKIE_SECRET,captureToken:env.PUBLIC_CAPTURE_TOKEN,upstreamPort:Number(env.PORT||3000)});
  const server=app.listen(port,'127.0.0.1',()=>log(`public gate listening on http://127.0.0.1:${port} (loopback only; capture ${env.PUBLIC_CAPTURE_TOKEN?'enabled':'disabled'})`));
  server.on('error',error=>log(`public gate failed to listen: ${(error as NodeJS.ErrnoException).code??'error'}`));
  return server;
 }catch(error){log(`public gate disabled (${error instanceof Error?error.message:'init failed'})`);return null;}
}
