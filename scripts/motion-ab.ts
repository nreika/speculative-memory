/**
 * Motion A/B (2026-10-19): the OLD archived imagePromptFull vs the NEW prompt (fixed extras translation, hand use,
 * head/gaze rule, one object sentence, closing "Main change" line) for ONE archived scene, same source frame, same seed,
 * same negative prompt, same reference crops, through ONE engine for both sides. Test-only.
 *   --engine=turbo  (default when LOCAL_IMAGE_ENGINE=qwen21-turbo): turboCandidate.generateTurboProduction, the exact
 *                   library call orchestrator.generateImage makes in production (8 steps / cfg 1 / denoise 1, full-frame).
 *                   It spawns its own Turbo CPU worker (TURBO_CPU_PYTHON/TURBO_CPU_WORKER) in THIS process, uploads to the
 *                   ComfyUI at TURBO_CANDIDATE_URL (8001) and writes a run folder under TURBO_CANDIDATE_ARTIFACT_DIR.
 *   --engine=comfy  (old behaviour): comfyClient.generateQwenEdit on COMFYUI_URL (Qwen-Image-Edit, retired in production).
 *
 * Usage (from the repo root):
 *   node_modules\.bin\tsx.cmd scripts\motion-ab.ts <generation-id> <A|B|C>                 # dry run: print both prompts, no ComfyUI call
 *   node_modules\.bin\tsx.cmd scripts\motion-ab.ts <generation-id> <A|B|C> --run           # submit old and new to ComfyUI
 *   ... --engine=turbo|comfy                                              # image engine (default: production's)
 *   node_modules\.bin\tsx.cmd scripts\motion-ab.ts 2026-10-19_12-11-46 C --run --only=new  # one side only (old|new)
 *   ... --action="stays seated on the chair and looks down at the desk"   # English action to use instead of the built-in table
 *   ... --translate                                                       # ask the planner model (Ollama/VLM_URL) for the action instead
 *   ... --rulebook=19                                                     # rulebook version for the NEW prompt (default 19)
 *
 * What it does NOT do: no UDP/TD notification, no archive write, no /api/generate, no production setting change.
 * Output: C:\Users\nmrei\GitHub\speculative-memory_data\experiments\motion-ab\<gid>_<scene>_{old,new}.png plus
 * <gid>_<scene>_prompts.json (both prompts, seed, inputs). Like obstruct-ab.ts it waits until no capture is generating and
 * aborts the ComfyUI job when the next capture's planning has run for 20 s, so it never delays an exhibition capture.
 * With --engine=turbo the OLD side uses the same engine, inputs and seed as the archived scene PNG.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import '../server/loadEnv';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const value = (name: string) => flag(name)?.split('=').slice(1).join('=');
const [gid, letterArg] = argv.filter((a) => !a.startsWith('--'));
if (!gid || !/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(gid)) {
  console.error('usage: tsx scripts/motion-ab.ts <generation-id> <A|B|C> [--run] [--engine=turbo|comfy] [--only=old|new|variants|<variant>] [--variant=minimal,action-first,new-seed] [--action=...] [--translate] [--rulebook=19]');
  process.exit(1);
}
const letter = (letterArg ?? 'A').toUpperCase();
const run = !!flag('run');
const only = value('only');
const variantNames = argv.filter((a) => a.startsWith('--variant=')).flatMap((a) => a.slice('--variant='.length).split(',')).map((v) => v.trim()).filter(Boolean);
const BLOCK_VARIANTS = ['block1', 'block2', 'block3', 'block4', 'block5', 'block3a', 'block3b'];
for (const v of variantNames) if (!['minimal', 'action-first', 'new-seed', 'subject-fix', ...BLOCK_VARIANTS].includes(v)) throw new Error(`unknown --variant ${v} (minimal|action-first|new-seed|subject-fix|block1..block5|block3a|block3b)`);
const seedNames = (value('seeds') ?? 'orig').split(',').map((v) => v.trim()).filter(Boolean);
for (const v of seedNames) if (!['orig', 'plus1'].includes(v)) throw new Error(`unknown --seeds ${v} (orig|plus1)`);
const subjectFix = value('subject-fix');
if (subjectFix && !['left', 'right', 'center'].includes(subjectFix)) throw new Error('--subject-fix must be left|right|center');
if (variantNames.includes('subject-fix') && !subjectFix) throw new Error('variant subject-fix needs --subject-fix=left|right|center');
const rbVersion = Number(value('rulebook') ?? '19');
const engine = value('engine') ?? (process.env.LOCAL_IMAGE_ENGINE === 'qwen21-turbo' ? 'turbo' : 'comfy');
if (engine !== 'turbo' && engine !== 'comfy') throw new Error(`--engine must be turbo or comfy (got ${engine})`);

const { archiveRootDir } = await import('../server/archive/generationArchive');
const dir = path.join(archiveRootDir(), gid.slice(0, 10), gid);
const doc = JSON.parse(fs.readFileSync(path.join(dir, `${gid}_prompts.json`), 'utf8'));
const scene = doc.scenes.find((s: any) => s.letter === letter);
if (!scene) throw new Error(`scene ${letter} not found in ${gid}`);
const ja: string = scene.sceneExtra ?? '';
if (!ja) throw new Error(`scene ${letter} has no sceneExtra (operator instruction): nothing to A/B`);

// NEW prompt: rebuilt offline from the archived inputs, exactly like vlmClient's extras path + composeEditInstruction.
const rbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-ab-rb-'));
fs.copyFileSync(path.join(process.cwd(), 'rulebook', `rulebook.v${rbVersion}.json`), path.join(rbDir, `rulebook.v${rbVersion}.json`));
fs.writeFileSync(path.join(rbDir, 'active.json'), JSON.stringify({ version: rbVersion, appliedAt: 'motion-ab' }));
process.env.RULEBOOK_DIR = rbDir; // this process only; the production rulebook/active.json is untouched
const sx = await import('../server/generation/sceneExtras');
const oa = await import('../server/generation/operatorActionTranslation');
const fid = await import('../server/generation/fidelity');
const { composeEditInstruction } = await import('../server/generation/orchestrator');
const { translateActionPhrase } = await import('../server/generation/vlmClient');

/** Expected meaning-preserving translations of the 2026-10-19 test instructions (used when --action/--translate are absent). */
const KNOWN: Record<string, string> = {
  '椅子に座ったまま机を見る。': 'stays seated on the chair and looks down at the desk',
  '片手を軽く上げる。': 'raises one hand lightly',
  '机に片手を置く。': 'places one hand on the desk',
};
const people: import('../server/generation/peopleDescribe').PersonInfo[] = doc.vlm?.guard?.people ?? [];
const personCount = doc.vlm?.guard?.detector?.count ?? people.length;
const located = oa.operatorActorPosition(ja);
const positioned = located.position ? oa.personAtImagePosition(people, located.position) : undefined;
const poseActor = positioned ?? (people.length === 1 ? people[0] : undefined);
const translator = async (text: string, pose?: string) =>
  value('action') ?? (flag('translate') ? await translateActionPhrase(text, undefined, undefined, pose) : KNOWN[text] ?? null);
