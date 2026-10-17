/**
 * Local VLM scenario planner via Ollama.
 * Replaces the Gemini "predictFutureScenarios" text step.
 */
import { parseClockVisible, type ScenarioResult } from "../../services/promptBuilder";
import { withEnglishSpan, withJapaneseSpan } from "./spanFix";
import { groundTruthNote, hasBigArmMotion, isWeakScenario, mentionsSeveralPeople, modestMotion, recentPersonPhrase, spanPhrase, synthesizeEmptyRoom, synthesizeScenarios, type PersonInfo } from "./peopleDescribe";
import { extractObjects } from "./scenarioGuard";
import { guardRetries, timeBudgetMs, withVlmExtras } from "./rulebook";
import { findFabricatedObjects, objectReminder } from "./objectGuard";
import { buildExtraSentence, buildSceneExtrasNote, lookupAction, SCENE_KEYS, serverExtraDescription, type SceneExtras } from "./sceneExtras";
import {
  applySafeFallback,
  occupancySourceOf,
  findDuplicateScenarios,
  findFabricatedScenarios,
  isUnoccupied,
  sceneWithoutPeople,
  type GuardRecord,
} from "./scenarioGuard";

/** Model stays loaded between the calls of one VLM phase (describe, plan, judge...); the final translation call unloads it. */
const PHASE_KEEP_ALIVE = process.env.VLM_PHASE_KEEP_ALIVE ?? "2m";
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const VLM_MODEL = process.env.VLM_MODEL || "gemma3:latest";
const VLM_TIMEOUT_MS = Number(process.env.VLM_TIMEOUT_MS || "120000");

const DATA_URL_PATTERN = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/;

function toBareBase64(imageDataUrl: string): string {
  const match = imageDataUrl.match(DATA_URL_PATTERN);
  if (!match) throw new Error("vlmClient: unsupported image data URL");
  return match[1];
}

/**
 * The shared prompt asks for a Japanese scenario_description; the 4B local VLM then also writes
 * prediction_prompt in Japanese. Plan in English only and translate for display afterwards.
 */
export function stripJapaneseDescriptionRule(prompt: string): string {
  return prompt.replace(/Write scenario_description in Japanese[^\n]*?always keep that exact time phrase\.?/g, "");
}

const JSON_INSTRUCTION =
  "\n\nFIRST decide who is visible and write scene_description. IF NO PERSON is visible in this frame (the room is empty), " +
  "NO scenario may mention any person, people, hands, arms, he, she or they: there is nobody, so describe only changes of objects that are already visible " +
  "(ONLY environmental changes: light or shadow changing, a curtain swaying, a screen's content changing, lamps turning on or off; NEVER moving, rotating, opening, taking out or putting away any object, because nobody is there to do it). Write only affirmative changes of objects or light there (never sentences such as 'Nobody enters' or 'no one is present'). This overrides every example below that mentions people. " +
  "Each prediction_prompt MUST be a short image-EDIT instruction (max 2 sentences) that " +
  "describes ONLY what changes from the given frame — the new actions, poses and positions of the people who are visible (only if any), " +
  "and nearby object states. Do NOT re-describe the room, camera, lighting or the " +
  "people's appearance; those stay identical. Base every change on what is actually visible in " +
  "this frame (no curtains, windows or objects that are not present). " +
  "If, and only if, a person is visible: for every person whose arms or hands move, state the FINAL position of BOTH arms/hands " +
  '(e.g. "his right hand leaves the keyboard and picks up the paper on the right while his left hand stays on the keyboard"); ' +
  'describe the resulting pose, never an action added on top of the current pose (no bare "also reaches"). ' +
  "Follow the per-scenario direction and time span, and the People and Tone instructions given above (how far before or after this frame each scenario is, how much people appear or move, how calm or dramatic); a new person may enter only when the People instruction allows it, always from a frame edge or door and never in the middle of the scene. In an empty room nobody enters unless the People instruction allows it. " +
  "Never change anyone's hairstyle, hair length or hair colour. " +
  "Never write large arm motions (raising both hands or arms overhead, stretching, waving, banzai) unless an operator MAIN EVENT asks for it; only small posture changes, sitting down or standing up, walking and turning are allowed. " +
  "Do not add new objects and do not relocate small loose items (bags, papers, cups); prefer changes in place (a chair rotated, a monitor off); a dark monitor stays dark. If an object must move, say it is moved FROM its original spot TO the new one and the original spot becomes empty. " +
  "If a person is visible, every person keeps exactly two arms and two hands, and nobody is ever duplicated.\n" +
  'Return ONLY a JSON object of the form ' +
  '{"clock_visible":false,"scene_description":"...","scenarios":[{"prediction_prompt":"...","scenario_description":"...","label":"..."}]}. ' +
  '"clock_visible" is a boolean: true ONLY if a clock, a digital time readout, or a physical ' +
  "number/flip sign showing a time is clearly visible in this frame; false if there is none or " +
  "you are unsure. Do not guess true. " +
  '"scene_description" is a plain English description (1-2 short sentences, max about 100 characters) of what is visible in this frame right now; describe only what is seen, no predictions. ' +
  "Also return a top-level string field foreground_object (next to scene_description): the object that is very close to the camera and large in the frame, described with its REAL size and distance, " +
  "e.g. 'the backrest of an ordinary office chair about 50 cm wide, right in front of the camera'; use an empty string when there is none. " +
  "Likewise, in scene_description describe any such near-camera object by its real-world size, not as a big structure. " +
  "LANGUAGE: write EVERY text field (prediction_prompt, scenario_description, scene_description) in English only. Begin each scenario_description with its time span in English (e.g. \"30 seconds later,\" or \"2 minutes 30 seconds before,\"). The Japanese version is produced in a separate step. " +
  "No markdown, no commentary.";

