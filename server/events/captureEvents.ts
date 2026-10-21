/**
 * Per-capture structured log: logs/capture-events.jsonl, one JSON line per write, append-only.
 *   - a "started" row when /api/generate begins, a final row (completed|failed|cancelled) when it ends
 *   - display rows ({captureId, displayAdd}) from POST /api/display-log (TD: which image went to which DISPLAY)
 * Readers fold all rows of one captureId in file order (later fields win, displayAdd entries accumulate),
 * so a crash between started and final just leaves a "running" row (shown as interrupted after 15 min).
 * Every write swallows its own errors: the log must never stop a generation.
 */
import fs from 'node:fs';
import {browserOutputCurrent} from '../browserOutputCurrent';
import path from 'node:path';

export type CaptureResult = 'running' | 'completed' | 'failed' | 'cancelled';

export interface DisplayAssignment {
  display: number;
  window: string;
  source: string;
  scene: string;
  open: boolean;
}

export interface DisplayEntry {
  at: string;
  reason: string;
  assignments: DisplayAssignment[];
}

export interface CaptureEvent {
  captureId: string;
  source?: string;
  /** Explicit batch accounting, written only by versioned new capture producers. */
  batchLogVersion?: 1;
  requestedCount?: number | null;
  savedCount?: number | null;
  /** Browser publication eligibility; not a remote browser decode acknowledgement. */
  publishedCount?: number | null;
  executionSource?: 'manual'|'timer'|'chain'|'scenario'|'unknown';
  /** G-27: the live scenario CSV run this capture was started under (runId, scenario id, sha256 of the archived CSV copy). */
  scenarioRun?: {runId:string;scenarioId:string;csvSha:string};
  inputIdentity?: {kind:'test'|'live-camera'|'unknown';id:string|null;sceneId?:string;runId?:string;loop?:number;sha256?:string};
  failureReason?: string | null;
  browserFollow?: {updateMode?:'each'|'all';testSceneId?:string;testRunId?:string;scope:string;sourceRecordedAtMs:number|null;cameraScope?:string};
  browserBatch?: import('../browserDisplay').BrowserDisplayContent[];
  /**
   * G-24: unoccupied scenes that were not generated (no recent person drawn, no object change). Browser outputs keep the
   * previous image/caption for these keys and still treat the batch as complete; QA never sees them.
   */
  skippedScenes?: Array<{ sceneKey: 'gen_a' | 'gen_b' | 'gen_c'; reason: string }>;
  /** G-25 per-scene person roll / chance / personDrawn of an unoccupied frame (compact). */
  emptyRoom?: Array<{ sceneKey: string; chance: number; roll: number; personDrawn: boolean; reason: string; objectAllowed: boolean; skipped?: boolean; skipReason?: string }>;
  test?: boolean;
  startedAt: string;
  endedAt?: string;
  result: CaptureResult;
  detectDescribeMs?: number | null;
  planMs?: number | null;
  planCalls?: number | null;
  sceneAMs?: number | null;
  sceneBMs?: number | null;
  sceneCMs?: number | null;
  totalMs?: number | null;
  occupied?: boolean | null;
  occupancySource?: string | null;
  people?: number | null;
  /** Camera view judged blocked by a close object (describe call); undefined = no verdict. */
  obstructed?: boolean;
  obstructedBy?: string;
  guard?: { synthesized: boolean; replaced: number; duplicateRetried: boolean };
  extras?: Record<string, { text: string; reflected: boolean | null; synthesized: boolean }>;
  vlmBackend?: string | null;
  vlmModel?: string | null;
  imageBackend?: string | null;
  imageModel?: string | null;
  /** Gemini cost of this capture in yen (sum of usage.jsonl rows with this captureId). */
  cost?: number;
  errorStage?: string | null;
  errorMessage?: string | null;
  archiveDir?: string | null;
  images?: { now?: string | null; a?: string | null; b?: string | null; c?: string | null };
  displays?: DisplayEntry[];
  /** ComfyUI hang alert that was active when this capture ended. */
  comfyAlert?: { level: string; message: string; since: string };
  /** Perform-panel presence / tone of this capture (0..1) and the presence actually used (0 when the room was empty). */
  presence?: number | null;
  tone?: number | null;
  effectivePresence?: number | null;
  /** Per-scene presence / tone [gen_a, gen_b, gen_c]; present only when a scene differs from the global value. */
  scenePresence?: number[] | null;
  sceneTone?: number[] | null;
  /** Rulebook version (rulebook/active.json) the prompts of this capture were built with. */
  rulebookVersion?: number | null;
  /** Local-QA summary (server/qa/localJudge.ts), added after the images were judged between captures. */
  qa?: { judged: number; defective: number; defects: Record<string, number>; elapsedMs: number; at: string };
  /** Filled by the backfill script only. */
  backfilled?: boolean;
}

