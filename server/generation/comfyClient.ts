/**
 * Minimal ComfyUI HTTP API client for the Qwen-Image-Edit-2511 pipeline.
 *
 * Mirrors the official "Qwen Image Edit 2511" template graph:
 *   UNETLoader -> ModelSamplingAuraFlow -> CFGNorm            (model path)
 *   CLIPLoader + VAELoader + LoadImage -> FluxKontextImageScale
 *     -> TextEncodeQwenImageEditPlus (pos/neg)
 *     -> FluxKontextMultiReferenceLatentMethod (pos/neg)      (conditioning path)
 *   FluxKontextImageScale -> VAEEncode                        (latent path)
 *   KSampler -> VAEDecode -> SaveImage
 *
 * Defaults to quality mode (20 steps, cfg 2.5). COMFYUI_LIGHTNING=true swaps in
 * the 4-step Lightning LoRA (~6x faster; see the LIGHTNING note below).
 */

import { createHash } from "node:crypto";
import { getComfyWatchdog } from "./comfyWatchdog";
import { DEFAULT_NEGATIVE_PROMPT } from "./ruleTexts";
import { hairNegativeTerms, negativePrompt as rulebookNegativePrompt, qualitySuffix as rulebookQualitySuffix } from "./rulebook";

const COMFY_URL = (process.env.COMFYUI_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

const MODELS = {
  unet: process.env.COMFYUI_QWEN_UNET || "qwen_image_edit_2511_fp8mixed.safetensors",
  ggufUnet: process.env.COMFYUI_QWEN_GGUF || "qwen-image-edit-2511-Q4_K_M.gguf",
  clip: process.env.COMFYUI_QWEN_CLIP || "qwen_2.5_vl_7b_fp8_scaled.safetensors",
  vae: process.env.COMFYUI_QWEN_VAE || "qwen_image_vae.safetensors",
  lightningLora:
    process.env.COMFYUI_LIGHTNING_LORA ||
    "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
};

/**
 * Q4_K_M GGUF UNet (12.3GB) instead of the fp8 one (19.1GB), via the
 * ComfyUI-GGUF custom node's UnetLoaderGGUF.
 *
 * This is a memory decision that pays off as speed. fp8 UNet + the Qwen2.5-VL
 * CLIP is 26.8GB, which does not fit in 24GB of VRAM, so ComfyUI swapped the
 * two per image: measured, 7.3s of every 17s image was that swap. At 12.3GB the
 * pair is 20.0GB and both stay resident.
 *
 * Measured on the fixed-camera scene, 3 scenarios per capture:
 *   fp8  53.3s  (19.2 / 17.0 / 17.1 per image), peak commit 43.3GB
 *   Q4   38.1s  (14.0 / 12.0 / 12.0 per image), peak commit 31.2GB
 * Dequantisation does make each sampling step slower, but losing the swap more
 * than covers it. Quality A/B at identical seeds: clock digits correct in all
 * three scenarios (leading zero kept), faces and hands intact.
 *
 * IMPORTANT: this only wins if ComfyUI is allowed to keep models in VRAM.
 * With --disable-smart-memory the weights are evicted per prompt regardless of
 * size, which throws the benefit away and leaves only the dequantisation cost
 * (measured: 65.2s, i.e. slower than fp8). Do not set that flag with GGUF.
 */
const GGUF = (process.env.COMFYUI_GGUF ?? "false").toLowerCase() === "true";

/**
 * 4-step Lightning LoRA. Off by default (quality mode, 20 steps / cfg 2.5).
 * On, a single image drops from ~114s to ~20s; A/B on the fixed-camera scene
 * showed equal prompt adherence and a *better* rendered flip-number sign.
 * cfg must stay at 1.0 — Lightning is distilled for it, and CFG at 1.0 makes
 * the negative prompt inert, so the sign/monitor guards come from the positive
 * instruction alone.
 */
const LIGHTNING = (process.env.COMFYUI_LIGHTNING ?? "false").toLowerCase() === "true";

const DEFAULTS = {
  steps: Number(process.env.COMFYUI_STEPS || (LIGHTNING ? "4" : "20")),
  cfg: Number(process.env.COMFYUI_CFG || (LIGHTNING ? "1.0" : "2.5")),
  shift: Number(process.env.COMFYUI_SHIFT || "3.1"),
  sampler: process.env.COMFYUI_SAMPLER || "euler",
  scheduler: process.env.COMFYUI_SCHEDULER || "simple",
  // 0.5s: an image takes ~12s, so a 1.5s poll wasted up to 1.5s per image
  // (measured 40.6s client-side vs 37.1s of ComfyUI execution for 3 images).
  // Generation is serialised, so there is only ever one poller.
  pollMs: Number(process.env.COMFYUI_POLL_MS || "500"),
  timeoutMs: Number(process.env.COMFYUI_TIMEOUT_MS || "300000"),
  // Second-pass "hires fix": latent upscale + light re-diffusion to recover
  // fine detail lost through the ~1MP scale + VAE round-trip.
  hires: (process.env.COMFYUI_HIRES ?? "true").toLowerCase() !== "false",
  hiresScale: Number(process.env.COMFYUI_HIRES_SCALE || "1.35"),
  hiresDenoise: Number(process.env.COMFYUI_HIRES_DENOISE || "0.3"),
  hiresSteps: Number(process.env.COMFYUI_HIRES_STEPS || (LIGHTNING ? "4" : "10")),
  sharpenAlpha: Number(process.env.COMFYUI_SHARPEN_ALPHA || "0.2"),
};

// The fixed prompt wording lives in ruleTexts.ts (v1 literals) and the versioned rulebook (rulebook.ts); these names stay
// exported for the tests and for tools that want the v1 text.
export {
  QUALITY_SUFFIX,
  QUALITY_SUFFIX_ENTERING,
  CLOCK_QUALITY_SUFFIX,
  LONG_SPAN_QUALITY_SUFFIX,
  DEFAULT_NEGATIVE_PROMPT,
  CLOCK_NEGATIVE_PROMPT,
  NO_PERSON_NEGATIVE_PROMPT,
  BEHIND_VIEW_NEGATIVE_PROMPT,
} from "./ruleTexts";

/** Hair-length terms for the negative prompt: a long-haired person must not become a bob, and the other way round. */
export const hairNegative = hairNegativeTerms;

/**
 * NOTE: with the Lightning LoRA (cfg 1.0) the negative prompt is inert, so it cannot stop an invented clock; the guard
 * against that is leaving clock wording out of the positive prompt. At cfg > 1 (non-Lightning) it is active.
 */
export const buildQualitySuffix = (clockEdit: boolean, allowNewPerson = false, longSpan = false): string =>
  rulebookQualitySuffix(clockEdit, allowNewPerson, longSpan);

export const buildNegativePrompt = (clockEdit: boolean, noPerson = false, behindView: boolean | { hair?: string } = false, obstructed = false): string =>
  rulebookNegativePrompt(clockEdit, noPerson, behindView, undefined, obstructed);

const DATA_URL_PATTERN = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/;

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; ext: string } {
  const match = dataUrl.match(DATA_URL_PATTERN);
  if (!match) throw new Error("comfyClient: unsupported image data URL");
  const ext = match[1].split("/")[1]?.replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
  return { buffer: Buffer.from(match[2], "base64"), ext };
}

