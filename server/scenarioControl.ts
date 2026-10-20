/**
 * Scenario-control v1 preparation only: no route, generation capability, compositing or content approval.
 * v1 accepts static PNG only; fit is cover|contain, with no MIME conversion or external URLs.
 * Rectangles are top-left normalized [x,y,width,height], within 0..1 with positive size.
 * sourceRect refers to the full ORIGINAL asset and is applied once by a future compositor;
 * targetRect refers to the full scene canvas. This validator applies neither rectangle.
 * IDs are case-sensitive ASCII [A-Za-z0-9][A-Za-z0-9._:-]{0,127}; duplicate IDs in one scene
 * and duplicate cue IDs are errors. Element order is preserved; omitted scene keys stay omitted.
 * Elapsed time is 0..86400 seconds (fractional allowed); cycle is a nonnegative safe integer.
 * Other conservative v1 bounds are declared below; changing them needs sender/receiver agreement.
 * The request JSON/body limit must be reconciled separately before wiring this into /api/generate.
 */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

export const SCENARIO_CONTROL_LIMITS = Object.freeze({
  idLength: 128, elapsedSec: 86400, cycle: Number.MAX_SAFE_INTEGER, cueIds: 64,
  elementsPerScene: 8, imageBytes: 8 * 1024 * 1024, totalImageBytes: 24 * 1024 * 1024,
  imageEdge: 8192, imagePixels: 16 * 1024 * 1024, featherPx: 256, instructionLength: 2000,
});
const SCENES = ['gen_a', 'gen_b', 'gen_c'] as const;
export type ScenarioSceneKey = typeof SCENES[number];
export type ScenarioSceneMode = 'asset_only'|'people_and_assets';
export type NormalizedRect = readonly [x:number, y:number, width:number, height:number];
export type ScenarioElementFit = 'cover' | 'contain';

export interface ValidatedScenarioElement {
  readonly id: string;
  /** Full original asset; it has NOT been cropped or transformed by this module. */
  readonly image: string;
  readonly imageSha256: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly sourceRect: NormalizedRect;
  readonly targetRect: NormalizedRect;
  readonly fit: ScenarioElementFit;
  readonly opacity: number;
  readonly featherPx: number;
  readonly instruction: string;
  /** Syntax validation does not authorize an asset containing people or override identity rules. */
  readonly contentReview: 'required';
}
export interface ValidatedScenarioControl {
  readonly version: 1;
  readonly scenarioId: string;
  readonly runId: string;
  readonly elapsedSec: number;
  readonly cycle: number;
  readonly cueIds: readonly string[];
  readonly sceneElements: Readonly<Partial<Record<ScenarioSceneKey, readonly ValidatedScenarioElement[]>>>;
  readonly sceneModes?:Readonly<Partial<Record<ScenarioSceneKey,ScenarioSceneMode>>>;
  readonly stage: 'validation-only';
}

