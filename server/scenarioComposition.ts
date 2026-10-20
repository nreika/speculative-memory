/** Scene-local raster composition. Requires parseScenarioControl output; does not approve people/content.
 * Pillow is already used by the CPU image pipeline. No files, network or model calls are used here.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SCENARIO_CONTROL_LIMITS, type NormalizedRect, type ScenarioSceneKey, type ValidatedScenarioControl } from './scenarioControl';

export interface CompositionRect { x: number; y: number; width: number; height: number }
export interface ScenarioCompositionTarget {
  elementId: string; imageSha256: string; applyOrder: number;
  sourceRect: NormalizedRect; targetRect: NormalizedRect;
  sourcePixels: CompositionRect; targetPixels: CompositionRect; drawPixels: CompositionRect;
  fit: 'cover' | 'contain'; opacity: number; featherPx: number;
  applied: boolean; contentReview: 'required';
}
export interface ComposedScenarioInput {
  imageDataUrl: string; imageSha256: string;
  protectedCoreMaskDataUrl?:string; protectedCoreMaskSha256?:string; protectedCorePixels?:number;
  targets: ScenarioCompositionTarget[];
  /** Conservative target rectangles for merging into the generation edit mask. Empty for invisible layers. */
  editRectangles: CompositionRect[];
}
export interface ScenarioCompositionResult {
  width: number; height: number; sourceSha256: string;
  /** Only keys explicitly present in control.sceneElements; empty scenes return the exact original data URL. */
  scenes: Partial<Record<ScenarioSceneKey, ComposedScenarioInput>>;
}
export interface ScenarioCompositionOptions { pythonPath?: string; timeoutMs?: number; signal?: AbortSignal }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function imageBytes(image: string): Buffer {
  const match = /^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
  if (!match || match[1].length > 4 * Math.ceil(SCENARIO_CONTROL_LIMITS.imageBytes / 3)) throw new Error('Invalid or oversized composition image');
  const bytes = Buffer.from(match[1], 'base64');
  if (!bytes.length || bytes.length > SCENARIO_CONTROL_LIMITS.imageBytes || bytes.toString('base64') !== match[1]) throw new Error('Invalid composition base64');
  return bytes;
}

// Integer source/target bounds enclose the normalized rectangle (floor left/top, ceil right/bottom).
// Crop ORIGINAL asset once. Cover then uses a centered fit box within that crop, never sourceRect again.
// Resize premultiplied alpha to avoid dark fringes. Opacity and feather multiply original alpha.
// Feather is a linear inward ramp at the DRAWN image edges, measured in output pixels at pixel centers.
// Contain margins retain the original scene; all layers are source-over in request order.
const COMPOSITOR = String.raw`
import sys,json,base64,io,math,hashlib
from PIL import Image,ImageChops
request=json.load(sys.stdin)
limit=request['limits']
Image.MAX_IMAGE_PIXELS=limit['imagePixels']
def load(encoded):
    raw=base64.b64decode(encoded,validate=True)
    if len(raw)>limit['imageBytes']: raise ValueError('image byte limit exceeded')
    image=Image.open(io.BytesIO(raw))
    if image.format not in ('PNG','JPEG','WEBP') or getattr(image,'n_frames',1)!=1: raise ValueError('unsupported source format')
    w,h=image.size
    if not w or not h or max(w,h)>limit['imageEdge'] or w*h>limit['imagePixels']: raise ValueError('image dimensions exceed limits')
    image.load()
    # Pillow preserves RGB16 downconversion itself; 16-bit grayscale needs explicit 0..65535 scaling.
    if image.mode.startswith('I;16') or (image.mode=='I' and image.format=='PNG'):
        image=image.convert('I').point(lambda v:v/257).convert('L')
    return image.convert('RGBA')
def rect(value,w,h):
    x,y,rw,rh=value
    left=max(0,min(w-1,math.floor(x*w+1e-9)))
    top=max(0,min(h-1,math.floor(y*h+1e-9)))
    right=max(left+1,min(w,math.ceil((x+rw)*w-1e-9)))
    bottom=max(top+1,min(h,math.ceil((y+rh)*h-1e-9)))
    return {'x':left,'y':top,'width':right-left,'height':bottom-top}
def feather(w,h,amount):
    horizontal=bytes(round(255*min(1,(x+.5)/amount,(w-x-.5)/amount)) for x in range(w))
    vertical=bytes(round(255*min(1,(y+.5)/amount,(h-y-.5)/amount)) for y in range(h))
    return ImageChops.darker(Image.frombytes('L',(w,1),horizontal).resize((w,h)),Image.frombytes('L',(1,h),vertical).resize((w,h)))
base=load(request['source'])
w,h=base.size
scenes={}
assets={}
for key,elements in request['scenes'].items():
    canvas=base.copy()
    core=Image.new('L',(w,h),0)
    targets=[]
    edit=[]
    for order,e in enumerate(elements):
        asset_hash=e['imageSha256']
        if asset_hash not in assets: assets[asset_hash]=load(e['image'].split(',',1)[1])
        original=assets[asset_hash]
        if original.size!=(e['imageWidth'],e['imageHeight']): raise ValueError('validated asset dimensions do not match')
        source=rect(e['sourceRect'],*original.size)
        target=rect(e['targetRect'],w,h)
        sx,sy,sw,sh=(source[k] for k in ('x','y','width','height'))
        tx,ty,tw,th=(target[k] for k in ('x','y','width','height'))
        cropped=original.crop((sx,sy,sx+sw,sy+sh))
        if request.get('sceneModes',{}).get(key)=='asset_only' and cropped.getchannel('A').getextrema()!=(255,255): raise ValueError('ASSET_ONLY_OPAQUE_CROP_REQUIRED')
        if e['fit']=='cover':
            scale=max(tw/sw,th/sh)
            bw,bh=tw/scale,th/scale
            bx,by=(sw-bw)/2,(sh-bh)/2
            layer=cropped.convert('RGBa').resize((tw,th),Image.Resampling.LANCZOS,box=(bx,by,bx+bw,by+bh)).convert('RGBA')
            dx,dy,dw,dh=tx,ty,tw,th
        else:
            scale=min(tw/sw,th/sh)
            dw,dh=max(1,min(tw,math.floor(sw*scale+.5))),max(1,min(th,math.floor(sh*scale+.5)))
            dx,dy=tx+(tw-dw)//2,ty+(th-dh)//2
            layer=cropped.convert('RGBa').resize((dw,dh),Image.Resampling.LANCZOS).convert('RGBA')
        alpha=layer.getchannel('A').point([round(a*e['opacity']) for a in range(256)])
        if e['featherPx']>0: alpha=ImageChops.multiply(alpha,feather(dw,dh,e['featherPx']))
        applied=alpha.getbbox() is not None
        if applied:
            layer.putalpha(alpha)
            canvas.alpha_composite(layer,(dx,dy))
            if request.get('sceneModes',{}).get(key)=='asset_only':
                layer_core=alpha.point(lambda a:255 if a>0 else 0)
                full_core=Image.new('L',(w,h),0);full_core.paste(layer_core,(dx,dy))
                core=ImageChops.lighter(core,full_core)
            edit.append(dict(x=dx,y=dy,width=dw,height=dh) if request.get('sceneModes',{}).get(key)=='asset_only' else target)
        targets.append(dict(elementId=e['id'],imageSha256=asset_hash,applyOrder=order,sourceRect=e['sourceRect'],targetRect=e['targetRect'],sourcePixels=source,targetPixels=target,drawPixels=dict(x=dx,y=dy,width=dw,height=dh),fit=e['fit'],opacity=e['opacity'],featherPx=e['featherPx'],applied=applied,contentReview='required'))
    if edit:
        output=io.BytesIO()
        canvas.save(output,format='PNG')
        encoded=base64.b64encode(output.getvalue()).decode('ascii')
    else: encoded=None
    core_data=None;core_pixels=0
    if request.get('sceneModes',{}).get(key)=='asset_only':
        core_output=io.BytesIO();core.convert('RGB').save(core_output,format='PNG');core_data=base64.b64encode(core_output.getvalue()).decode('ascii');core_pixels=core.histogram()[255]
    scenes[key]=dict(png=encoded,targets=targets,editRectangles=edit,coreMask=core_data,corePixels=core_pixels)
json.dump(dict(width=w,height=h,scenes=scenes),sys.stdout,separators=(',',':'))
`;

