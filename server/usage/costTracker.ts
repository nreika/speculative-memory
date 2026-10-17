/**
 * Gemini API cost tracking: every generateContent call is recorded with its
 * real token usage (response.usageMetadata) and a computed cost.
 *
 * Output
 *   logs/usage.jsonl   one JSON line per call (git-ignored with logs/)
 *   GET /api/usage     running totals (server.ts)
 *   UDP -> TouchDesigner {type:"usage.updated", ...} after each call (server.ts
 *                      registers the notifier via setNotifier)
 *
 * PRICES: Google's official list prices, USD per 1M tokens, Standard tier,
 * paid tier. Source: https://ai.google.dev/gemini-api/docs/pricing
 * Fetched 2026-10-06 (via WebFetch; values below are what that page showed):
 *   gemini-3-flash-preview   input $0.50 (text/image/video), output $3.00
 *                            (output INCLUDES thinking tokens), cached input $0.05
 *   gemini-3.1-pro-preview   input $2.00 / output $12.00 for prompts <= 200k
 *                            ($4.00 / $18.00 above 200k; not modelled, prompts
 *                            here are a few thousand tokens). gemini-3-pro-preview
 *                            is no longer listed on the page; we assume the same
 *                            price as 3.1 Pro (verify before relying on it).
 *   gemini-2.5-flash         input $0.30, output $2.50
 *   gemini-2.5-flash-image   input $0.30; image output $0.039/image =
 *                            ~$30 per 1M output tokens (1290 tokens/image).
 *                            ALL output tokens are billed at $30 here, which
 *                            slightly overstates the (rare) text part.
 * Thinking tokens (thoughtsTokenCount) are billed at the output price.
 * Cached tokens (cachedContentTokenCount, part of promptTokenCount) are billed
 * at the model's cached price where known, else at the input price. Cache
 * storage fees are not modelled (we use no explicit caches).
 * Models not in the table fall back to the gemini-3-flash-preview price and
 * are logged with priceKnown:false so it is visible, not silent.
 *
 * Env overrides
 *   GEMINI_PRICE_INPUT_PER_M_USD / GEMINI_PRICE_OUTPUT_PER_M_USD
 *       force one input/output price for EVERY model (USD per 1M tokens).
 *   GEMINI_PRICES_JSON   per-model map, e.g.
 *       {"gemini-3-flash-preview":{"in":0.5,"out":3,"cachedIn":0.05}}
 *   USD_JPY   default 157.73 (open.er-api.com USD/JPY, 2026-10-05). It is only
 *       a display conversion; usd is logged too, and the yen value is stored
 *       per call with the rate in force when the call was made.
 */
import fs from 'fs';
import path from 'path';

export type UsagePurpose = 'scenario' | 'qa' | 'image' | 'other';

export interface ModelPrice {
  /** USD per 1M input tokens. */
  in: number;
  /** USD per 1M output tokens (thinking tokens bill as output). */
  out: number;
  /** USD per 1M cached input tokens (defaults to `in`). */
  cachedIn?: number;
}

export const DEFAULT_USD_JPY = 157.73;

export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'gemini-3-flash-preview': { in: 0.5, out: 3.0, cachedIn: 0.05 },
  'gemini-3.1-pro-preview': { in: 2.0, out: 12.0, cachedIn: 0.2 },
  'gemini-3-pro-preview': { in: 2.0, out: 12.0, cachedIn: 0.2 },
  'gemini-2.5-flash': { in: 0.3, out: 2.5, cachedIn: 0.03 },
  'gemini-2.5-flash-image': { in: 0.3, out: 30.0 },
};
const FALLBACK_MODEL = 'gemini-3-flash-preview';

const num = (v: unknown): number | null => {
  const n = Number(v);
  return v !== undefined && v !== null && v !== '' && Number.isFinite(n) && n >= 0 ? n : null;
};

export function getUsdJpy(env: NodeJS.ProcessEnv = process.env): number {
  const n = num(env.USD_JPY);
  return n && n > 0 ? n : DEFAULT_USD_JPY;
}

