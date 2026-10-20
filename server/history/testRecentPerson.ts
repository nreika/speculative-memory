/**
 * Recent-person lookup for scoped test playback (historyScope test:<scene>:<run>:L<loop>).
 * Test captures never read or write logs/scene-history.jsonl, so G-01/G-02 (draw the person seen within the last
 * RECENT_PERSON_WINDOW_MIN minutes from behind in an empty frame) needs the loop's own replayed source observations.
 * Read-only over the in-memory ScopedTestHistory; nothing here touches the exhibition history.
 */
import type { SceneHistoryEntry } from './sceneHistory';
import type { ReplayedOriginalObservation } from './historyDisplay';

export interface TestRecentPerson { entry: SceneHistoryEntry; minutesAgo: number; frameId: string }

/** Latest replayed frame of this loop whose original detector saw a person, within the window (replay wall clock). */
export function latestTestPerson(
  rows: readonly ReplayedOriginalObservation[],
  opts: { windowMin: number; now?: number; excludeFrameId?: string },
): TestRecentPerson | null {
  const now = opts.now ?? Date.now();
  const since = now - opts.windowMin * 60_000;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.frameId === opts.excludeFrameId) continue;
    const t = Date.parse(row.replayedAt);
    const people = (row.people ?? []).filter(p => p && typeof p.clothes === 'string');
    if (row.detectorPerson !== true || !people.length || !Number.isFinite(t) || t < since || t > now + 60_000) continue;
    const p = people[0];
    // English, from the structured people record (the cached observation text may be the Japanese NOW caption).
    const description = `A person in ${p.clothes}, ${p.pose || 'standing'}${p.position ? `, at the ${p.position} of the frame` : ''}.`;
    return {
      frameId: row.frameId,
      minutesAgo: Math.max(0, Math.round((now - t) / 60_000)),
      entry: {
        time: row.replayedAt,
        captureId: row.originalCaptureId,
        sceneDescription: description,
        observation: description,
        hasPerson: true,
        detectorPerson: true,
        people: people.map(x => ({ position: x.position ?? '', pose: x.pose, clothes: x.clothes, facing: x.facing ?? '', hair: (x as { hair?: string }).hair, ...((x as { headBox?: [number, number, number, number] | null }).headBox ? { headBox: (x as { headBox?: [number, number, number, number] }).headBox } : {}) })),
      },
    };
  }
  return null;
}

/** Source frames (data URLs) of occupied replayed frames, per test scope, for the behind-view reference crop. */
export class TestPersonFrames {
  private scopes = new Map<string, Map<string, string>>();
  constructor(private readonly maxScopes = 12, private readonly maxFrames = 4) {}
  remember(scopeKey: string, originalCaptureId: string, imageDataUrl: string): void {
    let frames = this.scopes.get(scopeKey);
    if (!frames) frames = new Map();
    frames.delete(originalCaptureId);
    frames.set(originalCaptureId, imageDataUrl);
    while (frames.size > this.maxFrames) frames.delete(frames.keys().next().value!);
    this.scopes.delete(scopeKey);
    this.scopes.set(scopeKey, frames);
    while (this.scopes.size > this.maxScopes) this.scopes.delete(this.scopes.keys().next().value!);
  }
  get(scopeKey: string, originalCaptureId: string): string | undefined {
    return this.scopes.get(scopeKey)?.get(originalCaptureId);
  }
}
