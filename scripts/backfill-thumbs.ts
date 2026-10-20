/**
 * Backfill History thumbnails (captures/thumbs/<name>.jpg, 320 px JPEG q75) for existing captures.
 * Low priority: one python process at a time (below-normal priority), newest files first, and it pauses
 * while GET /api/capture/status reports an active capture. Resumable: existing thumbs are skipped, so
 * stopping (Ctrl+C) and re-running continues where it left off. Progress is logged every 500 files.
 * No model calls. A running server picks the new files up on the next History view (its on-miss check finds them).
 *
 *   npx tsx scripts/backfill-thumbs.ts [--batch 4] [--limit N] [--server http://127.0.0.1:3000] [--dry-run]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { THUMB_DIRNAME, thumbName, pythonThumbBatch, defaultThumbPython, type ThumbJob } from '../server/captureThumbs';

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const capturesDir = path.resolve(process.cwd(), process.env.CAPTURES_DIR || 'captures');
const thumbsDir = path.join(capturesDir, THUMB_DIRNAME);
const server = arg('--server') || `http://127.0.0.1:${process.env.PORT || '3000'}`;
const batchSize = Math.max(1, Math.min(16, Number(arg('--batch')) || 4));
const limit = Number(arg('--limit')) || Infinity;
const dryRun = args.includes('--dry-run');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }

/** True while the server reports an active capture. An unreachable server means no capture is running. */
async function captureActive(): Promise<boolean> {
  try {
    const res = await fetch(`${server}/api/capture/status`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    return !!(await res.json())?.active;
  } catch {
    return false;
  }
}

async function main() {
  fs.mkdirSync(thumbsDir, { recursive: true });
  const have = new Set(fs.readdirSync(thumbsDir).filter((n) => /\.jpg$/i.test(n)));
  const todo: Array<ThumbJob & { mtime: number }> = [];
  for (const entry of fs.readdirSync(capturesDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = thumbName(entry.name);
    if (!name || have.has(name)) continue;
    const source = path.join(capturesDir, entry.name);
    todo.push({ source, output: path.join(thumbsDir, name), mtime: fs.statSync(source).mtimeMs });
  }
  todo.sort((a, b) => b.mtime - a.mtime); // newest first: the History page shows recent rows first
  const total = Math.min(todo.length, limit);
  console.log(`[thumbs] ${have.size} thumbs exist, ${todo.length} missing; processing ${total} (batch ${batchSize}) -> ${thumbsDir}`);
  if (dryRun || !total) return;

  const python = defaultThumbPython();
  const run = pythonThumbBatch(python);
  let done = 0, made = 0, failed = 0, nextLog = 500, warned = false, paused = false;
  const startedAt = Date.now();
  for (let i = 0; i < total; i += batchSize) {
    while (await captureActive()) {
      if (!paused) { paused = true; console.log('[thumbs] capture active; paused'); }
      await sleep(3000);
    }
    if (paused) { paused = false; console.log('[thumbs] capture idle; resuming'); }
    const batch = todo.slice(i, Math.min(i + batchSize, total)).filter((j) => !fs.existsSync(j.output));
    if (batch.length) {
      try { await run(batch); } catch (error) {
        if (!warned) { warned = true; console.warn(`[thumbs] failure (later ones counted silently): ${(error as Error).message} (python=${python})`); }
      }
      for (const job of batch) fs.existsSync(job.output) ? made++ : failed++;
    }
    done = Math.min(i + batchSize, total);
    if (done >= nextLog || done === total) {
      const rate = done / Math.max(1, (Date.now() - startedAt) / 1000);
      console.log(`[thumbs] ${done}/${total} (made ${made}, failed ${failed}, ${rate.toFixed(1)}/s, ~${Math.round((total - done) / Math.max(rate, 0.01) / 60)} min left)`);
      while (nextLog <= done) nextLog += 500;
    }
    await sleep(50); // yield CPU between batches
  }
  console.log(`[thumbs] done: made ${made}, failed ${failed}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
