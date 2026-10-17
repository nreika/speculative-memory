/**
 * Run the local QA judge on archived generations (images stay outside the repo).
 *   npx tsx scripts/qa-judge.ts <archive-dir-or-generationId> [A,B,C]
 * Prints the verdict and the seconds per image. Nothing is written.
 */
import fs from 'node:fs';
import path from 'node:path';
import '../server/loadEnv';
import { judgeImage } from '../server/qa/localJudge';
import { archiveRootDir } from '../server/archive/generationArchive';

const serverUrl = (process.env.SERVER_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
async function busy(): Promise<boolean> {
  try {
    return (await (await fetch(`${serverUrl}/api/qa?limit=1`, { signal: AbortSignal.timeout(3000) })).json()).idleWindow === false;
  } catch {
    return false;
  }
}
const arg = process.argv[2];
if (!arg) {
  console.error('usage: qa-judge.ts <archive-dir | generationId> [A,B,C]');
  process.exit(1);
}
const dir = fs.existsSync(arg) ? arg : path.join(archiveRootDir(), arg.slice(0, 10), arg);
const letters = (process.argv[3] ?? 'A,B,C').split(',');
const files = fs.readdirSync(dir);
const find = (re: RegExp) => files.find((f) => re.test(f));
const dataUrl = (f: string) => `data:image/${f.endsWith('.png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}`;
const nowFile = find(/_NOW\.(jpg|jpeg|png)$/i)!;
const prompts = JSON.parse(fs.readFileSync(path.join(dir, find(/_prompts\.json$/)!), 'utf8'));
for (const L of letters) {
  const f = find(new RegExp(`_${L}\\.png$`));
  const scene = prompts.scenes?.find((s: any) => s.letter === L);
  if (!f || !scene) continue;
  // Never during a capture (same rule as the server's QA): wait while one runs, abort and retry if one starts.
  let r = null as Awaited<ReturnType<typeof judgeImage>> | null;
  while (!r) {
    while (await busy()) await new Promise((res) => setTimeout(res, 2000));
    const ctl = new AbortController();
    const watch = setInterval(async () => {
      if (await busy()) ctl.abort();
    }, 1000);
    const x = await judgeImage({ nowImage: dataUrl(nowFile), image: dataUrl(f), predictionPrompt: scene.predictionPrompt }, { signal: ctl.signal });
    clearInterval(watch);
    if (!ctl.signal.aborted) r = x;
  }
  console.log(`${path.basename(dir)} ${L}: ok=${r.ok} score=${r.score} ${(r.elapsedMs / 1000).toFixed(1)}s ${r.error ?? ''}`);
  for (const d of r.defects) console.log(`   - ${d.type} @ ${d.where}: ${d.note}`);
}
