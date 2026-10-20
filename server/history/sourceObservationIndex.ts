/**
 * Read-only source-observation cache preparation. Build once from original NOW images and archives;
 * image/hash lookup is in memory, has no inference, generation, live history or run/loop side effects.
 * Only the original guard scene and its pre-generation NOW display text are eligible;
 * never read generated scenario descriptions, edit prompts or venue summaries.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface OriginalObservationRecord {
  readonly sceneId: string;
  readonly frameId: string;
  readonly frameFile: string;
  readonly sourceImageSha256: string;
  readonly originalCaptureId: string;
  readonly sourceObservedAt: string | null;
  /** Original literal clock value; an offset is never guessed for a timezone-less archive field. */
  readonly sourceCapturedAt: string | null;
  readonly sourceTimeProvenance: 'archive-offset-time' | 'capture-id-epoch' | 'unknown';
  readonly observation: string;
  readonly observationOrigin: 'vlm.guard.scene' | 'vlm.parsedScenarios[].scene_now' | 'nowText';
  readonly people?: readonly {position:string;pose:string;clothes:string;facing:string;hair?:string}[];
  readonly detectorPerson: boolean | null;
}
export interface OriginalObservationLedger {
  readonly version: 1;
  readonly kind: 'original-source-observations';
  readonly records: readonly OriginalObservationRecord[];
}
export interface ObservationIndexIssue { frameFile:string; reason:string }
export interface SourceObservationBuild {
  ledger: OriginalObservationLedger;
  total: number;
  available: number;
  issues: ObservationIndexIssue[];
}
type ManifestEntry = {file:string;sha256:string;captureId:string;source:string};
export type SourceObservationLookup = {status:'hit';record:OriginalObservationRecord} | {status:'miss'} | {status:'ambiguous';originalCaptureIds:string[]};
export type SourceObservationIdentity = {sceneId?:string;frameId?:string};

const hash = (data:Uint8Array) => createHash('sha256').update(data).digest('hex');
const isHash = (value:unknown):value is string => typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value);
const OBSERVATION_ORIGINS = ['vlm.guard.scene','vlm.parsedScenarios[].scene_now','nowText'];
const japanese = (text:string) => /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text);
function manifestEntry(value:any):ManifestEntry {
  if (!value || typeof value !== 'object' || typeof value.file !== 'string' || !isHash(value.sha256) || typeof value.captureId !== 'string' || !value.captureId.trim() || typeof value.source !== 'string') throw new Error('invalid-manifest-entry');
  const file = value.file.replace(/\\/g,'/');
  if (!/^[A-Za-z0-9_-]+\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:jpg|jpeg|png|webp)$/i.test(file) || !/_NOW\.(?:jpg|jpeg|png|webp)$/i.test(value.source)) throw new Error('invalid-manifest-path');
  return {...value,file,sha256:value.sha256.toLowerCase()};
}

function sourceTime(archive:any,captureId:string):Pick<OriginalObservationRecord,'sourceObservedAt'|'sourceCapturedAt'|'sourceTimeProvenance'> {
  const raw = typeof archive?.capturedAt === 'string' && archive.capturedAt.trim() ? archive.capturedAt.trim() : null;
  if (raw && /(Z|[+-]\d{2}:\d{2})$/i.test(raw) && Number.isFinite(Date.parse(raw))) return {sourceObservedAt:new Date(raw).toISOString(),sourceCapturedAt:raw,sourceTimeProvenance:'archive-offset-time'};
  // TD's _new_capture_id uses int(time.time()*1000); this is an original trigger epoch, not replay time.
  const epoch = /^td-(\d{13})-\d+$/.exec(captureId)?.[1];
  if (epoch) {
    const milliseconds = Number(epoch);
    if (Number.isSafeInteger(milliseconds) && Number.isFinite(new Date(milliseconds).getTime())) return {sourceObservedAt:new Date(milliseconds).toISOString(),sourceCapturedAt:raw,sourceTimeProvenance:'capture-id-epoch'};
  }
  return {sourceObservedAt:null,sourceCapturedAt:raw,sourceTimeProvenance:'unknown'};
}

