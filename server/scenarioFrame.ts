import {spawn} from 'node:child_process';import path from 'node:path';
import type {CompositionRect} from './scenarioComposition';
export interface SourceFrameRestoration {imageDataUrl:string;width:number;height:number;transform:{sourceSize:{width:number;height:number};modelSize:{width:number;height:number};crop:{x:number;y:number;width:number;height:number};rectangles:CompositionRect[];method:string}}
const PY=String.raw`
import sys,json,base64,io
from PIL import Image
q=json.load(sys.stdin)
def image(s):
 b=base64.b64decode(s.split(',',1)[1],validate=True)
 if len(b)>32*1024*1024:raise ValueError('image too large')
 im=Image.open(io.BytesIO(b));im.load()
 if im.width*im.height>16*1024*1024:raise ValueError('image dimensions exceed limit')
 return im.convert('RGBA')
raw=image(q['raw']);generated=image(q['generated']);w,h=raw.size;mw,mh=generated.size
old=w/h;new=mw/mh;x=round((w-w*(new/old))/2) if old>new else 0;y=round((h-h*(old/new))/2) if old<new else 0
cw,ch=w-2*x,h-2*y
# This is the exact inverse coordinate map of Comfy common_upscale(...,'center').
# Only generated target patches are resampled; the raw frame itself is never scaled.
restored=raw.copy();patches=generated.resize((cw,ch),Image.Resampling.LANCZOS)
for r in q['rectangles']:
 rx,ry,rw,rh=(r[k] for k in ('x','y','width','height'))
 if any(type(n)!=int for n in (rx,ry,rw,rh)) or rw<1 or rh<1 or rx<x or ry<y or rx+rw>x+cw or ry+rh>y+ch:raise ValueError('ASSET_ONLY_TARGET_OUTSIDE_MODEL_CROP')
 restored.paste(patches.crop((rx-x,ry-y,rx-x+rw,ry-y+rh)),(rx,ry))
core_pixels=0
if q.get('coreMask') is not None or q.get('composed') is not None:
 if not q.get('coreMask') or not q.get('composed'):raise ValueError('Both composed input and core mask are required')
 composed=image(q['composed']);core=image(q['coreMask']).convert('L').point(lambda a:255 if a>0 else 0)
 if composed.size!=raw.size or core.size!=raw.size:raise ValueError('Core/source dimensions mismatch')
 allowed=Image.new('L',raw.size,0)
 for r in q['rectangles']:allowed.paste(255,(r['x'],r['y'],r['x']+r['width'],r['y']+r['height']))
 from PIL import ImageChops
 if ImageChops.subtract(core,allowed).getbbox():raise ValueError('Protected core outside allowed rectangles')
 restored.paste(composed,(0,0),core);core_pixels=core.histogram()[255]
out=io.BytesIO();restored.save(out,format='PNG')
json.dump(dict(png=base64.b64encode(out.getvalue()).decode('ascii'),width=w,height=h,transform=dict(sourceSize=dict(width=w,height=h),modelSize=dict(width=mw,height=mh),crop=dict(x=x,y=y,width=cw,height=ch),rectangles=q['rectangles'],protectedCorePixels=core_pixels,coreProtection='ordered composed pixels selected once where effective alpha > 0',method='raw frame unchanged; inverse center-crop/lanczos for generated target patches only')),sys.stdout,separators=(',',':'))
`;
/** Preserve raw NOW pixel coordinates outside explicit asset rectangles. No diffusion or VLM calls. */
export async function restoreAssetOnlySourceFrame(raw:string,generated:string,rectangles:CompositionRect[],options:{pythonPath?:string;signal?:AbortSignal;composedImageDataUrl?:string;protectedCoreMaskDataUrl?:string}={}):Promise<SourceFrameRestoration>{
 if(!rectangles.length)throw new Error('Asset-only restoration requires actual edit rectangles');options.signal?.throwIfAborted();
 const python=options.pythonPath||process.env.SCENARIO_COMPOSITION_PYTHON||process.env.PEOPLE_DETECTOR_PYTHON||path.join(process.env.USERPROFILE||'','Documents/ComfyUI/.venv/Scripts/python.exe');
 const output=await new Promise<string>((resolve,reject)=>{const child=spawn(python,['-c',PY],{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',settled=false;const done=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);if(error){child.kill();reject(error);}else resolve(stdout);};const abort=()=>done(new DOMException('Source-frame restoration cancelled','AbortError'));const timer=setTimeout(()=>done(new Error('Source-frame restoration timeout')),30000);child.on('error',done);child.stdin.on('error',done);child.stdout.on('data',b=>{stdout+=String(b);if(stdout.length>96*1024*1024)done(new Error('Restoration output exceeds limit'));});child.stderr.on('data',b=>stderr=(stderr+String(b)).slice(-2000));child.on('close',code=>done(code===0?undefined:new Error('Source-frame restoration failed: '+stderr)));options.signal?.addEventListener('abort',abort,{once:true});child.stdin.end(JSON.stringify({raw,generated,rectangles,composed:options.composedImageDataUrl,coreMask:options.protectedCoreMaskDataUrl}));});
 const value=JSON.parse(output);return {imageDataUrl:'data:image/png;base64,'+value.png,width:value.width,height:value.height,transform:value.transform};
}
