import {spawn} from 'node:child_process';import path from 'node:path';
import type {CompositionRect} from './scenarioComposition';

const PY=String.raw`
import sys,json,base64,io
from PIL import Image,ImageChops
q=json.load(sys.stdin)
def image(s):
 b=base64.b64decode(s.split(',',1)[1],validate=True)
 if len(b)>32*1024*1024:raise ValueError('image too large')
 im=Image.open(io.BytesIO(b));im.load()
 if im.width*im.height>16*1024*1024:raise ValueError('image dimensions exceed limit')
 return im.convert('RGBA')
try:
 raw=image(q['raw']);composed=image(q['composed']);core=image(q['coreMask']).convert('L').point(lambda a:255 if a>0 else 0)
 if raw.size!=composed.size or raw.size!=core.size:raise ValueError('dimensions mismatch')
 if not q['rectangles']:raise ValueError('no actual rectangles')
 allowed=Image.new('L',raw.size,0);w,h=raw.size
 for r in q['rectangles']:
  x,y,rw,rh=(r[k] for k in ('x','y','width','height'))
  if any(type(n)!=int for n in (x,y,rw,rh)) or x<0 or y<0 or rw<1 or rh<1 or x+rw>w or y+rh>h:raise ValueError('invalid rectangle')
  allowed.paste(255,(x,y,x+rw,y+rh))
 if ImageChops.subtract(core,allowed).getbbox():raise ValueError('core outside allowed rectangles')
 if ImageChops.subtract(allowed,core).getbbox():raise ValueError('unprotected generated pixels remain')
 # Existing restoration: raw outside allowed; generated inside allowed; then composed at every core pixel.
 # Here core == union(allowed), so every possible generated pixel is overwritten, for any model output.
 result=raw.copy();result.paste(composed,(0,0),core)
 out=io.BytesIO();result.save(out,format='PNG')
 json.dump(dict(proven=True,png=base64.b64encode(out.getvalue()).decode('ascii'),width=w,height=h,proof=dict(version='asset-only-core-covers-edit-union-v1',allowedPixels=allowed.histogram()[255],protectedCorePixels=core.histogram()[255],generatedContributionPixels=0,rectangles=q['rectangles'],alphaSemantics='copy already-composited pixels once where mask luminance > 0; never reapply asset alpha',outside='exact raw decoded pixels',modelExecuted=False)),sys.stdout,separators=(',',':'))
except Exception as e:
 json.dump(dict(proven=False,reason=str(e)),sys.stdout,separators=(',',':'))
`;

export interface AssetOnlyCpuResult {imageDataUrl:string;width:number;height:number;proof:Record<string,unknown>;cpuMs:number}
/** A proof-driven optimization only. Any hole, malformed image or uncertain coverage keeps normal generation. */
export async function tryAssetOnlyCpuResult(raw:string,composed:string,coreMask:string,rectangles:CompositionRect[],options:{pythonPath?:string;signal?:AbortSignal}={}):Promise<AssetOnlyCpuResult|null>{
 if(!rectangles.length||!coreMask)return null;options.signal?.throwIfAborted();const start=Date.now();
 const python=options.pythonPath||process.env.SCENARIO_COMPOSITION_PYTHON||process.env.PEOPLE_DETECTOR_PYTHON||path.join(process.env.USERPROFILE||'','Documents/ComfyUI/.venv/Scripts/python.exe');
 try{
  const output=await new Promise<string>((resolve,reject)=>{const child=spawn(python,['-c',PY],{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',settled=false;const done=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);if(error){child.kill();reject(error);}else resolve(stdout);};const abort=()=>done(new DOMException('Asset-only CPU proof cancelled','AbortError'));const timer=setTimeout(()=>done(new Error('Asset-only CPU proof timeout')),30000);child.on('error',done);child.stdin.on('error',done);child.stdout.on('data',b=>{stdout+=String(b);if(stdout.length>96*1024*1024)done(new Error('CPU proof output exceeds limit'));});child.stderr.resume();child.on('close',code=>done(code===0?undefined:new Error('CPU proof failed')));options.signal?.addEventListener('abort',abort,{once:true});child.stdin.end(JSON.stringify({raw,composed,coreMask,rectangles}));});
  const value=JSON.parse(output);if(value.proven!==true)return null;
  return {imageDataUrl:'data:image/png;base64,'+value.png,width:value.width,height:value.height,proof:value.proof,cpuMs:Date.now()-start};
 }catch(error){options.signal?.throwIfAborted();return null;}
}