export function captureExecutionSource(value:unknown):NonNullable<CaptureEvent['executionSource']> {
  return ['manual','timer','chain','scenario'].includes(value as string)?value as NonNullable<CaptureEvent['executionSource']>:'unknown';
}

/** Safe input identifiers only. Never copies arbitrary request fields, tokens or image data. */
export function captureInputIdentity(request:unknown,isTest:boolean):NonNullable<CaptureEvent['inputIdentity']> {
  const r=request&&typeof request==='object'&&!Array.isArray(request)?request as Record<string,unknown>:{};
  if(isTest){
    const scene=typeof r.testSceneId==='string'&&/^TSC-[0-9]{3}$/.test(r.testSceneId)?r.testSceneId:undefined;
    const id=scene&&typeof r.testFrameId==='string'&&new RegExp('^'+scene+'-F[0-9]{3,8}$').test(r.testFrameId)?r.testFrameId:null;
    const run=typeof r.testRunId==='string'&&/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(r.testRunId)?r.testRunId:undefined;
    return {kind:'test',id,...(scene?{sceneId:scene}:{}),...(run?{runId:run}:{}),...(Number.isSafeInteger(r.testLoop)&&Number(r.testLoop)>=1?{loop:Number(r.testLoop)}:{})};
  }
  return r.sourceScope==='camera:main'||r.sourceScope==='camera:remote'?{kind:'live-camera',id:r.sourceScope}:{kind:'unknown',id:null};
}

/** Saved output slots and published browserBatch members are deliberately different. */
export function captureBatchCounts(event:CaptureEvent):Pick<CaptureEvent,'requestedCount'|'savedCount'|'publishedCount'> {
  const requested=event.batchLogVersion===1&&Number.isInteger(event.requestedCount)&&Number(event.requestedCount)>=1&&Number(event.requestedCount)<=3?event.requestedCount!:null;
  if(event.batchLogVersion!==1)return {requestedCount:null,savedCount:null,publishedCount:null};
  const keys=['a','b','c']as const;
  const saved=keys.filter(key=>typeof event.images?.[key]==='string'&&event.images[key]!.startsWith('/captures/'));
  const scope=event.browserFollow?.scope,mode=event.browserFollow?.updateMode;
  if(!scope||!['each','all'].includes(mode)||!['test','td-native','browser'].includes(event.source??''))return {requestedCount:requested,savedCount:saved.length,publishedCount:null};
  try {
    const snapshots=browserOutputCurrent([event],Date.parse(event.endedAt??event.startedAt)||0,{updateMode:mode});
    const published=keys.filter(key=>snapshots[key]?.content?.captureId===event.captureId&&snapshots[key]?.content?.sceneKey==='gen_'+key).length;
    return {requestedCount:requested,savedCount:saved.length,publishedCount:requested===null?null:published};
  } catch {return {requestedCount:requested,savedCount:saved.length,publishedCount:null};}
}

export const STALE_RUNNING_MS = 15 * 60 * 1000;

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const localDayKey = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : localDay(d);
};

/** Sum of the yen cost of every usage.jsonl row of this capture (0 when none / no file). */
export function costForCapture(usageLogPath: string, captureId: string): number {
  try {
    const text = fs.readFileSync(usageLogPath, 'utf8');
    let jpy = 0;
    for (const line of text.split('\n')) {
      if (!line || !line.includes(captureId)) continue;
      try {
        const r = JSON.parse(line);
        if (r.captureId === captureId && Number.isFinite(r.jpy)) jpy += r.jpy;
      } catch {
        /* skip a torn line */
      }
    }
    return Math.round(jpy * 100) / 100;
  } catch {
    return 0;
  }
}

export interface EventQuery {
  limit?: number;
  before?: string;
  failedOnly?: boolean;
  extras?: boolean;
  people?: boolean;
  gemini?: boolean;
}