/** Pure extraction with explicit provenance checks. Existing observation mistakes are preserved, not re-inferred. */
export function originalObservationRecord(entryValue:unknown,archive:any,actualImageSha256:string):OriginalObservationRecord {
  const entry = manifestEntry(entryValue);
  if (!isHash(actualImageSha256) || actualImageSha256.toLowerCase() !== entry.sha256) throw new Error('source-image-hash-mismatch');
  if (archive?.captureId !== entry.captureId) throw new Error('original-capture-id-mismatch');
  const guard = archive?.vlm?.guard;
  const original = typeof guard?.scene === 'string' ? guard.scene.trim() : '';
  if (!original || original.length > 10000) throw new Error('original-observation-unavailable');
  let observation=original,observationOrigin:OriginalObservationRecord['observationOrigin']='vlm.guard.scene';
  // scene_now is the source-frame description copied onto each scenario, translated before generation.
  const nowValues = Array.isArray(archive?.vlm?.parsedScenarios) ? [...new Set<string>(archive.vlm.parsedScenarios.map((s:any)=>typeof s?.scene_now==='string'?s.scene_now.trim():'').filter(Boolean))] : [];
  const topNow = typeof archive.nowText==='string' ? archive.nowText.trim() : '';
  if(topNow && topNow.length<=10000 && japanese(topNow) && (!nowValues.length || nowValues.length===1&&nowValues[0]===topNow)) {
    observation=topNow;observationOrigin='nowText';
  } else if(nowValues.length===1 && nowValues[0].length<=10000 && japanese(nowValues[0])) {
    observation=nowValues[0];observationOrigin='vlm.parsedScenarios[].scene_now';
  }
  const people = Array.isArray(guard?.people) ? guard.people.filter((p:any) => p && typeof p === 'object').map((p:any) => Object.freeze({
    position:typeof p.position === 'string' ? p.position : '',pose:typeof p.pose === 'string' ? p.pose : '',
    clothes:typeof p.clothes === 'string' ? p.clothes : '',facing:typeof p.facing === 'string' ? p.facing : '',
    ...(typeof p.hair === 'string' ? {hair:p.hair} : {}),
  })) : undefined;
  const frameId = path.posix.basename(entry.file).replace(/\.[^.]+$/,'');
  return Object.freeze({sceneId:entry.file.split('/')[0],frameId,frameFile:entry.file,
    sourceImageSha256:entry.sha256,originalCaptureId:entry.captureId,...sourceTime(archive,entry.captureId),
    observation,observationOrigin,...(people ? {people:Object.freeze(people)} : {}),
    detectorPerson:typeof guard?.detector?.person === 'boolean' ? guard.detector.person : null,
  });
}

/** Scan only the explicit manifest, not the live venue logs or generated images. No files are written. */
export function buildOriginalObservationLedger(manifest:unknown,readFile:(file:string)=>Buffer = fs.readFileSync):SourceObservationBuild {
  if (!Array.isArray(manifest)) throw new Error('source manifest must be an array');
  const records:OriginalObservationRecord[] = [],issues:ObservationIndexIssue[] = [];
  for (const raw of manifest) {
    const frameFile = typeof raw?.file === 'string' ? raw.file : '';
    try {
      const entry = manifestEntry(raw);
      let bytes:Buffer;
      try { bytes = readFile(entry.source); } catch { throw new Error('original-image-unavailable'); }
      const actualHash = hash(bytes);
      if (actualHash !== entry.sha256) throw new Error('source-image-hash-mismatch');
      const archiveFile = entry.source.replace(/_NOW\.(?:jpg|jpeg|png|webp)$/i,'_prompts.json');
      let archive:any;
      try { archive = JSON.parse(readFile(archiveFile).toString('utf8').replace(/^\uFEFF/,'')); } catch { throw new Error('original-archive-unavailable'); }
      records.push(originalObservationRecord(entry,archive,actualHash));
    } catch(error) { issues.push({frameFile,reason:error instanceof Error ? error.message : 'original-observation-unavailable'}); }
  }
  return {ledger:Object.freeze({version:1,kind:'original-source-observations',records:Object.freeze(records)}),total:manifest.length,available:records.length,issues};
}

/** Shared immutable originals, independent of per-replay scene/run/loop history accumulation. */
export class SourceObservationIndex {
  private readonly byHash = new Map<string,OriginalObservationRecord[]>();
  constructor(ledger:OriginalObservationLedger) {
    if (ledger.version !== 1 || ledger.kind !== 'original-source-observations') throw new Error('unsupported original-observation ledger');
    for (const record of ledger.records) {
      if (!isHash(record.sourceImageSha256) || !OBSERVATION_ORIGINS.includes(record.observationOrigin) || typeof record.observation!=='string' || !record.observation.trim()) throw new Error('invalid original-observation record');
      const key=record.sourceImageSha256.toLowerCase(),matches=this.byHash.get(key)??[];
      matches.push(record);this.byHash.set(key,matches);
    }
  }
  lookupSha256(sha256:string,identity:SourceObservationIdentity={}):SourceObservationLookup {
    if (!isHash(sha256)) return {status:'miss'};
    const records=(this.byHash.get(sha256.toLowerCase())??[]).filter(r=>(identity.sceneId===undefined||r.sceneId===identity.sceneId)&&(identity.frameId===undefined||r.frameId===identity.frameId));
    if (!records.length) return {status:'miss'};
    if (records.length !== 1) return {status:'ambiguous',originalCaptureIds:records.map(r=>r.originalCaptureId)};
    return {status:'hit',record:records[0]};
  }
  lookupImage(image:Uint8Array,identity:SourceObservationIdentity={}):SourceObservationLookup { return this.lookupSha256(hash(image),identity); }
}
