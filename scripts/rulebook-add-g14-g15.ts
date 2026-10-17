/**
 * One-off (2026-10-16, user-approved): derive the next rulebook version from the active one with the G-14 / G-15 rules
 * (held items stay, no newly drawn face) and make it active. Not an automatic-improvement change: the improver does not
 * track it, so it is never rolled back automatically. Re-running adds another version only when the rules are missing.
 */
import '../server/loadEnv';
import { getRulebook, listVersions, setActive, writeRulebook } from '../server/generation/rulebook';
import { appendFileSync } from 'node:fs';
import path from 'node:path';

const HOLDINGS =
  'Items a person holds or carries in the input (for example a microphone, phone, cup or bag) stay in their hands or on them in the same form; none of them disappears, is replaced or is put down unless the instruction says so.';
const NO_NEW_FACE =
  'Do not draw a face that is not visible in the input: a person seen from behind or in profile stays turned away and does not turn to show the face; never create a new frontal face.';

const cur = getRulebook();
if (cur.imagePrompt.holdingsRule === HOLDINGS && cur.imagePrompt.noNewFaceRule === NO_NEW_FACE) {
  console.log(`v${cur.version} already has G-14 / G-15`);
} else {
  const next = JSON.parse(JSON.stringify(cur));
  next.version = Math.max(cur.version, ...listVersions()) + 1;
  next.parent = cur.version;
  next.createdAt = new Date().toISOString();
  next.note = 'user-approved G-14 (held items stay) and G-15 (no newly drawn face)';
  next.imagePrompt.holdingsRule = HOLDINGS;
  next.imagePrompt.noNewFaceRule = NO_NEW_FACE;
  for (const t of ['item removed from hands, missing held item', 'newly drawn face, face turned to the camera']) if (!next.negative.added.includes(t)) next.negative.added.push(t);
  const line = 'Never make a person turn around to show a face that is not visible in this frame, and never remove an item a person holds.';
  if (!next.vlm.extraInstructions.includes(line)) next.vlm.extraInstructions.push(line);
  writeRulebook(next);
  setActive(next.version, { by: 'user', reason: 'G-14 / G-15 (candidates C-01 / C-02 approved)' });
  appendFileSync(
    path.join(process.cwd(), 'rulebook', 'CHANGELOG.md'),
    `## v${next.version} — ${next.createdAt}（ユーザー承認）\n- 元: v${cur.version}。G-14（持ち物を維持）と G-15（見えていない顔を新しく描かない）を固定ルールとして追加: imagePrompt.holdingsRule / noNewFaceRule、negative.added に 2 件、vlm.extraInstructions に 1 文。\n- 自動改善の検証・ロールバック対象外（ユーザー判断のため）。\n\n`
  );
  console.log(`created and activated v${next.version}`);
}
