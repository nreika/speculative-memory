/**
 * Judge already archived generations with the local QA and append the rows to logs/qa-local.jsonl (flag backfill:true,
 * rulebookVersion 1 = the wording in force when they were made). Gives the improver a baseline before live QA rows exist.
 * Runs only while no capture is generating (polls GET /api/qa?limit=1) so it never slows a capture.
 *
 *   npx tsx scripts/qa-backfill.ts [--day 2026-10-16] [--captures 30] [--from-end] [--since 2026-10-16_12-00-00]
 */
import fs from 'node:fs';
import path from 'node:path';
import '../server/loadEnv';
import { archiveRootDir } from '../server/archive/generationArchive';
import { appendQaRow, judgeImage, readQaRows, type QaRow } from '../server/qa/localJudge';

const arg = (name: string, d?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const day = arg('day', new Date().toISOString().slice(0, 10))!;
const limit = Number(arg('captures', '30'));
const since = arg('since', '')!;
const serverUrl = (process.env.SERVER_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const qaFile = path.join(process.cwd(), 'logs', 'qa-local.jsonl');
const root = path.join(archiveRootDir(), day);

async function busy(): Promise<boolean> {
  try {
    const r = await fetch(`${serverUrl}/api/qa?limit=1`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return j.idleWindow === false;
  } catch {
    return false; // no server: nothing to disturb
  }
}
const dataUrl = (f: string) => `data:image/${f.endsWith('.png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(f).toString('base64')}`;

const done = new Set(readQaRows(qaFile).map((r) => `${r.captureId}|${r.sceneKey}`));
const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => d >= since).sort().reverse() : [];
let captures = 0;
let images = 0;
for (const gid of dirs) {
  if (captures >= limit) break;
  const dir = path.join(root, gid);
  const files = fs.readdirSync(dir);
  const promptsName = files.find((f) => f.endsWith('_prompts.json'));
  const nowName = files.find((f) => /_NOW\.(jpg|jpeg|png)$/i.test(f));
  if (!promptsName || !nowName) continue;
  const doc = JSON.parse(fs.readFileSync(path.join(dir, promptsName), 'utf8'));
  if (doc.status !== 'completed' || doc.source === 'test' || !Array.isArray(doc.scenes) || doc.scenes.length === 0) continue;
  captures += 1;
  for (const scene of doc.scenes) {
    if (done.has(`${doc.captureId}|${scene.sceneKey}`)) continue;
    const img = files.find((f) => f === `${gid}_${scene.letter}.png`);
    if (!img) continue;
    // Same rule as the live QA: never run while a capture generates; a capture that starts aborts the running call.
    let result = null as Awaited<ReturnType<typeof judgeImage>> | null;
    while (!result) {
      while (await busy()) await new Promise((r) => setTimeout(r, 2000));
      const ctl = new AbortController();
      const watch = setInterval(async () => {
        if (await busy()) ctl.abort();
      }, 1000);
      const r = await judgeImage({ nowImage: dataUrl(path.join(dir, nowName)), image: dataUrl(path.join(dir, img)), predictionPrompt: scene.predictionPrompt ?? '' }, { signal: ctl.signal });
      clearInterval(watch);
      if (!ctl.signal.aborted) result = r;
    }
    const row: QaRow & { backfill: boolean } = {
      time: doc.capturedAt && !Number.isNaN(Date.parse(doc.capturedAt)) ? new Date(doc.capturedAt).toISOString() : new Date().toISOString(),
      captureId: doc.captureId,
      sceneKey: scene.sceneKey,
      file: img,
      ...result,
      rulebookVersion: 1,
      backfill: true,
    };
    appendQaRow(qaFile, row);
    images += 1;
    console.log(`${gid} ${scene.letter}: ${row.ok === null ? 'unknown ' + row.error : row.ok ? 'ok' : row.defects.map((d) => d.type).join(',')} ${(row.elapsedMs / 1000).toFixed(1)}s`);
  }
}
console.log(`done: ${captures} captures, ${images} images judged`);
