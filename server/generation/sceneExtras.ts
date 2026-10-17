/**
 * Per-scene "must include" extras from TD (/api/generate body.sceneExtras = { gen_a, gen_b, gen_c }).
 * Blank / non-string entries are dropped; each text is cut to 200 characters.
 */
import { mentionsPerson } from "./scenarioGuard";

export const SCENE_EXTRA_MAX_CHARS = 200;
const KEYS = ["gen_a", "gen_b", "gen_c"] as const;

export type SceneExtras = Partial<Record<(typeof KEYS)[number], string>>;

export function parseSceneExtras(raw: unknown): SceneExtras {
  const out: SceneExtras = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v !== "string") continue;
    const text = v.replace(/\s+/g, " ").trim().slice(0, SCENE_EXTRA_MAX_CHARS);
    if (text) out[key] = text;
  }
  return out;
}

export const SCENE_KEYS = KEYS;

/** Planning-prompt section: the extra is the MAIN EVENT of its scenario ("" when none). */
export function buildSceneExtrasNote(extras: SceneExtras, strong = false, english: SceneExtras = {}): string {
  const lines = KEYS.map((key, i) => {
    const text = extras[key];
    if (!text) return "";
    const n = i + 1;
    // English rendering first (the 4B model reads English far better); the original stays as the source of truth.
    const shown = english[key] ? `${english[key]}" (operator's original, Japanese: "${text}` : text;
    if (strong) {
      return (
        `Scenario ${n} (${key}): prediction_prompt MUST begin with "The person" and describe this event concretely ` +
        `(operator text, may be Japanese): "${shown}". Do not write a different small motion instead.`
      );
    }
    return (
      `Scenario ${n} (${key}): the MAIN EVENT of this scenario is "${shown}". ` +
      `The person already visible performs this; it overrides the small-motion / tone guidance for this scenario only. ` +
      `prediction_prompt must describe this event concretely (e.g. standing up, picking up the bag, walking toward the exit).`
    );
  }).filter(Boolean);
  if (lines.length === 0) return "";
  return (
    "MAIN EVENTS requested by the operator (highest priority for the scenarios named below; keep every other rule, including the rule on people). " +
    "If a requirement is an action or feeling of a person, write the scenario as THE PERSON ALREADY VISIBLE IN THIS FRAME " +
    "(the same person, same clothes, same position) doing it, with that person as the subject, e.g. " +
    '"The man in the black shirt raises both arms above his head, smiling". ' +
    "Never add a new person, and never add arms or hands that do not belong to a visible person. " +
    "If nobody is visible, ignore any requirement that needs a person. Write in English.\n" +
    lines.join("\n")
  );
}

/** Extras naming a person while the frame is empty: the guard wins; returns the scene keys concerned. */
export function personExtrasInEmptyRoom(extras: SceneExtras, empty: boolean): string[] {
  if (!empty) return [];
  return KEYS.filter((k) => extras[k] && mentionsPerson(extras[k]!));
}

/** Japanese span prefix for a signed distance: "30秒後、", "2分30秒前、". */
export function jaSpan(distanceSec: number): string {
  const abs = Math.abs(Math.round(distanceSec));
  const m = Math.floor(abs / 60);
  const sec = abs % 60;
  return `${m > 0 ? `${m}分` : ""}${sec > 0 || m === 0 ? `${sec}秒` : ""}${distanceSec >= 0 ? "後、" : "前、"}`;
}

/**
 * Common operator instructions -> English action phrase (third person, concrete) and a natural Japanese form for the
 * display text. The 4B model describes the CURRENT pose when asked "what happens next", so the action comes from this
 * dictionary (or a pure text translation), never from the image.
 */
export const ACTION_DICT: Array<{ re: RegExp; en: string; ja: string }> = [
  { re: /(両手|万歳|ばんざい).*(上げ|挙げ|あげ)|万歳|ばんざい/, en: "raises both arms above their head, smiling", ja: "両手を上げて喜ぶ" },
  { re: /立ち上が|立ちあが|起立/, en: "stands up from the chair", ja: "立ち上がる" },
  { re: /帰|かえ/, en: "gets ready to leave, picks up their belongings and heads for the exit", ja: "帰ろうとする" },
  { re: /振り向|ふりむ|振り返/, en: "turns around to face the camera", ja: "振り向く" },
  { re: /手を振/, en: "waves", ja: "手を振る" },
  { re: /手を(挙げ|上げ|あげ)|挙手/, en: "raises one hand", ja: "手を挙げる" },
  { re: /伸び/, en: "stretches", ja: "伸びをする" },
  { re: /歩/, en: "walks across the room", ja: "歩く" },
  { re: /電話/, en: "picks up the phone", ja: "電話を取る" },
  { re: /あくび/, en: "yawns", ja: "あくびをする" },
  { re: /拍手/, en: "claps", ja: "拍手する" },
  { re: /笑/, en: "smiles", ja: "笑う" },
  { re: /うなず|頷/, en: "nods", ja: "うなずく" },
  { re: /見上げ/, en: "looks up", ja: "見上げる" },
  { re: /飲/, en: "drinks from a cup", ja: "飲み物を飲む" },
  { re: /食べ/, en: "eats", ja: "食べる" },
  { re: /読/, en: "reads a book", ja: "本を読む" },
  { re: /書/, en: "writes on paper", ja: "書く" },
  { re: /タイピング|キーボード|打っ|打つ/, en: "types on the keyboard", ja: "キーボードを打つ" },
  { re: /話/, en: "talks", ja: "話す" },
  { re: /走/, en: "runs", ja: "走る" },
  { re: /寝|眠/, en: "dozes off at the desk", ja: "居眠りする" },
  { re: /去|出て|出る/, en: "leaves the room", ja: "部屋を出る" },
  { re: /座|すわ/, en: "sits down", ja: "座る" },
  { re: /立って|立つ|立っ/, en: "is standing", ja: "立っている" },
];

