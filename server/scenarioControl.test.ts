import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { parseScenarioControl, scenarioControlArchiveMetadata, ScenarioControlValidationError, SCENARIO_CONTROL_LIMITS } from './scenarioControl';

const signature = Buffer.from([137,80,78,71,13,10,26,10]);
const crcTable = Uint32Array.from({length:256}, (_, i) => {
  let crc = i;
  for (let n = 0; n < 8; n++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  return crc >>> 0;
});
function chunk(type: string, bytes: Buffer): Buffer {
  const out = Buffer.alloc(bytes.length + 12);
  out.writeUInt32BE(bytes.length); out.write(type, 4, 4, 'latin1'); bytes.copy(out, 8);
  let crc = 0xffffffff;
  for (const byte of out.subarray(4,-4)) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length-4);
  return out;
}
function png(width = 1, height = 1, options: {raster?:Buffer; extra?:Buffer[]; end?:boolean; depth?:number; color?:number; interlace?:number} = {}): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height,4);
  header[8] = options.depth ?? 8; header[9] = options.color ?? 6; header[12] = options.interlace ?? 0;
  const raster = options.raster ?? Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([signature,chunk('IHDR',header),...(options.extra??[]),chunk('IDAT',deflateSync(raster)),...(options.end===false?[]:[chunk('IEND',Buffer.alloc(0))])]);
}
const imageBytes = png();
const image = 'data:image/png;base64,' + imageBytes.toString('base64');
const element = (id = 'asset-1') => ({id,image,sourceRect:[.5,0,.5,1],targetRect:[.5,0,.5,1],fit:'cover',opacity:1,featherPx:24,instruction:'Keep the original camera and lighting.'});
function control() { return {version:1,scenarioId:'scenario-001',runId:'run:001',elapsedSec:12.5,cycle:0,cueIds:['cue-1'],sceneElements:{gen_a:[element()]}}; }
function rejects(value: unknown, path: string) {
  assert.throws(()=>parseScenarioControl(value), (error: unknown) => error instanceof ScenarioControlValidationError && error.code === 'INVALID_SCENARIO_CONTROL' && error.path.includes(path));
}

test('absent controls leave the legacy path available; null and unknown versions are errors', () => {
  assert.equal(parseScenarioControl(undefined), undefined);
  for (const value of [null,false,[],1,'{}']) rejects(value,'scenarioControl');
  for (const version of [0,2,'1',null]) rejects({...control(),version},'.version');
});

test('preserves scene order and original source image without applying a crop twice', () => {
  const input = {...control(),sceneElements:{gen_a:[element('z'),element('a')],gen_b:[],gen_c:[{...element('z'),fit:'contain',opacity:0,featherPx:0}]}};
  const parsed = parseScenarioControl(input)!;
  assert.deepEqual(parsed.sceneElements.gen_a!.map(e=>e.id), ['z','a']);
  assert.equal(parsed.sceneElements.gen_a![0].image, image);
  assert.deepEqual(parsed.sceneElements.gen_a![0].sourceRect, [.5,0,.5,1]);
  assert.deepEqual(parsed.sceneElements.gen_a![0].targetRect, [.5,0,.5,1]);
  assert.equal(parsed.sceneElements.gen_a![0].imageWidth, 1);
  assert.equal(parsed.sceneElements.gen_a![0].imageHeight, 1);
  assert.equal(parsed.sceneElements.gen_c![0].fit, 'contain');
  assert.equal(parsed.stage, 'validation-only');
  assert.equal(parsed.sceneElements.gen_a![0].contentReview, 'required');
  input.sceneElements.gen_a[0].sourceRect[0] = 0;
  assert.equal(parsed.sceneElements.gen_a![0].sourceRect[0], .5);
});

test('rejects missing fields, unknown fields and unknown scene names instead of ignoring them', () => {
  for (const field of Object.keys(control())) {
    const input: any = control(); delete input[field]; rejects(input,`.${field}`);
  }
  for (const field of Object.keys(element())) {
    const input: any = control(); delete input.sceneElements.gen_a[0][field]; rejects(input,`.${field}`);
  }
  rejects({...control(),extra:true},'scenarioControl');
  rejects({...control(),sceneElements:{gen_d:[]}},'.sceneElements');
  rejects({...control(),sceneElements:{gen_a:[{...element(),width:100}]}},'.gen_a[0]');
  rejects({...control(),sceneElements:null},'.sceneElements');
});