export function priceFor(model: string, env: NodeJS.ProcessEnv = process.env): ModelPrice & { known: boolean } {
  let table: Record<string, ModelPrice> = DEFAULT_PRICES;
  if (env.GEMINI_PRICES_JSON) {
    try {
      table = { ...DEFAULT_PRICES, ...JSON.parse(env.GEMINI_PRICES_JSON) };
    } catch {
      console.error('[usage] GEMINI_PRICES_JSON is not valid JSON; ignored');
    }
  }
  const hit = table[model];
  const base = hit ?? table[FALLBACK_MODEL] ?? DEFAULT_PRICES[FALLBACK_MODEL];
  const inOverride = num(env.GEMINI_PRICE_INPUT_PER_M_USD);
  const outOverride = num(env.GEMINI_PRICE_OUTPUT_PER_M_USD);
  const inPrice = inOverride ?? base.in;
  return {
    in: inPrice,
    out: outOverride ?? base.out,
    // A forced input price also governs cached tokens.
    cachedIn: inOverride !== null ? inPrice : base.cachedIn ?? inPrice,
    known: !!hit || inOverride !== null || outOverride !== null,
  };
}

export interface TokenUsage {
  promptTokens: number;
  outputTokens: number; // candidatesTokenCount
  thinkingTokens: number; // thoughtsTokenCount
  cachedTokens: number; // cachedContentTokenCount (subset of promptTokens)
  totalTokens: number;
}

/** Normalizes a Gemini `usageMetadata` object; null when it is absent. */
export function tokensFromMetadata(u: any): TokenUsage | null {
  if (!u || typeof u !== 'object') return null;
  const promptTokens = Number(u.promptTokenCount) || 0;
  const outputTokens = Number(u.candidatesTokenCount) || 0;
  const thinkingTokens = Number(u.thoughtsTokenCount) || 0;
  const cachedTokens = Number(u.cachedContentTokenCount) || 0;
  const totalTokens = Number(u.totalTokenCount) || promptTokens + outputTokens + thinkingTokens;
  return { promptTokens, outputTokens, thinkingTokens, cachedTokens, totalTokens };
}

/** USD cost of one call. Thinking tokens bill as output; cached tokens at the cached price. */
export function computeCostUsd(model: string, t: TokenUsage, env: NodeJS.ProcessEnv = process.env): number {
  const p = priceFor(model, env);
  const cached = Math.min(t.cachedTokens, t.promptTokens);
  const freshIn = t.promptTokens - cached;
  return (
    (freshIn * p.in + cached * (p.cachedIn ?? p.in) + (t.outputTokens + t.thinkingTokens) * p.out) / 1_000_000
  );
}

export interface UsageRecord {
  time: string;
  captureId: string | null;
  purpose: UsagePurpose;
  model: string;
  attempt?: number;
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedTokens: number;
  totalTokens: number;
  usd: number;
  jpy: number;
  usdJpy: number;
  priceKnown: boolean;
  /** true when the response carried no usageMetadata: cost is 0 but the call happened. */
  usageMissing?: boolean;
}

export interface Totals {
  calls: number;
  tokens: number;
  usd: number;
  jpy: number;
}
const emptyTotals = (): Totals => ({ calls: 0, tokens: 0, usd: 0, jpy: 0 });
const addTo = (t: Totals, r: UsageRecord) => {
  t.calls += 1;
  t.tokens += r.totalTokens;
  t.usd += r.usd;
  t.jpy += r.jpy;
};

/** Local-time calendar day, YYYY-MM-DD. */
export const localDayKey = (d: Date = new Date()): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export interface UsageUpdate {
  type: 'usage.updated';
  todayJpy: number;
  allTimeJpy: number;
  todayCalls: number;
  lastJpy: number;
  purpose: UsagePurpose;
  todayUsd: number;
  allTimeUsd: number;
  allTimeCalls: number;
  captureId: string | null;
  model: string;
}

