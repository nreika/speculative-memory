/** Read-only bridge settings cache. No mutation, secret publication, or own-Node proxy recursion. */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
export type TdDisplayTiming='each'|'all';
export interface TdDisplayRouting {slots:Partial<Record<'td-1'|'td-2'|'td-3'|'td-4','now'|'a'|'b'|'c'>>;view:{visible:boolean;labels:boolean;subtitles:boolean;fade:boolean}}
export interface TdDisplayTimingReader {():Promise<TdDisplayTiming>;readRouting():Promise<TdDisplayRouting|undefined>}
function routingFrom(data:any):TdDisplayRouting|undefined {
 const layout=data?.display?.layout,view={visible:data?.display?.visible,labels:data?.settings?.labels,subtitles:data?.settings?.subtitles,fade:data?.settings?.fade};
 if(!Array.isArray(layout)||layout.length!==4||!layout.every(x=>['A','B','C','NOW'].includes(x))||!Object.values(view).every(x=>typeof x==='boolean'))return;
 const sources={A:'a',B:'b',C:'c',NOW:'now'}as const;
 return {slots:Object.fromEntries(layout.map((source,index)=>['td-'+(index+1),sources[source as keyof typeof sources]])),view};
}
const cloneRouting=(value:TdDisplayRouting|undefined)=>value?{slots:{...value.slots},view:{...value.view}}:undefined;
export interface TdDisplayTimingOptions {
 env?:NodeJS.ProcessEnv;fetch?:typeof fetch;readToken?:(file:string)=>Promise<string>;
 now?:()=>number;ttlMs?:number;timeoutMs?:number;
}
function configuredStateUrl(env:NodeJS.ProcessEnv){
 const u=new URL(env.TD_CONTROL_BRIDGE_URL||'');const [a,b]=u.hostname.split('.').map(Number);
 if(u.protocol!=='http:'||net.isIP(u.hostname)!==4||a!==100||b<64||b>127||u.port!=='8767'||u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw Error('Invalid bridge configuration');
 return u.origin+'/api/td-control/state';
}
export function createTdDisplayTimingReader(options:TdDisplayTimingOptions={}):TdDisplayTimingReader{
 const env=options.env??process.env,http=options.fetch??fetch,now=options.now??Date.now;
 const read=options.readToken??(file=>fs.readFile(file,'utf8'));
 const ttl=options.ttlMs??1500,timeout=options.timeoutMs??1200;
 if(!Number.isFinite(ttl)||ttl<0||!Number.isInteger(timeout)||timeout<1||timeout>10000)throw Error('Invalid display timing cache settings');
 let last:TdDisplayTiming='all',lastRouting:TdDisplayRouting|undefined,checkedAt=-Infinity,inflight:Promise<TdDisplayTiming>|null=null;
 type Packet={mode:TdDisplayTiming;routing:TdDisplayRouting|undefined};
 const retained=():Packet=>({mode:last,routing:lastRouting});
 const reader=(()=>{
  if(inflight)return inflight;
  if(now()-checkedAt<ttl)return Promise.resolve(last);
  const ctrl=new AbortController();let timer:ReturnType<typeof setTimeout>;
  const readMode=async():Promise<Packet>=>{
   try{
    const url=configuredStateUrl(env),file=env.TD_CONTROL_BRIDGE_TOKEN_FILE;
    if(!file||!path.isAbsolute(file))return retained();
    const token=(await read(file)).trim();if(!/^[A-Za-z0-9_-]{32,512}$/.test(token))return retained();
    const response=await http(url,{headers:{Authorization:'Bearer '+token},signal:ctrl.signal,redirect:'error',cache:'no-store'});
    if(!response.ok)return retained();
    const data=await response.json(),mode=data?.settings?.displayTiming;
    return {mode:mode==='each'||mode==='all'?mode:last,routing:routingFrom(data)??lastRouting};
   }catch{return retained();}
  };
  const deadline=new Promise<Packet>(resolve=>{timer=setTimeout(()=>{ctrl.abort();resolve(retained());},timeout);});
  inflight=Promise.race([readMode(),deadline]).then(packet=>{last=packet.mode;lastRouting=packet.routing;checkedAt=now();return last;}).finally(()=>{clearTimeout(timer);inflight=null;});
  return inflight;
 }) as TdDisplayTimingReader;
 reader.readRouting=async()=>{await reader();return cloneRouting(lastRouting);};
 return reader;
}
