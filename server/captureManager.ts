/**
 * One capture at a time: the server-side lifecycle of a capture -> generate ->
 * display run, keyed by captureId.
 *
 * There is a single GPU and a single display, so "the latest capture wins":
 * beginning a capture cancels whatever capture is still in flight. Every piece
 * of work belonging to a capture (Gemini/VLM call, ComfyUI prompts, image
 * saves) is tied to the capture's AbortSignal and checks `isActive()` before it
 * publishes anything, so results of a cancelled capture never reach
 * TouchDesigner.
 *
 * Lifecycle notifications go to TouchDesigner on the same UDP channel as
 * `capture.saved` (see CaptureLifecycleMessage); TD uses them for Chain mode,
 * for skipping Timer ticks while busy, and to drop stale images.
 */

export type CaptureSource = 'td-native' | 'control' | 'browser';

export type CaptureCancelReason =
  /** A newer capture started (manual capture while generating). */
  | 'superseded'
  /** Someone called the cancel API. */
  | 'requested'
  /** The browser that was running this capture went away mid-request. */
  | 'client-gone';

export type CaptureLifecycleMessage =
  | {
      type: 'generation.started';
      captureId: string;
      source: CaptureSource;
      imageCount: number;
      startedAt: string;
    }
  | {
      type: 'generation.completed';
      captureId: string;
      imageCount: number;
      deliveredCount: number;
      durationMs: number;
      completedAt: string;
    }
  | {
      type: 'generation.cancelled';
      captureId: string;
      reason: CaptureCancelReason;
      supersededBy: string | null;
      durationMs: number;
      cancelledAt: string;
    }
  | {
      type: 'generation.failed';
      captureId: string;
      error: string;
      durationMs: number;
      failedAt: string;
    };

export type CaptureEndState = 'completed' | 'cancelled' | 'failed';

export interface ActiveCapture {
  captureId: string;
  source: CaptureSource;
  imageCount: number;
  startedAt: number;
  lastActivityAt: number;
  /** Queued for the browser but not picked up yet (control-command path). */
  awaitingClient: boolean;
  deliveredCount: number;
  controller: AbortController;
  signal: AbortSignal;
}

export class CaptureCancelledError extends Error {
  constructor(public readonly captureId: string, reason = 'cancelled') {
    super(`capture ${captureId} ${reason}`);
    this.name = 'AbortError';
  }
}

export const isAbortError = (error: unknown): boolean =>
  !!error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError';

interface CaptureManagerOptions {
  notify: (message: CaptureLifecycleMessage) => void;
  /** Control-command captures that no browser picks up within this are failed. */
  pickupTimeoutMs: number;
  /** A capture with no activity for this long is failed (e.g. browser tab closed). */
  idleTimeoutMs: number;
}

const ENDED_HISTORY_LIMIT = 200;

export class CaptureManager {
  private active: ActiveCapture | null = null;
  private readonly ended = new Map<string, CaptureEndState>();

  constructor(private readonly options: CaptureManagerOptions) {
    const watchdog = setInterval(() => this.checkWatchdog(), 5000);
    watchdog.unref?.();
  }

  /** Start a capture, cancelling the one in flight (if any). */
  begin(
    captureId: string,
    init: { source: CaptureSource; imageCount: number; awaitingClient?: boolean }
  ): ActiveCapture {
    if (this.active && this.active.captureId !== captureId) {
      this.endActive('cancelled', { reason: 'superseded', supersededBy: captureId });
    } else if (this.active) {
      return this.active;
    }

    const controller = new AbortController();
    const now = Date.now();
    const capture: ActiveCapture = {
      captureId,
      source: init.source,
      imageCount: init.imageCount,
      startedAt: now,
      lastActivityAt: now,
      awaitingClient: Boolean(init.awaitingClient),
      deliveredCount: 0,
      controller,
      signal: controller.signal,
    };
    this.ended.delete(captureId);
    this.active = capture;
    console.log(`[capture] started ${captureId} (${init.source}, ${init.imageCount} images)`);
    this.options.notify({
      type: 'generation.started',
      captureId,
      source: init.source,
      imageCount: init.imageCount,
      startedAt: new Date(now).toISOString(),
    });
    return capture;
  }

  get current(): ActiveCapture | null {
    return this.active;
  }

  get(captureId: string): ActiveCapture | null {
    return this.active && this.active.captureId === captureId ? this.active : null;
  }

  isActive(captureId: string): boolean {
    return this.get(captureId) !== null && !this.active!.signal.aborted;
  }

