// Appends PUBLIC_OUTPUT_PASSWORD / PUBLIC_COOKIE_SECRET / PUBLIC_CAPTURE_TOKEN to .env.local only when absent.
// Idempotent; never rewrites or prints existing lines or values. Output: "ok".
// Run: npx tsx scripts/ensure-public-secrets.ts   (an .env.local change makes vite restart: run between captures)
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const file=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','.env.local');
const current=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
const has=(key:string)=>new RegExp('^\s*'+key+'\s*=\s*\S',`m`).test(current);
const wanted:Array<[string,()=>string]>=[
 ['PUBLIC_OUTPUT_PASSWORD',()=>randomBytes(15).toString('base64url')],
 ['PUBLIC_COOKIE_SECRET',()=>randomBytes(32).toString('base64url')],
 ['PUBLIC_CAPTURE_TOKEN',()=>randomBytes(24).toString('base64url')],
];
const lines=wanted.filter(([key])=>!has(key)).map(([key,make])=>`${key}=${make()}`);
if(lines.length){
 const eol=current.includes('\r\n')?'\r\n':'\n';
 const prefix=current.length&&!current.endsWith('\n')?eol:'';
 fs.appendFileSync(file,prefix+'# Public output gate (127.0.0.1:3443 / Tailscale Funnel); see docs/HANDOVER.md'+eol+lines.join(eol)+eol);
}
console.log('ok');