const resolved = await sx.resolveActionPhrase(located.actionText, translator, poseActor?.pose);
if (!resolved.en) throw new Error(`no English action for 「${located.actionText}」: pass --action="..." or --translate`);
const actionEn = oa.translatedOperatorAction(ja, resolved.en, located.position);
const base = located.position
  ? sx.buildExtraSentence(actionEn).replace('The person already in the photo', oa.positionedActorSubject(located.position, positioned?.clothes))
  : sx.buildExtraSentence(actionEn, people[0]?.clothes);
const actor = positioned ?? fid.uniqueActionPerson(base, people);
const newPrediction = sx.preserveActionConditions(ja, base, actor ? fid.occupiedHandSides(actor) : []);
const compact = /^Edit the existing (?:single person|\d+ people) in image1\./.test(scene.imagePromptFull);
const newPrompt = composeEditInstruction({
  predictionPrompt: newPrediction, people, personCount, compactPeople: compact,
  presence: doc.params?.presence, tone: doc.params?.tone, distanceSec: scene.distanceSec,
  behindView: scene.behindView || undefined, obstructed: doc.vlm?.guard?.obstructed === true,
});
const oldPrompt: string = scene.imagePromptFull;
fs.rmSync(rbDir, { recursive: true, force: true });

const out = path.join(path.dirname(archiveRootDir()), 'experiments', 'motion-ab');
const stem = `${gid}_${letter}`;

