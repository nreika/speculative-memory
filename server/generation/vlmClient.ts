/**
 * Local VLM scenario planner via Ollama.
 * Replaces the Gemini "predictFutureScenarios" text step.
 */
import type { ScenarioResult } from "../../services/promptBuilder";

const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const VLM_MODEL = process.env.VLM_MODEL || "gemma3:latest";
const VLM_TIMEOUT_MS = Number(process.env.VLM_TIMEOUT_MS || "120000");

const DATA_URL_PATTERN = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/;

function toBareBase64(imageDataUrl: string): string {
  const match = imageDataUrl.match(DATA_URL_PATTERN);
  if (!match) throw new Error("vlmClient: unsupported image data URL");
  return match[1];
}

const JSON_INSTRUCTION =
  "\n\nEach prediction_prompt MUST be a short image-EDIT instruction (max 2 sentences) that " +
  "describes ONLY what changes from the given frame — the people's new actions, poses, " +
  "positions and nearby object states. Do NOT re-describe the room, camera, lighting or the " +
  "people's appearance; those stay identical. Base every change on what is actually visible in " +
  "this frame (no curtains, windows or objects that are not present).\n" +
  'Return ONLY a JSON object of the form ' +
  '{"scenarios":[{"prediction_prompt":"...","scenario_description":"...","label":"..."}]}. ' +
  "No markdown, no commentary.";

interface OllamaGenerateResponse {
  response?: string;
  error?: string;
}

export async function planScenariosLocal(args: {
  imageDataUrl: string;
  prompt: string;
  scenarioCount: number;
}): Promise<ScenarioResult[]> {
  const body = {
    model: VLM_MODEL,
    prompt: args.prompt + JSON_INSTRUCTION,
    images: [toBareBase64(args.imageDataUrl)],
    stream: false,
    format: "json",
    // Release the VLM from VRAM right after planning so ComfyUI/Qwen gets the
    // full GPU for the image step (they don't fit at the same time on 24 GB).
    keep_alive: process.env.OLLAMA_KEEP_ALIVE ?? "0",
    options: { temperature: 0.9, num_predict: 1024 },
  };

  let lastCount = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(VLM_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`vlmClient: Ollama ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as OllamaGenerateResponse;
    if (json.error) throw new Error(`vlmClient: Ollama error — ${json.error}`);

    const scenarios = parseScenarios(json.response || "");
    lastCount = scenarios.length;
    if (scenarios.length >= args.scenarioCount) {
      return scenarios.slice(0, args.scenarioCount);
    }
  }

  throw new Error(
    `vlmClient: expected ${args.scenarioCount} scenarios from ${VLM_MODEL}, got ${lastCount}`
  );
}

function parseScenarios(raw: string): ScenarioResult[] {
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