export interface EventTimelineQuery {limit?:number;cursor?:string}
export interface EventTimelinePage {schema:1;events:Array<CaptureEvent&{timelineRunKey:string}>;nextCursor:string|null;runOrigins:Array<{key:string;startedAtMs:number}>}
export class EventTimelineQueryError extends Error {readonly status=400;}
const TIMELINE_CURSOR_MAX=4096;
function timelineCursor(value:string):[number,string] {
  if(typeof value!=='string'||!value.length||value.length>TIMELINE_CURSOR_MAX||!/^[A-Za-z0-9_-]+$/.test(value))throw new EventTimelineQueryError('Invalid timeline cursor');
  try {
    const bytes=Buffer.from(value,'base64url');if(bytes.toString('base64url')!==value)throw Error();
    const v=JSON.parse(bytes.toString('utf8'));
    if(!Array.isArray(v)||v.length!==3||v[0]!==1||!Number.isSafeInteger(v[1])||Math.abs(v[1])>8640000000000000||typeof v[2]!=='string'||!v[2].length)throw Error();
    return [v[1],v[2]];
  } catch {throw new EventTimelineQueryError('Invalid timeline cursor');}
}
function encodeTimelineCursor(ms:number,id:string):string {
  const encoded=Buffer.from(JSON.stringify([1,ms,id]),'utf8').toString('base64url');
  if(encoded.length>TIMELINE_CURSOR_MAX)throw new EventTimelineQueryError('Capture identity exceeds timeline cursor limit');
  return encoded;
}
/** Derived only for timeline responses. Live/legacy day is Japan time, never source-capture time. */
export function timelineRunKey(event:CaptureEvent,startMs=Date.parse(event.startedAt)):string {
  const run=event.inputIdentity?.runId||event.browserFollow?.testRunId;
  if(typeof run==='string'&&run)return 'test:'+run;
  const shifted=new Date(startMs+9*60*60*1000);
  const day=Number.isFinite(shifted.getTime())?shifted.toISOString().slice(0,10):new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(startMs));
  return (event.browserFollow?.scope||event.source||'legacy')+':'+day;
}

export class CaptureEventStore {
  private cache: { mtimeMs: number; size: number; events: CaptureEvent[]; offset: number; byId: Map<string, CaptureEvent>; orphanDisplays: Map<string, DisplayEntry[]> } | null = null;

  constructor(
    readonly filePath: string,
    readonly displayLogPath: string = path.join(path.dirname(filePath), 'display-log.jsonl'),
    private readonly usageLogPath: string = path.join(path.dirname(filePath), 'usage.jsonl'),
    private readonly now: () => Date = () => new Date(),
    /** Active ComfyUI hang alert (comfyWatchdog), stamped on final rows and display-log lines. */
    private readonly getAlert: () => { level: string; message: string; since: string } | null = () => null
  ) {}

