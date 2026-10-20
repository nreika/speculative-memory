/**
 * G-13: hair colour distribution for the recent person drawn from behind. The describe call often returns only the
 * accent ("pink-tipped") or "black hair with pink tips", and the image model then paints the WHOLE hair in the accent
 * colour. These helpers keep base colour and tip colour apart: "dark hair, only the tips pink".
 * Pure string functions (no rulebook / model access).
 */

const COLOUR_WORDS =
  "black|dark|dark brown|brown|light brown|chestnut|blonde|blond|fair|golden|red|ginger|auburn|grey|gray|silver|white|pink|purple|violet|blue|green|teal|orange|yellow|bleached|platinum|lavender|magenta|turquoise";
const BASE_COLOUR_RE = new RegExp(String.raw`\b(${COLOUR_WORDS})\b`, "i");
const TIP = String.raw`((?:(?:light|bright|pale|dark|hot|neon|pastel|deep|dusty|faded)\s+)?[a-z]+)`;
const TIP_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\b${TIP}[- ]tipped\b`, "i"),
  new RegExp(String.raw`\bwith\s+${TIP}\s+(?:coloured\s+|colored\s+|dyed\s+)?(?:tips|ends)\b`, "i"),
  new RegExp(String.raw`\b(?:tips|ends)\s+(?:are\s+|dyed\s+|coloured\s+|colored\s+|in\s+)?${TIP}\b`, "i"),
  new RegExp(String.raw`(?:^|[,;]\s*|\band\s+)${TIP}\s+(?:coloured\s+|colored\s+|dyed\s+)?(?:tips|ends)\b`, "i"),
];

export interface HairTips {
  /** Hair description without the tip clause ("long straight black hair"), "" when only the tips were named. */
  base: string;
  /** Base colour word found in `base` ("black", "dark"), "" when unknown. */
  baseColour: string;
  /** Tip colour ("pink", "bright pink"). */
  tips: string;
}

/** Splits "black hair with pink tips" / "pink-tipped black hair" / "black hair, pink tips" into base and tips (null = no tips named). */
export function parseHairTips(hair?: string): HairTips | null {
  const h = String(hair ?? "").trim();
  if (!h) return null;
  for (const re of TIP_PATTERNS) {
    const m = h.match(re);
    if (!m || m.index === undefined) continue;
    const tips = m[1].toLowerCase().trim();
    if (!BASE_COLOUR_RE.test(tips) && !/^(?:light|bright|pale|dark|hot|neon|pastel|deep|dusty|faded)\s/.test(tips)) continue;
    const base = (h.slice(0, m.index) + " " + h.slice(m.index + m[0].length))
      .replace(/\s+/g, " ")
      .replace(/\s*[,;]\s*(?=[,;]|$)/g, "")
      .replace(/^[\s,;]+|[\s,;.]+$/g, "")
      .replace(/\s+,/g, ",")
      .trim();
    const baseColour = (base.match(BASE_COLOUR_RE)?.[1] ?? "").toLowerCase();
    return { base: /\bhair\b/i.test(base) || !base ? base : `${base} hair`, baseColour, tips };
  }
  return null;
}

/**
 * The hair as written into the behind-view sentence: the described hair verbatim when it has one colour; with coloured
 * tips the base colour comes first and the tips are explicitly limited ("dark hair, only the tips pink"), never
 * collapsing the whole hair to the accent colour.
 */
export function behindViewHairPhrase(hair?: string): string {
  const h = String(hair ?? "").trim();
  const t = parseHairTips(h);
  if (!t) return h;
  if (t.baseColour && t.baseColour !== t.tips) {
    return `${t.base}, only the tips ${t.tips} (the rest of the hair stays ${t.baseColour}; never colour the whole hair ${t.tips})`;
  }
  const base = t.base && !/^hair$/i.test(t.base) ? t.base : "hair";
  return `${base} in its original darker base colour as in the reference image, only the tips ${t.tips} (never colour the whole hair ${t.tips})`;
}

/** Negative terms against an accent colour spreading over the whole hair ("" when no coloured tips are recorded). */
export function hairTipNegativeTerms(hair?: string): string {
  const t = parseHairTips(hair);
  if (!t) return "";
  return `fully ${t.tips} hair, ${t.tips} hair from root to tip, hair dyed ${t.tips} all over`;
}
