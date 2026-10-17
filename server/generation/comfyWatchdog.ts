/**
 * ComfyUI hang recovery. A job stuck inside a kernel keeps ComfyUI's queue blocked: every later capture times out
 * (comfyClient 300 s) while its prompt piles up in the queue, and neither POST /interrupt nor /queue {"clear":true}
 * removes the stuck one (2026-10-17: 7 h, 71 failed captures). Only a process restart helps.
 *
 *   - comfyClient reports every timeout / success here (noteTimeout / noteSuccess); consecutive timeouts are counted
 *   - from the first one an alert is active (banner in /logs, `alert` on capture.saved, comfy.alert UDP, display-log)
 *   - at COMFYUI_FAIL_RESTART_AFTER (default 2) consecutive timeouts scripts/restart-comfyui.ps1 runs; the timed-out
 *     capture is the active one and is already failing, so nothing healthy is interrupted
 *   - /api/generate awaits whenReady() before it accepts the next capture, so none starts while ComfyUI is down
 * COMFYUI_AUTO_RESTART=false disables the restart (the alert stays).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

export interface ComfyAlert {
  level: 'warn' | 'restarting' | 'restart-failed';
  consecutiveTimeouts: number;
  since: string;
  message: string;
}

export interface WatchdogStatus {
  consecutiveTimeouts: number;
  lastTimeoutAt: string | null;
  autoRestarts: number;
  restarting: boolean;
  alert: ComfyAlert | null;
}

export interface WatchdogOptions {
  threshold?: number;
  autoRestart?: boolean;
  /** Runs the restart and resolves true once ComfyUI answers /queue again. */
  restart?: () => Promise<boolean>;
  now?: () => Date;
  onChange?: (status: WatchdogStatus) => void;
}

export class ComfyWatchdog {
  private consecutive = 0;
  private lastTimeoutAt: string | null = null;
  private restarts = 0;
  private restartPromise: Promise<void> | null = null;
  private alert: ComfyAlert | null = null;
  private readonly now: () => Date;
  onChange: ((status: WatchdogStatus) => void) | undefined;

  constructor(private readonly opts: WatchdogOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.onChange = opts.onChange;
  }

  private get threshold(): number {
    return Math.max(1, this.opts.threshold ?? Number(process.env.COMFYUI_FAIL_RESTART_AFTER || '2'));
  }

  private get autoRestart(): boolean {
    return this.opts.autoRestart ?? process.env.COMFYUI_AUTO_RESTART !== 'false';
  }

  status(): WatchdogStatus {
    return {
      consecutiveTimeouts: this.consecutive,
      lastTimeoutAt: this.lastTimeoutAt,
      autoRestarts: this.restarts,
      restarting: this.restartPromise !== null,
      alert: this.alert,
    };
  }

  private setAlert(level: ComfyAlert['level']) {
    const since = this.alert?.since ?? this.now().toISOString();
    const text = {
      warn: `ComfyUI が応答しません(連続 ${this.consecutive} 回タイムアウト)`,
      restarting: `ComfyUI が応答しません(連続 ${this.consecutive} 回)。自動再起動中`,
      'restart-failed': `ComfyUI の自動再起動に失敗しました(連続 ${this.consecutive} 回タイムアウト)。手動で scripts/restart-comfyui.ps1`,
    }[level];
    this.alert = { level, consecutiveTimeouts: this.consecutive, since, message: text };
  }

  private emit() {
    try {
      this.onChange?.(this.status());
    } catch {
      /* a listener must never break generation */
    }
  }

  noteTimeout(): void {
    this.consecutive += 1;
    this.lastTimeoutAt = this.now().toISOString();
    this.setAlert(this.restartPromise ? 'restarting' : 'warn');
    if (this.consecutive >= this.threshold && this.autoRestart && !this.restartPromise) this.startRestart();
    this.emit();
  }

  /** A generation finished: ComfyUI works. */
  noteSuccess(): void {
    if (this.consecutive === 0 && !this.alert) return;
    this.consecutive = 0;
    if (!this.restartPromise) this.alert = null;
    this.emit();
  }

  private startRestart() {
    const run = this.opts.restart ?? runRestartScript;
    this.setAlert('restarting');
    this.restartPromise = (async () => {
      let ok = false;
      try {
        ok = await run();
      } catch (error) {
        console.error('comfyWatchdog: restart threw:', error);
      }
      this.restarts += 1;
      this.consecutive = 0;
      if (ok) this.alert = null;
      else this.setAlert('restart-failed');
      console.log(`comfyWatchdog: ComfyUI restart ${ok ? 'finished' : 'FAILED'} (auto restarts: ${this.restarts})`);
    })().finally(() => {
      this.restartPromise = null;
      this.emit();
    });
  }

  /** Resolves when no restart is running (immediately in the normal case). */
  whenReady(): Promise<void> {
    return this.restartPromise ?? Promise.resolve();
  }
}

/** scripts/restart-comfyui.ps1: stops the hung python, starts ComfyUI, waits up to 75 s for /queue. Exit 0 = answering. */
export function runRestartScript(): Promise<boolean> {
  const script = path.join(process.cwd(), 'scripts', 'restart-comfyui.ps1');
  console.log(`comfyWatchdog: restarting ComfyUI (${script})`);
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
    child.stdout.on('data', (d) => console.log(`comfyWatchdog: ${String(d).trim()}`));
    child.stderr.on('data', (d) => console.error(`comfyWatchdog: ${String(d).trim()}`));
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

let singleton: ComfyWatchdog | null = null;
export function getComfyWatchdog(): ComfyWatchdog {
  if (!singleton) singleton = new ComfyWatchdog();
  return singleton;
}