/** Dictionary lookup per " / " part. Returns null when any part is unknown (then a pure text translation is used). */
export function lookupAction(text: string): { en: string; ja: string } | null {
  const parts = String(text).split(/\s*[\/／]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const found: Array<{ en: string; ja: string }> = [];
  for (const p of parts) {
    const hit = ACTION_DICT.find((d) => d.re.test(p));
    if (!hit) return null;
    found.push({ en: hit.en, ja: hit.ja });
  }
  return { en: found.map((f) => f.en).join(" and "), ja: found.map((f) => f.ja).join("、") };
}

/** English clothes phrase -> Japanese ("teal long-sleeved shirt" -> "青緑の長袖のシャツ"); null if any word is unknown. */
const CLOTHES_JA: Record<string, string> = {
  teal: "青緑の", blue: "青い", black: "黒い", white: "白い", red: "赤い", green: "緑の", gray: "グレーの", grey: "グレーの",
  beige: "ベージュの", brown: "茶色の", dark: "暗い色の", pink: "ピンクの", striped: "ストライプの", yellow: "黄色い", orange: "オレンジの",
  navy: "紺の", "long-sleeved": "長袖の", "short-sleeved": "半袖の", light: "明るい色の",
  shirt: "シャツ", "t-shirt": "Tシャツ", tshirt: "Tシャツ", hoodie: "パーカー", jacket: "ジャケット", cap: "キャップ", hat: "帽子",
  sweater: "セーター", sweatshirt: "スウェット", top: "トップス", coat: "コート", blouse: "ブラウス", dress: "ワンピース", uniform: "制服",
};
export function clothesJa(clothes: string | undefined): string | null {
  const first = String(clothes ?? "").toLowerCase().split(/[,;]| and | with /)[0].trim();
  if (!first) return null;
  const words = first.split(/\s+/).filter((w) => !["a", "an", "the"].includes(w));
  const out: string[] = [];
  for (const w of words) {
    const ja = CLOTHES_JA[w];
    if (!ja) return null;
    out.push(ja);
  }
  return out.length ? out.join("") : null;
}

/** Main sentence of an extra scene (template, nothing is left to the VLM): "The person in the <clothes> <action>." */
export function buildExtraSentence(action: string, clothes?: string): string {
  const who = clothes && clothes.trim() ? `The person in the ${clothes.trim().replace(/^(a|an|the)\s+/i, "")}` : "The person already in the photo";
  let a = action.trim().replace(/[.。\s]+$/, "");
  // a free translation may carry its own subject ("someone is cheering"): keep only the verb phrase
  a = a.replace(/^(?:someone|somebody|one of them|a person|the person|people|he|she|they)\s+/i, "");
  if (/^[a-z]+ing\b/i.test(a)) a = `is ${a}`;
  return `${who} ${a}.`;
}

/** The operator's text already carries its own subject ("どちらかの人がはしゃいでる", "誰かが…"). */
export function hasJaSubject(text: string): boolean {
  const t = String(text).trim();
  return /^(誰か|だれか|どちら|どれか|みんな|全員|皆|[二三2-9２-９]人|右の|左の|奥の|手前の)/.test(t) || /(人|人物|男性|女性|子|さん|みんな|全員|誰|だれ)(が|は)/.test(t);
}

/** Colloquial predicate -> plain form: "はしゃいでる" -> "はしゃいでいる", "立ち上がってる" -> "立ち上がっている". */
export function normalizePredicate(text: string): string {
  return String(text).trim().replace(/[。.\s]+$/, "").replace(/([てで])る$/, "$1いる");
}

/** Display text: "30秒後、青いシャツの人物が立ち上がる。" built by the server (no translation call). */
export function serverExtraDescription(distanceSec: number, extraJa: string, clothesEn?: string): string {
  const predicate = normalizePredicate(extraJa);
  if (hasJaSubject(extraJa)) return `${jaSpan(distanceSec)}${predicate}。`;
  const who = clothesJa(clothesEn);
  return `${jaSpan(distanceSec)}${who ? `${who}の人物` : "写っている人物"}が${predicate}。`;
}
