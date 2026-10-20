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
 *
 * Each `re` must match the WHOLE phrase (anchored, inflections only). A keyword inside a longer phrase never counts:
 * 「椅子に座ったまま机を見る」 is not 「座る」 (2026-10-19: every A scene became "sits down" and lost 「机を見る」).
 */
export const ACTION_DICT: Array<{ re: RegExp; en: string; ja: string }> = [
  // A single exuberant actor is not merely "playing alone". Match the whole
  // predicate, so another clause still uses the existing compound/full-text path.
  { re: /^(?:(?:一人|１人|1人|ひとり)(?:で|が|は)?|(?:誰か|だれか|どちらかの人|一人の人|一人の人物|人物|人)(?:が|は))?\s*(?:はしゃぐ|はしゃいで(?:いる|る)|大はしゃぎ(?:して(?:いる|る))?)$/, en: "is cheering", ja: "はしゃぐ" },
  { re: /^(?:(?:両手|両腕)を(?:上げ|挙げ|あげ)(?:る|て(?:いる|る)?|て喜(?:ぶ|んで(?:いる|る)))|万歳(?:する|して(?:いる|る))?|ばんざい(?:する|して(?:いる|る))?)$/, en: "raises both arms above their head, smiling", ja: "両手を上げて喜ぶ" },
  { re: /^(?:(?:立ち上が|立ちあが)(?:る|って(?:いる|る)|ります)|起立(?:する)?)$/, en: "stands up from the chair", ja: "立ち上がる" },
  { re: /^(?:帰る|帰って(?:いる|る|いく)|帰ろうと(?:する|して(?:いる|る))|かえる)$/, en: "gets ready to leave, picks up their belongings and heads for the exit", ja: "帰ろうとする" },
  { re: /^(?:(?:振り向|ふりむ)(?:く|いて(?:いる|る))|振り返(?:る|って(?:いる|る)))$/, en: "turns around to face the camera", ja: "振り向く" },
  { re: /^手を振(?:る|って(?:いる|る))$/, en: "waves", ja: "手を振る" },
  { re: /^(?:手を(?:挙げ|上げ|あげ)(?:る|て(?:いる|る))|挙手(?:する)?)$/, en: "raises one hand", ja: "手を挙げる" },
  { re: /^伸び(?:を)?(?:する|して(?:いる|る))$/, en: "stretches", ja: "伸びをする" },
  { re: /^歩(?:く|いて(?:いる|る))$/, en: "walks across the room", ja: "歩く" },
  { re: /^電話(?:を取る|に出る|する|して(?:いる|る))$/, en: "picks up the phone", ja: "電話を取る" },
  { re: /^あくび(?:を)?(?:する|して(?:いる|る))$/, en: "yawns", ja: "あくびをする" },
  { re: /^拍手(?:する|して(?:いる|る))?$/, en: "claps", ja: "拍手する" },
  { re: /^(?:笑う|笑って(?:いる|る)|笑顔(?:で|になる)?)$/, en: "smiles", ja: "笑う" },
  { re: /^(?:うなず|頷)(?:く|いて(?:いる|る))$/, en: "nods", ja: "うなずく" },
  { re: /^見上げ(?:る|て(?:いる|る))$/, en: "looks up", ja: "見上げる" },
  { re: /^(?:飲み物を)?飲(?:む|んで(?:いる|る))$/, en: "drinks from a cup", ja: "飲み物を飲む" },
  { re: /^食べ(?:る|て(?:いる|る))$/, en: "eats", ja: "食べる" },
  { re: /^(?:本を)?読(?:む|んで(?:いる|る))$/, en: "reads a book", ja: "本を読む" },
  { re: /^書(?:く|いて(?:いる|る))$/, en: "writes on paper", ja: "書く" },
  { re: /^(?:キーボードを打(?:つ|って(?:いる|る))|タイピング(?:する|して(?:いる|る))?)$/, en: "types on the keyboard", ja: "キーボードを打つ" },
  { re: /^話(?:す|して(?:いる|る))$/, en: "talks", ja: "話す" },
  { re: /^走(?:る|って(?:いる|る))$/, en: "runs", ja: "走る" },
  { re: /^(?:寝る|寝て(?:いる|る)|眠る|眠って(?:いる|る)|居眠り(?:する|して(?:いる|る))?)$/, en: "dozes off at the desk", ja: "居眠りする" },
  { re: /^(?:去る|出て(?:いく|行く)|(?:部屋を)?出る)$/, en: "leaves the room", ja: "部屋を出る" },
  { re: /^(?:座|すわ)(?:る|って(?:いる|る))$/, en: "sits down", ja: "座る" },
  { re: /^(?:立つ|立って(?:いる|る))$/, en: "is standing", ja: "立っている" },
];