export class ScenarioControlValidationError extends Error {
  readonly code = 'INVALID_SCENARIO_CONTROL';
  constructor(readonly path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = 'ScenarioControlValidationError';
  }
}
function invalid(path: string, reason: string): never { throw new ScenarioControlValidationError(path, reason); }
function object(value: unknown, path: string, allowed: readonly string[], required = allowed): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(path, 'expected a JSON object');
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !allowed.includes(key)) invalid(path, 'unknown field');
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`, 'required field');
  return value as Record<string, unknown>;
}
function id(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) invalid(path, 'expected an ASCII ID of 1..128 characters');
  return value;
}
function number(value: unknown, path: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) invalid(path, `expected ${integer ? 'an integer' : 'a number'} in ${min}..${max}`);
  return value;
}
function rect(value: unknown, path: string): NormalizedRect {
  if (!Array.isArray(value) || value.length !== 4) invalid(path, 'expected [x,y,width,height]');
  const n = Array.from(value, (v, i) => number(v, `${path}[${i}]`, 0, 1));
  if (n[2] <= 0 || n[3] <= 0 || n[0] + n[2] > 1 || n[1] + n[3] > 1) invalid(path, 'rectangle must have positive size and stay inside the image');
  return Object.freeze(n) as unknown as NormalizedRect;
}

const PNG_SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10]);
const CRC_TABLE = Uint32Array.from({length:256}, (_, i) => {
  let n = i;
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const b of data) crc = CRC_TABLE[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Validate PNG structure, checksums and bounded raster data; never decode unbounded compressed text. */
function png(data: Buffer, path: string): {width: number; height: number} {
  if (data.length < 45 || !data.subarray(0,8).equals(PNG_SIGNATURE)) invalid(path, 'expected PNG bytes');
  let offset = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  let palette = false, ended = false, dataEnded = false;
  const compressed: Buffer[] = [];
  while (offset < data.length) {
    if (data.length - offset < 12) invalid(path, 'truncated PNG chunk');
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > data.length) invalid(path, 'truncated PNG chunk');
    const type = data.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) invalid(path, 'invalid PNG chunk type');
    if (crc32(data.subarray(offset+4,end-4)) !== data.readUInt32BE(end-4)) invalid(path, 'PNG checksum mismatch');
    const payload = data.subarray(offset+8,end-4);
    if (offset === 8 && type !== 'IHDR') invalid(path, 'PNG header must be first');
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) invalid(path, 'invalid PNG header');
      width = payload.readUInt32BE(0); height = payload.readUInt32BE(4);
      if (!width || !height || width > SCENARIO_CONTROL_LIMITS.imageEdge || height > SCENARIO_CONTROL_LIMITS.imageEdge || width * height > SCENARIO_CONTROL_LIMITS.imagePixels) invalid(path, 'PNG dimensions exceed limits');
      depth = payload[8]; color = payload[9]; interlace = payload[12];
      const allowedDepths: Record<number, number[]> = {0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      if (!allowedDepths[color]?.includes(depth) || payload[10] !== 0 || payload[11] !== 0 || interlace > 1) invalid(path, 'unsupported PNG header');
    } else if (type === 'PLTE') {
      if (palette || compressed.length || color === 0 || color === 4 || !length || length % 3 || length > 768 || (color === 3 && length / 3 > 2 ** depth)) invalid(path, 'invalid PNG palette');
      palette = true;
    } else if (type === 'IDAT') {
      if (dataEnded || (color === 3 && !palette)) invalid(path, 'invalid PNG data order');
      compressed.push(payload);
    } else if (type === 'IEND') {
      if (length || !compressed.length || end !== data.length) invalid(path, 'invalid PNG end');
      ended = true;
    } else {
      if (['acTL','fcTL','fdAT'].includes(type)) invalid(path, 'animated PNG is unsupported');
      if (type[0] === type[0].toUpperCase()) invalid(path, 'unsupported critical PNG chunk');
      if (compressed.length) dataEnded = true;
    }
    offset = end;
  }
  if (!ended) invalid(path, 'PNG end is missing');
  const channels: Record<number, number> = {0:1,2:3,3:1,4:2,6:4};
  const passes = interlace ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
  const rows = passes.map(([x,y,dx,dy]) => {
    const w = Math.max(0, Math.ceil((width-x)/dx)), h = Math.max(0, Math.ceil((height-y)/dy));
    return {height:w ? h : 0, bytes:Math.ceil(w * channels[color] * depth / 8)};
  });
  const expected = rows.reduce((sum, row) => sum + row.height * (row.bytes + 1), 0);
  let raster: Buffer;
  try { raster = inflateSync(Buffer.concat(compressed), {maxOutputLength:expected}); }
  catch { return invalid(path, 'invalid or oversized PNG raster'); }
  if (raster.length !== expected) invalid(path, 'PNG raster size mismatch');
  let pos = 0;
  for (const row of rows) for (let y = 0; y < row.height; y++) {
    if (raster[pos] > 4) invalid(path, 'invalid PNG scanline filter');
    pos += row.bytes + 1;
  }
  return {width, height};
}

const ELEMENT_FIELDS = ['id','image','sourceRect','targetRect','fit','opacity','featherPx','instruction'] as const;
/** Undefined means absent. Null or ANY malformed provided control throws; nothing is silently ignored. */
export function parseScenarioControl(value: unknown): ValidatedScenarioControl | undefined {
  if (value === undefined) return undefined;
  const path = 'scenarioControl';
  const control = object(value, path, ['version','scenarioId','runId','elapsedSec','cycle','cueIds','sceneElements','sceneModes'],['version','scenarioId','runId','elapsedSec','cycle','cueIds','sceneElements']);
  if (control.version !== 1) invalid(`${path}.version`, 'only version 1 is supported');
  const scenarioId = id(control.scenarioId, `${path}.scenarioId`), runId = id(control.runId, `${path}.runId`);
  const elapsedSec = number(control.elapsedSec, `${path}.elapsedSec`, 0, SCENARIO_CONTROL_LIMITS.elapsedSec);
  const cycle = number(control.cycle, `${path}.cycle`, 0, SCENARIO_CONTROL_LIMITS.cycle, true);
  if (!Array.isArray(control.cueIds) || control.cueIds.length > SCENARIO_CONTROL_LIMITS.cueIds) invalid(`${path}.cueIds`, 'expected at most 64 cue IDs');
  const cueIds = Array.from(control.cueIds, (value, i) => id(value, `${path}.cueIds[${i}]`));
  if (new Set(cueIds).size !== cueIds.length) invalid(`${path}.cueIds`, 'duplicate cue ID');
  const scenes = object(control.sceneElements, `${path}.sceneElements`, SCENES, []);
  const sceneElements: Partial<Record<ScenarioSceneKey, readonly ValidatedScenarioElement[]>> = {};
  let totalBytes = 0;
  for (const scene of SCENES) {
    if (!Object.hasOwn(scenes, scene)) continue;
    const scenePath = `${path}.sceneElements.${scene}`, input = scenes[scene];
    if (!Array.isArray(input) || input.length > SCENARIO_CONTROL_LIMITS.elementsPerScene) invalid(scenePath, 'expected at most 8 elements');
    const ids = new Set<string>();
    sceneElements[scene] = Object.freeze(Array.from(input, (raw, index) => {
      const elementPath = `${scenePath}[${index}]`, element = object(raw, elementPath, ELEMENT_FIELDS);
      const elementId = id(element.id, `${elementPath}.id`);
      if (ids.has(elementId)) invalid(`${elementPath}.id`, 'duplicate element ID in scene');
      ids.add(elementId);
      const sourceRect = rect(element.sourceRect, `${elementPath}.sourceRect`), targetRect = rect(element.targetRect, `${elementPath}.targetRect`);
      if (element.fit !== 'cover' && element.fit !== 'contain') invalid(`${elementPath}.fit`, 'expected cover or contain');
      const opacity = number(element.opacity, `${elementPath}.opacity`, 0, 1);
      const featherPx = number(element.featherPx, `${elementPath}.featherPx`, 0, SCENARIO_CONTROL_LIMITS.featherPx, true);
      if (typeof element.instruction !== 'string' || element.instruction.length > SCENARIO_CONTROL_LIMITS.instructionLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(element.instruction)) invalid(`${elementPath}.instruction`, 'expected at most 2000 characters of text');
      const imagePath = `${elementPath}.image`, image = element.image;
      const prefix = 'data:image/png;base64,';
      const maxEncoded = 4 * Math.ceil(SCENARIO_CONTROL_LIMITS.imageBytes / 3);
      if (typeof image !== 'string' || !image.startsWith(prefix) || image.length > prefix.length + maxEncoded) invalid(imagePath, 'expected a PNG data URL of at most 8 MiB decoded');
      const b64 = image.slice(prefix.length);
      if (!b64.length || b64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) invalid(imagePath, 'invalid base64');
      const bytes = Buffer.from(b64, 'base64');
      if (bytes.length > SCENARIO_CONTROL_LIMITS.imageBytes || bytes.toString('base64') !== b64) invalid(imagePath, 'invalid or oversized base64');
      totalBytes += bytes.length;
      if (totalBytes > SCENARIO_CONTROL_LIMITS.totalImageBytes) invalid(imagePath, 'combined PNG assets exceed 24 MiB');
      const dimensions = png(bytes, imagePath);
      return Object.freeze({id:elementId,image,imageSha256:createHash('sha256').update(bytes).digest('hex'),imageWidth:dimensions.width,imageHeight:dimensions.height,sourceRect,targetRect,fit:element.fit,opacity,featherPx,instruction:element.instruction,contentReview:'required' as const});
    }));
  }
  let sceneModes:Partial<Record<ScenarioSceneKey,ScenarioSceneMode>>|undefined;
  if(control.sceneModes!==undefined){
    const modes=object(control.sceneModes,`${path}.sceneModes`,SCENES,[]);sceneModes={};
    for(const scene of SCENES){if(!Object.hasOwn(modes,scene))continue;const mode=modes[scene];
      if(mode!=='asset_only'&&mode!=='people_and_assets')invalid(`${path}.sceneModes.${scene}`,'expected asset_only or people_and_assets');
      if(mode==='asset_only'&&!sceneElements[scene]?.some(e=>e.opacity>0))invalid(`${path}.sceneModes.${scene}`,'asset_only requires a visible asset');
      sceneModes[scene]=mode;
    }
  }
  return Object.freeze({version:1,scenarioId,runId,elapsedSec,cycle,cueIds:Object.freeze(cueIds),sceneElements:Object.freeze(sceneElements),...(sceneModes?{sceneModes:Object.freeze(sceneModes)}:{}),stage:'validation-only'});
}

/** applyOrder is zero-based within its scene; the hash covers full original decoded PNG bytes. */
export interface ScenarioControlArchiveMetadata {
  version: 1; scenarioId: string; runId: string; elapsedSec: number; cycle: number; cueIds: string[];
  sceneModes?:Partial<Record<ScenarioSceneKey,ScenarioSceneMode>>;
  stage: 'validation-only';
  sceneElements: Partial<Record<ScenarioSceneKey, Array<Omit<ValidatedScenarioElement, 'image'> & {applyOrder:number}>>>;
}
/** Explicit allow-list: no data URL, base64 or Buffer is copied into the archive metadata. */
export function scenarioControlArchiveMetadata(control: ValidatedScenarioControl): ScenarioControlArchiveMetadata {
  const sceneElements: ScenarioControlArchiveMetadata['sceneElements'] = {};
  for (const scene of SCENES) {
    const elements = control.sceneElements[scene];
    if (elements) sceneElements[scene] = elements.map((e, applyOrder) => ({
      id:e.id,imageSha256:e.imageSha256,imageWidth:e.imageWidth,imageHeight:e.imageHeight,
      sourceRect:[...e.sourceRect],targetRect:[...e.targetRect],fit:e.fit,opacity:e.opacity,
      featherPx:e.featherPx,instruction:e.instruction,contentReview:'required',applyOrder,
    }));
  }
  return {version:1,scenarioId:control.scenarioId,runId:control.runId,elapsedSec:control.elapsedSec,cycle:control.cycle,cueIds:[...control.cueIds],...(control.sceneModes?{sceneModes:{...control.sceneModes}}:{}),stage:'validation-only',sceneElements};
}
