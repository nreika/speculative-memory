import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {installTdBrowserControl} from './node-proxy.mjs';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'td-control-test-'));
const tokenFile=path.join(dir,'token');fs.writeFileSync(tokenFile,'test-token-for-isolated-unit-tests-only-000');
let handler;
installTdBrowserControl({use:h=>{handler=h;}},{bridgeUrl:'http://100.100.0.2:8767',tokenFile,allowedHosts:['100.100.0.1:3000']});
function request(extra={}){return {method:'GET',originalUrl:'/api/td-control/state',headers:{host:'100.100.0.1:3000'},socket:{remoteAddress:'100.100.0.2'},...extra};}
function response(){return {code:200,headers:{},status(n){this.code=n;return this;},json(x){this.body=x;return this;},send(x){this.body=x;return this;},type(){return this;},setHeader(k,v){this.headers[k]=v;},removeHeader(){},sendFile(x){this.file=x;}};}
test('reject arbitrary upstream configuration',()=>{assert.throws(()=>installTdBrowserControl({},{bridgeUrl:'http://example.com',tokenFile}));});
test('reject non-tailnet peers',async()=>{const res=response();await handler(request({socket:{remoteAddress:'8.8.8.8'}}),res,()=>{});assert.equal(res.code,403);});
test('reject hostile Host for DNS rebinding',async()=>{const res=response();await handler(request({headers:{host:'attacker.example'}}),res,()=>{});assert.equal(res.code,403);});
test('reject cross-origin state-changing request',async()=>{const res=response();await handler(request({method:'POST',originalUrl:'/api/td-control/action',headers:{host:'100.100.0.1:3000',origin:'http://attacker.example','content-type':'application/json','x-control-request':'1'}}),res,()=>{});assert.equal(res.code,403);});
test('reject exec routes',async()=>{const res=response();await handler(request({originalUrl:'/api/td-control/exec'}),res,()=>{});assert.equal(res.code,404);});
test('inject bearer on server only',async()=>{const old=globalThis.fetch;let passed;globalThis.fetch=async(url,options)=>{passed={url,options};return {status:200,text:async()=>'{"connected":true}'};};try{const res=response();await handler(request(),res,()=>{});assert.equal(passed.url,'http://100.100.0.2:8767/api/td-control/state');assert.match(passed.options.headers.Authorization,/^Bearer /);assert.equal(res.body,'{"connected":true}');assert.ok(!res.body.includes('test-token'));}finally{globalThis.fetch=old;}});
test('native control owns allowed API without a TD fallback',async()=>{
 let nativeHandler,calls=0;
 installTdBrowserControl({use:h=>{nativeHandler=h;}},{bridgeUrl:'http://100.100.0.2:8767',tokenFile,allowedHosts:['100.100.0.1:3000'],controlHandler:async input=>{calls++;return {status:200,body:{runtime:'native',route:input.route}};}});
 const previous=globalThis.fetch;globalThis.fetch=async()=>{throw Error('TD forwarding is forbidden');};
 try{const res=response();await nativeHandler(request(),res,()=>{});assert.equal(res.body.runtime,'native');assert.equal(calls,1);const denied=response();await nativeHandler(request({headers:{host:'attacker.example'}}),denied,()=>{});assert.equal(denied.code,403);assert.equal(calls,1);}finally{globalThis.fetch=previous;}
});
test('POST transport failure is explicitly indeterminate',async()=>{const old=globalThis.fetch;globalThis.fetch=async()=>{throw Error('timeout');};try{const res=response();await handler(request({method:'POST',originalUrl:'/api/td-control/action',headers:{host:'100.100.0.1:3000',origin:'http://100.100.0.1:3000','content-type':'application/json','x-control-request':'1'},body:{action:'scenario.play',requestId:'test',data:{}}}),res,()=>{});assert.equal(res.code,504);assert.equal(res.body.indeterminate,true);}finally{globalThis.fetch=old;}});
test.after(()=>{fs.rmSync(dir,{recursive:true,force:true});});
const mutation=(body,extra={})=>request({method:'POST',originalUrl:'/api/td-control/action',headers:{host:'100.100.0.1:3000',origin:'http://100.100.0.1:3000','content-type':'application/json','x-control-request':'1'},body,...extra});
test('parsed JSON still has hard 36MB bound and invalid actions never reach upstream',async()=>{
 const before=globalThis.fetch;let called=0;globalThis.fetch=async()=>{called++;throw Error('must not forward');};
 try{for(const [body,status]of [[{action:'exec',data:{},requestId:'x'},400],[{action:'settings.apply',data:{text:'x'.repeat(36*1024*1024)},requestId:'x'},413]]){const res=response();await handler(mutation(body),res,()=>{});assert.equal(res.code,status);}assert.equal(called,0);}finally{globalThis.fetch=before;}
});
test('static files are whitelisted and cannot expose runtime token paths',async()=>{for(const route of ['/control/.local/bridge-token.txt','/control/node-proxy.mjs','/control/README.md']){const res=response();await handler(request({originalUrl:route}),res,()=>{});assert.equal(res.code,404);assert.equal(res.file,undefined);}});
test('additional browser screens use the player without forwarding through TD',async()=>{
 for(const route of ['/control/screen/screen-10','/control/mapping/']){const res=response();await handler(request({originalUrl:route}),res,()=>{});assert.equal(res.code,200);assert.ok(res.file.endsWith(route.includes('/screen/')?'output.html':'mapping.html'));}
 for(const route of ['/control/screen/screen-0','/control/screen/screen-../private','/control/screen/https:example.com']){const res=response();await handler(request({originalUrl:route}),res,()=>{});assert.equal(res.code,404);}
});
test('invalid bridge authority/path/query/auth and allowed Host are rejected at startup',()=>{
 for(const bridgeUrl of ['http://127.0.0.1:8767','http://100.100.0.2:8767/x','http://100.100.0.2:8767/?x=1','http://user@100.100.0.2:8767','http://100.100.0.2:8768'])assert.throws(()=>installTdBrowserControl({use(){}},{bridgeUrl,tokenFile}));
 assert.throws(()=>installTdBrowserControl({use(){}},{bridgeUrl:'http://100.100.0.2:8767',tokenFile,allowedHosts:['attacker.example:3000']}));
});