/**
 * Upload an image into ComfyUI's input/ folder. Returns the stored filename.
 *
 * The name is derived from the content hash, not the clock: the three scenarios
 * of one capture share a source frame, so a stable name lets ComfyUI reuse the
 * cached LoadImage -> FluxKontextImageScale -> VAEEncode chain (and the shared
 * negative TextEncode) instead of recomputing it per scenario.
 */
async function uploadImage(
  dataUrl: string,
  namePrefix = "specmem_src",
  signal?: AbortSignal
): Promise<string> {
  const { buffer, ext } = dataUrlToBuffer(dataUrl);
  const hash = createHash("sha1").update(buffer).digest("hex").slice(0, 16);
  const filename = `${namePrefix}_${hash}.${ext}`;
  const form = new FormData();
  form.append("image", new Blob([buffer], { type: `image/${ext}` }), filename);
  form.append("overwrite", "true");

  const res = await fetch(`${COMFY_URL}/upload/image`, { method: "POST", body: form, signal });
  if (!res.ok) {
    throw new Error(`comfyClient: upload failed (${res.status}) ${await res.text()}`);
  }
  const json = (await res.json()) as { name: string; subfolder?: string };
  return json.subfolder ? `${json.subfolder}/${json.name}` : json.name;
}

export interface QwenEditParams {
  /** Scene frame as a data URL (data:image/...;base64,...). */
  sceneImage: string;
  /** Full edit instruction (already includes the time-direction prompt). */
  prompt: string;
  negativePrompt?: string;
  /** Optional identity reference (face / upper-body crop) as a data URL. */
  faceImage?: string;
  /** Rough rectangle of the person inside faceImage (pixels): cut and enlarged inside ComfyUI before it is used as image2. */
  faceCrop?: { x: number; y: number; width: number; height: number };
  /** Extra identity references (downscaled recent frames) as data URLs; image2/image3 = [faceImage, ...referenceImages] (max 2). */
  referenceImages?: string[];
  seed?: number;
  steps?: number;
  cfg?: number;
  /** KSampler denoise of the first pass (default 1.0 = production). Lower keeps more of the input latent (experiments only). */
  denoise?: number;
  filenamePrefix?: string;
  /**
   * Cancels this generation. While it still waits in the serialise queue it is
   * dropped without touching ComfyUI; once its prompt is queued, the prompt is
   * cancelled in ComfyUI (dequeued if pending, interrupted if running). The
   * promise then rejects with an AbortError.
   */
  signal?: AbortSignal;
}