// ---- Engine inputs, reconstructed like server.ts + orchestrator.generateImage build them for this scene ----
const notes: string[] = [];
const nowFile = fs.readdirSync(dir).find((f) => /_NOW\.(jpg|jpeg|png)$/i.test(f));
if (!nowFile) throw new Error(`no _NOW frame in ${dir}`);
const nowBytes = fs.readFileSync(path.join(dir, nowFile));
const sceneImage = `data:image/${nowFile.endsWith('.png') ? 'png' : 'jpeg'};base64,${nowBytes.toString('base64')}`;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const archivedTurbo = scene.turboCandidate as { sourceSha256?: string; artifactDir?: string } | undefined;
if (archivedTurbo?.sourceSha256 && archivedTurbo.sourceSha256 !== sha(nowBytes)) notes.push(`WARNING: _NOW frame sha differs from the archived Turbo source (${archivedTurbo.sourceSha256.slice(0, 12)})`);
if (scene.behindView) notes.push('behindView scene: production used a recent-person capture as faceImage; not archived, rendered without it');
// server.ts: the normal person path sends the source frame once per visible head with headCropFor() crops (archived as
// identityReferenceCrops); orchestrator keeps at most 2 for comfy, all for Turbo.
type Crop = { x: number; y: number; width: number; height: number };
const allCrops: Crop[] = Array.isArray(scene.identityReferenceCrops) ? scene.identityReferenceCrops : [];
const crops = engine === 'turbo' ? allCrops : allCrops.slice(0, 2);
// Older archives with a single-person face crop (referenceCrop) and no head crops: faceImage = source frame + that crop.
const face: { faceImage?: string; faceCrop?: Crop } = !allCrops.length && scene.referenceCrop && !scene.behindView ? { faceImage: sceneImage, faceCrop: scene.referenceCrop } : {};
if (!allCrops.length && !scene.referenceCrop && scene.referenceImage === 'attached') notes.push('archive says a reference was attached but stores no crop: rendered without references');
const negativePrompt: string = scene.negativePrompt ?? '';
if (!negativePrompt) notes.push('no archived negativePrompt: empty negative used');
const seed: number = scene.seed;
if (!Number.isSafeInteger(seed)) throw new Error('scene has no archived seed');
const shared = {
  sceneImage, negativePrompt, seed, ...face,
  ...(crops.length ? { referenceImages: crops.map(() => sceneImage), referenceCrops: crops } : {}),
};
if (engine === 'turbo') notes.push('Turbo production always forces compositionMode=full-frame, so turboContext (sourceActors/protectedBoxes) and people detection are not render inputs; the server-side post-render people integrity check is not run here');
const summary: Record<string, unknown> = {
  engine: engine === 'turbo' ? 'qwen21-turbo (generateTurboProduction)' : 'qwen2511 (comfyClient.generateQwenEdit)',
  url: engine === 'turbo' ? (process.env.TURBO_CANDIDATE_URL || 'http://127.0.0.1:8001') : (process.env.COMFYUI_URL || 'http://127.0.0.1:8000'),
  archivedEngine: scene.localImageEngine ?? null,
  sceneImage: `${nowFile} (${nowBytes.length} B, sha ${sha(nowBytes).slice(0, 12)})`,
  seed, negativePromptChars: negativePrompt.length, referenceImages: crops.length, referenceCrops: crops,
  faceImage: face.faceImage ? 'source frame' : 'none', faceCrop: face.faceCrop ?? null,
  ...(engine === 'turbo' ? { steps: 8, cfg: 1, denoise: 1, compositionMode: 'full-frame' } : {}),
};
if (engine === 'turbo') {
  const { turboCandidateConfig, validateTurboImageInputs, buildTurboWorkflow } = await import('../server/generation/turboCandidate');
  const cfg = turboCandidateConfig(); // throws if the TURBO_* env is missing; no network
  validateTurboImageInputs({ ...shared, prompt: oldPrompt });
  Object.assign(summary, { cpuWorker: cfg.worker, artifactDir: cfg.artifactDir });
  // Offline check against the archived production workflow: everything except the prompt must match.
  const wfPath = archivedTurbo?.artifactDir ? path.join(archivedTurbo.artifactDir, 'workflow.json') : '';
  if (wfPath && fs.existsSync(wfPath)) {
    const archived = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
    const refs = [...(face.faceImage ? [{ name: `turbo_${sha(nowBytes)}.png`, crop: face.faceCrop }] : []), ...crops.map((c) => ({ name: `turbo_${sha(nowBytes)}.png`, crop: c }))];
    const rebuilt: Record<string, unknown> = buildTurboWorkflow({ ...shared, prompt: oldPrompt }, archived['4'].inputs.image, refs, seed, archived['11'].inputs.filename_prefix);
    const diff = [...new Set([...Object.keys(archived), ...Object.keys(rebuilt)])].filter((k) => JSON.stringify(archived[k]) !== JSON.stringify(rebuilt[k]));
    notes.push(`archived production workflow ${diff.length ? 'DIFFERS at nodes ' + diff.join(',') : 'matches the rebuilt OLD workflow node for node'} (${wfPath})`);
  } else notes.push('archived Turbo workflow.json not found: workflow equivalence not checked');
}
// ---- Variants (extra renders besides old/new); all share engine params, references, negative prompt and steps ----
const MAIN = 'Main change that must be clearly visible:';
const mainIdx = newPrompt.indexOf(MAIN);
if (variantNames.length && mainIdx < 0) throw new Error(`NEW prompt has no "${MAIN}" line: cannot derive the action sentence`);
const actionSentence = mainIdx < 0 ? '' : newPrompt.slice(mainIdx + MAIN.length).trim().split(String.fromCharCode(10))[0].trim();
const variants: Record<string, { prompt: string; seed: number }> = {};
// Constraint blocks of the NEW prompt: everything after the action sentence's first occurrence (up to the closing MAIN line),
// split into sentences and classified by text. Unmatched sentences go to block 5 and are reported.
const NL = String.fromCharCode(10);
const BLOCK_RULES: Array<[number, RegExp]> = [
  [0, /^Amount of change/i], // tone line: deliberately unclassified (goes to block 5, reported)
  [3, /^(?:The head and gaze|Preserve the original head direction|Their back remains|Their face)/i],
  [1, /^Hand use:/i],
  [2, /Exactly \d+ original|Each person has two arms|extra hand or arm|exactly two hands/i],
  [1, /^Original person \d|^Keep this individual|attached\.?$|^Image\d|Preserve the visible face|belonging|held object|original grip|clothes/i],
  [4, /^Only (?:alter|modify) existing objects|^Preserve unrelated objects|^Existing movable furniture|^Preserve each original object|foreground|obstruct|occlu|never add objects|never add new ones/i],
  [5, /exposure|lighting|white balance|^Keep the fixed camera|room architecture|camera/i],
];
const blockSentences: string[][] = [[], [], [], [], []];
const unclassified: string[] = [];
if (actionSentence) {
  const first = newPrompt.indexOf(actionSentence);
  const body = newPrompt.slice(first + actionSentence.length, mainIdx).trim();
  for (const sent of body.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean)) {
    const hit = BLOCK_RULES.find(([, re]) => re.test(sent));
    if (!hit || hit[0] === 0) unclassified.push(sent);
    blockSentences[(hit && hit[0] ? hit[0] : 5) - 1].push(sent);
  }
}
const minimalPrompt = `Edit image1. ${actionSentence} Keep the same people, clothes, room, camera, lighting and white balance.`;
function fixSubject(text: string): string {
  const to = subjectFix === 'center' ? 'in the center of the image' : `on the ${subjectFix} side of the image`;
  return text.split(actionSentence).join(actionSentence.replace(/(?:in the center of|on the (?:left|right) side of) the image/, to));
}
for (const v of variantNames) {
  if (v === 'minimal') variants[v] = { prompt: minimalPrompt, seed };
  else if (v === 'action-first') variants[v] = { prompt: `${MAIN} ${actionSentence}${NL}${newPrompt}`, seed };
  else if (v === 'new-seed') variants[v] = { prompt: newPrompt, seed: seed + 1 };
  else if (v === 'subject-fix') {
    for (const sn of seedNames) variants[sn === 'plus1' ? 'subject-fix@s1' : v] = { prompt: fixSubject(newPrompt), seed: sn === 'plus1' ? seed + 1 : seed };
  } else if (v === 'block3a' || v === 'block3b') {
    // block2 prompt + only a subset of block 3 (a: back/face-hidden sentences, b: head/gaze rule sentences), then the closing MAIN line.
    const re = v === 'block3a' ? /Their back remains|Their face/ : /The head and gaze|Preserve the original head direction/;
    const blocks = [...blockSentences.slice(0, 2).flat(), ...blockSentences[2].filter((x) => re.test(x))].join(' ');
    for (const sn of seedNames) variants[sn === 'plus1' ? `${v}@s1` : v] = { prompt: `${minimalPrompt} ${blocks}${NL}${MAIN} ${actionSentence}`, seed: sn === 'plus1' ? seed + 1 : seed };
  } else {
    const n = Number(v.slice(5));
    const blocks = blockSentences.slice(0, n).flat().join(' ');
    for (const sn of seedNames) variants[sn === 'plus1' ? `${v}@s1` : v] = { prompt: `${minimalPrompt} ${blocks}${NL}${MAIN} ${actionSentence}`, seed: sn === 'plus1' ? seed + 1 : seed };
  }
}
const sideSeeds: Record<string, { prompt: string; seed: number }> = {};
if (seedNames.includes('plus1')) { sideSeeds['old@s1'] = { prompt: oldPrompt, seed: seed + 1 }; sideSeeds['new@s1'] = { prompt: newPrompt, seed: seed + 1 }; }
const record = { gid, captureId: doc.captureId, letter, engine: summary.engine, engineParams: summary, notes, seed, sceneExtra: ja, action: resolved, oldPrediction: scene.predictionPrompt, newPrediction, rulebookNew: rbVersion, compact, oldPrompt, newPrompt, negativePrompt, ...(Object.keys(sideSeeds).length ? { sideSeeds: Object.fromEntries(Object.entries(sideSeeds).map(([k, v]) => [k, { seed: v.seed }])) } : {}), ...(variantNames.length ? { variants, blockSentences, unclassified } : {}) };
if (!run) {
  console.log(`--- OLD (${gid} ${letter}, seed ${seed}) ---\n${oldPrompt}\n\n--- NEW ---\n${newPrompt}\n`);
  if (variantNames.length) { blockSentences.forEach((b, i) => console.log(`[block ${i + 1}] ` + b.join(' | '))); console.log('[unclassified -> block 5] ' + (unclassified.join(' | ') || '(none)')); }
  for (const [n, v] of Object.entries(variants)) console.log(`--- VARIANT ${n} (seed ${v.seed}) ---${String.fromCharCode(10)}${v.prompt}${String.fromCharCode(10)}`);
  console.log(`PLANNED RENDERS: ${[['old', seed], ['new', seed], ...Object.entries(sideSeeds).map(([k, v]) => [k, v.seed]), ...Object.entries(variants).map(([k, v]) => [k, v.seed])].map(([k, v]) => `${k}(seed ${v})`).join(', ')}`);
  console.log(`--- engine params (identical for both sides except the prompt) ---\n${JSON.stringify(summary, null, 2)}`);
  for (const n of notes) console.log(`note: ${n}`);
  console.log(`\n(dry run: add --run to render through ${engine})`);
  process.exit(0);
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, `${stem}_prompts.json`), JSON.stringify(record, null, 2));

