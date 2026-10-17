/**
 * Lightweight "is a person in this photo?" check for the TD presence gate.
 * One image + a short instruction to the same Ollama VLM the scenario planner uses.
 * Never throws: failures come back as { person: null, error } so TD treats them as "unknown".
 */

export interface PersonDetectResult {
  person: boolean | null;
  count?: number;
  elapsedMs: number;
  model: string;
  error?: string;
}

export const PERSON_PROMPT =
  'Answer JSON only: {"person": true|false, "count": N}. ' +
  'Is at least one real human visible in this photo? Mannequins, posters, screens do not count.';

const DATA_URL_PATTERN = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/;

/** Parse the model's JSON answer. Returns null when it is not a usable answer. */
export function parsePersonResponse(raw: unknown): { person: boolean; count?: number } | null {
  if (typeof raw !== 'string') return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  let person: boolean | null = null;
  if (typeof parsed.person === 'boolean') person = parsed.person;
  else if (parsed.person === 'true') person = true;
  else if (parsed.person === 'false') person = false;
  const n = Number(parsed.count);
  const count = Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  if (person === null) {
    if (count === undefined) return null;
    person = count > 0;
  }
  // person:false with count>0 is contradictory; a counted person wins.
  if (!person && count !== undefined && count > 0) person = true;
  return count === undefined ? { person } : { person, count: person ? count : 0 };
}

export interface DetectOptions {
  ollamaUrl?: string;
  model?: string;
  timeoutMs?: number;
  keepAlive?: string;
  fetchImpl?: typeof fetch;
}

export async function detectPerson(image: unknown, options: DetectOptions = {}): Promise<PersonDetectResult> {
  const started = Date.now();
  const ollamaUrl = (options.ollamaUrl ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = options.model ?? process.env.VLM_MODEL ?? 'gemma3:latest';
  const timeoutMs = options.timeoutMs ?? 10_000;
  const keepAlive = options.keepAlive ?? process.env.OLLAMA_KEEP_ALIVE ?? '0';
  const doFetch = options.fetchImpl ?? fetch;
  const fail = (error: string): PersonDetectResult => ({
    person: null,
    elapsedMs: Date.now() - started,
    model,
    error,
  });

  const match = typeof image === 'string' ? image.match(DATA_URL_PATTERN) : null;
  if (!match) return fail('image must be a data:image/...;base64 URL');

  try {
    const res = await doFetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: PERSON_PROMPT,
        images: [match[1]],
        stream: false,
        think: false,
        format: 'json',
        keep_alive: keepAlive,
        options: { temperature: 0, num_predict: 32 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return fail(`Ollama ${res.status}`);
    const body = (await res.json()) as { response?: string };
    const parsed = parsePersonResponse(body.response);
    if (!parsed) return fail(`unparseable answer: ${String(body.response ?? '').slice(0, 80)}`);
    return {
      person: parsed.person,
      ...(parsed.count !== undefined ? { count: parsed.count } : {}),
      elapsedMs: Date.now() - started,
      model,
    };
  } catch (err: any) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : String(err?.message ?? err);
    return fail(reason);
  }
}