/** State-keeping / manner modifiers change the meaning of the main verb: never resolve them from a dictionary keyword. */
export const ACTION_MODIFIER_RE = /まま|ながら|ずに|ないで|つつ/;

/** Resolve both hand clauses together; partial dictionary hits must not erase the other hand.
 * Unknown compound instructions use the existing full-text translation path instead.
 */
export function bilateralHandAction(text:string):{en:string;ja:string}|null {
 const clauses=text.trim().replace(/[。.!！]+$/,'').split(/[、,。;；]/).map(s=>s.trim()).filter(Boolean);
 if(clauses.length!==2)return null;
 const subject='(右手|左手|片手|一方の手|反対の手|もう片方の手|他方の手)';
 const raise=new RegExp('^'+subject+'(?:は|を)?肩(?:の高さ|の位置)(?:へ|に|まで)?(?:上げ|挙げ|あげ)(?:る|て|ている|たまま)?$');
 const rest=new RegExp('^'+subject+'(?:は|を)?キーボード(?:の上)?(?:に|へ)(?:置(?:く|いた|き)(?:まま)?|残(?:す|した|し)(?:まま)?|保つ)$');
 let up:RegExpMatchArray|null=null,down:RegExpMatchArray|null=null;
 for(const clause of clauses){const u=clause.match(raise),d=clause.match(rest);if(u&&!up)up=u;else if(d&&!down)down=d;else return null;}
 if(!up||!down)return null;
 const explicit=(hand:string)=>hand==='右手'?'right':hand==='左手'?'left':null;
 const a=explicit(up[1]),b=explicit(down[1]);
 if(a&&b&&a===b)return null;
 const relative=(hand:string)=>['反対の手','もう片方の手','他方の手'].includes(hand);
 if(!a&&!b&&!relative(down[1])&&!relative(up[1]))return null;
 const raised=a??(b?(b==='right'?'left':'right'):null),resting=b??(a?(a==='right'?'left':'right'):null);
 const raisedPhrase=raised?`the ${raised} hand`:'one hand',restingPhrase=resting?`the ${resting} hand`:'the opposite hand';
 return {en:`raises ${raisedPhrase} to shoulder height while keeping ${restingPhrase} on the keyboard`,ja:text.trim().replace(/[。.!！]+$/,'')};
}

