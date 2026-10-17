/**
 * The leading time phrase of a scenario's display text ("30 seconds later," / "30秒後、") is decided by the server
 * from the scene's signed distance, never by the model: a model-written or mistranslated span was wrong in practice
 * (distance 15 shown as "30秒後").
 */
import { spanPhrase } from "./peopleDescribe";
import { jaSpan } from "./sceneExtras";

const EN_UNIT = String.raw`(?:minutes?|mins?|seconds?|secs?|s)`;
const EN_SPAN = new RegExp(
  String.raw`^\s*(?:(?:about|exactly|roughly|around)\s+)?(?:\d+(?:\.\d+)?\s*${EN_UNIT}\b\s*(?:and\s+)?){1,2}\s*(?:later|before|after|earlier|ago|prior)\b\s*[,，、]?\s*` +
    String.raw`|^\s*(?:shortly|soon|a (?:moment|while|short time|bit)|moments?)\s+(?:later|after|before|earlier)\b\s*[,，、]?\s*`,
  "i"
);
const JA_SPAN = /^\s*(?:約)?(?:[0-9０-９]+\s*(?:時間|分|秒))+\s*(?:後|前|先|以内)?に?[、,，]?\s*/;

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** English description with its leading span replaced by the one for `distanceSec` (added when missing). */
export function withEnglishSpan(text: string, distanceSec: number): string {
  const body = lowerFirst(text.replace(EN_SPAN, "").trim());
  return body ? `${spanPhrase(distanceSec)} ${body}` : text;
}

/** Japanese display text with its leading span replaced by the one for `distanceSec` (added when missing). */
export function withJapaneseSpan(text: string, distanceSec: number): string {
  if (!/[぀-ヿ一-鿿]/.test(text)) return text; // translation failed: still English, keep it
  const body = text.replace(JA_SPAN, "").trim();
  return body ? `${jaSpan(distanceSec)}${body}` : text;
}