// Context and output budget. The prompt+image is ~2.9k tokens; num_ctx must hold it plus the output.
const VLM_NUM_CTX = Number(process.env.VLM_NUM_CTX || "8192");
const VLM_NUM_PREDICT = Number(process.env.VLM_NUM_PREDICT || "2048");

interface OllamaGenerateResponse {
  response?: string;
  thinking?: string;
  done_reason?: string;
  eval_count?: number;
  prompt_eval_count?: number;
  error?: string;
}

/** The exact /api/generate body used for scenario planning (exported for diagnostics scripts). */
export function buildPlanRequestBody(prompt: string, imageDataUrl: string) {
  return {
    model: VLM_MODEL,
    prompt: stripJapaneseDescriptionRule(prompt) + withVlmExtras(JSON_INSTRUCTION),
    images: [toBareBase64(imageDataUrl)],
    stream: false,
    // Keep the limited output budget for the scenario JSON. Qwen3-VL can
    // otherwise exhaust num_predict on thinking and return no response text.
    think: false,
    format: "json",
    // Release the VLM from VRAM right after planning so ComfyUI/Qwen gets the
    // full GPU for the image step (they don't fit at the same time on 24 GB).
    keep_alive: PHASE_KEEP_ALIVE,
    options: { temperature: 0.9, num_predict: VLM_NUM_PREDICT, num_ctx: VLM_NUM_CTX } as Record<string, number>,
  };
}

/**
 * Replaceable model behind the planner (default: Ollama). The Gemini path injects its own so the
 * guard, people facts, history, extras and Japanese display text run identically for both.
 */
export interface PlannerLlm {
  model: string;
  /** One planner call with the source frame; returns the raw JSON text. */
  plan(prompt: string, imageDataUrl: string, signal?: AbortSignal): Promise<string>;
  /** Short text-only call (extras translation, judge, Japanese display text); returns the raw text. */
  text(prompt: string, signal?: AbortSignal): Promise<string>;
}

/** Filled by planScenariosLocal when passed as `trace`. */
export interface PlanTrace {
  promptFull?: string | null;
  rawResponse?: string | null;
  model?: string;
  /** Fabricated-person guard outcome (see scenarioGuard.ts). */
  guard?: GuardRecord;
}

/** Retries after a scenario set invents people in an empty room: rulebook guard.guardRetries (env VLM_GUARD_RETRIES overrides). */
/** Planning phase: at most this many planner calls and this much wall time before retries stop (then last resort). */
// Empty room: ONE planner call (then server-side templates); people present: at most 2 calls within the budget.
// Time budget: rulebook guard.timeBudgetMs (env VLM_TIME_BUDGET_MS overrides).
const NO_PEOPLE_REMINDER =
  "\n\nREMINDER: the frame description shows NO person. Write every scenario about objects, light or screens only; " +
  "do not write person, people, he, she, they, hand or arm.";