  private append(file: string, row: unknown): boolean {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
      return true;
    } catch (error) {
      console.error('captureEvents: write failed (generation continues):', error);
      return false;
    }
  }

  /** Write the "started" row (or any later full snapshot). */
  write(event: CaptureEvent): void {
    this.append(this.filePath, event);
  }

  /** Late fields for an existing capture (readers fold rows of one captureId, later fields win). */
  patch(captureId: string, fields: Partial<CaptureEvent>): void {
    this.append(this.filePath, { captureId, ...fields });
  }

  /** Final row: fills the yen cost from usage.jsonl and the end time. */
  finish(event: CaptureEvent): void {
    const endedAt = event.endedAt ?? this.now().toISOString();
    this.write({
      ...event,
      endedAt,
      ...captureBatchCounts(event),
      failureReason:event.result==='failed'||event.result==='cancelled'?event.errorMessage??null:null,
      totalMs: event.totalMs ?? Math.max(0, Date.parse(endedAt) - Date.parse(event.startedAt)),
      cost: costForCapture(this.usageLogPath, event.captureId),
      ...(this.getAlert() ? { comfyAlert: this.getAlert() } : {}),
    });
  }

  /** Raw display-log line (kept even when the captureId has no event) + a displayAdd row for the capture. */
  addDisplay(captureId: string, entry: DisplayEntry): void {
    const alert = this.getAlert();
    this.append(this.displayLogPath, { captureId, ...entry, receivedAt: this.now().toISOString(), ...(alert ? { alert } : {}) });
    this.append(this.filePath, { captureId, displayAdd: entry });
  }

  /**
   * All captures folded, oldest first. Cached by file mtime+size; when the file only grew, just the appended lines are folded
   * (2026-10-21: a 30 MB log was fully re-parsed after every append during generation, blocking the server ~0.7 s per read).
   */
  readAll(): CaptureEvent[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      return [];
    }
    const cached = this.cache;
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.events;
    let state = cached && stat.size > cached.size && cached.offset > 0 ? cached : null;
    if (!state) state = { mtimeMs: 0, size: 0, events: [], offset: 0, byId: new Map(), orphanDisplays: new Map() };
    let chunk = '';
    let consumed = 0;
    try {
      const fd = fs.openSync(this.filePath, 'r');
      try {
        const length = stat.size - state.offset;
        const buffer = Buffer.alloc(Math.max(0, length));
        let read = 0;
        while (read < length) {
          const n = fs.readSync(fd, buffer, read, length - read, state.offset + read);
          if (n <= 0) break;
          read += n;
        }
        const end = buffer.subarray(0, read).lastIndexOf(10);
        // A torn final line (no newline yet) is left for the next read.
        consumed = end >= 0 ? end + 1 : 0;
        chunk = buffer.subarray(0, consumed).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return cached?.events ?? [];
    }
    const { byId, orphanDisplays } = state;
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const id = row?.captureId;
      if (typeof id !== 'string' || !id) continue;
      if (row.displayAdd) {
        const cur = byId.get(id);
        const list = cur ? (cur.displays ??= []) : (orphanDisplays.get(id) ?? orphanDisplays.set(id, []).get(id)!);
        list.push(row.displayAdd);
        continue;
      }
      const prev = byId.get(id);
      const merged: CaptureEvent = { ...(prev ?? {}), ...row };
      if (prev?.displays && !row.displays) merged.displays = prev.displays;
      if (!prev && orphanDisplays.has(id)) merged.displays = orphanDisplays.get(id);
      byId.set(id, merged);
    }
    const nowMs = this.now().getTime();
    const events: CaptureEvent[] = [];
    for (const ev of byId.values()) {
      if (!ev.startedAt) continue; // display rows for a capture that never wrote an event row
      if (ev.result === 'running' && nowMs - Date.parse(ev.startedAt) > STALE_RUNNING_MS) {
        ev.result = 'failed';
        ev.errorStage = ev.errorStage ?? 'unknown';
        ev.errorMessage = ev.errorMessage ?? 'No end record (interrupted, e.g. server stopped)';
      }
      events.push(ev);
    }
    events.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, events, offset: state.offset + consumed, byId, orphanDisplays };
    return events;
  }

  get(captureId: string): CaptureEvent | null {
    return this.readAll().find((e) => e.captureId === captureId) ?? null;
  }

  /** Newest first. */
  query(q: EventQuery = {}): CaptureEvent[] {
    const limit = Math.min(Math.max(Math.floor(q.limit ?? 200) || 200, 1), 2000);
    const before = q.before ? Date.parse(q.before) : NaN;
    const out: CaptureEvent[] = [];
    const all = this.readAll();
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      const e = all[i];
      if (!Number.isNaN(before) && !(Date.parse(e.startedAt) < before)) continue;
      if (q.failedOnly && e.result !== 'failed') continue;
      if (q.extras && !(e.extras && Object.keys(e.extras).length > 0)) continue;
      if (q.people && !((e.people ?? 0) > 0)) continue;
      if (q.gemini && e.vlmBackend !== 'gemini' && e.imageBackend !== 'gemini') continue;
      out.push(e);
    }
    return out;
  }

  /** Query-only copy: stable descending (startedAt milliseconds, ordinal captureId) order. */
  timeline(q:EventTimelineQuery={}):EventTimelinePage {
    if(Object.keys(q).some(k=>!['limit','cursor'].includes(k)))throw new EventTimelineQueryError('Unsupported timeline query');
    const limit=q.limit===undefined?200:q.limit;
    if(!Number.isInteger(limit)||limit<1||limit>2000)throw new EventTimelineQueryError('Timeline limit must be an integer from 1 to 2000');
    const cursor=q.cursor===undefined?undefined:timelineCursor(q.cursor);
    const all=this.readAll().map(event=>({event,ms:Date.parse(event.startedAt)})).filter(r=>Number.isFinite(r.ms)&&typeof r.event.captureId==='string'&&r.event.captureId.length>0);
    const ordered=all.filter(r=>!cursor||r.ms<cursor[0]||r.ms===cursor[0]&&r.event.captureId<cursor[1]).sort((a,b)=>b.ms-a.ms||(a.event.captureId<b.event.captureId?1:a.event.captureId>b.event.captureId?-1:0));
    const page=ordered.slice(0,limit),events=page.map(r=>({...r.event,timelineRunKey:timelineRunKey(r.event,r.ms)}));
    const keys=new Set(events.map(e=>e.timelineRunKey)),origins=new Map<string,number>();
    for(const r of all){const key=timelineRunKey(r.event,r.ms);if(keys.has(key)&&(!origins.has(key)||r.ms<origins.get(key)!))origins.set(key,r.ms);}
    const last=page.at(-1);
    return {schema:1,events,nextCursor:ordered.length>limit&&last?encodeTimelineCursor(last.ms,last.event.captureId):null,runOrigins:[...origins].map(([key,startedAtMs])=>({key,startedAtMs})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)};
  }

  summary(day?: string) {
    const target = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : localDay(this.now());
    const all = this.readAll().filter((e) => !e.test);
    const dayEvents = all.filter((e) => localDayKey(e.startedAt) === target);
    const completed = dayEvents.filter((e) => e.result === 'completed');
    const failed = dayEvents.filter((e) => e.result === 'failed');
    const cancelled = dayEvents.filter((e) => e.result === 'cancelled');
    const durations = completed.map((e) => e.totalMs).filter((n): n is number => typeof n === 'number').sort((a, b) => a - b);
    const pct = (p: number) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor(p * durations.length))] : null);
    const failedByHour = Array.from({ length: 24 }, () => 0);
    for (const e of failed) failedByHour[new Date(e.startedAt).getHours()] += 1;
    const last = all.length ? all[all.length - 1] : null;
    const lastCompleted = [...all].reverse().find((e) => e.result === 'completed') ?? null;
    return {
      day: target,
      completed: completed.length,
      failed: failed.length,
      cancelled: cancelled.length,
      costJpy: Math.round(dayEvents.reduce((s, e) => s + (e.cost ?? 0), 0) * 100) / 100,
      durationMs: {
        count: durations.length,
        min: durations[0] ?? null,
        p50: pct(0.5),
        p90: pct(0.9),
        max: durations.length ? durations[durations.length - 1] : null,
        avg: durations.length ? Math.round(durations.reduce((s, n) => s + n, 0) / durations.length) : null,
      },
      failedByHour,
      lastCaptureAt: last?.startedAt ?? null,
      lastCompletedAt: lastCompleted?.endedAt ?? lastCompleted?.startedAt ?? null,
    };
  }
}