  /** 'active' | 'completed' | 'cancelled' | 'failed' | 'unknown' */
  stateOf(captureId: string): 'active' | CaptureEndState | 'unknown' {
    if (this.isActive(captureId)) return 'active';
    return this.ended.get(captureId) ?? 'unknown';
  }

  touch(captureId: string): void {
    const capture = this.get(captureId);
    if (!capture) return;
    capture.lastActivityAt = Date.now();
    capture.awaitingClient = false;
  }

  noteDelivered(captureId: string): void {
    const capture = this.get(captureId);
    if (!capture) return;
    capture.deliveredCount += 1;
    capture.lastActivityAt = Date.now();
  }

  complete(captureId: string): boolean {
    if (!this.isActive(captureId)) return false;
    this.endActive('completed');
    return true;
  }

  fail(captureId: string, error: unknown): boolean {
    if (!this.isActive(captureId)) return false;
    this.endActive('failed', { error });
    return true;
  }

  /** Cancel the given capture, or whatever is active when no id is given. */
  cancel(captureId: string | null, reason: CaptureCancelReason = 'requested'): string | null {
    if (!this.active) return null;
    if (captureId && this.active.captureId !== captureId) return null;
    const cancelledId = this.active.captureId;
    this.endActive('cancelled', { reason, supersededBy: null });
    return cancelledId;
  }

  snapshot() {
    const capture = this.active;
    return {
      active: capture
        ? {
            captureId: capture.captureId,
            source: capture.source,
            imageCount: capture.imageCount,
            deliveredCount: capture.deliveredCount,
            awaitingClient: capture.awaitingClient,
            startedAt: new Date(capture.startedAt).toISOString(),
            elapsedMs: Date.now() - capture.startedAt,
          }
        : null,
    };
  }

  private endActive(
    state: CaptureEndState,
    detail: { reason?: CaptureCancelReason; supersededBy?: string | null; error?: unknown } = {}
  ): void {
    const capture = this.active;
    if (!capture) return;
    this.active = null;
    this.ended.set(capture.captureId, state);
    if (this.ended.size > ENDED_HISTORY_LIMIT) {
      const oldest = this.ended.keys().next().value;
      if (oldest !== undefined) this.ended.delete(oldest);
    }

    const now = Date.now();
    const durationMs = now - capture.startedAt;
    const at = new Date(now).toISOString();

    if (state === 'completed') {
      console.log(`[capture] completed ${capture.captureId} in ${(durationMs / 1000).toFixed(1)}s`);
      this.options.notify({
        type: 'generation.completed',
        captureId: capture.captureId,
        imageCount: capture.imageCount,
        deliveredCount: capture.deliveredCount,
        durationMs,
        completedAt: at,
      });
      return;
    }

    // Abort after the bookkeeping so anything reacting to the abort already
    // sees the capture as inactive.
    capture.controller.abort(new CaptureCancelledError(capture.captureId, state));

    if (state === 'cancelled') {
      const reason = detail.reason ?? 'requested';
      console.log(
        `[capture] cancelled ${capture.captureId} (${reason}${detail.supersededBy ? ` by ${detail.supersededBy}` : ''}) after ${(durationMs / 1000).toFixed(1)}s`
      );
      this.options.notify({
        type: 'generation.cancelled',
        captureId: capture.captureId,
        reason,
        supersededBy: detail.supersededBy ?? null,
        durationMs,
        cancelledAt: at,
      });
      return;
    }

    const message =
      detail.error instanceof Error ? detail.error.message : String(detail.error ?? 'failed');
    console.log(`[capture] failed ${capture.captureId}: ${message}`);
    this.options.notify({
      type: 'generation.failed',
      captureId: capture.captureId,
      error: message,
      durationMs,
      failedAt: at,
    });
  }

  private checkWatchdog(): void {
    const capture = this.active;
    if (!capture) return;
    const now = Date.now();
    if (capture.awaitingClient && now - capture.startedAt > this.options.pickupTimeoutMs) {
      this.fail(capture.captureId, new Error('no browser picked up the capture command'));
      return;
    }
    if (now - capture.lastActivityAt > this.options.idleTimeoutMs) {
      this.fail(capture.captureId, new Error('capture stalled (no activity)'));
    }
  }
}

/**
 * Resolve with `promise`, or reject as soon as `signal` aborts. The underlying
 * work is abandoned, not stopped - use this for calls that cannot take a
 * signal (the Gemini SDK call); its late result is simply ignored.
 */
export function abandonOnAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason ?? new CaptureCancelledError('?'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => undefined);
      reject(signal.reason ?? new CaptureCancelledError('?'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}