export async function planScenariosLocal(args: {
  imageDataUrl: string;
  prompt: string;
  scenarioCount: number;
  /** Optional out-param: receives the full prompt sent and the raw model response (for the archive). */
  trace?: PlanTrace;
  /** Aborting closes the request, which makes Ollama stop generating. */
  signal?: AbortSignal;
  /** A person was seen recently (RECENT_PERSON_WINDOW_MIN): people in scenarios are not treated as invented. */
  allowPerson?: boolean;
  /** Person detector verdict on the source frame (server/presence/personDetect.ts); true = occupied regardless of the text. */
  detector?: { person: boolean | null; count?: number; elapsedMs: number; doneReason?: string; raw?: string };
  /** People described by the short image call (detector said person=true). */
  people?: PersonInfo[];
  /** Signed seconds per scene (for synthesized scenarios). */
  sceneDistances?: number[];
  /** Cap on planner calls (default: 2 when people are present, else 1). */
  maxAttempts?: number;
  /** TD sceneExtras: each is checked after planning; one retry with a stronger instruction when not reflected. */
  sceneExtras?: SceneExtras;
  /** Model to call instead of Ollama (Gemini path). */
  llm?: PlannerLlm;
}): Promise<ScenarioResult[]> {
  const body = buildPlanRequestBody(args.prompt, args.imageDataUrl);
  if (args.people && args.people.length > 0) {
    body.prompt = groundTruthNote(args.people, args.detector?.count) + "\n\n" + body.prompt;
  }
  const planStarted = Date.now();
  let planCalls = 0;
  const MAX_PLAN_ATTEMPTS = Math.max(
    1,
    args.maxAttempts ?? (process.env.VLM_MAX_PLAN_ATTEMPTS ? Number(process.env.VLM_MAX_PLAN_ATTEMPTS) : args.people && args.people.length > 0 ? 2 : 1)
  );
  const canRetry = () => planCalls < MAX_PLAN_ATTEMPTS && Date.now() - planStarted < timeBudgetMs();
  if (args.trace) {
    args.trace.promptFull = body.prompt;
    args.trace.model = args.llm?.model ?? body.model;
  }

  let lastCount = 0;
  let parseFailures = 0;
  let duplicateRetried = false;
  let detectorRetried = false;
  let objectRetried = false;
  let armRetried = false;
  const detectedPerson = args.detector?.person === true;
  const allow = args.allowPerson === true || detectedPerson;
  // The short detector call is more reliable than the long planner: when it says nobody is there, a person named in
  // scene_description is a hallucination (the planner then 'sees' people and edits objects around them).
  // The detector + describe call is authoritative when it says nobody (people = 0): a person named in scene_description alone
  // never makes the frame occupied (the 4B planner invents people in empty frames; this drew people into an empty room).
  // Occupied = the detector/describe call found a person. Recent-person drawing needs a past detector hit (allowPerson).
  const detectorEmpty = args.detector?.person === false;
  const sceneEmpty = (text: string) => detectorEmpty || isUnoccupied(text);
  const detectorDisagrees = (text: string) => args.detector?.person === false && !isUnoccupied(text);
  let armsRaisedIdx: number[] = [];
  // sceneExtras are NOT left to the planner: each is rewritten into one concrete English sentence about the
  // person already in the photo (short image call) and the scene is written by the server (no judge call).
  const extrasEnglish: SceneExtras = {};
  const extrasResolved: Record<string, string> = {};
  const extrasJa: Record<string, string> = {};
  const extrasStatusMap: Record<string, string> = {};
  let extrasState: Record<string, { reflected: boolean; retried: boolean; synthesized?: boolean; source?: "server"; text?: string; english?: string }> | undefined;
  const extrasOverrides = new Map<number, string>();
  if (args.sceneExtras && args.detector?.person === false) {
    // Detector says nobody: the planner is not told the person-actions (G-03). They stay resolved below in case the planner's text names a person.
    body.prompt = body.prompt.replace(buildSceneExtrasNote(args.sceneExtras), "");
  }
  if (args.sceneExtras) {
    // Detector empty: extras that need a person are off, also when a recent person is drawn (from behind, modest motion).
    // Always resolved: the detector can miss people (truncated JSON, cut-off persons); whether an extra is applied is decided
    // after planning from the detector OR the planner's text (applyServerExtras).
    for (const key of SCENE_KEYS) {
      const ja = args.sceneExtras[key];
      if (!ja) continue;
      // Action: dictionary first, else a pure text translation (no image: the model would describe the current pose).
      const hit = lookupAction(ja);
      let actionEn = hit?.en ?? (await translateActionPhrase(ja, args.signal, args.llm));
      if (!actionEn) actionEn = `performs: ${ja}`;
      extrasJa[key] = hit?.ja ?? ja;
      const sentence = buildExtraSentence(actionEn, args.people?.[0]?.clothes);
      extrasResolved[key] = sentence;
      extrasEnglish[key] = sentence;
      console.error(`[extras] ${key}: "${ja}" -> ${sentence}`);
    }
    const note = buildSceneExtrasNote(args.sceneExtras, false, extrasEnglish);
    if (note && Object.keys(extrasEnglish).length > 0) {
      body.prompt = body.prompt.replace(buildSceneExtrasNote(args.sceneExtras), note);
    }
  }
  /** Replace every extra's scene by the server-written one (only where a person really is in the frame). */
  const applyServerExtras = (list: ScenarioResult[], personThere: boolean): ScenarioResult[] => {
    if (Object.keys(extrasResolved).length === 0) return list;
    if (!personThere) {
      for (const key of Object.keys(extrasResolved)) {
        extrasStatusMap[key] = "ignored: frame empty";
        console.error(`[extras] ${key}: ignored: frame empty${args.allowPerson === true ? " (recent person drawn from behind)" : ""}`);
      }
      return list;
    }
    const dists = args.sceneDistances ?? [30, 30, -30];
    const st: NonNullable<typeof extrasState> = {};
    const out = list.map((s, i) => {
      const key = SCENE_KEYS[i];
      const en = key ? extrasResolved[key] : undefined;
      const text = key ? args.sceneExtras?.[key] : undefined;
      if (!key || !en || !text) return s;
      const ja = serverExtraDescription(dists[i] ?? 30, extrasJa[key] ?? text, args.people?.[0]?.clothes);
      extrasOverrides.set(i, ja);
      st[key] = { reflected: true, retried: false, synthesized: true, source: "server", text, english: en };
      // English here: the normal translation step makes the display text from the concrete sentence.
      return { ...s, prediction_prompt: en, scenario_description: `${spanPhrase(dists[i] ?? 30)} ${en.charAt(0).toLowerCase()}${en.slice(1)}` };
    });
    extrasState = st;
    return out;
  };
  const finishWith = async (list: ScenarioResult[]): Promise<ScenarioResult[]> => {
    // The leading time span comes from each scene's signed distance, not from the model (before and after translation).
    const spanDists = args.sceneDistances ?? [30, 30, -30];
    const spanned = list.map((x, i) => ({ ...x, scenario_description: withEnglishSpan(x.scenario_description, spanDists[i] ?? 30) }));
    const out = (await translateDisplayTextToJapanese(spanned, args.signal, args.llm)).map((x, i) => ({
      ...x,
      scenario_description: withJapaneseSpan(x.scenario_description, spanDists[i] ?? 30),
    }));
    // Recent person drawn into an empty frame: the display text always names the subject ("人物は…").
    if (args.allowPerson === true && !detectedPerson) {
      out.forEach((x, i) => {
        // only where the sentence's subject is the person (never on an environment sentence such as "the box is pushed...")
        if (!/^the person\b/i.test(list[i]?.prediction_prompt ?? "")) return;
        const m = x.scenario_description.match(/^((?:[0-9０-９]+分)?[0-9０-９]+秒[後前]、)(.*)$/);
        if (m && !/人|男|女|彼|誰/.test(m[2])) out[i] = { ...x, scenario_description: `${m[1]}人物は${m[2]}` };
      });
    }
    // Extras scenes: the display sentence is a server template (no translation).
    extrasOverrides.forEach((ja, i) => {
      if (out[i]) out[i] = { ...out[i], scenario_description: ja };
    });
    return out;
  };
  const fabricatedPerAttempt: number[][] = [];
  let lastGood: ScenarioResult[] | null = null;
  for (let attempt = 0; attempt < MAX_PLAN_ATTEMPTS; attempt += 1) {
    planCalls += 1;
    if (fabricatedPerAttempt.length > 0) body.prompt = body.prompt.replace(NO_PEOPLE_REMINDER, "") + NO_PEOPLE_REMINDER;
    let json: OllamaGenerateResponse;
    if (args.llm) {
      json = { response: await args.llm.plan(body.prompt, args.imageDataUrl, args.signal), done_reason: "stop" };
    } else {
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: args.signal
          ? AbortSignal.any([args.signal, AbortSignal.timeout(VLM_TIMEOUT_MS)])
          : AbortSignal.timeout(VLM_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`vlmClient: Ollama ${res.status} ${await res.text()}`);
      }
      json = (await res.json()) as OllamaGenerateResponse;
      if (json.error) throw new Error(`vlmClient: Ollama error — ${json.error}`);
    }

    if (args.trace) args.trace.rawResponse = json.response || "";
    const scenarios = parseScenarios(json.response || "");
    lastCount = scenarios.length;
    if (scenarios.length < args.scenarioCount) {
      // Never go dark: say why the output was unusable (empty response + long thinking = think:false ignored).
      console.error(
        `vlmClient: attempt ${attempt + 1} parsed ${scenarios.length}/${args.scenarioCount} ` +
          `done_reason=${json.done_reason} prompt_eval=${json.prompt_eval_count} eval=${json.eval_count} ` +
          `response_len=${(json.response || "").length} thinking_len=${(json.thinking || "").length}
` +
          `  response: ${(json.response || "").slice(0, 500)}
` +
          (json.thinking ? `  thinking: ${json.thinking.slice(0, 500)}
` : "")
      );
    }
    if (scenarios.length >= args.scenarioCount) {
      const picked = scenarios.slice(0, args.scenarioCount);
      const scene = picked[0]?.scene_now ?? "";
      const bad = findFabricatedScenarios(scene, picked, allow, detectorEmpty);
      fabricatedPerAttempt.push(bad);
      if (detectedPerson && isUnoccupied(scene) && !detectorRetried && canRetry() && !(args.people && args.people.length > 0)) {
        detectorRetried = true;
        lastGood = picked;
        console.error('[guard] detector found a person but scene_description names none -> retry once');
        body.prompt = body.prompt + "\n\nA person detector found at least one person in this frame: describe them (position, pose, clothes) in scene_description and base the scenarios on them.";
        continue;
      }
      lastGood = picked;
      if (bad.length > 0 && fabricatedPerAttempt.length <= guardRetries() && canRetry()) {
        console.error(
          `[guard] attempt ${attempt + 1}: person invented in empty room (scene="${scene.slice(0, 120)}") ` +
            `scenarios ${bad.map((i) => i + 1).join(",")} -> retry ${fabricatedPerAttempt.length}/${guardRetries()}`
        );
        continue;
      }
      // Large arm motions are not chosen by the planner (only operator extras may ask for them): word match plus a short
      // semantic check per scene (no image, no retry: time), then replaced by a modest motion.
      const armIdx: number[] = [];
      const personish = !sceneEmpty(scene) || allow || detectedPerson;
      const extrasWillApply = detectedPerson || !sceneEmpty(scene);
      await Promise.all(
        picked.map(async (sc, i) => {
          const key = SCENE_KEYS[i];
          if (key && extrasResolved[key] && extrasWillApply) return;
          if (hasBigArmMotion(sc.prediction_prompt)) {
            armIdx.push(i);
            return;
          }
          // Only scenes that talk about arms/hands/reaching/lifting get the (1-2 s) semantic check: time budget.
          if (personish && ARM_WORDS_RE.test(sc.prediction_prompt) && (await judgeArmsRaised(sc.prediction_prompt, args.signal, args.llm))) armIdx.push(i);
        })
      );
      armIdx.sort((x, y) => x - y);
      armsRaisedIdx = armIdx;
      // Objects the frame does not contain (a jacket pulled from a chair that is not there): one re-ask, then replaced.
      const peopleText = (args.people ?? []).map((p) => `${p.pose} ${p.position} ${p.clothes}`).join(" ");
      const objFab = bad.length === 0 ? findFabricatedObjects(`${scene} ${peopleText}`, picked) : [];
      if (objFab.length > 0 && !objectRetried && canRetry()) {
        objectRetried = true;
        const words = Array.from(new Set(objFab.flatMap((f) => f.words)));
        console.error(`[guard] fabricated objects in scenarios ${objFab.map((f) => `${f.index + 1}:${f.words.join("/")}`).join(", ")} -> retry once`);
        body.prompt = body.prompt + objectReminder(scene, words);
        continue;
      }
      // Repeated scenarios: one re-ask; if still repeated in an empty room, vary with scene-object templates.
      const dups = bad.length === 0 ? findDuplicateScenarios(picked) : [];
      if (dups.length > 0 && !duplicateRetried && canRetry()) {
        duplicateRetried = true;
        console.error(`[guard] duplicate: scenarios ${dups.map((i) => i + 1).join(",")} repeat an earlier one -> retry once`);
        continue;
      }
      const emptyRoom = sceneEmpty(scene) && !allow;
      const dupReplaced = dups.length > 0 && emptyRoom ? dups : [];
      if (dups.length > 0) {
        console.error(
          `[guard] duplicate: still repeated after retry (${dups.map((i) => i + 1).join(",")}); ` +
            (dupReplaced.length ? "replaced with scene-object variations" : "kept (room not empty)")
        );
      }
      // Empty room, single planner call: weak answers ("No change.") are replaced by server templates too.
      const weak: number[] = [];
      if (emptyRoom && !detectedPerson) {
        picked.forEach((s, i) => {
          if (isWeakScenario(s.prediction_prompt) && !bad.includes(i) && !dupReplaced.includes(i)) weak.push(i);
        });
        for (const f of objFab) if (!bad.includes(f.index) && !dupReplaced.includes(f.index) && !weak.includes(f.index)) weak.push(f.index);
        if (objFab.length > 0) console.error(`[guard] fabricated objects still present after retry: replaced by environmental templates (${objFab.map((f) => f.words.join('/')).join(', ')})`);
      }
      let final = applySafeFallback(picked, [...bad, ...dupReplaced, ...weak]);
      if (weak.length > 0) {
        const synthEmpty = synthesizeEmptyRoom({ distances: args.sceneDistances ?? [30, 30, -30], objects: extractObjects(scene), count: picked.length });
        final = final.map((s, i) => (weak.includes(i) ? { ...s, prediction_prompt: synthEmpty[i].prediction_prompt, scenario_description: synthEmpty[i].scenario_description } : s));
        console.error(`[guard] weak empty-room scenarios ${weak.map((i) => i + 1).join(",")} replaced by server templates`);
      }
      if (armIdx.length > 0) {
        final = final.map((x, i) => {
          if (!armIdx.includes(i)) return x;
          const motion = modestMotion(args.people, i);
          return { ...x, prediction_prompt: motion, scenario_description: `${(x.scenario_description.match(/^[^,]{0,40},/) ?? ["Shortly after,"])[0]} ${motion.charAt(0).toLowerCase()}${motion.slice(1)}` };
        });
        console.error(`[guard] large arm motion replaced by modest motion in scenarios ${armIdx.map((i) => i + 1).join(",")}`);
      }
      // Occupied frame with a fabricated object left: the scene's event is written from the people description.
      if (objFab.length > 0 && !(emptyRoom && !detectedPerson) && args.people && args.people.length > 0) {
        const s = synthesizeScenarios({
          people: args.people, distances: args.sceneDistances ?? [30, 30, -30], extrasEnglish: {}, extras: {}, keys: SCENE_KEYS, base: picked,
        });
        final = final.map((x, i) => (objFab.some((f) => f.index === i) ? { ...x, prediction_prompt: s.scenes[i].prediction_prompt, scenario_description: s.scenes[i].scenario_description } : x));
        console.error(`[guard] fabricated objects replaced by people-based scenes: ${objFab.map((f) => f.index + 1).join(",")}`);
      }
      if (objFab.length > 0 && !(emptyRoom && !detectedPerson) && !(args.people && args.people.length > 0)) {
        final = final.map((x, i) => {
          if (!objFab.some((f) => f.index === i) || armsRaisedIdx.includes(i)) return x;
          const motion = modestMotion(undefined, i);
          return { ...x, prediction_prompt: motion, scenario_description: `${(x.scenario_description.match(/^[^,]{0,40},/) ?? ["Shortly after,"])[0]} ${motion.charAt(0).toLowerCase()}${motion.slice(1)}` };
        });
        console.error(`[guard] fabricated objects replaced by modest motions (no people record): ${objFab.map((f) => f.index + 1).join(",")}`);
      }
      // Recent person drawn into an empty frame: exactly ONE person whose quiet motion is the main clause of every scene;
      // planner text that only describes the environment becomes a subordinate clause.
      const recentDraw = args.allowPerson === true && args.detector?.person === false && sceneEmpty(scene);
      if (recentDraw) {
        const span = (x: ScenarioResult) => (x.scenario_description.match(/^[^,]{0,40},/) ?? ["Shortly after,"])[0];
        final = final.map((x, i) => {
          const pred = x.prediction_prompt;
          const phrase = recentPersonPhrase(i);
          if (mentionsSeveralPeople(pred)) {
            const t = `The person ${phrase}.`;
            console.error(`[guard] recent person: several people named in scenario ${i + 1}; replaced by a one-person scene`);
            return { ...x, prediction_prompt: t, scenario_description: `${span(x)} ${t.charAt(0).toLowerCase()}${t.slice(1)}` };
          }
          if (/^the person\b/i.test(pred)) return x;
          const env = pred.trim().replace(/[.]+$/, "");
          const t = `The person ${phrase}, while ${env.charAt(0).toLowerCase()}${env.slice(1)}.`;
          return { ...x, prediction_prompt: t, scenario_description: `${span(x)} ${t.charAt(0).toLowerCase()}${t.slice(1)}` };
        });
      }
      // Last resort: a person was detected but the planner still says "empty / No change" -> write the scenes here.
      let synthesized = false;
      let sceneFinal = scene;
      if (detectorDisagrees(scene)) {
        sceneFinal = sceneWithoutPeople(scene);
        console.error(`[guard] detector/text disagree: detector found nobody but scene_description names a person ("${scene.slice(0, 100)}"); detector wins: unoccupied, person text removed`);
        final = final.map((x) => ({ ...x, scene_now: sceneFinal }));
      }
      if (detectedPerson && isUnoccupied(scene) && args.people && args.people.length > 0) {
        const s = synthesizeScenarios({
          people: args.people,
          distances: args.sceneDistances ?? [30, 30, -30],
          extrasEnglish: extrasEnglish as Record<string, string | undefined>,
          extras: (args.sceneExtras ?? {}) as Record<string, string | undefined>,
          keys: SCENE_KEYS,
          base: picked,
        });
        final = s.scenes;
        sceneFinal = s.sceneNow;
        synthesized = true;
        console.error(`[guard] synthesized scenarios from the described people (planner kept denying them): ${s.sceneNow}`);
      }
      final = applyServerExtras(final, synthesized || detectedPerson || !sceneEmpty(scene));
      const record: GuardRecord = {
        people: args.people,
        synthesized,
        planMs: Date.now() - planStarted,
        planCalls,
        unoccupied: sceneEmpty(scene) && !detectedPerson,
        attempts: fabricatedPerAttempt.length,
        fabricatedPerAttempt,
        replaced: bad,
        scene: sceneFinal,
        recentPersonAllowed: args.allowPerson === true,
        detector: args.detector,
        occupancySource: occupancySourceOf(!sceneEmpty(scene) && scene.length > 0, args.detector?.person),
        detectorRetried,
        duplicates: dups,
        duplicateRetried,
        detectorDisagree: detectorDisagrees(scene),
        armsRaised: armsRaisedIdx,
        fabricatedObjects: objFab,
        objectRetried,
        extras: extrasState, extrasStatus: extrasStatusMap,
      };
      if (args.trace) args.trace.guard = record;
      if (bad.length > 0) {
        console.error(`[guard] replaced scenarios ${bad.map((i) => i + 1).join(",")} with the safe empty-room fallback after ${record.attempts} attempts`);
      } else if (record.attempts > 1) {
        console.error(`[guard] clean scenarios after ${record.attempts} attempts`);
      }
      return finishWith(final);
    }
    parseFailures += 1;
    if (parseFailures >= 3 && !lastGood) break;
  }

  if (lastGood) {
    const lastScene = lastGood[0]?.scene_now ?? "";
    const bad = findFabricatedScenarios(lastScene, lastGood, allow, detectorEmpty);
    if (args.trace) {
      args.trace.guard = { people: args.people, planMs: Date.now() - planStarted, planCalls, extras: extrasState, extrasStatus: extrasStatusMap, detector: args.detector, occupancySource: occupancySourceOf(!isUnoccupied(lastScene) && lastScene.length > 0, args.detector?.person), detectorRetried, unoccupied: isUnoccupied(lastScene) && !detectedPerson, attempts: fabricatedPerAttempt.length, fabricatedPerAttempt, replaced: bad, scene: lastScene, recentPersonAllowed: args.allowPerson === true };
    }
    const finalLast = applyServerExtras(applySafeFallback(lastGood, bad), detectedPerson || !sceneEmpty(lastScene));
    if (args.trace?.guard) args.trace.guard.extras = extrasState;
    return finishWith(finalLast);
  }

  // Nothing usable from the planner: write the scenes here instead of failing the capture.
  {
    const distances = args.sceneDistances ?? [30, 30, -30];
    const blanks = Array.from({ length: args.scenarioCount }, (_, i) => ({ prediction_prompt: "", scenario_description: "", label: `Timeline ${i + 1}` })) as ScenarioResult[];
    let scenes: ScenarioResult[];
    let sceneNow: string;
    if (args.people && args.people.length > 0) {
      const s = synthesizeScenarios({
        people: args.people, distances, extrasEnglish: extrasEnglish as Record<string, string | undefined>,
        extras: (args.sceneExtras ?? {}) as Record<string, string | undefined>, keys: SCENE_KEYS, base: blanks,
      });
      scenes = s.scenes;
      sceneNow = s.sceneNow;
    } else {
      scenes = synthesizeEmptyRoom({ distances, count: args.scenarioCount }).map((s) => ({ ...s, scene_now: "" }) as ScenarioResult);
      sceneNow = "";
    }
    scenes = applyServerExtras(scenes.map((s) => ({ ...s, scene_now: sceneNow, clock_visible: false })), !!(args.people && args.people.length > 0));
    console.error(`[guard] planner returned no usable scenarios (${lastCount}); synthesized by the server`);
    if (args.trace) {
      args.trace.guard = {
        people: args.people, synthesized: true, planMs: Date.now() - planStarted, planCalls, detector: args.detector,
        occupancySource: occupancySourceOf(false, args.detector?.person), detectorRetried,
        unoccupied: !detectedPerson, attempts: planCalls, fabricatedPerAttempt, replaced: [], scene: sceneNow,
        recentPersonAllowed: args.allowPerson === true,
        extras: extrasState, extrasStatus: extrasStatusMap,
      };
    }
    return finishWith(scenes);
  }
}