test('validates IDs, finite elapsed time, safe cycle integers and unique bounded cue IDs', () => {
  for (const value of ['', 'a b','../asset','日本語','a\u0000', 'a'.repeat(129), 5]) {
    rejects({...control(),scenarioId:value},'.scenarioId');
    rejects({...control(),runId:value},'.runId');
    rejects({...control(),cueIds:[value]},'.cueIds[0]');
    rejects({...control(),sceneElements:{gen_a:[{...element(),id:value}]}},'.id');
  }
  assert.equal(parseScenarioControl({...control(),scenarioId:'a'.repeat(128)})!.scenarioId.length,128);
  for (const elapsedSec of [-1,NaN,Infinity,'1',86400.1]) rejects({...control(),elapsedSec},'.elapsedSec');
  for (const cycle of [-1,.5,NaN,Infinity,'1',Number.MAX_SAFE_INTEGER+1]) rejects({...control(),cycle},'.cycle');
  rejects({...control(),cueIds:['a','a']},'.cueIds');
  rejects({...control(),cueIds:Array.from({length:65},(_,i)=>'cue'+i)},'.cueIds');
  rejects({...control(),cueIds:'a'},'.cueIds');
  assert.equal(parseScenarioControl({...control(),elapsedSec:86400,cycle:Number.MAX_SAFE_INTEGER,cueIds:[]})!.elapsedSec,86400);
});

test('supports up to eight elements per scene and rejects duplicates only within the same scene', () => {
  const eight = Array.from({length:8},(_,i)=>element('e'+i));
  assert.equal(parseScenarioControl({...control(),sceneElements:{gen_a:eight,gen_b:eight,gen_c:eight}})!.sceneElements.gen_c!.length,8);
  rejects({...control(),sceneElements:{gen_a:[...eight,element('extra')]}},'.gen_a');
  rejects({...control(),sceneElements:{gen_a:[element(),element()]}},'.id');
  rejects({...control(),sceneElements:{gen_a:{}}},'.gen_a');
  assert.deepEqual(parseScenarioControl({...control(),sceneElements:{}})!.sceneElements,{});
});

test('normalized rectangles must be positive, finite and fully inside the source or target', () => {
  const invalid = [[0,0,0,1],[0,0,1,-1],[-.1,0,1,1],[.5,0,.6,1],[0,.9,1,.2],[0,0,NaN,1],[0,0,1,Infinity],[0,0,1],['0',0,1,1],Array(4)];
  for (const field of ['sourceRect','targetRect']) for (const rect of invalid) rejects({...control(),sceneElements:{gen_a:[{...element(),[field]:rect}]}},'.'+field);
});

test('fit, opacity, feather and instruction values are strict and are never coerced', () => {
  for (const fit of ['stretch','Cover',null,1]) rejects({...control(),sceneElements:{gen_a:[{...element(),fit}]}},'.fit');
  for (const opacity of [-.1,1.1,NaN,Infinity,'1']) rejects({...control(),sceneElements:{gen_a:[{...element(),opacity}]}},'.opacity');
  for (const featherPx of [-1,257,.5,'24',NaN]) rejects({...control(),sceneElements:{gen_a:[{...element(),featherPx}]}},'.featherPx');
  for (const instruction of [null,1,'x'.repeat(2001),'bad\u0000text']) rejects({...control(),sceneElements:{gen_a:[{...element(),instruction}]}},'.instruction');
  assert.equal(parseScenarioControl({...control(),sceneElements:{gen_a:[{...element(),instruction:'line 1\nline 2',featherPx:256}]}})!.sceneElements.gen_a![0].instruction,'line 1\nline 2');
});

test('PNG-only canonical base64 rejects URLs, other MIME types, bad padding and fake PNGs', () => {
  for (const bad of ['https://example.com/image.png',image.replace('image/png','image/jpeg'),image.replace('image/png','image/webp'),image.replace('data:','DATA:'),'data:image/png;base64,','data:image/png;base64,====',image+'\n','data:image/png;base64,bm90LXBuZw==',image.slice(0,-1)]) rejects({...control(),sceneElements:{gen_a:[{...element(),image:bad}]}},'.image');
});

