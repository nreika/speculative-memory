/**
 * Public gate side of external scenario submissions (server/scenarioSubmit.ts). Same token mechanism as /capture/:
 * GET /submit/?token=<PUBLIC_CAPTURE_TOKEN> sets an HMAC-signed cookie (SameSite=Lax, scoped to /submit and
 * /api/scenario-submit) and redirects; without it every submit route is 401. Only GET /submit/ (+ its .mjs/.css) and
 * POST /api/scenario-submit are allowed; the multipart body is size-capped and streamed to :3000 over loopback with
 * X-Submit-Key (hash of the cookie) for the per-submitter rate limit.
 */
import http from 'node:http';
import {createHash} from 'node:crypto';
import type express from 'express';
import {cookieHeader,readCookie,safeEqualString,SESSION_MS,type createCookieSigner,type createLoginLimiter} from './auth';
import {SUBMIT_MAX_BODY} from '../scenarioSubmit';

export const SUBMIT_COOKIE='sm_sub';
const PAGES=['/submit/','/submit/submit.mjs','/submit/submit.css'];
// Read-only authoring guide for external authors: served by :3000 from the /control/guide/ routes (loopback only).
const GUIDE:Record<string,string>={'/submit/guide/':'/control/guide/','/submit/guide/guide.css':'/control/guide/guide.css','/submit/guide/guide.md':'/control/guide/guide.md'};
export const isSubmitRoute=(route:string)=>route==='/submit'||route.startsWith('/submit/')||route==='/api/scenario-submit';

export function createSubmitGate(o:{
 captureToken?:string;signer:ReturnType<typeof createCookieSigner>;limiter:ReturnType<typeof createLoginLimiter>;
 clientIp:(req:express.Request)=>string;upstreamPort:number;log:(line:string)=>void;
}){
 const text=(res:express.Response,status:number,body:string)=>res.status(status).type('text/plain').send(body);
 const submitter=(req:express.Request)=>{const v=readCookie(req.headers.cookie,SUBMIT_COOKIE);return o.signer.verify(v,'capture')?v!:null;};
 const upstream=(req:express.Request,res:express.Response,method:string,route:string,headers:Record<string,string>,body?:Buffer)=>new Promise<void>(resolve=>{
  const r=http.request({host:'127.0.0.1',port:o.upstreamPort,method,path:route,headers:{host:'localhost:'+o.upstreamPort,'user-agent':'speculative-memory-public-gate',...headers}},up=>{
   const status=up.statusCode??502;
   if(status>=300&&status<400){up.resume();text(res,404,'Not found');return resolve();}
   res.status(status);
   for(const h of ['content-type','content-length','content-security-policy']){const v=up.headers[h];if(v!==undefined)res.setHeader(h,v as string);}
   if(method==='HEAD'){up.resume();res.end();return resolve();}
   up.pipe(res);up.on('end',()=>resolve());up.on('error',()=>resolve());
  });
  r.on('error',()=>{if(!res.headersSent)text(res,502,'Upstream unavailable');resolve();});
  r.setTimeout(60000,()=>r.destroy(Error('upstream timeout')));
  r.end(body);
 });
 return async function handle(req:express.Request,res:express.Response,route:string,query:string,params:URLSearchParams){
  if(!o.captureToken)return text(res,404,'Not found');
  const method=req.method;
  if(route==='/submit'){if(method!=='GET'&&method!=='HEAD')return text(res,405,'Method not allowed');return res.redirect(303,'/submit/'+(query?'?'+query:''));}
  if(route==='/api/scenario-submit'){
   if(method!=='POST')return text(res,405,'Method not allowed');if(query)return text(res,400,'Bad request');
   const cookie=submitter(req);if(!cookie)return res.status(401).json({ok:false,error:'Open the submission link (with its token) on this device first.'});
   if(req.headers['x-submit-request']!=='1')return res.status(403).json({ok:false,error:'Missing submit header'});
   const type=String(req.headers['content-type']??'');
   if(!/^multipart\/form-data\s*;\s*boundary=/i.test(type)||type.length>200)return res.status(415).json({ok:false,error:'multipart/form-data is required'});
   const declared=Number(req.headers['content-length']);
   if(Number.isFinite(declared)&&declared>SUBMIT_MAX_BODY)return res.status(413).json({ok:false,error:'Upload too large (CSV 2 MB, images 5 MB each, at most 5)'});
   const chunks:Buffer[]=[];let size=0;
   for await(const c of req){size+=c.length;if(size>SUBMIT_MAX_BODY){req.destroy();return res.status(413).json({ok:false,error:'Upload too large'});}chunks.push(Buffer.from(c));}
   const body=Buffer.concat(chunks);
   return upstream(req,res,'POST','/api/scenario-submit',{'content-type':type,'content-length':String(body.length),'x-submit-request':'1','x-submit-key':createHash('sha256').update(cookie).digest('hex').slice(0,32),accept:'application/json'},body);
  }
  if(method!=='GET'&&method!=='HEAD')return text(res,405,'Method not allowed');
  if(route==='/submit/'&&params.has('token')){
   if([...params.keys()].length!==1||params.getAll('token').length!==1)return text(res,400,'Bad request');
   const ip=o.clientIp(req);if(o.limiter.blocked(ip))return text(res,429,'Too many attempts');
   if(!safeEqualString(params.get('token'),o.captureToken)){o.limiter.fail(ip);o.log(`[public-gate] submit token rejected ip=${ip}`);return text(res,401,'This submission link is not valid.');}
   // Lax: the link is usually opened from a chat app (cross-site navigation). POSTs stay same-origin (Lax is not sent cross-site on POST).
   const value=o.signer.issue('capture');
   res.setHeader('Set-Cookie',[cookieHeader(SUBMIT_COOKIE,value,'/submit',SESSION_MS/1000,'Lax'),cookieHeader(SUBMIT_COOKIE,value,'/api/scenario-submit',SESSION_MS/1000,'Lax')]);
   return res.redirect(303,'/submit/');
  }
  if(query)return text(res,400,'Bad request');
  if(!PAGES.includes(route)&&!GUIDE[route])return text(res,404,'Not found');
  if(!submitter(req))return text(res,401,'Open the submission link (with its token) on this device first.');
  return upstream(req,res,method,GUIDE[route]??route,{accept:'*/*'});
 };
}
