// Test-only: swap the planned action in the archived prompt of 2026-10-20_20-48-24 A and render via Turbo (GPU only).
import fs from 'node:fs';
import path from 'node:path';
import '../server/loadEnv';
const gid = '2026-10-20_20-48-24';
const { archiveRootDir } = await import('../server/archive/generationArchive');
const dir = path.join(archiveRootDir(), gid.slice(0, 10), gid);
const doc = JSON.parse(fs.readFileSync(path.join(dir, `${gid}_prompts.json`), 'utf8'));
const scene = doc.scenes.find((s: any) => s.letter === 'A');
const nowFile = fs.readdirSync(dir).find((f) => /_NOW\.(jpg|jpeg|png)$/i.test(f))!;
const nowBytes = fs.readFileSync(path.join(dir, nowFile));
const sceneImage = `data:image/jpeg;base64,${nowBytes.toString('base64')}`;
const crops = scene.identityReferenceCrops ?? [];
const shared = { sceneImage, negativePrompt: scene.negativePrompt, ...(crops.length ? { referenceImages: crops.map(() => sceneImage), referenceCrops: crops } : {}) };
const VARIANTS: Record<string, string | null> = {
  base: null,
  lid: 'stands up straight, lifts the green box lid high above their head with both hands',
  turn: 'turns their whole body to the right, away from the box, and steps toward the right edge of the frame',
  back: 'steps back from the box and stands upright with both arms raised',
  pick: 'picks the green box up off the stack and holds it against their chest',
};
const out = path.join(path.dirname(archiveRootDir()), 'experiments', 'motion-ab');
fs.mkdirSync(out, { recursive: true });
const { generateTurboProduction } = await import('../server/generation/turboCandidate');
const old: string = scene.imagePromptFull, plan: string = scene.predictionPrompt;
if (old.split(plan).length !== 3) throw new Error('plan sentence count mismatch ' + old.split(plan).length);
const rec: any = {};
for (const [name, act] of Object.entries(VARIANTS)) {
  const prompt = act ? old.split(plan).join(act) : old;
  for (const [sn, seed] of [['s0', scene.seed], ['s1', scene.seed + 1]] as const) {
    while ((await (await fetch('http://127.0.0.1:3000/api/capture/status')).json() as any).active) await new Promise((r) => setTimeout(r, 1000));
    const t0 = Date.now();
    const r = await generateTurboProduction({ ...shared, seed, prompt, steps: 8, cfg: 1, denoise: 1, filenamePrefix: `SpecMem/tone1-ab-${name}-${sn}` });
    fs.writeFileSync(path.join(out, `tone1ab_${name}_${sn}.png`), r.buffer);
    rec[`${name}_${sn}`] = { seed, action: act ?? plan, prompt };
    console.log(name, sn, ((Date.now() - t0) / 1000).toFixed(1) + 's');
  }
}
fs.writeFileSync(path.join(out, 'tone1ab_prompts.json'), JSON.stringify(rec, null, 2));
process.exit(0);
