/**
 * Mechanical "same person" check for the empty-room recent-person path (2026-10-21, person rule: only the person who was really
 * there, never a stranger). The inspection describes the drawn person's hair and clothes in its single call; this compares the
 * colour / length words with the description of the recent person. A mismatch of the colour words (both sides name colours and
 * share none) or of the hair length (long vs short) rejects.
 */
const COLORS: Record<string, string> = {
  black: 'dark', dark: 'dark', navy: 'dark', charcoal: 'dark', blue: 'blue', teal: 'teal', turquoise: 'teal', white: 'white', cream: 'white', grey: 'grey', gray: 'grey', silver: 'grey',
  red: 'red', pink: 'pink', orange: 'orange', yellow: 'yellow', green: 'green', brown: 'brown', blond: 'blond', blonde: 'blond', beige: 'beige', purple: 'purple',
};
const GARMENTS = /\b(sleeveless|sweater|sweatshirt|hoodie|shirt|t-?shirt|tee|dress|jacket|coat|top|blouse|vest|cardigan|striped|stripes)\b/gi;

const colorSet = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const w of String(text ?? '').toLowerCase().match(/[a-z]+/g) ?? []) if (COLORS[w]) out.add(COLORS[w]);
  return out;
};
const hairLength = (text: string): 'long' | 'short' | 'bald' | null => {
  const t = String(text ?? '').toLowerCase();
  if (/\b(bald|shaved)\b/.test(t)) return 'bald';
  if (/\b(long|shoulder[- ]length|ponytail|braid)\w*/.test(t)) return 'long';
  if (/\b(short|bob|cropped|buzz)\w*/.test(t)) return 'short';
  return null;
};

export interface Look { hair?: string; clothes?: string }

export function personLookMismatch(expected: Look, observed: Look): string | null {
  const reasons: string[] = [];
  const eh = hairLength(expected.hair ?? ''), oh = hairLength(observed.hair ?? '');
  if (eh && oh && eh !== oh) reasons.push(`hair ${oh} instead of ${eh}`);
  const ec = colorSet(`${expected.clothes ?? ''}`), oc = colorSet(`${observed.clothes ?? ''}`);
  if (ec.size && oc.size && ![...ec].some((c) => oc.has(c))) reasons.push(`clothes ${[...oc].join('/')} instead of ${[...ec].join('/')}`);
  const eg = new Set<string>((String(expected.clothes ?? '').match(GARMENTS) ?? []).map((x) => x.toLowerCase()));
  const og = new Set<string>((String(observed.clothes ?? '').match(GARMENTS) ?? []).map((x) => x.toLowerCase()));
  const sleeve = (s: Set<string>) => s.has('sleeveless') ? 'sleeveless' : s.has('dress') ? 'dress' : '';
  if (sleeve(eg) !== sleeve(og) && (sleeve(eg) || sleeve(og)) && eg.size && og.size && reasons.length) reasons.push('different garment');
  return reasons.length ? reasons.join('; ') : null;
}
