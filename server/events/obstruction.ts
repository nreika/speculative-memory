/**
 * Camera obstruction ("the lens is blocked by a chair back / hand / cloth") bookkeeping.
 * The describe call flags it per capture (CaptureEvent.obstructed); here we turn the log into
 * "since when" and the closing note of the venue summary. Generation is never stopped by it.
 */
import type { CaptureEvent } from './captureEvents';

export const OBSTRUCTION_NOTE = '(camera may be blocked)';

/**
 * Start time of the current run of obstructed captures (newest -> older, test captures and captures
 * without a verdict are skipped; the first `obstructed:false` ends the run). null when the newest verdict is not true.
 */
export function obstructedSince(events: CaptureEvent[]): string | null {
  let since: string | null = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.test || typeof e.obstructed !== 'boolean') continue;
    if (!e.obstructed) break;
    since = e.startedAt;
  }
  return since;
}

/** Appends the obstruction note to a summary once (no-op when since is null or the note is already there). */
export function withObstructionNote(summary: string, since: string | null): string {
  if (!since || summary.includes(OBSTRUCTION_NOTE)) return summary;
  return `${summary}${OBSTRUCTION_NOTE}`;
}