/** Validates the TD body of POST /api/display-log; null = invalid (400). */
export function parseDisplayLog(body: any, now: () => Date = () => new Date()): { captureId: string; entry: DisplayEntry } | null {
  const captureId = typeof body?.captureId === 'string' ? body.captureId.trim() : '';
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(captureId)) return null;
  if (!Array.isArray(body?.assignments)) return null;
  const str = (v: unknown, max = 64) => (typeof v === 'string' ? v.slice(0, max) : '');
  const assignments: DisplayAssignment[] = body.assignments
    .filter((a: any) => a && typeof a === 'object')
    .slice(0, 16)
    .map((a: any) => ({
      display: Number.isFinite(Number(a.display)) ? Number(a.display) : 0,
      window: str(a.window),
      source: str(a.source),
      scene: str(a.scene),
      open: a.open === true,
    }));
  const at = typeof body.at === 'string' && !Number.isNaN(Date.parse(body.at)) ? body.at : now().toISOString();
  return { captureId, entry: { at, reason: str(body.reason, 16) || 'unknown', assignments } };
}

/** Group consecutive failed events (newest first in, same order out) with the same stage + first 40 message chars. */
export function groupFailureRuns<T extends { captureId: string; startedAt: string; result: string; errorStage?: string | null; errorMessage?: string | null }>(
  events: T[]
): Array<{ kind: 'event'; event: T } | { kind: 'run'; stage: string; messageHead: string; events: T[] }> {
  const out: Array<{ kind: 'event'; event: T } | { kind: 'run'; stage: string; messageHead: string; events: T[] }> = [];
  let run: { stage: string; messageHead: string; events: T[] } | null = null;
  const flush = () => {
    if (!run) return;
    if (run.events.length >= 2) out.push({ kind: 'run', ...run });
    else out.push({ kind: 'event', event: run.events[0] });
    run = null;
  };
  for (const e of events) {
    if (e.result !== 'failed') {
      flush();
      out.push({ kind: 'event', event: e });
      continue;
    }
    const stage = e.errorStage ?? '';
    const head = (e.errorMessage ?? '').slice(0, 40);
    if (run && run.stage === stage && run.messageHead === head) run.events.push(e);
    else {
      flush();
      run = { stage, messageHead: head, events: [e] };
    }
  }
  flush();
  return out;
}
