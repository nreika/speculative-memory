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
 * Lightning LoRA is intentionally NOT wired in: quality mode (20 steps, cfg 2.5).
 */

const COMFY_URL = (process.env.COMFYUI_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

const MODELS = {
  unet: process.env.COMFYUI_QWEN_UNET || "qwen_image_edit_2511_fp8mixed.safetensors",
  clip: process.env.COMFYUI_QWEN_CLIP || "qwen_2.5_vl_7b_fp8_scaled.safetensors",
  vae: process.env.COMFYUI_QWEN_VAE || "qwen_image_vae.safetensors",
};

const DEFAULTS = {
  steps: Number(process.env.COMFYUI_STEPS || "20"),
  cfg: Number(process.env.COMFYUI_CFG || "2.5"),
  shift: Number(process.env.COMFYUI_SHIFT || "3.1"),
  sampler: process.env.COMFYUI_SAMPLER || "euler",
  scheduler: process.env.COMFYUI_SCHEDULER || "simple",
  pollMs: Number(process.env.COMFYUI_POLL_MS || "1500"),
  timeoutMs: Number(process.env.COMFYUI_TIMEOUT_MS || "300000"),
  // Second-pass "hires fix": latent upscale + light re-diffusion to recover
  // fine detail lost through the ~1MP scale + VAE round-trip.
  hires: (process.env.COMFYUI_HIRES ?? "true").toLowerCase() !== "false",
  hiresScale: Number(process.env.COMFYUI_HIRES_SCALE || "1.35"),
  hiresDenoise: Number(process.env.COMFYUI_HIRES_DENOISE || "0.3"),
  hiresSteps: Number(process.env.COMFYUI_HIRES_STEPS || "10"),
  sharpenAlpha: Number(process.env.COMFYUI_SHARPEN_ALPHA || "0.2"),
};

/** Appended to every edit instruction — the quality guard rails found during testing. */
export const QUALITY_SUFFIX =
  "Sharp, crisp, high-detail photo, in focus edge to edge, fully solid opaque people, no transparency, no ghosting. " +
  "Keep the exact same number of monitors, screens and furniture as the input — do not add or remove any. " +
  "Do not change what any monitor or TV displays. " +
  "The only text that may change is the physical flip-number sign; keep it as two rows of two-digit cards, " +
  "always showing a leading zero (08, not 8), same size and position as the input.";

export const DEFAULT_NEGATIVE_PROMPT =
  "blurry, soft focus, out of focus, hazy, low detail, motion blur, " +
  "transparent, translucent, see-through, ghost, double exposure, " +
  "creature, monster face, melted face, distorted face, disfigured, deformed hands, extra limbs, " +
  "duplicated person, merged bodies, extra people, " +
  "extra monitor, additional screen, more televisions, duplicated display, extra furniture, " +
  "changed screen content, different monitor image, " +
  "single-digit clock number, missing leading zero, garbled digits, distorted numbers";

const DATA_URL_PATTERN = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/;

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; ext: string } {
  const match = dataUrl.match(DATA_URL_PATTERN);
  if (!match) throw new Error("comfyClient: unsupported image data URL");
  const ext = match[1].split("/")[1]?.replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
  return { buffer: Buffer.from(match[2], "base64"), ext };
}

/** Upload an image into ComfyUI's input/ folder. Returns the stored filename. */
async function uploadImage(dataUrl: string, namePrefix = "specmem_src"): Promise<string> {
  const { buffer, ext } = dataUrlToBuffer(dataUrl);
  const filename = `${namePrefix}_${Date.now()}.${ext}`;
  const form = new FormData();
  form.append("image", new Blob([buffer], { type: `image/${ext}` }), filename);
  form.append("overwrite", "true");

  const res = await fetch(`${COMFY_URL}/upload/image`, { method: "POST", body: form });
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
  seed?: number;
  steps?: number;
  cfg?: number;
  filenamePrefix?: string;
}

function buildWorkflow(opts: {
  sceneName: string;
  faceName?: string;
  prompt: string;
  negativePrompt: string;
  seed: number;
  steps: number;
  cfg: number;
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
    if (opts.faceName) inputs.image2 = ["11", 0];
    return { class_type: "TextEncodeQwenImageEditPlus", inputs };
  };

  const wf: Record<string, unknown> = {
    "1": {
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
        model: ["3", 0],
        positive: ["41", 0],
        negative: ["42", 0],
        latent_image: ["50", 0],
        seed: opts.seed,
        steps: opts.steps,
        cfg: opts.cfg,
        sampler_name: DEFAULTS.sampler,
        scheduler: DEFAULTS.scheduler,
        denoise: 1.0,
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
        model: ["3", 0],
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

  if (opts.faceName) {
    wf["11"] = { class_type: "LoadImage", inputs: { image: opts.faceName } };
  }
  return wf;
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

async function waitForImage(promptId: string): Promise<{ filename: string; subfolder: string }> {
  const deadline = Date.now() + DEFAULTS.timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DEFAULTS.pollMs));
    const res = await fetch(`${COMFY_URL}/history/${promptId}`);
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

async function fetchImage(filename: string, subfolder: string): Promise<Buffer> {
  const params = new URLSearchParams({ filename, subfolder, type: "output" });
  const res = await fetch(`${COMFY_URL}/view?${params.toString()}`);
  if (!res.ok) throw new Error(`comfyClient: /view failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Run one Qwen-Image-Edit pass and return the result as a PNG data URL. */
export async function generateQwenEdit(
  params: QwenEditParams
): Promise<{ dataUrl: string; buffer: Buffer }> {
  const sceneName = await uploadImage(params.sceneImage, "specmem_scene");
  const faceName = params.faceImage
    ? await uploadImage(params.faceImage, "specmem_face")
    : undefined;

  const workflow = buildWorkflow({
    sceneName,
    faceName,
    prompt: params.prompt,
    negativePrompt: params.negativePrompt ?? DEFAULT_NEGATIVE_PROMPT,
    seed: params.seed ?? Math.floor(Math.random() * 2 ** 31),
    steps: params.steps ?? DEFAULTS.steps,
    cfg: params.cfg ?? DEFAULTS.cfg,
    filenamePrefix: params.filenamePrefix ?? "SpecMem/gen",
    hires: DEFAULTS.hires,
  });

  const promptId = await queuePrompt(workflow);
  const { filename, subfolder } = await waitForImage(promptId);
  const buffer = await fetchImage(filename, subfolder);
  return { dataUrl: `data:image/png;base64,${buffer.toString("base64")}`, buffer };
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
