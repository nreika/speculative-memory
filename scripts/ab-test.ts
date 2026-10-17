/**
 * Small A/B helper: scenarios + images + judge for given source photos.
 *   tsx scripts/ab-test.ts <label> <outDir> <source.jpg> [...]
 * Output goes to <outDir>/<label>/ (NOT captures/). Needs ComfyUI + Gemini key.
 * Env: AB_DISTANCES="a,b,c" (signed seconds for gen_a,gen_b,gen_c, -600..+600, e.g. "30,30,-30");
 *      AB_DISTANCE (s) = the old single distance N -> [+N,+N,-N] (ignored when AB_DISTANCES is valid);
 *      AB_PRESENCE (0..1), AB_TONE (0..1) set the other scene controls;
 *      AB_NO_IMAGES=1 stops after the scenario texts (no ComfyUI, no judge);
 *      AB_NO_JUDGE=1 skips the Gemini image judge (saves cost).
 */
import '../server/loadEnv';
import fs from 'fs';
import path from 'path';
import { predictScenarios, generateImage, clockForSignedDistance } from '../server/generation/orchestrator';
import { judgeImages } from '../server/qa/imageJudge';
import { normalizeSceneParams, describeSceneParams, resolveSceneDistances } from '../services/sceneParams';

const [label, outDir, ...sources] = process.argv.slice(2);
const dir = path.join(outDir, label);
const sceneParams = normalizeSceneParams({
  futureDistanceSec: process.env.AB_DISTANCE,
  sceneDistancesSec: process.env.AB_DISTANCES ? process.env.AB_DISTANCES.split(',').map((x) => x.trim()) : undefined,
  presence: process.env.AB_PRESENCE,
  tone: process.env.AB_TONE,
});
console.log(label, describeSceneParams(sceneParams));
const distances = resolveSceneDistances(sceneParams);
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const summary: any[] = [];
  for (const src of sources) {
    const base = path.basename(src, path.extname(src));
    const m = base.match(/(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)/);
    const sceneTime = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString() : new Date().toISOString();
    const dataUrl = 'data:image/jpeg;base64,' + fs.readFileSync(src).toString('base64');
    const scPath = path.join(dir, `${base}.scenarios.json`);
    const scenarios = fs.existsSync(scPath) ? JSON.parse(fs.readFileSync(scPath, 'utf8')) : await predictScenarios({ imageDataUrl: dataUrl, target: null, scenarioCount: 3, sceneTime, sceneParams, captureId: `ab-${label}` });
    fs.writeFileSync(path.join(dir, `${base}.scenarios.json`), JSON.stringify(scenarios, null, 2));
    if (process.env.AB_NO_IMAGES === '1') { console.log('scenarios only:', base); continue; }
    const imgs: { label: string; path: string; predictionPrompt: string }[] = [];
    for (let i = 0; i < scenarios.length; i++) {
      const s = scenarios[i];
      const p = path.join(dir, `${base}_gen_${'abc'[i]}.png`);
      if (!fs.existsSync(p)) {
      const out = await generateImage({
        originalImageDataUrl: dataUrl,
        predictionPrompt: s.prediction_prompt,
        filenamePrefix: `SpecMem/ab_${label}`,
        presence: sceneParams.presence,
        distanceSec: distances[i],
        clock: clockForSignedDistance(distances[i], sceneTime, s.clock_visible === true),
      });
      fs.writeFileSync(p, Buffer.from(out.split(',')[1], 'base64'));
      }
      imgs.push({ label: `gen_${'abc'[i]}`, path: p, predictionPrompt: s.prediction_prompt });
      console.log('saved', p);
    }
    let res: any = null;
    if (process.env.AB_NO_JUDGE === '1') continue;
    for (let t = 0; t < 3 && !res; t++) {
      try { res = await judgeImages(src, imgs, { captureId: `ab-${label}`, timeoutMs: 300_000 }); } catch (e) { console.error('judge retry', String(e)); }
    }
    if (!res) continue;
    summary.push({ source: src, scenarios: scenarios.map((s: any) => s.scenario_description), verdicts: res.verdicts.map((v: any, i: number) => ({ file: imgs[i]?.path, ...v })) });
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  }
  const all = summary.flatMap((s) => s.verdicts);
  console.log(`${label}: flagged(sev>=2) ${all.filter((v) => v.severity >= 2).length}/${all.length}`);
  for (const v of all) console.log(v.severity, path.basename(v.file ?? ''), v.reason);
})().catch((e) => { console.error(e); process.exit(1); });