function buildWorkflow(opts: {
  sceneName: string;
  faceName?: string;
  faceCrop?: { x: number; y: number; width: number; height: number };
  /** Uploaded names of extra reference frames; they take the image slots after the face (max 2 slots in all). */
  refNames?: string[];
  prompt: string;
  negativePrompt: string;
  seed: number;
  steps: number;
  cfg: number;
  denoise?: number;
  filenamePrefix: string;
  hires: boolean;
}) {
  const te = (prompt: string) => {
    const inputs: Record<string, unknown> = {
      clip: ["4", 0],
      vae: ["5", 0],
      image1: ["20", 0],
      prompt,
    };
    const slots: Array<[string, number]> = [];
    if (opts.faceName) slots.push(opts.faceCrop ? ["13", 0] : ["11", 0]);
    (opts.refNames ?? []).forEach((_, i) => slots.push([`${16 + i}`, 0]));
    slots.slice(0, 2).forEach((ref, i) => {
      inputs[`image${i + 2}`] = ref;
    });
    return { class_type: "TextEncodeQwenImageEditPlus", inputs };
  };

  // Lightning inserts a LoRA between CFGNorm and the samplers.
  const samplerModel: [string, number] = LIGHTNING ? ["35", 0] : ["3", 0];

  const wf: Record<string, unknown> = {
    "1": GGUF
      ? { class_type: "UnetLoaderGGUF", inputs: { unet_name: MODELS.ggufUnet } }
      : {
          class_type: "UNETLoader",
          inputs: { unet_name: MODELS.unet, weight_dtype: "default" },
        },
    "2": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: DEFAULTS.shift } },
    "3": { class_type: "CFGNorm", inputs: { model: ["2", 0], strength: 1.0 } },
    "4": {
      class_type: "CLIPLoader",
      inputs: { clip_name: MODELS.clip, type: "qwen_image" },
    },
    "5": { class_type: "VAELoader", inputs: { vae_name: MODELS.vae } },
    "10": { class_type: "LoadImage", inputs: { image: opts.sceneName } },
    "20": { class_type: "FluxKontextImageScale", inputs: { image: ["10", 0] } },
    "30": te(opts.prompt),
    "31": te(opts.negativePrompt),
    "41": {
      class_type: "FluxKontextMultiReferenceLatentMethod",
      inputs: { conditioning: ["30", 0], reference_latents_method: "index_timestep_zero" },
    },
    "42": {
      class_type: "FluxKontextMultiReferenceLatentMethod",
      inputs: { conditioning: ["31", 0], reference_latents_method: "index_timestep_zero" },
    },
    "50": { class_type: "VAEEncode", inputs: { pixels: ["20", 0], vae: ["5", 0] } },
    "60": {
      class_type: "KSampler",
      inputs: {
        model: samplerModel,
        positive: ["41", 0],
        negative: ["42", 0],
        latent_image: ["50", 0],
        seed: opts.seed,
        steps: opts.steps,
        cfg: opts.cfg,
        sampler_name: DEFAULTS.sampler,
        scheduler: DEFAULTS.scheduler,
        denoise: opts.denoise ?? 1.0,
      },
    },
  };

  if (opts.hires) {
    // Pass 2: upscale the latent and re-diffuse lightly to sharpen.
    wf["62"] = {
      class_type: "LatentUpscaleBy",
      inputs: { samples: ["60", 0], upscale_method: "bicubic", scale_by: DEFAULTS.hiresScale },
    };
    wf["64"] = {
      class_type: "KSampler",
      inputs: {
        model: samplerModel,
        positive: ["41", 0],
        negative: ["42", 0],
        latent_image: ["62", 0],
        seed: opts.seed + 1,
        steps: DEFAULTS.hiresSteps,
        cfg: opts.cfg,
        sampler_name: DEFAULTS.sampler,
        scheduler: DEFAULTS.scheduler,
        denoise: DEFAULTS.hiresDenoise,
      },
    };
    wf["70"] = { class_type: "VAEDecode", inputs: { samples: ["64", 0], vae: ["5", 0] } };
  } else {
    wf["70"] = { class_type: "VAEDecode", inputs: { samples: ["60", 0], vae: ["5", 0] } };
  }

  wf["75"] = {
    class_type: "ImageSharpen",
    inputs: { image: ["70", 0], sharpen_radius: 1, sigma: 1.0, alpha: DEFAULTS.sharpenAlpha },
  };
  wf["80"] = {
    class_type: "SaveImage",
    inputs: { images: ["75", 0], filename_prefix: opts.filenamePrefix },
  };

  if (LIGHTNING) {
    wf["35"] = {
      class_type: "LoraLoaderModelOnly",
      inputs: { model: ["3", 0], lora_name: MODELS.lightningLora, strength_model: 1.0 },
    };
  }

  if (opts.faceName) {
    wf["11"] = { class_type: "LoadImage", inputs: { image: opts.faceName } };
    if (opts.faceCrop) {
      const c = opts.faceCrop;
      const outH = 768;
      const outW = Math.max(64, Math.round((c.width * outH) / c.height / 8) * 8);
      wf["12"] = { class_type: "ImageCrop", inputs: { image: ["11", 0], width: c.width, height: c.height, x: c.x, y: c.y } };
      wf["13"] = { class_type: "ImageScale", inputs: { image: ["12", 0], upscale_method: "lanczos", width: outW, height: outH, crop: "disabled" } };
    }
  }
  (opts.refNames ?? []).slice(0, opts.faceName ? 1 : 2).forEach((name, i) => {
    wf[`${16 + i}`] = { class_type: "LoadImage", inputs: { image: name } };
  });
  return wf;
}