/** Pure text translation of a Japanese instruction into a short third-person English verb phrase ({"action": "..."}). */
export async function translateActionPhrase(text: string, signal?: AbortSignal, llm?: PlannerLlm): Promise<string | null> {
  const prompt =
    "Translate this Japanese instruction into a short English verb phrase describing an action, " +
    'e.g. 「立ち上がってる」 -> "stands up from the chair", 「帰ろうとしている」 -> "gets ready to leave and heads for the exit". ' +
    `Instruction: "${text}"\nOutput JSON {"action":"..."} only.`;
  try {
    let raw: string;
    if (llm) {
      raw = await llm.text(prompt, signal);
    } else {
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: VLM_MODEL,
          prompt,
          stream: false,
          think: false,
          format: "json",
          keep_alive: PHASE_KEEP_ALIVE,
          options: { temperature: 0, num_predict: 32, num_ctx: 2048 },
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
      });
      if (!res.ok) return null;
      raw = ((await res.json()) as OllamaGenerateResponse).response || "{}";
    }
    const a = JSON.parse(raw || "{}")?.action;
    if (typeof a !== "string" || !a.trim()) return null;
    const action = a.trim().slice(0, 160);
    return /\b(remains?|stays?|without moving|does not move|no change|unchanged)\b/i.test(action) ? null : action;
  } catch {
    return null;
  }
}

