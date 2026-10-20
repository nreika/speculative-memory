/** Display-only history selection. Never reads/writes venue history or invents observations.
 * Wire-field mapping belongs to the API adapter; identifiers below are normalized values, not assumed request fields.
 */
export type CaptureHistoryScope =
  | { kind: 'live'; key: string }
  | { kind: 'test'; key: string; sceneId: string; runId: string; loopId: string }
  | { kind: 'capture'; key: string; captureId: string };

export interface HistoryScopeInput {
  captureId: string;
  isTest: boolean;
  /** The same gate that allows this capture to read/write live scene history. */
  useLiveHistory: boolean;
  /** Set only after the sender's field semantics are confirmed. Missing IDs never share a test history. */
  testScope?: { sceneId?: unknown; runId?: unknown; loopId?: unknown };
}
const id = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;

export function resolveCaptureHistoryScope(input: HistoryScopeInput): CaptureHistoryScope {
  if (!id(input.captureId)) throw new Error('A capture ID is required for history isolation');
  if (!input.isTest && input.useLiveHistory) return { kind: 'live', key: 'live' };
  const sceneId = id(input.testScope?.sceneId), runId = id(input.testScope?.runId), loopId = id(input.testScope?.loopId);
  if (input.isTest && sceneId && runId && loopId) return {
    kind: 'test', key: `test:${encodeURIComponent(sceneId)}:${encodeURIComponent(runId)}:L${encodeURIComponent(loopId)}`, sceneId, runId, loopId,
  };
  return { kind: 'capture', key: JSON.stringify(['capture',input.captureId]), captureId: input.captureId };
}

export interface CaptureHistoryEcho {
  historyScope: string;
  testSceneId?: string; testFrameId?: string; testRunId?: string; testLoop?: number;
  testSourceStartedAt?: string;
}

/** Confirmed TD test wire fields. CSV scenarioControl.runId is deliberately not read. */
export function captureHistoryContext(args: {
  captureId: string; isTest: boolean; useLiveHistory: boolean; request: unknown;
}): { scope: CaptureHistoryScope; echo: CaptureHistoryEcho } {
  const body = args.request && typeof args.request === 'object' && !Array.isArray(args.request) ? args.request as Record<string,unknown> : {};
  const scene = args.isTest ? id(body.testSceneId) : null;
  const frame = args.isTest ? id(body.testFrameId) : null;
  const run = args.isTest && id(body.testRunId)!==null && typeof body.testRunId === 'string' && /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(body.testRunId) ? body.testRunId : null;
  const loop = args.isTest && typeof body.testLoop === 'number' && Number.isSafeInteger(body.testLoop) && body.testLoop >= 1 ? body.testLoop : null;
  const scope = resolveCaptureHistoryScope({ captureId: args.captureId, isTest: args.isTest, useLiveHistory: args.useLiveHistory,
    testScope: { sceneId: scene, runId: run, loopId: loop === null ? undefined : String(loop) } });
  const echo: CaptureHistoryEcho = { historyScope: scope.key };
  if (scene) echo.testSceneId=scene;
  if (frame) echo.testFrameId=frame;
  if (run) echo.testRunId=run;
  if (loop !== null) echo.testLoop=loop;
  if (args.isTest && typeof body.testSourceStartedAt === 'string' && body.testSourceStartedAt.length <= 64 && Number.isFinite(Date.parse(body.testSourceStartedAt))) echo.testSourceStartedAt=body.testSourceStartedAt;
  // The source's start timestamp is metadata only, not evidence of continuous occupancy or an observation.
  return { scope, echo };
}

export interface ScopedOriginalObservation {
  scopeKey: string;
  captureId: string;
  frameId: string;
  /** Must identify the original NOW bytes, never a composed/generated image. */
  sourceImageSha256: string;
  origin: 'original-now';
  observedAt: string;
  observation: string;
}
export interface CaptureHistoryDisplay {
  summary: string;
  scope: CaptureHistoryScope;
  source: 'live-summary' | 'original-observations' | 'none';
  observationCount: number;
  evidence: Array<Pick<ScopedOriginalObservation,'captureId'|'frameId'|'sourceImageSha256'|'observedAt'>>;
}

/**
 * A persisted live summary (including its obstruction note) is only eligible for live captures.
 * Isolated histories have no carry-over state, elapsed-time inference or arrival/departure inference.
 * Empty evidence returns an explicit empty string so clients can clear a previous summary.
 */
export function captureHistoryDisplay(args: {
  scope: CaptureHistoryScope;
  liveSummary?: string;
  observations?: readonly ScopedOriginalObservation[];
  /** Reject observations from after the current capture; caller supplies the capture timestamp, not replay wall-clock. */
  at: string;
}): CaptureHistoryDisplay {
  const result: CaptureHistoryDisplay = { summary: '', scope: args.scope, source: 'none', observationCount: 0, evidence: [] };
  if (args.scope.kind === 'live') return { ...result, summary: args.liveSummary ?? '', source: args.liveSummary ? 'live-summary' : 'none' };
  const at = Date.parse(args.at);
  if (!Number.isFinite(at)) return result;
  const seen = new Set<string>();
  const rows = (args.observations ?? []).filter(row => {
    const time = Date.parse(row.observedAt);
    if (row.scopeKey !== args.scope.key || row.origin !== 'original-now' || !id(row.captureId) || !id(row.frameId) ||
      !/^[a-f0-9]{64}$/i.test(row.sourceImageSha256) || !Number.isFinite(time) || time > at ||
      typeof row.observation !== 'string' || !row.observation.trim()) return false;
    if (args.scope.kind === 'capture' && row.captureId !== args.scope.captureId) return false;
    return true;
  }).sort((a,b) => Date.parse(a.observedAt)-Date.parse(b.observedAt));
  // Re-running the same frame does not manufacture repeated historical events.
  const unique = rows.filter(row => {
    const key = JSON.stringify([row.frameId,row.sourceImageSha256]);
    if (seen.has(key)) return false; seen.add(key); return true;
  }).slice(-3);
  if (!unique.length) return result;
  return {
    ...result,
    summary: unique.map(row => row.observation.replace(/\s+/g,' ').trim()).join('\n'),
    source: 'original-observations', observationCount: unique.length,
    evidence: unique.map(({captureId,frameId,sourceImageSha256,observedAt})=>({captureId,frameId,sourceImageSha256,observedAt})),
  };
}

