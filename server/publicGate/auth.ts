/** Public gate authentication: scrypt password check, HMAC-signed role cookies, in-memory login rate limit. No secret is ever logged. */
import {createHmac,randomBytes,scrypt,scryptSync,timingSafeEqual} from 'node:crypto';

export type GateRole='view'|'capture';
export const VIEW_COOKIE='sm_pub',CAPTURE_COOKIE='sm_cap',SESSION_MS=12*60*60*1000;

export function createPasswordVerifier(password:string){
 if(typeof password!=='string'||password.length<8)throw Error('Public password is missing or too short (8+ chars)');
 const salt=randomBytes(16),expected=scryptSync(password,salt,32);
 return (input:unknown)=>new Promise<boolean>(resolve=>{
  if(typeof input!=='string'||!input.length||input.length>256)return resolve(false);
  scrypt(input,salt,32,(error,actual)=>resolve(!error&&timingSafeEqual(actual,expected)));
 });
}

export function safeEqualString(a:unknown,b:string){
 if(typeof a!=='string'||!b)return false;
 const x=Buffer.from(a),y=Buffer.from(b);
 return x.length===y.length&&timingSafeEqual(x,y);
}

export function createCookieSigner(secret:string,now:()=>number=Date.now){
 if(typeof secret!=='string'||secret.length<16)throw Error('Public cookie secret is missing or too short');
 const mac=(body:string)=>createHmac('sha256',secret).update(body).digest('base64url');
 return {
  issue(role:GateRole){const body=`${now()+SESSION_MS}.${role}.${randomBytes(12).toString('base64url')}`;return body+'.'+mac(body);},
  verify(value:unknown,role:GateRole):boolean{
   if(typeof value!=='string'||value.length>256)return false;
   const parts=value.split('.');if(parts.length!==4)return false;
   const [expiry,valueRole,nonce,signature]=parts;
   if(!/^\d{13,15}$/.test(expiry)||valueRole!==role||!/^[A-Za-z0-9_-]{8,32}$/.test(nonce))return false;
   if(!safeEqualString(signature,mac(`${expiry}.${valueRole}.${nonce}`)))return false;
   return Number(expiry)>now();
  }
 };
}

export function cookieHeader(name:string,value:string,path:string,maxAgeSec:number){
 return `${name}=${value}; Path=${path}; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Strict`;
}
export function readCookie(header:unknown,name:string):string|undefined{
 if(typeof header!=='string'||header.length>8192)return undefined;
 for(const part of header.split(';')){const i=part.indexOf('=');if(i>0&&part.slice(0,i).trim()===name)return part.slice(i+1).trim();}
 return undefined;
}

/** Failed attempts in a sliding window: per client IP and global. */
export function createLoginLimiter(options:{perIp?:number;global?:number;windowMs?:number;now?:()=>number}={}){
 const perIp=options.perIp??5,global=options.global??50,windowMs=options.windowMs??10*60*1000,now=options.now??Date.now;
 const byIp=new Map<string,number[]>();let all:number[]=[];
 const prune=(list:number[])=>{const cut=now()-windowMs;return list.filter(t=>t>cut);};
 return {
  blocked(ip:string):boolean{all=prune(all);const list=prune(byIp.get(ip)??[]);if(list.length)byIp.set(ip,list);else byIp.delete(ip);return list.length>=perIp||all.length>=global;},
  fail(ip:string){all=prune(all);all.push(now());const list=prune(byIp.get(ip)??[]);list.push(now());byIp.set(ip,list);if(byIp.size>10000)byIp.delete(byIp.keys().next().value!);},
 };
}
