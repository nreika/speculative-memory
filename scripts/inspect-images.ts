/**
 * Pre-publish inspection on arbitrary PNGs, no publishing (2026-10-19). Calls the SAME function production calls
 * for a legacy (no added reference cast) scene: server/generation/combinedInspection.inspectAndCaption(source, output,
 * expectedPeople, distanceSec, people, signal) - ONE Ollama /api/generate call per image (VLM_MODEL at OLLAMA_URL,
 * 45 s timeout). No detector pass, no retry, no archive write, no UDP/TD, no ComfyUI.
 *
 *   node_modules\.bin\tsx.cmd scripts\inspect-images.ts <generation-id> <A|B|C> <png> [<png> ...] [--plan]
 *
 * Inputs reconstructed from <data>\generations\<date>\<gid>\<gid>_prompts.json and <gid>_NOW.jpg:
 *   source frame = NOW.jpg; people = vlm.guard.people; expectedPeople = scene.peopleIntegrity.sourceCount (else people.length);
 *   distanceSec = scenes[letter].distanceSec.
 * Defaulted / not reconstructable: reference cast (inspectAndCaptionWithReferences) is not archived, so the legacy path is used;
 * behind-view scenes used the recent-person reference as source in production, here NOW.jpg is used (flagged in --plan).
 * Output: one JSON line per png and <png dir>\inspect-<gid>_<scene>.json.
 * --cpu-only: run ONLY the CPU checks, no VLM call, no file written: the hand detector (server/handCount ->
 * scripts/hand-count.py; count, limit 2 x expected people, CPU extra-hand verdict) and the framing check (server/frameAlign ->
 * scripts/frame-align.py, NOW.jpg vs png; scale/dx/dy/rotation/inliers/edge IoU, framing_drift verdict).
 * The full run reports the same framing metrics (observationFacts.framing) next to the VLM verdict.
 */
import fs from 'node:fs';
import path from 'node:path';
import '../server/loadEnv';
import { inspectAndCaption, cpuHandFacts, framingFacts } from '../server/generation/combinedInspection';
import { countHands } from '../server/handCount';
import { alignFrames } from '../server/frameAlign';
import { archiveRootDir } from '../server/archive/generationArchive';

const argv = process.argv.slice(2);
const plan = argv.includes('--plan');
const cpuOnly = argv.includes('--cpu-only');
const [gid, letterArg, ...pngs] = argv.filter((a) => !a.startsWith('--'));
if (!gid || !/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(gid) || !/^[ABCabc]$/.test(letterArg ?? '') || !pngs.length) {
  console.error('usage: tsx scripts/inspect-images.ts <generation-id> <A|B|C> <png> [<png> ...] [--plan] [--cpu-only]');
  process.exit(1);
}
const letter = letterArg.toUpperCase();
const dir = path.join(archiveRootDir(), gid.slice(0, 10), gid);
const meta = JSON.parse(fs.readFileSync(path.join(dir, `${gid}_prompts.json`), 'utf8'));
const scene = (meta.scenes ?? []).find((s: any) => s.letter === letter);
if (!scene) { console.error(`scene ${letter} not in prompts.json`); process.exit(1); }
const people = meta.vlm?.guard?.people ?? [];
const expected = Number.isInteger(scene.peopleIntegrity?.sourceCount) ? scene.peopleIntegrity.sourceCount : people.length;
const distance = scene.distanceSec;
const nowPath = path.join(dir, meta.sourceFile || `${gid}_NOW.jpg`);
const mime = (f: string) => (/\.jpe?g$/i.test(f) ? 'image/jpeg' : /\.webp$/i.test(f) ? 'image/webp' : 'image/png');
const dataUrl = (f: string) => `data:${mime(f)};base64,${fs.readFileSync(f).toString('base64')}`;

const resolved = {
  gid, scene: letter, sourceFrame: nowPath, expectedPeople: expected, distanceSec: distance, peopleCount: people.length,
  people: people.map((p: any) => ({ position: p.position, pose: p.pose, clothes: p.clothes, facing: p.facing, hair: p.hair })),
  referenceCast: 'none (not archived; legacy inspectAndCaption path)', behindView: scene.behindView === true,
  model: process.env.VLM_MODEL, endpoint: process.env.OLLAMA_URL || 'http://127.0.0.1:11434', files: pngs, calls: cpuOnly ? 0 : pngs.length,
};
if (scene.behindView === true) console.error('warning: behind-view scene; production used the recent-person reference as source, using NOW.jpg');
if (plan) { console.log(JSON.stringify(resolved, null, 1)); process.exit(0); }

(async () => {
  if (cpuOnly) {
    for (const file of pngs) {
      const [hands, frame] = await Promise.all([countHands(fs.readFileSync(file)), alignFrames(fs.readFileSync(nowPath), fs.readFileSync(file))]);
      const cpu = cpuHandFacts(hands, expected), framing = framingFacts(frame);
      const handVerdict = cpu.status !== 'detected' && cpu.status !== 'no-hands' ? cpu.status : cpu.count > cpu.limit ? 'rejected (extra_hand)' : 'accepted';
      const frameVerdict = framing.status !== 'aligned' && framing.status !== 'no-alignment' ? framing.status : framing.drift ? 'rejected (framing_drift)' : 'accepted';
      const cpuVerdict = [handVerdict, frameVerdict].find((v) => v.startsWith('rejected')) ?? (handVerdict === 'accepted' && frameVerdict === 'accepted' ? 'accepted' : `hands ${handVerdict}, framing ${frameVerdict}`);
      console.log(JSON.stringify({ file, cpuVerdict, handVerdict, frameVerdict, ...cpu, framing }));
    }
    return;
  }
  const source = dataUrl(nowPath);
  const results: any[] = [];
  for (const file of pngs) {
    let row: any;
    try {
      const r: any = await inspectAndCaption(source, dataUrl(file), expected, distance, people);
      const hands = (r.observationFacts?.people ?? []).map((p: any) => (typeof p.hands === 'number' ? p.hands : null));
      const handPositions = (r.observationFacts?.people ?? []).map((p: any) => p.handPositions ?? null);
      const regions = (r.observationFacts?.people ?? []).map((p: any) => [p.raisedHands ?? null, p.objectHands ?? null, p.otherHands ?? null]);
      const handsCounted = (r.observationFacts?.people ?? []).map((p: any) => p.handsCounted ?? p.hands ?? null);
      row = { file, verdict: r.ok === true ? 'accepted' : 'rejected', ok: r.ok, reason: r.reason, defect: r.defect ?? null, hands, handsCounted, regions, handPositions, cpuHands: r.observationFacts?.cpuHands ?? null, framing: r.observationFacts?.framing ?? null, peopleCount: hands.length, outputToSource: r.outputToSource };
    } catch (e: any) {
      row = { file, verdict: 'error', ok: null, reason: String(e?.message ?? e), defect: null, hands: [], peopleCount: 0 };
    }
    results.push(row);
    console.log(JSON.stringify(row));
  }
  const out = path.join(path.dirname(path.resolve(pngs[0])), `inspect-${gid}_${letter}.json`);
  fs.writeFileSync(out, JSON.stringify({ inputs: { ...resolved, people: undefined }, results }, null, 1));
  console.error('wrote ' + out);
})();