export interface CachedOriginalObservation {
  sceneId: string;
  frameId: string;
  sourceImageSha256: string;
  originalCaptureId: string;
  sourceObservedAt: string | null;
  observation: string;
  people?: readonly { clothes: string; pose: string; position?: string; facing?: string }[];
  detectorPerson?: boolean | null;
}
export interface ReplayedOriginalObservation extends CachedOriginalObservation { replayedAt: string }
export interface TestHistorySnapshot {
  historyScope: string;
  summary: string;
  observationCount: number;
  /** Original observation time and replay time remain distinct; neither is an inferred occupancy duration. */
  observations: ReplayedOriginalObservation[];
}

function observationLabel(row: CachedOriginalObservation): string {
  const observation = row.observation.replace(/\s+/g, ' ').trim();
  const count = row.people?.length;
  const detection = row.detectorPerson === true ? '検出あり' : row.detectorPerson === false ? '未検出' : '不明';
  // A missing/empty people list is not a negative observation. Text has no explicit
  // presence/confidence field, so do not infer agreement by parsing its prose.
  const consistency = row.detectorPerson === false && count
    ? `人物情報が不一致（人物記録${count}件）`
    : '原観察との一致は未確認';
  // Preserve original wording, including uncertainty in posture/actions.
  // A detector result is labelled as a result, never promoted to room occupancy.
  return `${observation ? `原観察「${observation}」` : '原観察なし（人物有無は不明）'}（人物検出：${detection}。${consistency}）`;
}

/** Pure mechanical digest of observed source-frame states. No VLM, elapsed minutes or inferred transitions. */
export function summarizeTestObservations(rows: readonly ReplayedOriginalObservation[]): string {
  const runs: Array<{first:string;last:string;label:string}> = [];
  for (const row of rows) {
    const label=observationLabel(row),prev=runs[runs.length-1];
    if (prev?.label===label) prev.last=row.frameId;
    else runs.push({first:row.frameId,last:row.frameId,label});
  }
  const lines=runs.slice(-3).map(run=>`${run.first===run.last?run.last:`${run.first}〜${run.last}`}: ${run.label}`);
  // Keep whole recent states rather than cutting a sentence into an unsupported claim.
  while(lines.length>1&&lines.join('。').length>240)lines.shift();
  return lines.join('。');
}

/** Small display-only cache, independent of generation timing and live history persistence. */
export class ScopedTestHistory {
  private groups = new Map<string,ReplayedOriginalObservation[]>();
  constructor(private readonly maxScopes=12, private readonly maxFrames=64) {
    if(!Number.isInteger(maxScopes)||maxScopes<1||!Number.isInteger(maxFrames)||maxFrames<1)throw new Error('Invalid test history cache bounds');
  }
  observe(scope:CaptureHistoryScope,source:CachedOriginalObservation,replayedAt:string):{updated:boolean;snapshot:TestHistorySnapshot} {
    // Missing sender run/loop IDs are not enough to build a multi-frame test history.
    if(scope.kind!=='test'||source.sceneId!==scope.sceneId||!id(source.frameId)||!id(source.originalCaptureId)||
      !/^[a-f0-9]{64}$/i.test(source.sourceImageSha256)||!source.observation?.trim()||
      !Number.isFinite(Date.parse(replayedAt))||
      (source.sourceObservedAt!==null&&!Number.isFinite(Date.parse(source.sourceObservedAt))))return {updated:false,snapshot:this.snapshot(scope)};
    let rows=this.groups.get(scope.key);
    if(!rows){rows=[];this.groups.set(scope.key,rows);}
    const duplicate=rows.some(row=>row.frameId===source.frameId&&row.sourceImageSha256===source.sourceImageSha256);
    if(!duplicate){
      // Copy records: a caller modifying a cache lookup cannot rewrite observed history afterwards.
      rows.push({...source,people:source.people?.map(person=>({...person})),replayedAt});
      if(rows.length>this.maxFrames)rows.splice(0,rows.length-this.maxFrames);
    }
    this.groups.delete(scope.key);this.groups.set(scope.key,rows);
    while(this.groups.size>this.maxScopes)this.groups.delete(this.groups.keys().next().value!);
    return {updated:!duplicate,snapshot:this.snapshot(scope)};
  }
  snapshot(scope:CaptureHistoryScope):TestHistorySnapshot {
    const observations=(scope.kind==='test'?this.groups.get(scope.key)??[]:[]).map(row=>({...row,people:row.people?.map(person=>({...person}))}));
    return {historyScope:scope.key,summary:summarizeTestObservations(observations),observationCount:observations.length,observations};
  }
}