const serverUrl = (process.env.SERVER_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
async function captureState(): Promise<{ active: boolean; elapsedMs: number }> {
  try {
    const c: any = await (await fetch(`${serverUrl}/api/capture/status`, { signal: AbortSignal.timeout(3000) })).json();
    return { active: !!c.active, elapsedMs: c.active?.elapsedMs ?? 0 };
  } catch {
    return { active: false, elapsedMs: 0 };
  }
}

async function generate(side: string, prompt: string, signal: AbortSignal, useSeed: number = seed): Promise<Buffer> {
  const filenamePrefix = `SpecMem/motion-ab-${side.replace('@', '_')}`;
  if (engine === 'turbo') {
    // Same call orchestrator.generateImage makes for LOCAL_IMAGE_ENGINE=qwen21-turbo.
    const { generateTurboProduction } = await import('../server/generation/turboCandidate');
    return (await generateTurboProduction({ ...shared, seed: useSeed, prompt, steps: 8, cfg: 1, denoise: 1, filenamePrefix, signal })).buffer;
  }
  const { generateQwenEdit } = await import('../server/generation/comfyClient');
  return (await generateQwenEdit({ ...shared, seed: useSeed, prompt, filenamePrefix, signal })).buffer;
}

async function render(side: string, prompt: string, useSeed: number = seed): Promise<void> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    while ((await captureState()).active) await new Promise((r) => setTimeout(r, 1000));
    const ctl = new AbortController();
    const watch = setInterval(async () => {
      const s = await captureState();
      if (s.active && s.elapsedMs > 20_000) ctl.abort();
    }, 1000);
    const t0 = Date.now();
    try {
      const buffer = await generate(side, prompt, ctl.signal, useSeed);
      clearInterval(watch);
      const file = path.join(out, `${stem}_${side.replace('@', '_')}.png`);
      fs.writeFileSync(file, buffer);
      console.log(JSON.stringify({ side, engine, file, seed: useSeed, seconds: Math.round((Date.now() - t0) / 100) / 10, attempt }));
      return;
    } catch (e: any) {
      clearInterval(watch);
      console.log(`${side} attempt ${attempt}: aborted/failed after ${((Date.now() - t0) / 1000).toFixed(1)}s (${String(e?.message ?? e).slice(0, 80)}) - retry in the next gap`);
    }
  }
  throw new Error(`${side}: no free gap after 6 attempts`);
}

const onlyList = only ? only.split(',') : [];
const baseOf = (n: string) => n.replace(/@s1$/, '');
const wantBase = (n: 'old' | 'new') => (!only ? true : onlyList.includes(n));
if (wantBase('old')) await render('old', oldPrompt);
if (wantBase('new')) await render('new', newPrompt);
for (const [n, v] of Object.entries(sideSeeds)) if (wantBase(baseOf(n) as 'old' | 'new')) await render(n, v.prompt, v.seed);
for (const [n, v] of Object.entries(variants)) if (!only || onlyList.includes('variants') || onlyList.includes(n) || onlyList.includes(baseOf(n))) await render(n, v.prompt, v.seed);
process.exit(0);
