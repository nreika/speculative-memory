/**
 * Japanese text for MAIN's History box (2026-10-21: content / situation text is always Japanese).
 * Order: the translated scene text already archived for that capture (<id>_prompts.json nowText), then a cached translation,
 * and while a missing one is being translated (one Ollama call, queued, cached) the English line is shown.
 */
import fs from 'node:fs';
import path from 'node:path';

const JA = /[぀-ヿ一-鿿]/;
export interface HistoryJaOptions {
  archiveRoot: string;
  imageNowOf: (captureId: string) => string | undefined;
  translate?: (english: string) => Promise<string | null>;
}

export function createHistoryJa(options: HistoryJaOptions) {
  const byCapture = new Map<string, string>(), cache = new Map<string, string>(), pending = new Set<string>();
  function archived(captureId: string): string | undefined {
    if (byCapture.has(captureId)) return byCapture.get(captureId);
    const now = options.imageNowOf(captureId);
    const m = /record_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\./.exec(String(now ?? ''));
    if (!m) return undefined;
    const id = m[1];
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(options.archiveRoot, id.slice(0, 10), id, id + '_prompts.json'), 'utf8'));
      const text = typeof doc.nowText === 'string' ? doc.nowText.trim() : '';
      if (text && JA.test(text)) { byCapture.set(captureId, text); if (byCapture.size > 500) byCapture.delete(byCapture.keys().next().value!); return text; }
    } catch { /* not archived (yet) */ }
    return undefined;
  }
  /** Japanese line for a history entry, or its English text while the translation is pending. */
  function textFor(entry: { captureId: string; observation: string }): string {
    const fromArchive = archived(entry.captureId);
    if (fromArchive) return fromArchive;
    if (JA.test(entry.observation)) return entry.observation;
    const cached = cache.get(entry.observation);
    if (cached) return cached;
    if (options.translate && !pending.has(entry.observation) && pending.size < 8) {
      pending.add(entry.observation);
      void options.translate(entry.observation).then((ja) => { if (ja && JA.test(ja)) { cache.set(entry.observation, ja); if (cache.size > 500) cache.delete(cache.keys().next().value!); } }).catch(() => undefined).finally(() => pending.delete(entry.observation));
    }
    return entry.observation;
  }
  return { textFor };
}

/** One short Ollama call: English scene text -> one natural Japanese sentence (null on any failure). */
export async function translateWithOllama(english: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl((process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '') + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ model: process.env.VLM_MODEL || 'gemma3:latest', prompt: 'Translate this room description into 1 or 2 natural Japanese sentences. Output only the Japanese text.\n' + english.slice(0, 600), stream: false, think: false, keep_alive: '2m', options: { temperature: 0.1, num_predict: 200 } }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { response?: string };
    const text = String(json.response ?? '').trim().replace(/^["「]|["」]$/g, '');
    return text && JA.test(text) && text.length < 400 ? text : null;
  } catch { return null; }
}

/** Japanese version of formatHistory's "People: ..." footer (fixed phrases only). */
export function peopleFooterJa(text: string): string {
  return String(text ?? '')
    .replace(/^People: /, '人物: ')
    .replace(/a person arrived at (\d{2}:\d{2})/g, '$1 に人が来た')
    .replace(/left at (\d{2}:\d{2})/g, '$1 に退出')
    .replace(/; present now for (\d+) min/, '。今は $1 分間在室')
    .replace(/; the room has been empty for (\d+) min/, '。部屋は $1 分間無人')
    .replace(/the room has been empty for (\d+) min/, '部屋は $1 分間無人')
    .replace(/no one has entered or left in the last (\d+) min; a person is present/, '直近 $1 分は出入りなし・人がいる')
    .replace(/; /g, '、');
}

/** Japanese prefix of a formatHistory line: "[17:40, 8 min ago]" and "x6 (17:42-17:47, latest 1 min ago, no change for 5 min)". */
export function historyLinePrefixJa(line: string): string {
  return String(line ?? '')
    .replace(/^\[(\d{2}:\d{2}), (\d+) min ago\]/, '[$1, $2 分前]')
    .replace(/^(\u00d7\d+) \((\d{2}:\d{2}\u2013\d{2}:\d{2}), latest (\d+) min ago, no change for (\d+) min\)/, '$1（$2、最新 $3 分前、$4 分間変化なし）');
}
