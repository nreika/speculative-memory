/** Display derivatives, computed once when a generated image is saved (never on a screen request):
 *  captures/display/<name>.jpg (same size, JPEG q85, ~200 KB; the PNG stays the archive original)
 *  captures/display/<name>.faces.json (face boxes of that JPEG, same shape the face service returns). */
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {createHash} from 'node:crypto';
export const DISPLAY_DIRNAME='display';
const GEN=/^Gen_[a-z]_[A-Za-z0-9_.-]+\.png$/i;
const PY=String.raw`
import sys,os
from PIL import Image
Image.MAX_IMAGE_PIXELS=64*1024*1024
s,o=sys.argv[1],sys.argv[2];t=o+'.tmp'
with Image.open(s) as im:
 im=im.convert('RGB');im.save(t,'JPEG',quality=85,optimize=True)
os.replace(t,o)
`;
const python=()=>process.env.FACE_DETECTOR_PYTHON||path.join(process.env.USERPROFILE||'','claude-code/runtime-face-detector/Scripts/python.exe');
let capturesRoot=path.resolve('captures');
export const setDisplayCapturesDir=(dir:string)=>{capturesRoot=path.resolve(dir);};
const dirOf=()=>path.join(capturesRoot,DISPLAY_DIRNAME);
const known=new Set<string>();let scanned=false;
function scan(){if(scanned)return;scanned=true;try{for(const n of fs.readdirSync(dirOf()))if(/\.jpg$/i.test(n))known.add(n);}catch{}}
const jpgName=(file:string)=>path.parse(file).name+'.jpg';
/** '/captures/Gen_x.png' -> '/captures/display/Gen_x.jpg' when the derivative exists, else the input URL unchanged. */
export function displayImageUrl(url:string):string{
 const m=/^\/captures\/(Gen_[^/?#%\\]+\.png)$/i.exec(url);if(!m||!GEN.test(m[1]))return url;
 scan();const name=jpgName(m[1]);if(!known.has(name)&&fs.existsSync(path.join(dirOf(),name)))known.add(name);return known.has(name)?'/captures/'+DISPLAY_DIRNAME+'/'+name:url;
}
const run=(args:string[],input?:Buffer,timeoutMs=20000)=>new Promise<string>((resolve,reject)=>{
 const c=spawn(python(),args,{windowsHide:true,stdio:['pipe','pipe','ignore']});let out='';const t=setTimeout(()=>{c.kill();reject(Error('timeout'));},timeoutMs);
 c.stdout.on('data',d=>{out+=String(d);});c.on('error',e=>{clearTimeout(t);reject(e);});c.stdin.on('error',()=>{});
 c.on('close',code=>{clearTimeout(t);code===0?resolve(out):reject(Error('exit '+code));});c.stdin.end(input);
});
let chain:Promise<unknown>=Promise.resolve();
export async function makeDerivatives(file:string,faceWorker=path.resolve('scripts/browser-face-boxes.py')){
 const base=path.basename(file);if(!GEN.test(base))return;
 const dir=dirOf();fs.mkdirSync(dir,{recursive:true});const name=jpgName(base),out=path.join(dir,name),sidecar=path.join(dir,path.parse(name).name+'.faces.json');
 if(!fs.existsSync(out))await run(['-c',PY,file,out]);
 const bytes=fs.readFileSync(out);
 if(!fs.existsSync(sidecar)){
  try{const r=JSON.parse(await run(['-u',faceWorker],Buffer.from(JSON.stringify({image:bytes.toString('base64')}))));
   if(r&&(r.status==='detected'||r.status==='no-faces')){const tmp=sidecar+'.tmp';fs.writeFileSync(tmp,JSON.stringify({...r,imageSha256:createHash('sha256').update(bytes).digest('hex')}));fs.renameSync(tmp,sidecar);}}catch{/* request path falls back to live detection */}
 }
 known.add(name);
}
/** Queue (serial, background). Never throws. */
export function enqueueDisplayDerivatives(file:string){chain=chain.then(()=>makeDerivatives(file)).catch(e=>console.warn('[display] derivative failed: '+(e as Error).message));}
/** Pre-computed boxes for '/captures/display/<name>.jpg', or null. */
export function readDisplayFaces(url:string):any|null{
 const m=/^\/captures\/display\/([A-Za-z0-9][A-Za-z0-9_.-]*)\.jpg$/i.exec(url);if(!m)return null;
 try{return JSON.parse(fs.readFileSync(path.join(dirOf(),m[1]+'.faces.json'),'utf8'));}catch{return null;}
}