test('PNG verification catches corruption, unsupported animation, invalid raster and excessive dimensions', () => {
  const corrupted = Buffer.from(imageBytes); corrupted[corrupted.length-1] ^= 1;
  for (const bytes of [corrupted,imageBytes.subarray(0,-1),Buffer.concat([imageBytes,Buffer.from([0])]),png(1,1,{end:false}),png(8193,1),png(4097,4096,{raster:Buffer.from([0])}),png(1,1,{extra:[chunk('acTL',Buffer.alloc(8))]}),png(1,1,{raster:Buffer.from([0])}),png(1,1,{raster:Buffer.from([5,0,0,0,0])}),png(1,1,{raster:Buffer.alloc(6)})]) rejects({...control(),sceneElements:{gen_a:[{...element(),image:'data:image/png;base64,'+bytes.toString('base64')}]}},'.image');
});

test('valid static PNG variants include indexed/grayscale pixels, 16-bit channels and Adam7 interlacing', () => {
  const valid = [
    png(1,1,{depth:1,color:0,raster:Buffer.alloc(2)}),
    png(1,1,{depth:1,color:3,raster:Buffer.alloc(2),extra:[chunk('PLTE',Buffer.from([255,0,0]))]}),
    png(1,1,{depth:16,color:2,raster:Buffer.alloc(7)}),
    png(1,1,{interlace:1}),
  ];
  for (const bytes of valid) assert.ok(parseScenarioControl({...control(),sceneElements:{gen_a:[{...element(),image:'data:image/png;base64,'+bytes.toString('base64')}]}}));
});

test('per-image and combined decoded byte limits apply before assets can reach a generator', () => {
  rejects({...control(),sceneElements:{gen_a:[{...element(),image:'data:image/png;base64,'+'A'.repeat(4*Math.ceil(SCENARIO_CONTROL_LIMITS.imageBytes/3)+4)}]}},'.image');
  const padded = 'data:image/png;base64,'+png(1,1,{extra:[chunk('teST',Buffer.alloc(6*1024*1024))]}).toString('base64');
  rejects({...control(),sceneElements:{gen_a:Array.from({length:4},(_,i)=>({...element('e'+i),image:padded}))}},'.gen_a[3].image');
});

test('archive metadata includes hashes and application order without copying image payloads', () => {
  const parsed = parseScenarioControl({...control(),sceneElements:{gen_a:[element('second'),element('first')]}})!;
  const metadata = scenarioControlArchiveMetadata(parsed);
  const elements = metadata.sceneElements.gen_a!;
  assert.deepEqual(elements.map(e=>[e.id,e.applyOrder]),[['second',0],['first',1]]);
  assert.equal(elements[0].imageSha256,createHash('sha256').update(imageBytes).digest('hex'));
  assert.deepEqual(elements[0].sourceRect,[.5,0,.5,1]);
  assert.equal(elements[0].contentReview,'required');
  assert.equal(elements[0].instruction,element().instruction);
  assert.doesNotMatch(JSON.stringify(metadata),/data:image|base64|"image":|"type":"Buffer"/);
  (elements[0].sourceRect as number[])[0] = 0;
  assert.equal(parsed.sceneElements.gen_a![0].sourceRect[0],.5);
});

test('synthetic sparse lists are errors rather than unvalidated holes', () => {
  rejects({...control(),cueIds:Array(1)},'.cueIds[0]');
  rejects({...control(),sceneElements:{gen_a:Array(1)}},'.gen_a[0]');
});

test('optional scene modes preserve legacy and reject unsupported or ineffective asset-only requests',()=>{
 assert.equal(parseScenarioControl(control())!.sceneModes,undefined);
 const p=parseScenarioControl({...control(),sceneModes:{gen_a:'asset_only',gen_b:'people_and_assets'}})!;
 assert.deepEqual(p.sceneModes,{gen_a:'asset_only',gen_b:'people_and_assets'});assert.deepEqual(scenarioControlArchiveMetadata(p).sceneModes,p.sceneModes);
 for(const mode of ['asset',null,0])rejects({...control(),sceneModes:{gen_a:mode}},'sceneModes');
 rejects({...control(),sceneModes:{gen_d:'asset_only'}},'sceneModes');
 rejects({...control(),sceneModes:{gen_b:'asset_only'}},'sceneModes');
 rejects({...control(),sceneElements:{gen_a:[]},sceneModes:{gen_a:'asset_only'}},'sceneModes');
 rejects({...control(),sceneElements:{gen_a:[{...element(),opacity:0}]},sceneModes:{gen_a:'asset_only'}},'sceneModes');
});