/**
 * One short call WITH the frame: the operator's instruction (Japanese or English, possibly several joined by " / ")
 * becomes ONE concrete English sentence about what the person already visible does next. null on failure.
 */
export async function rewriteExtraEnglish(
  text: string,
  imageDataUrl: string | null,
  signal?: AbortSignal,
  llm?: PlannerLlm
): Promise<string | null> {
  const prompt =
    "Rewrite the following Japanese instruction as ONE concrete English sentence describing what THE PERSON ALREADY VISIBLE IN THIS PHOTO does next " +
    (imageDataUrl
      ? "(keep their identity, clothes and position; name the action concretely, e.g. stands up, picks up the bag, walks toward the door). "
      : "(a person who is seated at a desk; name the PHYSICAL action concretely, e.g. raises one arm and waves, or leans forward and picks up the cup). ") +
    "It must be a CHANGE from what they are doing now, never \"remains seated\" or \"does not move\": " +
    `"${text}"\nReturn ONLY JSON: {"en":"..."}`;
  try {
    let raw: string;
    if (llm) {
      raw = imageDataUrl ? await llm.plan(prompt, imageDataUrl, signal) : await llm.text(prompt, signal);
    } else {
      const m = imageDataUrl ? imageDataUrl.match(DATA_URL_PATTERN) : null;
      if (imageDataUrl && !m) return null;
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: VLM_MODEL,
          prompt,
          ...(m ? { images: [m[1]] } : {}),
          stream: false,
          think: false,
          format: "json",
          keep_alive: PHASE_KEEP_ALIVE,
          options: { temperature: 0, num_predict: 64, num_ctx: 4096 },
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;
      raw = ((await res.json()) as OllamaGenerateResponse).response || "{}";
    }
    const en = JSON.parse(raw || "{}")?.en;
    if (typeof en !== "string" || !en.trim()) return null;
    const sentence = en.trim().slice(0, 240);
    // A 4B model sometimes describes the current state instead of the change; refuse that and let the caller fall back.
    if (/\b(remains?|stays?|without moving|does not move|not moving|stationary|no change|unchanged|continues|keeps?)\b/i.test(sentence)) return null;
    const full = /^(the|a|an)\s/i.test(sentence) ? sentence : `The person already in the photo ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
    return /[.!?]$/.test(full) ? full : `${full}.`;
  } catch {
    return null;
  }
}

const ARM_WORDS_RE = /\b(?:arms?|hands?|fingers?|stretch\w*|rais\w*|lift\w*|reach\w*|spread\w*|wav\w*|upward|overhead|above)\b/i;

/**
 * Meaning-level check (no image): does the described action raise an arm above shoulder level, stretch up, wave or spread
 * the arms wide? Any failure counts as false.
 */
export async function judgeArmsRaised(prediction: string, signal?: AbortSignal, llm?: PlannerLlm): Promise<boolean> {
  const prompt =
    "Does this action involve raising one or both arms/hands above shoulder level, stretching up, waving, or spreading the arms wide? " +
    `Action: "${prediction}"\nAnswer JSON only: {"arms_above_shoulders": true|false}`;
  try {
    let raw: string;
    if (llm) {
      raw = await llm.text(prompt, signal);
    } else {
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: VLM_MODEL,
          prompt,
          stream: false,
          think: false,
          format: "json",
          keep_alive: PHASE_KEEP_ALIVE,
          options: { temperature: 0, num_predict: 16, num_ctx: 2048 },
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
      });
      if (!res.ok) return false;
      raw = ((await res.json()) as OllamaGenerateResponse).response || "{}";
    }
    return JSON.parse(raw || "{}")?.arms_above_shoulders === true;
  } catch {
    return false;
  }
}

/** Japanese operator instruction -> one short English phrase (what the visible person does). null on failure. */
export async function translateExtraToEnglish(text: string, signal?: AbortSignal, llm?: PlannerLlm): Promise<string | null> {
  const prompt =
    "Translate this Japanese instruction into one short, concrete English sentence describing what the person in the photo is doing or about to do " +
    `(example style only, unrelated to the input: "raising one hand to wave at someone"). Instruction: "${text}"
` +
    'Return ONLY JSON: {"en":"..."}';
  try {
    let raw: string;
    if (llm) {
      raw = await llm.text(prompt, signal);
    } else {
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: VLM_MODEL,
          prompt,
          stream: false,
          think: false,
          format: "json",
          keep_alive: PHASE_KEEP_ALIVE,
          options: { temperature: 0, num_predict: 48, num_ctx: 2048 },
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;
      raw = ((await res.json()) as OllamaGenerateResponse).response || "{}";
    }
    const en = JSON.parse(raw || "{}")?.en;
    return typeof en === "string" && en.trim() ? en.trim().slice(0, 200) : null;
  } catch {
    return null;
  }
}

/**
 * Text-only yes/no check: does the English scenario fulfil the (Japanese) operator instruction?
 * Any failure counts as "ok" so the check never blocks a capture.
 */
export async function judgeExtraReflected(
  extra: string,
  scenario: Pick<ScenarioResult, "prediction_prompt" | "scenario_description">,
  signal?: AbortSignal,
  llm?: PlannerLlm
): Promise<boolean> {
  const judgePrompt =
    "Does this English scenario fulfil the Japanese instruction? " +
    `Instruction: "${extra}"
Scenario: "${scenario.prediction_prompt} ${scenario.scenario_description}"
` +
    'Answer ONLY with JSON: {"ok":true} or {"ok":false}.';
  const payload = JSON.stringify({
    model: VLM_MODEL,
    prompt: judgePrompt,
    stream: false,
    think: false,
    format: "json",
    keep_alive: PHASE_KEEP_ALIVE,
    options: { temperature: 0, num_predict: 16, num_ctx: 2048 },
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      let raw: string;
      if (llm) {
        raw = (await llm.text(judgePrompt, signal)) || "{}";
      } else {
        const res = await fetch(`${OLLAMA_URL}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
        });
        if (!res.ok) throw new Error(`Ollama ${res.status}`);
        raw = ((await res.json()) as OllamaGenerateResponse).response || "{}";
      }
      const ok = JSON.parse(raw)?.ok !== false;
      console.error(`[extras] judge "${extra}" -> ${ok} (raw ${raw.slice(0, 40)})`);
      return ok;
    } catch (err) {
      console.error(`[extras] judge call failed (attempt ${attempt + 1}): ${(err as Error).message}`);
    }
  }
  return true; // never block a capture on a failed judge
}

