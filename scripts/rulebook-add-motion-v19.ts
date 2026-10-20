/**
 * One-off (2026-10-19, user request 「動作が出ない件、調べて直して」): derive the next rulebook version from the active one so
 * that the requested motion is no longer frozen or buried by the fixed rules. Not tracked by the automatic improver.
 *
 *   - noNewFaceRule (G-15 kept): head/gaze may move as the action needs; a face not visible in the input is never revealed.
 *     The "a side profile stays a side profile" freeze is dropped (it forbade looking at the desk).
 *   - holdingsRule (G-14 kept): a held object stays in the same hand and moves WITH it (replaces "Preserve the original grip
 *     during the requested movement", which read as "do not move that hand").
 *   - extraConstraints: the five near-identical "never add objects" sentences collapse into one.
 *
 * Usage:
 *   node_modules\.bin\tsx.cmd scripts\rulebook-add-motion-v19.ts               # write the new version AND activate it
 *   node_modules\.bin\tsx.cmd scripts\rulebook-add-motion-v19.ts --no-activate # only write rulebook.v<N>.json
 *   node_modules\.bin\tsx.cmd scripts\rulebook-add-motion-v19.ts --activate-existing  # activate an already written version
 * The rulebook is hot-reloaded by the running server (getRulebook re-reads on mtime): activating changes live prompts
 * immediately, without a restart. Re-running adds another version only when the texts are missing.
 */
import '../server/loadEnv';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { getRulebook, listVersions, loadRulebook, setActive, writeRulebook, type Rulebook } from '../server/generation/rulebook';

export const MOTION_HOLDINGS =
  'Each held or worn belonging stays with its original owner, with the same shape and size. Keep the original count of each belonging; another person never receives a copy. A held object stays in the same hand and moves together with that hand during the requested movement; never add a hand to free it.';
export const MOTION_NO_NEW_FACE =
  'The head and gaze may move as the requested action needs (looking at something, turning the head slightly), but never reveal a face that is not visible in the input and never turn a face toward the camera to show new facial features: a person viewed from behind remains back-facing with the face hidden, and a head cut by the frame edge remains cut by the frame.';
export const MOTION_OBJECTS = 'Only alter existing objects; never add objects that are not visible in the original photo, even if implied by context.';

/** The next version's content (pure; used by the script and by docs/tests). */
export function withMotionRules(cur: Rulebook, version: number, now = new Date()): Rulebook {
  const next: Rulebook = JSON.parse(JSON.stringify(cur));
  next.version = version;
  next.parent = cur.version;
  next.createdAt = now.toISOString();
  next.note = 'user request 2026-10-19 (motion not visible): G-15 allows head/gaze motion without revealing a hidden face; G-14 held object moves with its hand; duplicate object sentences collapsed to one.';
  next.imagePrompt.holdingsRule = MOTION_HOLDINGS;
  next.imagePrompt.noNewFaceRule = MOTION_NO_NEW_FACE;
  next.imagePrompt.extraConstraints = [MOTION_OBJECTS];
  return next;
}

const hasMotionRules = (rb: Rulebook) =>
  rb.imagePrompt.holdingsRule === MOTION_HOLDINGS && rb.imagePrompt.noNewFaceRule === MOTION_NO_NEW_FACE &&
  rb.imagePrompt.extraConstraints.length === 1 && rb.imagePrompt.extraConstraints[0] === MOTION_OBJECTS;

function main() {
  const args = process.argv.slice(2);
  const reason = 'motion fix 2026-10-19 (head/gaze may move without revealing a hidden face; held object moves with its hand; one object sentence)';
  if (args.includes('--activate-existing')) {
    const v = Math.max(...listVersions());
    const rb = loadRulebook(v);
    if (!rb || !hasMotionRules(rb)) throw new Error(`latest version v${v} does not carry the motion rules`);
    setActive(v, { by: 'user', reason });
    console.log(`activated v${v}`);
    return;
  }
  const cur = getRulebook();
  if (hasMotionRules(cur)) {
    console.log(`v${cur.version} already has the motion rules`);
    return;
  }
  const next = withMotionRules(cur, Math.max(cur.version, ...listVersions()) + 1);
  writeRulebook(next);
  const activate = !args.includes('--no-activate');
  if (activate) setActive(next.version, { by: 'user', reason });
  appendFileSync(
    path.join(process.cwd(), 'rulebook', 'CHANGELOG.md'),
    `\n## v${next.version} — ${next.createdAt}（ユーザー依頼「動作が出ない件、調べて直して」）\n- 元: v${cur.version}。G-15 は維持したまま noNewFaceRule を変更: 動作に必要な頭・視線の動き（見る、少し向きを変える）は許可し、入力で見えていない顔は出さない（後ろ姿は後ろ姿、画面端で切れた頭は切れたまま）。「a side profile stays a side profile」の固定を削除。\n- G-14 は維持したまま holdingsRule の「Preserve the original grip during the requested movement」を「持った物は同じ手に残り、その手と一緒に動く。手を足さない」に置換（動かすなと読まれていた）。\n- extraConstraints のほぼ同文 5 文（物を足さない）を 1 文に統合。照明・ホワイトバランス・人数・同一性・持ち物の制約は変更なし。\n- ${activate ? '同時に有効化。' : '書き出しのみ（未有効化）。有効化: scripts/rulebook-add-motion-v19.ts --activate-existing'}\n- 自動改善の検証・ロールバック対象外（ユーザー判断のため）。\n`
  );
  console.log(`created v${next.version}${activate ? ' and activated it' : ' (not activated)'}`);
}

if (process.argv[1] && /rulebook-add-motion-v19/.test(process.argv[1])) main();