/**
 * ComfyUI executes its queue one prompt at a time, so submitting a capture's
 * scenarios concurrently bought nothing and broke the timeout: it is measured
 * from submit, so the last prompt's budget was consumed by the earlier ones
 * waiting in the queue (measured 20s / 26s / 257s for one 3-image capture).
 * Serialising here keeps the public API unchanged - callers may still fire
 * their requests in parallel - while each generation gets the full timeout for
 * its own work, and only one 19.6GB model staging is in flight at a time.
 */
let queueTail: Promise<void> = Promise.resolve();

const abortReason = (signal: AbortSignal): unknown => {
  const reason = signal.reason;
  if (reason && typeof reason === "object" && (reason as { name?: string }).name === "AbortError") {
    return reason;
  }
  return new DOMException("comfyClient: generation cancelled", "AbortError");
};

/** Resolves with `promise`, or rejects as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/**
 * Cancellation keeps the guarantee: a waiter that is aborted leaves the queue
 * at once (its caller rejects without anything being sent to ComfyUI), but its
 * slot only releases when its predecessor's does, so whatever was queued
 * behind it still cannot start before the work ahead of it has finished.
 */
async function serialize<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const predecessor = queueTail;
  let release!: () => void;
  queueTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await untilAborted(predecessor, signal);
  } catch (error) {
    void predecessor.then(release);
    throw error;
  }
  try {
    if (signal?.aborted) throw abortReason(signal);
    return await work();
  } finally {
    release();
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  untilAborted(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);

interface QueueSnapshot {
  queue_running?: unknown[][];
  queue_pending?: unknown[][];
}

/**
 * Cancel one of our prompts in ComfyUI without touching anyone else's.
 *
 * ComfyUI 0.38 has POST /api/jobs/{id}/cancel, which dequeues the prompt if it
 * is pending or interrupts it if (and only if) it is the one running, checked
 * atomically under the queue mutex. Older builds fall back to
 * POST /queue {"delete":[id]} + POST /interrupt {"prompt_id": id} (0.38's
 * /interrupt also honours prompt_id, but checks-then-interrupts without the
 * lock). Never a bare /interrupt: that kills whatever is running, and ComfyUI
 * is shared with interactive use.
 *
 * Then wait (0.5s polls, bounded) until the prompt has left the queue, so the
 * next serialised generation does not overlap the tail of this one.
 */
export async function cancelPrompt(
  promptId: string
): Promise<{ method: string; dispatched: boolean | null; settledMs: number }> {
  const started = Date.now();
  let method = "jobs-cancel";
  let dispatched: boolean | null = null;
  try {
    const res = await fetch(`${COMFY_URL}/api/jobs/${encodeURIComponent(promptId)}/cancel`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const json = (await res.json().catch(() => ({}))) as { cancelled?: boolean };
    dispatched = Boolean(json.cancelled);
  } catch {
    method = "queue-delete+interrupt";
    const post = (path: string, body: unknown) =>
      fetch(`${COMFY_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
    await post("/queue", { delete: [promptId] });
    await post("/interrupt", { prompt_id: promptId });
  }

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${COMFY_URL}/queue`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const queue = (await res.json()) as QueueSnapshot;
        const ids = [...(queue.queue_running || []), ...(queue.queue_pending || [])].map(
          (item) => item?.[1]
        );
        if (!ids.includes(promptId)) break;
      }
    } catch {
      // keep polling until the deadline
    }
    await sleep(DEFAULTS.pollMs);
  }
  const settledMs = Date.now() - started;
  console.log(
    `comfyClient: cancelled prompt ${promptId} via ${method} (dispatched=${dispatched ?? "?"}, settled in ${settledMs}ms)`
  );
  return { method, dispatched, settledMs };
}

interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean };
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
}

