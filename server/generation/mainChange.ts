/**
 * The single action sentence of a scene, repeated once at the very end of the edit instruction so that it is not
 * buried under the preservation rules (2026-10-19 review: the requested motion vanished among ~5 near-identical
 * "never add objects" sentences). Pure text; no model call.
 */

/** First sentence of the prediction (a period inside "..." does not end it). "" when there is none. */
export function mainActionSentence(prediction: string): string {
  const text = String(prediction ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  let inQuote = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') inQuote = !inQuote;
    if (inQuote || (ch !== '.' && ch !== '!' && ch !== '?')) continue;
    const next = text.slice(i + 1);
    if (next === '' || /^\s+["A-Z]/.test(next)) return text.slice(0, i + 1).trim();
  }
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** A "keep everything" fallback is not a change to emphasize. */
const NO_ACTION = /^(?:keep|preserve) the scene\b|^nothing changes\b/i;

/** "\n\nMain change that must be clearly visible: <action sentence>" or "" when there is no action. */
export function mainChangeLine(prediction: string): string {
  const sentence = mainActionSentence(prediction);
  if (!sentence || NO_ACTION.test(sentence)) return '';
  return `\n\nMain change that must be clearly visible: ${sentence}`;
}
