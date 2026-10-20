import { randomUUID } from 'node:crypto';
import {explicitRecordingTime,validRecordingScope} from './browserOutputRecordings';

/** Acquisition time must carry its timezone; receiving time is not a substitute. */
export function recordingMetadata(body:unknown):{capturedAt:string|null;source:'live-camera'|'record-only';sourceScope:string|null;recordId:string|null} {
  const value=body&&typeof body==='object'?body as Record<string,unknown>:{};
  const time=explicitRecordingTime(value.capturedAt);
  const capturedAt=time===null?null:new Date(time).toISOString();
  const source=value.source==='live-camera'?'live-camera':'record-only';
  const sourceScope=source==='live-camera'&&validRecordingScope(value.sourceScope)?value.sourceScope:null;
  const recordId=typeof value.recordId==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.recordId)?value.recordId:null;
  return {capturedAt,source,sourceScope,recordId};
}

/** Keep high-frequency live records separate from generation source snapshots. */
export function recordingFilename(timestamp: string, extension: string): string {
  const stamp=timestamp.replace(/[^0-9_-]/g,'');
  const ext=extension.replace(/[^a-zA-Z0-9]/g,'').toLowerCase()||'png';
  if(!stamp)throw new Error('Recording timestamp missing');
  return `live_record_${stamp}_${randomUUID()}.${ext}`;
}
