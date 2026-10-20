import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs/promises';import os from'node:os';import path from'node:path';import{deflateSync}from'node:zlib';import{createBrowserOutputAssets}from'./browserOutputAssets';
import{execFileSync}from'node:child_process';
function png(){const chunk=(type:string,data:Buffer)=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);let crc=0xffffffff;for(const v of b.subarray(4,-4)){crc^=v;for(let bit=0;bit<8;bit++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}b.writeUInt32BE((crc^0xffffffff)>>>0,b.length-4);return b;};const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,10,20,30,255]))),chunk('IEND',Buffer.alloc(0))]);}
const dataUrl='data:image/png;base64,'+png().toString('base64');
const inspect=async()=>({format:'PNG'as const,width:1,height:1});
async function fixture(){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'browser-output-assets-'));return{directory,service:createBrowserOutputAssets({directory,inspect})};}
test('import uses private UUID path, registry-only resolution and restart-persistent uploaded metadata',async()=>{
 const f=await fixture();try{const result=await f.service.importImage({filename:'参照画像.png',imageDataUrl:dataUrl});assert.equal(result.provenance,'uploaded');assert.equal(result.scope,'uploaded');assert.equal(result.caption,'参照画像.png');for(const key of ['recordedAtMs','sourceRecordedAtMs','generatedAtMs','targetAtMs']as const)assert.equal(result[key],null);assert.match(result.imageUrl,/^\/captures\/browser-output-assets\/[a-f0-9-]+\.png$/);const resolved=await f.service.resolve(result.imageUrl);assert.ok(resolved);assert.equal(resolved.contentType,'image/png');assert.deepEqual(await fs.readFile(resolved.absolutePath),png());const again=createBrowserOutputAssets({directory:f.directory,inspect});assert.deepEqual(await again.list(),[result]);assert.equal(await again.resolve('/captures/browser-output-assets/../registry.json'),null);assert.equal(await again.resolve('https://example.com/file.png'),null);}finally{await fs.rm(f.directory,{recursive:true,force:true});}
});
test('URL/path filenames, non-image URLs, MIME mismatch and oversize fail before any write',async()=>{
 const f=await fixture();try{for(const filename of ['../x.png','C:\\x.png','https://example.com/x.png','bad\n.png'])await assert.rejects(f.service.importImage({filename,imageDataUrl:dataUrl}));for(const imageDataUrl of ['https://example.com/x.png','file:///private.png',dataUrl.replace('image/png','image/jpeg'),'data:image/png;base64,SGVsbG8='])await assert.rejects(f.service.importImage({filename:'x.png',imageDataUrl}));await assert.rejects(createBrowserOutputAssets({directory:f.directory,maxBytes:4,inspect}).importImage({filename:'x.png',imageDataUrl:dataUrl}));assert.deepEqual(await fs.readdir(f.directory),[]);}finally{await fs.rm(f.directory,{recursive:true,force:true});}
});
test('invalid dimensions or decode failure reject, concurrent imports retain both registry entries',async()=>{
 const f=await fixture();try{await assert.rejects(createBrowserOutputAssets({directory:f.directory,inspect:async()=>({format:'PNG',width:100000,height:100000})}).importImage({filename:'x.png',imageDataUrl:dataUrl}));await assert.rejects(createBrowserOutputAssets({directory:f.directory,inspect:async()=>{throw Error('bad');}}).importImage({filename:'x.png',imageDataUrl:dataUrl}));const result=await Promise.all([f.service.importImage({filename:'first.png',imageDataUrl:dataUrl}),f.service.importImage({filename:'second.png',imageDataUrl:dataUrl})]);assert.equal((await f.service.list()).length,2);assert.notEqual(result[0].id,result[1].id);}finally{await fs.rm(f.directory,{recursive:true,force:true});}
});
test('default Pillow decoder validates synthetic PNG and rejects truncated raster',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'browser-output-decode-'));try{const service=createBrowserOutputAssets({directory});assert.equal((await service.importImage({filename:'synthetic.png',imageDataUrl:dataUrl})).provenance,'uploaded');await assert.rejects(service.importImage({filename:'broken.png',imageDataUrl:'data:image/png;base64,'+png().subarray(0,33).toString('base64')}));}finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('public repository storage is refused',()=>{assert.throws(()=>createBrowserOutputAssets({directory:path.resolve('captures','imports')}));});
test('synthetic PNG/JPEG/WebP all decode and retain uploaded provenance',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'browser-output-formats-'));
 try{
  const python=process.env.TURBO_CPU_PYTHON??path.join(process.env.USERPROFILE??'','Documents/ComfyUI/.venv/Scripts/python.exe');
  const fixtures=JSON.parse(execFileSync(python,['-c',"from PIL import Image; import io,base64,json; out={}; im=Image.new('RGB',(2,3),(10,20,30))\nfor fmt in ('PNG','JPEG','WEBP'):\n b=io.BytesIO(); im.save(b,format=fmt); out[fmt]=base64.b64encode(b.getvalue()).decode()\nprint(json.dumps(out))"],{encoding:'utf8',windowsHide:true}));
  const service=createBrowserOutputAssets({directory,python});
  for(const [format,mime,extension]of [['PNG','png','png'],['JPEG','jpeg','jpg'],['WEBP','webp','webp']]){const c=await service.importImage({filename:'synthetic.'+extension,imageDataUrl:'data:image/'+mime+';base64,'+fixtures[format]});assert.equal(c.provenance,'uploaded');assert.ok(c.imageUrl.endsWith('.'+extension));}
  assert.equal((await service.list()).length,3);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('private registry fields are stripped from public list',async()=>{
 const f=await fixture();try{await f.service.importImage({filename:'x.png',imageDataUrl:dataUrl});const file=path.join(f.directory,'registry.json'),rows=JSON.parse(await fs.readFile(file,'utf8'));rows[0].content.absolutePath='private-path';await fs.writeFile(file,JSON.stringify(rows));const content=(await createBrowserOutputAssets({directory:f.directory,inspect}).list())[0];assert.equal('absolutePath'in content,false);}finally{await fs.rm(f.directory,{recursive:true,force:true});}
});
