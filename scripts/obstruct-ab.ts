/**
 * Experiment (2026-10-17): how to keep things behind an obstruction (mesh chair back) behind it. One image per call.
 *   npx tsx scripts/obstruct-ab.ts <a|b|c|d> [archive-id=2026-10-17_12-54-52] [scene=B] [denoise=0.6]
 *   a = current prompt (production settings), b = non-Lightning 20 steps cfg 2.5 (the negative prompt is active),
 *   c = production settings + a "mesh is the frontmost layer" sentence first, d = production settings + lower denoise.
 * Same source frame, same recorded prompt/negative, fixed seed (the recorded one). Production settings are NOT changed.
 * Runs only when no capture is generating and aborts the ComfyUI job when the next capture's planning has gone on for 20 s
 * (ComfyUI is idle then), so it never delays a capture's images. Output goes to the data folder (not the repo).
 */
import fs from 'node:fs';
import path from 'node:path';
import '../server/loadEnv';

const variant = (process.argv[2] ?? 'a').toLowerCase();
const gid = process.argv[3] ?? '2026-10-17_12-54-52';
const letter = process.argv[4] ?? 'B';
const denoise = Number(process.argv[5] ?? '0.6');
if (variant === 'b') process.env.COMFYUI_LIGHTNING = 'false';
const { generateQwenEdit } = await import('../server/generation/comfyClient');
const { archiveRootDir } = await import('../server/archive/generationArchive');

const dir = path.join(archiveRootDir(), gid.slice(0, 10), gid);
const doc = JSON.parse(fs.readFileSync(path.join(dir, `${gid}_prompts.json`), 'utf8'));
const scene = doc.scenes.find((s: any) => s.letter === letter);
const nowFile = fs.readdirSync(dir).find((f) => /_NOW\.(jpg|jpeg|png)$/i.test(f))!;
const sceneImage = `data:image/${nowFile.endsWith('.png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(path.join(dir, nowFile)).toString('base64')}`;
const FRONT =
  'The mesh chair backrest is the frontmost layer of the whole image; everything seen through the mesh stays dim, blurred and partially hidden by the mesh pattern, exactly as in the input.';
const prompt = variant === 'c' ? `${FRONT}\n\n${scene.imagePromptFull}` : scene.imagePromptFull;

const serverUrl = (process.env.SERVER_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
async function state(): Promise<{ idle: boolean; est: number | null; active: boolean; elapsedMs: number }> {
  try {
    const q: any = await (await fetch(`${serverUrl}/api/qa?limit=1`, { signal: AbortSignal.timeout(3000) })).json();
    const c: any = await (await fetch(`${serverUrl}/api/capture/status`, { signal: AbortSignal.timeout(3000) })).json();
    return { idle: q.idleWindow === true, est: q.nextCaptureEstimate ? Date.parse(q.nextCaptureEstimate) : null, active: !!c.active, elapsedMs: c.active?.elapsedMs ?? 0 };
  } catch {
    return { idle: true, est: null, active: false, elapsedMs: 0 };
  }
}

const out = path.join(path.dirname(archiveRootDir()), 'experiments', 'obstruct-ab');
fs.mkdirSync(out, { recursive: true });
for (let attempt = 1; attempt <= 6; attempt++) {
  // wait for the gap right after a capture finished (nothing generating, ComfyUI free)
  for (;;) {
    const s = await state();
    if (!s.active) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const ctl = new AbortController();
  const watch = setInterval(async () => {
    const s = await state();
    if (s.active && s.elapsedMs > 20_000) ctl.abort(); // the next capture's images would queue behind us
  }, 1000);
  const t0 = Date.now();
  try {
    const r = await generateQwenEdit({
      sceneImage,
      prompt,
      negativePrompt: scene.negativePrompt,
      seed: scene.seed,
      denoise: variant === 'd' ? denoise : undefined,
      filenamePrefix: `SpecMem/obstruct-ab-${variant}`,
      signal: ctl.signal,
    });
    clearInterval(watch);
    const secs = (Date.now() - t0) / 1000;
    const m = /^data:image\/(\w+);base64,(.+)$/.exec(r.dataUrl)!;
    const file = path.join(out, `obstruct-ab-${variant}${variant === 'd' ? `-${denoise}` : ''}_${gid}_${letter}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    console.log(JSON.stringify({ variant, file, seconds: Math.round(secs * 10) / 10, attempt }));
    process.exit(0);
  } catch (e: any) {
    clearInterval(watch);
    console.log(`attempt ${attempt}: aborted/failed after ${((Date.now() - t0) / 1000).toFixed(1)}s (${String(e?.message ?? e).slice(0, 80)}) - retry in the next gap`);
  }
}
process.exit(2);