const round = (n: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

export class CostTracker {
  private byDay = new Map<string, Totals>();
  private sinceStart = emptyTotals();
  private allTime = emptyTotals();
  private last: UsageRecord | null = null;
  private notifier: ((u: UsageUpdate) => void) | null = null;

  constructor(
    readonly logPath: string,
    private readonly now: () => Date = () => new Date(),
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.loadExisting();
  }

  private loadExisting() {
    let text = '';
    try {
      text = fs.readFileSync(this.logPath, 'utf8');
    } catch {
      return;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as UsageRecord;
        if (typeof r.usd !== 'number' || typeof r.jpy !== 'number') continue;
        r.totalTokens = Number(r.totalTokens) || 0;
        addTo(this.allTime, r);
        const key = localDayKey(new Date(r.time));
        let d = this.byDay.get(key);
        if (!d) this.byDay.set(key, (d = emptyTotals()));
        addTo(d, r);
        this.last = r;
      } catch {
        /* skip a corrupt line */
      }
    }
  }

  setNotifier(fn: ((u: UsageUpdate) => void) | null) {
    this.notifier = fn;
  }

  /** Records one call. Never throws: accounting must not break generation. */
  record(args: {
    purpose: UsagePurpose;
    model: string;
    usageMetadata: unknown;
    captureId?: string | null;
    attempt?: number;
  }): UsageRecord | null {
    try {
      const tokens = tokensFromMetadata(args.usageMetadata);
      const usdJpy = getUsdJpy(this.env);
      const price = priceFor(args.model, this.env);
      const t: TokenUsage = tokens ?? {
        promptTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
      };
      const usd = computeCostUsd(args.model, t, this.env);
      const when = this.now();
      const rec: UsageRecord = {
        time: when.toISOString(),
        captureId: args.captureId ?? null,
        purpose: args.purpose,
        model: args.model,
        ...(args.attempt !== undefined ? { attempt: args.attempt } : {}),
        ...t,
        usd,
        jpy: usd * usdJpy,
        usdJpy,
        priceKnown: price.known,
        ...(tokens ? {} : { usageMissing: true }),
      };
      if (!tokens) console.warn(`[usage] ${args.purpose} call (${args.model}) returned no usageMetadata; cost unknown`);
      if (!price.known) console.warn(`[usage] no price for model "${args.model}"; using ${FALLBACK_MODEL} price`);
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.appendFileSync(this.logPath, JSON.stringify(rec) + '\n', 'utf8');
      addTo(this.allTime, rec);
      addTo(this.sinceStart, rec);
      const key = localDayKey(when);
      let d = this.byDay.get(key);
      if (!d) this.byDay.set(key, (d = emptyTotals()));
      addTo(d, rec);
      this.last = rec;
      console.log(
        `[usage] ${rec.purpose} ${rec.model}${rec.captureId ? ` ${rec.captureId}` : ''}: ` +
          `in ${rec.promptTokens} out ${rec.outputTokens} think ${rec.thinkingTokens} = ` +
          `$${rec.usd.toFixed(5)} (JPY ${rec.jpy.toFixed(2)}); today JPY ${d.jpy.toFixed(1)} (${d.calls} calls)`
      );
      try {
        this.notifier?.(this.update(rec));
      } catch (error) {
        console.error('[usage] notifier failed:', error);
      }
      return rec;
    } catch (error) {
      console.error('[usage] failed to record usage:', error);
      return null;
    }
  }

  today(): Totals {
    return this.byDay.get(localDayKey(this.now())) ?? emptyTotals();
  }

  /** Current message for TD; `rec` defaults to the last call. */
  update(rec: UsageRecord | null = this.last): UsageUpdate {
    const today = this.today();
    return {
      type: 'usage.updated',
      todayJpy: round(today.jpy, 2),
      allTimeJpy: round(this.allTime.jpy, 2),
      todayCalls: today.calls,
      lastJpy: round(rec?.jpy ?? 0, 3),
      purpose: rec?.purpose ?? 'other',
      todayUsd: round(today.usd, 5),
      allTimeUsd: round(this.allTime.usd, 5),
      allTimeCalls: this.allTime.calls,
      captureId: rec?.captureId ?? null,
      model: rec?.model ?? '',
    };
  }

  snapshot() {
    const fmt = (t: Totals) => ({ calls: t.calls, tokens: t.tokens, jpy: round(t.jpy, 2), usd: round(t.usd, 5) });
    return {
      today: fmt(this.today()),
      sinceStart: fmt(this.sinceStart),
      allTime: fmt(this.allTime),
      last: this.last,
      usdJpy: getUsdJpy(this.env),
      day: localDayKey(this.now()),
    };
  }
}

let singleton: CostTracker | null = null;

/** Process-wide tracker writing to <cwd>/logs/usage.jsonl. */
export function getCostTracker(): CostTracker {
  if (!singleton) singleton = new CostTracker(path.join(process.cwd(), 'logs', 'usage.jsonl'));
  return singleton;
}

/** Convenience used at every Gemini call site. */
export function recordGeminiUsage(args: {
  purpose: UsagePurpose;
  model: string;
  response: { usageMetadata?: unknown } | null | undefined;
  captureId?: string | null;
  attempt?: number;
}) {
  return getCostTracker().record({
    purpose: args.purpose,
    model: args.model,
    usageMetadata: args.response?.usageMetadata,
    captureId: args.captureId,
    attempt: args.attempt,
  });
}