async function queuePrompt(workflow: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${COMFY_URL}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
  });
  if (!res.ok) {
    throw new Error(`comfyClient: /prompt rejected (${res.status}) ${await res.text()}`);
  }
  const json = (await res.json()) as { prompt_id: string };
  return json.prompt_id;
}

async function waitForImage(
  promptId: string,
  signal?: AbortSignal
): Promise<{ filename: string; subfolder: string }> {
  const deadline = Date.now() + DEFAULTS.timeoutMs;
  while (Date.now() < deadline) {
    await sleep(DEFAULTS.pollMs, signal);
    const res = await fetch(`${COMFY_URL}/history/${promptId}`, { signal });
    if (!res.ok) continue;
    const history = (await res.json()) as Record<string, HistoryEntry>;
    const entry = history[promptId];
    if (!entry) continue;

    const statusStr = entry.status?.status_str;
    if (statusStr === "error") {
      throw new Error(`comfyClient: generation failed — ${JSON.stringify(entry.status)}`);
    }
    for (const out of Object.values(entry.outputs || {})) {
      const img = out.images?.find((i) => i.type === "output");
      if (img) return { filename: img.filename, subfolder: img.subfolder };
    }
    if (statusStr === "success") {
      throw new Error("comfyClient: completed without an output image");
    }
  }
  throw new Error(`comfyClient: timed out after ${DEFAULTS.timeoutMs}ms`);
}

