/**
 * Per-request backend selection: scene recognition (VLM) and image generation
 * are chosen independently, each "local" (Ollama / ComfyUI, free) or "gemini" (paid).
 * Pure helpers, no heavy imports: safe for tests and for the Gemini-free local path.
 */
export type StepBackend = "local" | "gemini";
export type GenerationBackendName = "local" | "gemini" | "hybrid";

/** Model ids of the Gemini path (services/geminiService.ts uses the same constants). */
export const GEMINI_VLM_MODEL = "gemini-3-flash-preview";
export const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";

export interface ResolvedBackends {
  vlm: StepBackend;
  image: StepBackend;
  /** One of the two requested "gemini" but no API key exists, so that step ran local. */
  fellBack: Array<"vlm" | "image">;
}

/** GENERATION_BACKEND -> default per step. local: local/local, hybrid: gemini/local, gemini: gemini/gemini. */
export function defaultBackends(generation: string | undefined): { vlm: StepBackend; image: StepBackend } {
  switch ((generation || "local").trim().toLowerCase()) {
    case "gemini":
      return { vlm: "gemini", image: "gemini" };
    case "hybrid":
      return { vlm: "gemini", image: "local" };
    default:
      return { vlm: "local", image: "local" };
  }
}

const parseStep = (v: unknown): StepBackend | null => {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s === "local" || s === "gemini" ? s : null;
};

export function hasGeminiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.GEMINI_API_KEY || env.API_KEY);
}

/**
 * body.vlmBackend / body.imageBackend ('local' | 'gemini'); anything else or missing -> the default
 * derived from GENERATION_BACKEND. A requested 'gemini' without an API key falls back to local.
 */
export function resolveBackends(
  body: unknown,
  generation: string | undefined = process.env.GENERATION_BACKEND,
  env: NodeJS.ProcessEnv = process.env
): ResolvedBackends {
  const def = defaultBackends(generation);
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const vlm = parseStep(b.vlmBackend) ?? def.vlm;
  const image = parseStep(b.imageBackend) ?? def.image;
  const fellBack: Array<"vlm" | "image"> = [];
  const keyed = hasGeminiKey(env);
  const out: ResolvedBackends = { vlm, image, fellBack };
  if (vlm === "gemini" && !keyed) {
    out.vlm = "local";
    fellBack.push("vlm");
  }
  if (image === "gemini" && !keyed) {
    out.image = "local";
    fellBack.push("image");
  }
  return out;
}

/** Legacy single label for the response / archive "backend" field. */
export function backendLabel(r: Pick<ResolvedBackends, "vlm" | "image">): GenerationBackendName | "custom" {
  if (r.vlm === r.image) return r.vlm;
  return r.vlm === "gemini" ? "hybrid" : "custom";
}