/** Dictionary lookup per " / " part. Returns null when any part is unknown (then a pure text translation is used). */
export function lookupAction(text: string): { en: string; ja: string } | null {
  const parts = String(text).split(/\s*[\/／]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const found: Array<{ en: string; ja: string }> = [];
  for (const p of parts) {
    const bilateral=bilateralHandAction(p);
    if(bilateral){found.push(bilateral);continue;}
    // Never discard an unparsed second clause by matching one keyword (e.g. keyboard).
    const whole=p.replace(/[。.!！\s]+$/,'').trim();
    if(/[、,。;；]/.test(whole)||/(?:反対|もう片方|他方)の手/.test(whole)||ACTION_MODIFIER_RE.test(whole))return null;
    // Exact whole-phrase match only (see ACTION_DICT).
    const hit = ACTION_DICT.find((d) => d.re.test(whole));
    if (!hit) return null;
    found.push({ en: hit.en, ja: hit.ja });
  }
  return { en: found.map((f) => f.en).join(" and "), ja: found.map((f) => f.ja).join("、") };
}

type HandSide='left'|'right';
const SURFACE_EN:Record<string,string>={机:'desk',テーブル:'table',椅子:'chair',イス:'chair',いす:'chair',キーボード:'keyboard',手すり:'railing'};
const SURFACE_JA='(机|テーブル|椅子|イス|いす|キーボード|手すり)(の(?:縁|端|上|背もたれ|背))?';
const CONTACT_JA='(?:ついて|つき|つく|付いて|付けて|置いて|置き|置く|置いた|添えて|添え|添える|掛けて|かけて|かける|乗せる|乗せて|のせる|のせて)';
const HAND_JA='(右手|左手|両手|片手|手)';
/** 「机に片手を置く」 (surface first) and 「片手を机に置く」 (hand first). */
const SUPPORT_SURFACE_FIRST=new RegExp(SURFACE_JA+'に'+HAND_JA+'を'+CONTACT_JA,'g');
const SUPPORT_HAND_FIRST=new RegExp(HAND_JA+'を'+SURFACE_JA+'に'+CONTACT_JA,'g');
/** 「片手を軽く上げる」; 両手 is a different (dictionary) action. */
const RAISE_ONE_HAND=/(右手|左手|片手|(?<![両片右左])手)を(軽く|少し|そっと|高く)?(?:上げ|挙げ|あげ)/;
const sideOf=(hand:string):HandSide|null=>hand==='右手'?'right':hand==='左手'?'left':null;
const otherSide=(side:HandSide):HandSide=>side==='left'?'right':'left';

/** How an existing hand makes the requested surface contact. An occupied hand is never replaced by an invented free hand:
 * it keeps its object while resting on the surface (or sets it down there first). The action itself is never dropped. */
export function surfaceContactHandUse(hand:string,where:string,occupiedHands:readonly HandSide[],bothArmsItem?:string):string {
 const keep=`if that hand holds an object, it keeps holding it while resting on ${where} (or sets the object down on ${where} first)`;
 const side=sideOf(hand);
 // One object held with both hands/arms: it moves to one arm so the requested hand is real (never a third hand).
 if(bothArmsItem&&hand!=='両手')return `places ${side?`the existing ${side} hand`:'one existing hand'} on ${where}; ${oneArmClause(bothArmsItem)}`;
 if(side)return occupiedHands.includes(side)?`places the existing ${side} hand on ${where}; ${keep}`:`places the existing ${side} hand on ${where}`;
 if(hand==='両手')return occupiedHands.length?`places both existing hands on ${where}; a hand that holds an object keeps holding it while resting on ${where} (or sets the object down on ${where} first)`:`places both existing hands on ${where}`;
 if(occupiedHands.length===1)return `places the free ${otherSide(occupiedHands[0])} hand on ${where}; the ${occupiedHands[0]} hand keeps holding its object`;
 if(occupiedHands.length===2)return `places one existing hand on ${where}; ${keep}`;
 return `places one existing hand on ${where}`;
}

/** The both-hands object stays with its owner, now on one arm (handConflict.ts). */
const oneArmClause=(item:string)=>`the ${item} stays held against the body by the other arm only`;

/** Raising one hand while a hand holds something: the object rises with that same hand, never a third hand (null = nothing to add). */
export function raiseHandUse(hand:string,degree:string|undefined,occupiedHands:readonly HandSide[],bothArmsItem?:string):string|null {
 const deg=degree==='軽く'?' lightly':degree==='少し'?' slightly':degree==='そっと'?' gently':degree==='高く'?' high':'';
 const side=sideOf(hand);
 if(bothArmsItem)return `raises ${side?`the existing ${side} hand`:'one existing hand'}${deg}; ${oneArmClause(bothArmsItem)}`;
 if(side)return occupiedHands.includes(side)?`raises the existing ${side} hand${deg}; it keeps holding its object, and the object rises together with that same hand; the other hand stays where it is`:null;
 if(!occupiedHands.length)return null;
 return `raises one existing hand${deg}; if it holds an object, the object rises together with that same hand; the other hand stays where it is`;
}

/** Retain source-language hand constraints when a short text translation drops them, and say how an occupied hand
 * performs the action. The translated action sentence is always kept (2026-10-19: a blocked surface contact used to
 * replace it with a bare "cannot use an occupied hand" note, so nothing moved). Surface names come only from the
 * operator text; this never declares an occupied hand free and never adds a hand.
 */
export function preserveActionConditions(original:string,translated:string,occupiedHands:readonly HandSide[]=[],bothArmsItem?:string):string {
 const uses:string[]=[];const notes:string[]=[];let out=translated.trim();
 const contact=(surface:string,part:string|undefined,hand:string)=>{
  const noun=SURFACE_EN[surface];
  const where=part&&/縁|端/.test(part)?`the edge of the ${noun}`:part&&/背/.test(part)?`the back of the ${noun}`:`the ${noun}`;
  // The translation lost the contact: restore it in the action sentence itself.
  if(!new RegExp(`\\b${noun}\\b`,'i').test(out)){
   const side=sideOf(hand);
   const which=side?`the ${side} hand`:hand==='両手'?'both hands':'one hand';
   out=`${out.replace(/[.\s]+$/,'')}, and places ${which} on ${where}`;
  }
  uses.push(surfaceContactHandUse(hand,where,occupiedHands,bothArmsItem));
  return '';
 };
 const unsupported=original
  .replace(SUPPORT_SURFACE_FIRST,(_m,surface:string,part:string|undefined,hand:string)=>contact(surface,part,hand))
  .replace(SUPPORT_HAND_FIRST,(_m,hand:string,surface:string,part:string|undefined)=>contact(surface,part,hand));
 const raise=unsupported.match(RAISE_ONE_HAND);
 if(raise){const use=raiseHandUse(raise[1],raise[2],occupiedHands,bothArmsItem);if(use)uses.push(use);}
 // Preserve an unparsed hand/holding modifier verbatim rather than silently reducing it
 // to the first recognized action. It is subordinate to observed grips, never a new free-hand claim.
 if(/(?:持|握|抱|掴|つか|支え|添え|まま|ながら|つつ|反対の手|もう片方の手|他方の手)/.test(unsupported))notes.push(`Additional operator hand/object constraints (apply only where compatible with original occupied-hand grips; never invent extra hands): ${JSON.stringify(original)}.`);
 if(!uses.length&&!notes.length)return translated;
 const parts=[`${out.replace(/[.\s]+$/,'')}.`];
 for(const use of new Set(uses))parts.push(`Hand use: ${use}; exactly two hands. Never add an extra hand or arm.`);
 parts.push(...notes);
 return [...new Set(parts)].join(' ');
}

/** A translated state-keeping phrase must fit the observed posture: a standing person cannot "stay seated". */
export function adaptActionToPosture(action:string,pose?:string):string {
 const p=String(pose??'').toLowerCase();
 const seated=/\b(?:seated|sitting|sits)\b/.test(p);
 const standing=!seated&&/\b(?:stand\w*|leaning|walking)\b/.test(p);
 let a=action.trim();
 if(standing&&/^(?:stays|remains|keeps)\s+(?:seated|sitting)\b/i.test(a)){
  a=a.replace(/^(?:stays|remains|keeps)\s+(?:seated|sitting)\s+(on|in|at)\s+/i,'sits $1 ').replace(/^(?:stays|remains|keeps)\s+(?:seated|sitting)\b/i,'sits down').replace(/\blooks down at\b/i,'looks at');
 }
 if(seated&&/^(?:stays|remains|keeps)\s+standing\b/i.test(a))a=a.replace(/^(?:stays|remains|keeps)\s+standing\b/i,'stands up');
 return a;
}

export type ActionTranslator=(text:string,pose?:string)=>Promise<string|null>;
/**
 * Operator action -> English verb phrase. The dictionary is used only on an exact whole-phrase match; a phrase with a
 * modifier (まま / ながら / ずに ...) or not in the dictionary goes to the meaning-preserving text translation, whose
 * result is used verbatim (only adapted to the observed posture). `ja` is set only for a dictionary hit.
 */
export async function resolveActionPhrase(text:string,translate:ActionTranslator,pose?:string):Promise<{en:string|null;ja?:string;source:'dictionary'|'translation'|'none'}> {
 const hit=lookupAction(text);
 if(hit)return {en:hit.en,ja:hit.ja,source:'dictionary'};
 const translated=await translate(text,pose);
 return translated?{en:adaptActionToPosture(translated,pose),source:'translation'}:{en:null,source:'none'};
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