async function fetchImage(filename: string, subfolder: string, signal?: AbortSignal): Promise<Buffer> {
  const params = new URLSearchParams({ filename, subfolder, type: "output" });
  const res = await fetch(`${COMFY_URL}/view?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`comfyClient: /view failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Run one Qwen-Image-Edit pass and return the result as a PNG data URL. */
export async function generateQwenEdit(
  params: QwenEditParams
): Promise<{ dataUrl: string; buffer: Buffer }> {
  const { signal } = params;
  return serialize(async () => {
    const sceneName = await uploadImage(params.sceneImage, "specmem_scene", signal);
    const faceName = params.faceImage
      ? await uploadImage(params.faceImage, "specmem_face", signal)
      : undefined;
    const refNames: string[] = [];
    for (const ref of (params.referenceImages ?? []).slice(0, faceName ? 1 : 2)) {
      refNames.push(await uploadImage(ref, "specmem_ref", signal));
    }

    const workflow = buildWorkflow({
      sceneName,
      faceName,
      refNames,
      faceCrop: params.faceCrop,
      prompt: params.prompt,
      negativePrompt: params.negativePrompt ?? DEFAULT_NEGATIVE_PROMPT,
      seed: params.seed ?? Math.floor(Math.random() * 2 ** 31),
      steps: params.steps ?? DEFAULTS.steps,
      cfg: params.cfg ?? DEFAULTS.cfg,
      denoise: params.denoise,
      filenamePrefix: params.filenamePrefix ?? "SpecMem/gen",
      hires: DEFAULTS.hires,
    });

    if (signal?.aborted) throw abortReason(signal);
    // POST /prompt itself is not aborted: we need its prompt id to cancel the
    // prompt, so let it return and cancel right after if needed.
    const promptId = await queuePrompt(workflow);
    try {
      if (signal?.aborted) throw abortReason(signal);
      const { filename, subfolder } = await waitForImage(promptId, signal);
      const buffer = await fetchImage(filename, subfolder, signal);
      getComfyWatchdog().noteSuccess();
      return { dataUrl: `data:image/png;base64,${buffer.toString("base64")}`, buffer };
    } catch (error) {
      if (signal?.aborted) {
        // Still inside the serialise slot: the next generation waits until
        // ComfyUI has actually let go of this prompt.
        await cancelPrompt(promptId);
        throw abortReason(signal);
      }
      if (String((error as Error)?.message).startsWith("comfyClient: timed out")) {
        // Hung job: take our prompt out of ComfyUI's queue (pending -> delete, running -> interrupt), then count the
        // timeout; consecutive ones trigger the ComfyUI restart (comfyWatchdog.ts).
        await cancelPrompt(promptId).catch(() => undefined);
        getComfyWatchdog().noteTimeout();
      }
      throw error;
    }
  }, signal);
}

export async function comfyReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${COMFY_URL}/system_stats`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const comfyConfig = { url: COMFY_URL, models: MODELS, defaults: DEFAULTS };
