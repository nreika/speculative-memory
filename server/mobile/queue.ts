/**
 * Phone captures wait here, one at a time. A job starts only while the venue capture lane is idle
 * (`isVenueBusy()` false); a running job is never cancelled by a venue capture (it finishes first;
 * the venue capture is not delayed either, ComfyUI's own queue is serial).
 */
export type MobileJobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface MobileJob<P = unknown> {
  id: string;
  payload: P;
  state: MobileJobState;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
  /** Free-form result of the runner (generation id, ...). */
  result: unknown;
  /** Stage text set by the runner ("detect", "plan", "scene A"...). */
  stage: string | null;
}

export interface MobileQueueOptions<P> {
  run: (job: MobileJob<P>) => Promise<unknown>;
  isVenueBusy: () => boolean;
  /** Estimated seconds of one job (queue position -> waiting time). */
  jobEstimateSec?: number;
  pollMs?: number;
  now?: () => number;
  maxKept?: number;
  maxQueued?: number;
}

export class MobileQueue<P = unknown> {
  private readonly jobs = new Map<string, MobileJob<P>>();
  private readonly pending: string[] = [];
  private running: string | null = null;
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastDurationsSec: number[] = [];

  constructor(private readonly opts: MobileQueueOptions<P>) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  enqueue(payload: P, id?: string): MobileJob<P> {
    if (this.pending.length >= (this.opts.maxQueued ?? 20)) throw new Error('queue is full');
    const jobId = id ?? `mob-${this.now()}-${++this.seq}`;
    const job: MobileJob<P> = {
      id: jobId,
      payload,
      state: 'queued',
      createdAt: this.now(),
      startedAt: null,
      endedAt: null,
      error: null,
      result: null,
      stage: null,
    };
    this.jobs.set(jobId, job);
    this.pending.push(jobId);
    this.trim();
    this.kick();
    return job;
  }

  get(id: string): MobileJob<P> | null {
    return this.jobs.get(id) ?? null;
  }

  /** Cancel a queued job (a running job cannot be stopped from here). */
  cancel(id: string): boolean {
    const i = this.pending.indexOf(id);
    if (i < 0) return false;
    this.pending.splice(i, 1);
    const job = this.jobs.get(id)!;
    job.state = 'cancelled';
    job.endedAt = this.now();
    return true;
  }

  get runningJob(): MobileJob<P> | null {
    return this.running ? this.jobs.get(this.running) ?? null : null;
  }

  get queuedCount(): number {
    return this.pending.length;
  }

  private typicalSec(): number {
    const d = this.lastDurationsSec;
    if (d.length) return Math.round(d.reduce((a, b) => a + b, 0) / d.length);
    return this.opts.jobEstimateSec ?? 110;
  }

  /** ahead = jobs in front (the running one included); etaStartSec/etaDoneSec = rough seconds from now. */
  describe(id: string) {
    const job = this.jobs.get(id);
    if (!job) return null;
    const per = this.typicalSec();
    const idx = this.pending.indexOf(id);
    let ahead = 0;
    let etaStartSec = 0;
    if (job.state === 'queued') {
      ahead = idx + (this.running ? 1 : 0);
      const run = this.runningJob;
      const runLeft = run && run.startedAt !== null ? Math.max(0, per - (this.now() - run.startedAt) / 1000) : 0;
      etaStartSec = Math.round(runLeft + idx * per);
      if (this.opts.isVenueBusy()) etaStartSec += 30;
    }
    const runningLeft =
      job.state === 'running' ? Math.max(0, Math.round(per - (this.now() - (job.startedAt ?? this.now())) / 1000)) : 0;
    return {
      id: job.id,
      state: job.state,
      stage: job.stage,
      ahead,
      etaStartSec,
      etaDoneSec: job.state === 'queued' ? etaStartSec + per : runningLeft,
      elapsedSec: job.startedAt ? Math.round(((job.endedAt ?? this.now()) - job.startedAt) / 1000) : 0,
      waitingForVenue: job.state === 'queued' && idx === 0 && !this.running && this.opts.isVenueBusy(),
      error: job.error,
      result: job.state === 'completed' ? job.result : null,
    };
  }

  private trim() {
    const keep = this.opts.maxKept ?? 50;
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= keep) break;
      if (job.state !== 'queued' && job.state !== 'running') this.jobs.delete(id);
    }
  }

  /** Try to start the next job; re-checked every pollMs while something waits. */
  kick(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running || !this.pending.length) return;
    if (this.opts.isVenueBusy()) {
      this.timer = setTimeout(() => this.kick(), this.opts.pollMs ?? 2000);
      this.timer.unref?.();
      return;
    }
    const id = this.pending.shift()!;
    const job = this.jobs.get(id)!;
    this.running = id;
    job.state = 'running';
    job.startedAt = this.now();
    void this.opts
      .run(job)
      .then((result) => {
        job.result = result;
        job.state = 'completed';
      })
      .catch((error) => {
        job.error = String((error as Error)?.message ?? error);
        job.state = 'failed';
      })
      .finally(() => {
        job.endedAt = this.now();
        if (job.state === 'completed') {
          this.lastDurationsSec = [...this.lastDurationsSec, (job.endedAt - job.startedAt!) / 1000].slice(-5);
        }
        this.running = null;
        this.kick();
      });
  }
}