/**
 * Replaces scenario_description and scene_now (display text for TD) with Japanese via a short
 * text-only call. prediction_prompt stays English. Falls back to the English text on any failure.
 */
export async function translateDisplayTextToJapanese(
  scenarios: ScenarioResult[],
  signal?: AbortSignal,
  llm?: PlannerLlm
): Promise<ScenarioResult[]> {
  const sceneNow = scenarios[0]?.scene_now ?? "";
  const payload = { scene: sceneNow, items: scenarios.map((s) => s.scenario_description) };
  try {
    let outRaw: string;
    if (llm) {
      outRaw = await llm.text(
        "Translate every string in this JSON from English into natural Japanese. Keep the JSON structure and the same number of items. " +
          'Write a leading time span as Japanese, e.g. "30 seconds later," -> "30秒後、", "2 minutes 30 seconds before," -> "2分30秒前、". ' +
          'Return ONLY JSON of the form {"scene":"...","items":["..."]}.\n' +
          JSON.stringify(payload),
        signal
      );
    } else {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VLM_MODEL,
        prompt:
          "Translate every string in this JSON from English into natural Japanese. Keep the JSON structure and the same number of items. " +
          'Write a leading time span as Japanese, e.g. "30 seconds later," -> "30秒後、", "2 minutes 30 seconds before," -> "2分30秒前、". ' +
          'Return ONLY JSON of the form {"scene":"...","items":["..."]}.\n' +
          JSON.stringify(payload),
        stream: false,
        think: false,
        format: "json",
        keep_alive: process.env.OLLAMA_KEEP_ALIVE ?? "0",
        options: { temperature: 0.2, num_predict: VLM_NUM_PREDICT, num_ctx: VLM_NUM_CTX },
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(VLM_TIMEOUT_MS)])
        : AbortSignal.timeout(VLM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    outRaw = ((await res.json()) as OllamaGenerateResponse).response || "{}";
    }
    const out = JSON.parse(outRaw || "{}");
    const items: unknown = out?.items;
    if (!Array.isArray(items) || items.length !== scenarios.length) throw new Error("item count mismatch");
    const scene = typeof out?.scene === "string" && out.scene.trim() ? out.scene.trim() : sceneNow;
    return scenarios.map((s, i) => ({
      ...s,
      scenario_description: String(items[i] ?? "").trim() || s.scenario_description,
      scene_now: scene,
    }));
  } catch (err) {
    console.error(`vlmClient: Japanese translation failed, keeping English text — ${(err as Error).message}`);
    return scenarios;
  }
}

