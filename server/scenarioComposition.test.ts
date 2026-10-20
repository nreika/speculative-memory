import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseScenarioControl } from './scenarioControl';
import { composeScenarioInputs } from './scenarioComposition';
import { decodePng } from './qa/gridDetect';

type RGBA = [number,number,number,number];
const red:RGBA=[255,0,0,255], blue:RGBA=[0,0,255,255], green:RGBA=[0,255,0,255], black:RGBA=[0,0,0,255];
function chunk(type:string,data:Buffer):Buffer {
  const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);
  let crc=0xffffffff;
  for(const value of b.subarray(4,-4)){crc^=value;for(let i=0;i<8;i++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}
  b.writeUInt32BE((crc^0xffffffff)>>>0,b.length-4);return b;
}
function png(w:number,h:number,pixel:(x:number,y:number)=>RGBA):string {
  const head=Buffer.alloc(13);head.writeUInt32BE(w);head.writeUInt32BE(h,4);head[8]=8;head[9]=6;
  const raster=Buffer.alloc((w*4+1)*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)Buffer.from(pixel(x,y)).copy(raster,y*(w*4+1)+1+x*4);
  return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(raster)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
function read(image:string) {return decodePng(Buffer.from(image.split(',')[1],'base64'))!;}
function pixel(image:string,x:number,y:number):number[] {const p=read(image);return [...p.data.subarray((y*p.width+x)*p.channels,(y*p.width+x)*p.channels+4)];}
function element(image:string,over:Record<string,unknown>={}) {return {id:'asset',image,sourceRect:[0,0,1,1],targetRect:[0,0,1,1],fit:'cover',opacity:1,featherPx:0,instruction:'',...over};}
function control(scenes:Record<string,unknown[]>) {return parseScenarioControl({version:1,scenarioId:'test',runId:'run',elapsedSec:0,cycle:0,cueIds:[],sceneElements:scenes})!;}
const digest=(image:string)=>createHash('sha256').update(Buffer.from(image.split(',')[1],'base64')).digest('hex');

test('crop once from original asset, keep each scene independent and preserve NOW/control',async()=>{
  const now=png(4,2,()=>black), asset=png(4,2,x=>[red,red,green,blue][x]);
  const c=control({gen_a:[element(asset,{sourceRect:[.5,0,.5,1],targetRect:[.5,0,.5,1]})],gen_b:[]});
  const before=JSON.stringify(c),result=await composeScenarioInputs(now,c);
  assert.equal(JSON.stringify(c),before);assert.equal(result.sourceSha256,digest(now));
  assert.equal(result.scenes.gen_b!.imageDataUrl,now);assert.equal(result.scenes.gen_c,undefined);
  const a=result.scenes.gen_a!;
  assert.deepEqual(pixel(a.imageDataUrl,0,0),black);
  assert.deepEqual(pixel(a.imageDataUrl,2,0),green,'a second application of sourceRect would lose this column');
  assert.deepEqual(pixel(a.imageDataUrl,3,0),blue);
  assert.equal(a.targets[0].imageSha256,digest(asset));
  assert.deepEqual(a.targets[0].sourcePixels,{x:2,y:0,width:2,height:2});
  assert.deepEqual(a.editRectangles,[{x:2,y:0,width:2,height:2}]);
  assert.equal(a.targets[0].contentReview,'required');
});

test('cover centers the fit crop; contain leaves margins from NOW, never transparent black',async()=>{
  const now=png(4,4,()=>green),asset=png(4,2,x=>[red,blue,blue,red][x]);
  const r=await composeScenarioInputs(now,control({gen_a:[element(asset,{targetRect:[0,0,.5,.5]})],gen_b:[element(asset,{fit:'contain'})]}));
  assert.deepEqual(pixel(r.scenes.gen_a!.imageDataUrl,0,0),blue);
  assert.deepEqual(pixel(r.scenes.gen_a!.imageDataUrl,1,1),blue);
  assert.deepEqual(pixel(r.scenes.gen_b!.imageDataUrl,0,0),green);
  assert.deepEqual(pixel(r.scenes.gen_b!.imageDataUrl,0,1),red);
  assert.deepEqual(pixel(r.scenes.gen_b!.imageDataUrl,0,3),green);
  assert.deepEqual(r.scenes.gen_b!.targets[0].drawPixels,{x:0,y:1,width:4,height:2});
});

test('opacity multiplies asset alpha and source-over preserves destination alpha',async()=>{
  const now=png(1,1,()=>[0,0,255,128]),asset=png(1,1,()=>[255,0,0,128]);
  const r=await composeScenarioInputs(now,control({gen_a:[element(asset,{opacity:.5})]}));
  assert.deepEqual(pixel(r.scenes.gen_a!.imageDataUrl,0,0),[102,0,153,160]);
});

test('layers apply in array order and one scene never inherits another scene composition',async()=>{
  const now=png(2,2,()=>black),r=png(1,1,()=>red),b=png(1,1,()=>blue);
  const result=await composeScenarioInputs(now,control({gen_a:[element(r,{id:'first'}),element(b,{id:'second',targetRect:[.5,0,.5,1]})],gen_b:[element(b,{opacity:.5})]}));
  assert.deepEqual(pixel(result.scenes.gen_a!.imageDataUrl,0,0),red);
  assert.deepEqual(pixel(result.scenes.gen_a!.imageDataUrl,1,0),blue);
  assert.deepEqual(pixel(result.scenes.gen_b!.imageDataUrl,0,0),[0,0,128,255]);
  assert.deepEqual(result.scenes.gen_a!.targets.map(t=>[t.elementId,t.applyOrder]),[['first',0],['second',1]]);
});

test('feather uses output-pixel inward distances and retains pixels outside target',async()=>{
  const now=png(7,5,()=>black),asset=png(1,1,()=>red);
  const r=await composeScenarioInputs(now,control({gen_a:[element(asset,{targetRect:[1/7,0,5/7,1],opacity:.5,featherPx:2})]}));
  const img=r.scenes.gen_a!.imageDataUrl;
  assert.deepEqual(pixel(img,0,2),black);assert.deepEqual(pixel(img,6,2),black);
  assert.deepEqual(pixel(img,1,2),[32,0,0,255]);assert.deepEqual(pixel(img,3,2),[128,0,0,255]);
});

test('transparent and zero-opacity elements are recorded but do not change original bytes or edit bounds',async()=>{
  const now=png(2,2,()=>green);
  const r=await composeScenarioInputs(now,control({gen_a:[element(png(1,1,()=>[255,0,0,0]),{id:'transparent'}),element(png(1,1,()=>red),{id:'zero',opacity:0})]}));
  assert.equal(r.scenes.gen_a!.imageDataUrl,now);assert.equal(r.scenes.gen_a!.imageSha256,digest(now));
  assert.deepEqual(r.scenes.gen_a!.editRectangles,[]);assert.ok(r.scenes.gen_a!.targets.every(t=>!t.applied));
});

test('tiny normalized rectangles touching bottom/right stay within canvas and occupy one pixel',async()=>{
  const now=png(3,3,()=>black),asset=png(2,2,()=>red);
  const r=await composeScenarioInputs(now,control({gen_a:[element(asset,{sourceRect:[.999,.999,.001,.001],targetRect:[.999,.999,.001,.001]})]}));
  assert.deepEqual(r.scenes.gen_a!.editRectangles,[{x:2,y:2,width:1,height:1}]);
  assert.deepEqual(pixel(r.scenes.gen_a!.imageDataUrl,2,2),red);assert.deepEqual(pixel(r.scenes.gen_a!.imageDataUrl,1,2),black);
});

test('notebook two-colour fixture uses blue half once with contain and feather at normalized target',async()=>{
  const now=png(320,180,()=>black),asset=png(160,120,x=>x<80?red:blue);
  const r=await composeScenarioInputs(now,control({gen_a:[element(asset,{sourceRect:[.5,0,.5,1],targetRect:[.02,.79,.10,.13],fit:'contain',featherPx:4})]}));
  const scene=r.scenes.gen_a!,t=scene.targets[0];
  assert.equal(t.imageSha256,digest(asset));assert.deepEqual(t.sourcePixels,{x:80,y:0,width:80,height:120});
  assert.deepEqual(t.targetPixels,{x:6,y:142,width:33,height:24});
  const p=read(scene.imageDataUrl);
  for(let y=0;y<p.height;y++)for(let x=0;x<p.width;x++){
    const i=(y*p.width+x)*4;
    assert.equal(p.data[i],0,'red half must never enter composite');
    if(x<t.drawPixels.x||x>=t.drawPixels.x+t.drawPixels.width||y<t.drawPixels.y||y>=t.drawPixels.y+t.drawPixels.height) assert.equal(p.data[i+2],0);
  }
  assert.deepEqual(pixel(scene.imageDataUrl,t.drawPixels.x+8,t.drawPixels.y+12),blue);
});

test('hash tampering and an already aborted operation fail without silently falling back to NOW',async()=>{
  const now=png(1,1,()=>black),c=control({gen_a:[element(png(1,1,()=>red))]});
  const tampered={...c,sceneElements:{gen_a:[{...c.sceneElements.gen_a![0],imageSha256:'0'.repeat(64)}]}};
  await assert.rejects(composeScenarioInputs(now,tampered),/hash mismatch/);
  await assert.rejects(composeScenarioInputs(now,c,{signal:AbortSignal.abort()}),/abort/i);
  await assert.rejects(composeScenarioInputs(now,c,{pythonPath:'missing-scenario-python-executable'}),/ENOENT/);
});

test('resizing transparent edges uses premultiplied alpha without dark colour fringes',async()=>{
  const now=png(8,2,()=>[0,0,0,0]),asset=png(2,1,x=>x?[255,0,0,255]:[0,0,0,0]);
  const r=await composeScenarioInputs(now,control({gen_a:[element(asset)]}));
  const p=read(r.scenes.gen_a!.imageDataUrl);
  assert.ok([...p.data].some((v,i)=>i%4===3&&v>0&&v<255));
  for(let i=0;i<p.data.length;i+=4)if(p.data[i+3]>0)assert.deepEqual([...p.data.subarray(i,i+3)],[255,0,0]);
});

test('validator-supported palette transparency and 16-bit grayscale decode with correct alpha/level',async()=>{
  const special=(depth:number,color:number,raster:Buffer,extra:Buffer[]=[])=>{
    const header=Buffer.alloc(13);header.writeUInt32BE(2);header.writeUInt32BE(1,4);header[8]=depth;header[9]=color;
    return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),...extra,chunk('IDAT',deflateSync(raster)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
  };
  const palette=special(8,3,Buffer.from([0,0,1]),[chunk('PLTE',Buffer.from([255,0,0,0,0,255])),chunk('tRNS',Buffer.from([0,128]))]);
  const gray=special(16,0,Buffer.from([0,0,0,128,0]));
  const r=await composeScenarioInputs(png(2,1,()=>black),control({gen_a:[element(palette)],gen_b:[element(gray)]}));
  assert.deepEqual(pixel(r.scenes.gen_a!.imageDataUrl,0,0),black);
  assert.deepEqual(pixel(r.scenes.gen_a!.imageDataUrl,1,0),[0,0,128,255]);
  assert.deepEqual(pixel(r.scenes.gen_b!.imageDataUrl,1,0),[127,127,127,255]);
});

test('extreme cover aspect ratio crops within the source instead of allocating an enlarged intermediate',async()=>{
  const r=await composeScenarioInputs(png(1,256,()=>black),control({gen_a:[element(png(256,1,()=>blue))]}));
  assert.deepEqual(pixel(r.scenes.gen_a!.imageDataUrl,0,255),blue);
  assert.deepEqual(r.scenes.gen_a!.targets[0].drawPixels,{x:0,y:0,width:1,height:256});
});

test('asset-only accepts opaque crop and preserves contain margins; transparent crop is unsupported',async()=>{
 const now=png(4,4,()=>green),asset=png(4,2,()=>blue);
 const c={...control({gen_a:[element(asset,{fit:'contain'})]}),sceneModes:{gen_a:'asset_only' as const}};
 const result=await composeScenarioInputs(now,c);assert.deepEqual(result.scenes.gen_a!.editRectangles,[{x:0,y:1,width:4,height:2}]);assert.deepEqual(pixel(result.scenes.gen_a!.imageDataUrl,0,0),green);
 for(const alpha of [0,128])await assert.rejects(()=>composeScenarioInputs(now,{...c,sceneElements:{gen_a:[{...c.sceneElements.gen_a![0],image:png(4,2,()=>[0,0,255,alpha]),imageSha256:digest(png(4,2,()=>[0,0,255,alpha]))}]}}),/ASSET_ONLY_OPAQUE_CROP_REQUIRED/);
 const partial=png(4,2,x=>x<2?[255,0,0,0]:blue);const cropped=control({gen_a:[element(partial,{sourceRect:[.5,0,.5,1]})]});await assert.doesNotReject(()=>composeScenarioInputs(now,{...cropped,sceneModes:{gen_a:'asset_only'}}));
});

test('asset-only core is the union of actual effective alpha and uses the final ordered canvas',async()=>{const now=png(8,8,()=>green),first=png(2,2,()=>red),second=png(2,2,()=>blue);const c={...control({gen_a:[element(first,{id:'first',opacity:.5,featherPx:1,targetRect:[.25,.25,.5,.5]}),element(second,{id:'second',opacity:.5,targetRect:[.5,.5,.25,.25]})]}),sceneModes:{gen_a:'asset_only' as const}};const r=await composeScenarioInputs(now,c);const a=r.scenes.gen_a!;assert.equal(a.protectedCorePixels,16);assert.ok(a.protectedCoreMaskSha256);assert.ok(a.protectedCoreMaskDataUrl);assert.equal(pixel(a.protectedCoreMaskDataUrl!,0,0)[0],0);assert.equal(pixel(a.protectedCoreMaskDataUrl!,3,3)[0],255);assert.notDeepEqual(pixel(a.imageDataUrl,5,5),pixel(a.imageDataUrl,3,3));assert.equal((await composeScenarioInputs(now,control({gen_a:[element(first)]}))).scenes.gen_a!.protectedCoreMaskDataUrl,undefined);});

test('asset-only overlapping contain layers preserve ordered opacity and feather through source-frame restoration',async()=>{
  const {restoreAssetOnlySourceFrame}=await import('./scenarioFrame');
  const now=png(12,12,()=>[0,200,0,255]);
  const c={...control({gen_a:[
    element(png(4,2,()=>red),{id:'red-first',targetRect:[2/12,3/12,8/12,6/12],fit:'contain',opacity:.5,featherPx:1}),
    element(png(2,2,()=>blue),{id:'blue-second',targetRect:[6/12,4/12,4/12,4/12],fit:'contain',opacity:.5,featherPx:1})
  ]}),sceneModes:{gen_a:'asset_only' as const}};
  const a=(await composeScenarioInputs(now,c)).scenes.gen_a!;
  assert.deepEqual(a.targets[0].drawPixels,{x:2,y:4,width:8,height:4},'contain margins stay outside editable area');
  assert.deepEqual(pixel(a.imageDataUrl,7,5),[64,50,128,255],'red at 50%, then blue at 50%; reverse order or double alpha changes this');
  assert.deepEqual(pixel(a.imageDataUrl,2,4),[64,150,0,255],'corner feather reduces the effective alpha once');
  const restored=await restoreAssetOnlySourceFrame(now,png(12,8,()=>[250,250,0,255]),a.editRectangles,{composedImageDataUrl:a.imageDataUrl,protectedCoreMaskDataUrl:a.protectedCoreMaskDataUrl});
  assert.deepEqual(restored.transform.crop,{x:0,y:2,width:12,height:8});
  const output=read(restored.imageDataUrl),input=read(a.imageDataUrl),raw=read(now),mask=read(a.protectedCoreMaskDataUrl!);
  let core=0,untouched=0;
  for(let i=0;i<output.data.length;i+=4){
    const protectedPixel=mask.data[(i/4)*mask.channels]>0;core+=Number(protectedPixel);untouched+=Number(!protectedPixel);
    assert.deepEqual([...output.data.subarray(i,i+4)],[...(protectedPixel?input:raw).data.subarray(i,i+4)]);
  }
  assert.equal(core,a.protectedCorePixels);assert.equal(core,32);assert.equal(untouched,112);
});
