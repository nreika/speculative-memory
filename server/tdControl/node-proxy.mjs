// Mount before other /control routes. No arbitrary URL, exec, shell, or file proxy.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
const MAX_BODY=36*1024*1024;
const ACTIONS=new Set(['settings.apply','generation.resume','generation.pause','generation.generate','generation.cancel','scenario.load','scenario.play','scenario.pause','scenario.stop','input.select','display.layout','display.shuffle','display.reset','display.show','display.hide','project.save']);

function privatePeer(address='') {
  address=address.replace(/^::ffff:/,'');
  if(address==='::1'||address.startsWith('127.'))return true;
  if(net.isIP(address)===4){const [a,b]=address.split('.').map(Number);return a===100&&b>=64&&b<=127;}
  return address.toLowerCase().startsWith('fd7a:115c:a1e0:');
}
export function installTdBrowserControl(app, options={}) {
  const assets=options.assetsDir||path.dirname(fileURLToPath(import.meta.url));
  const base=options.bridgeUrl||process.env.TD_CONTROL_BRIDGE_URL;
  const file=options.tokenFile||process.env.TD_CONTROL_BRIDGE_TOKEN_FILE;
  const bridge=new URL(base);const octets=bridge.hostname.split('.').map(Number);
  if(bridge.protocol!=='http:'||net.isIP(bridge.hostname)!==4||octets[0]!==100||octets[1]<64||octets[1]>127||bridge.port!=='8767'||bridge.pathname!=='/'||bridge.search||bridge.hash||bridge.username||bridge.password)throw Error('TD control bridge must use the configured Tailscale IPv4 on port 8767');
  const allowedHosts=new Set(options.allowedHosts||(process.env.TD_CONTROL_ALLOWED_HOSTS||'localhost:3000,127.0.0.1:3000').split(',').map(x=>x.trim()));
  for(const host of allowedHosts){const parsed=new URL('http://'+host);if(parsed.host!==host||parsed.port!=='3000'||parsed.pathname!=='/'||parsed.search||parsed.hash||parsed.username||parsed.password||!(parsed.hostname==='localhost'||privatePeer(parsed.hostname)))throw Error('Invalid TD control allowed Host');}
  const token=fs.readFileSync(file,'utf8').trim();if(token.length<32)throw Error('Invalid TD control bridge token');
  const files=new Map([['/control','index.html'],['/control/','index.html'],['/control/mapping','mapping.html'],['/control/mapping/','mapping.html'],['/control/history','history.html'],['/control/history/','history.html'],...['control.css','control.mjs','player.css','output.mjs','timeline.mjs','mapping.css','mapping.mjs','history.css','history.mjs','history-model.mjs','face-blur.mjs'].map(f=>['/control/'+f,f])]);
  const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8'};
  app.use(async(req,res,next)=>{
    const url=new URL(req.originalUrl||req.url,'http://local');
    const route=url.pathname;
    if(!route.startsWith('/api/td-control')&&!route.startsWith('/control'))return next();
    if(!allowedHosts.has(req.headers.host))return res.status(403).json({ok:false,error:'Unknown control host'});
    if(!privatePeer(req.socket.remoteAddress))return res.status(403).json({ok:false,error:'Use this control page over Tailscale or localhost'});
    res.removeHeader('Access-Control-Allow-Origin');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    if(req.method==='GET'&&(files.has(route)||/^\/control\/output\/[1-4]\/?$/.test(route)||/^\/control\/screen\/screen-[1-9][0-9]{0,2}\/?$/.test(route))){
      const name=files.get(route)||'output.html';
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; frame-ancestors 'self'; connect-src 'self'");
      res.type(types[path.extname(name)]);return res.sendFile(path.join(assets,name));
    }
    const get=req.method==='GET'&&/^\/api\/td-control\/(state|input-preview|outputs(?:\/[1-4])?)$/.test(route);
    const post=req.method==='POST'&&/^\/api\/td-control\/(action|scenario-upload)$/.test(route);
    if(!get&&!post)return res.status(404).json({ok:false,error:'Unknown control route'});
    if(url.search)return res.status(400).json({ok:false,error:'Query parameters are not supported'});
    if(post){
      const origin=req.headers.origin;
      if(req.headers['x-control-request']!=='1')return res.status(403).json({ok:false,error:'Missing control request headers'});
      if(String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json')return res.status(415).json({ok:false,error:'JSON is required'});
      if(!origin||!['http://'+req.headers.host,'https://'+req.headers.host].includes(origin))return res.status(403).json({ok:false,error:'Origin not allowed'});
    }
    try{
      let body;
      let payload;
      if(post){
        if(req.body!==undefined)body=JSON.stringify(req.body);
        else {const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>36*1024*1024)return res.status(413).json({ok:false,error:'Request too large'});chunks.push(part);}body=Buffer.concat(chunks);}
        if(Buffer.byteLength(body)>MAX_BODY)return res.status(413).json({ok:false,error:'Request too large'});
        try{payload=JSON.parse(String(body));}catch{return res.status(400).json({ok:false,error:'Invalid JSON'});}
        if(!payload||typeof payload!=='object'||Array.isArray(payload))return res.status(400).json({ok:false,error:'JSON object is required'});
        if(route.endsWith('/action')&&(!ACTIONS.has(payload.action)||typeof payload.requestId!=='string'||!payload.requestId||payload.requestId.length>128||!payload.data||typeof payload.data!=='object'||Array.isArray(payload.data)))return res.status(400).json({ok:false,error:'Invalid control command'});
      }
      // A native operator keeps the same browser contract and access checks.
      // When configured it owns every control API; never fall back to TD.
      if(options.controlHandler){
        const result=await options.controlHandler({method:req.method,route,payload});
        res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
        return res.status(result.status??200).json(result.body);
      }
      const response=await fetch(bridge.origin+route,{method:req.method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Control-Request':'1'},body,redirect:'error',signal:AbortSignal.timeout(25000)});
      const data=await response.text();
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
      return res.status(response.status).type('application/json').send(data);
    }catch{return res.status(post?504:503).json({ok:false,indeterminate:post,error:post?'The command was not confirmed. It may have executed; refresh state before continuing.':'The laptop control bridge is unavailable. TD outputs keep their last image.'});}
  });
}