/** Does not mutate NOW/control, save files, or authorize added people. Caller retains identity checks against raw NOW. */
export async function composeScenarioInputs(nowImage: string, control: ValidatedScenarioControl, options: ScenarioCompositionOptions = {}): Promise<ScenarioCompositionResult> {
  options.signal?.throwIfAborted();
  const source = imageBytes(nowImage);
  const scenes = control.sceneElements;
  // Defense against a mismatched asset/metadata pair; the validator remains the rectangle/PNG schema authority.
  for (const elements of Object.values(scenes)) for (const element of elements ?? []) {
    if (hash(imageBytes(element.image)) !== element.imageSha256) throw new Error(`Scenario asset hash mismatch: ${element.id}`);
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('Invalid composition timeout');
  const payload = JSON.stringify({ source: source.toString('base64'), scenes, sceneModes:control.sceneModes, limits: SCENARIO_CONTROL_LIMITS });
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(options.pythonPath ?? process.env.SCENARIO_COMPOSITION_PYTHON ?? process.env.PEOPLE_DETECTOR_PYTHON ?? 'python', ['-c', COMPOSITOR], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    const chunks: Buffer[] = []; let bytes = 0, stderr = '', settled = false;
    // PNG worst-case RGBA raster for all three scenes, plus base64 and small metadata overhead.
    const maxOutput = 3 * Math.ceil((SCENARIO_CONTROL_LIMITS.imagePixels * 4 + 1024 * 1024) * 4 / 3);
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error) { child.kill(); reject(error); } else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const abort = () => finish(new Error('Scenario composition interrupted'));
    const timer = setTimeout(() => finish(new Error('Scenario composition timed out')), timeoutMs);
    child.on('error', error => finish(error)); child.stdin.on('error', error => finish(error));
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxOutput) finish(new Error('Composition output exceeds limit')); else chunks.push(chunk); });
    child.on('close', code => finish(code === 0 ? undefined : new Error(`Scenario composition failed (${code}): ${stderr}`)));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort(); else child.stdin.end(payload);
  });
  const output = JSON.parse(stdout);
  const result: ScenarioCompositionResult = { width: output.width, height: output.height, sourceSha256: hash(source), scenes: {} };
  for (const key of Object.keys(scenes) as ScenarioSceneKey[]) {
    const scene = output.scenes[key];
    const bytes = scene.png === null ? source : Buffer.from(scene.png, 'base64');
    result.scenes[key] = { imageDataUrl: scene.png === null ? nowImage : `data:image/png;base64,${scene.png}`, imageSha256: hash(bytes), targets: scene.targets, editRectangles: scene.editRectangles,...(scene.coreMask?{protectedCoreMaskDataUrl:'data:image/png;base64,'+scene.coreMask,protectedCoreMaskSha256:hash(Buffer.from(scene.coreMask,'base64')),protectedCorePixels:scene.corePixels}:{}) };
  }
  return result;
}