export function parseScenarios(raw: string): ScenarioResult[] {
  let text = raw.trim();
  // Strip ```json fences if the model added them despite format:json.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return [];
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return [];
    }
  }

  // Missing / unparseable -> false ("not visible"); one scene-level flag copied onto each scenario.
  const clockVisible = parseClockVisible((parsed as any)?.clock_visible);
  const sceneNow = String((parsed as any)?.scene_description ?? "").trim();
  const foregroundObject = String((parsed as any)?.foreground_object ?? "").trim().slice(0, 200);

  const list = Array.isArray((parsed as any)?.scenarios)
    ? (parsed as any).scenarios
    : Array.isArray(parsed)
      ? parsed
      : [];

  return list
    .map((item: any) => ({
      prediction_prompt: String(item?.prediction_prompt ?? item?.prompt ?? "").trim(),
      scenario_description: String(
        item?.scenario_description ?? item?.description ?? ""
      ).trim(),
      label: String(item?.label ?? "").trim(),
    }))
    .filter(
      (item: ScenarioResult) =>
        item.prediction_prompt.length > 0 && item.scenario_description.length > 0
    )
    .map((item: ScenarioResult, index: number) => ({
      ...item,
      label: item.label || `Timeline ${index + 1}`,
      clock_visible: clockVisible,
      scene_now: sceneNow,
      ...(foregroundObject ? { foreground_object: foregroundObject } : {}),
    }));
}

export async function vlmReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const vlmConfig = { url: OLLAMA_URL, model: VLM_MODEL };
