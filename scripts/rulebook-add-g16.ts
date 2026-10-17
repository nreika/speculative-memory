/**
 * One-off (2026-10-17, user-approved): next rulebook version = active + G-16 (no new text/numbers/clock/UI on screens) and the
 * G-07 supplement (obstructed camera: keep the obstruction and the composition). Not tracked by the automatic improver
 * (user decisions are never rolled back automatically).
 */
import '../server/loadEnv';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { getRulebook, listVersions, setActive, writeRulebook } from '../server/generation/rulebook';

const NO_NEW_TEXT =
  'Do not add any new text, numbers, clock or user interface to any screen, sign or surface that is not in the input; every screen keeps exactly the content it has in the input, or stays dark if it is dark. The only digits that may change are on a clock or number sign that is already visible in the input.';
const OBSTRUCTED =
  'A large object right in front of the camera (such as a chair backrest) blocks much of the view in the input: keep that object and the whole composition exactly as in the input; do not remove it and do not draw the room behind it or a new, brighter room.';
const NEG = 'clock, digits, text on screen, garbled text, numbers';

const cur = getRulebook();
if (cur.imagePrompt.noNewTextRule === NO_NEW_TEXT && cur.imagePrompt.obstructedRule === OBSTRUCTED && cur.negative.noNewText === NEG) {
  console.log(`v${cur.version} already has G-16`);
} else {
  const next = JSON.parse(JSON.stringify(cur));
  next.version = Math.max(cur.version, ...listVersions()) + 1;
  next.parent = cur.version;
  next.createdAt = new Date().toISOString();
  next.note = 'user-approved G-16 (no new text/clock/UI) and G-07 supplement (obstructed: keep the composition)';
  next.imagePrompt.noNewTextRule = NO_NEW_TEXT;
  next.imagePrompt.obstructedRule = OBSTRUCTED;
  next.negative.noNewText = NEG;
  writeRulebook(next);
  setActive(next.version, { by: 'user', reason: 'G-16 and G-07 supplement' });
  appendFileSync(
    path.join(process.cwd(), 'rulebook', 'CHANGELOG.md'),
    `## v${next.version} — ${next.createdAt}（ユーザー承認）\n- 元: v${cur.version}。G-16（画面・表示物に新しい文字・数字・時計・UI を描かない: imagePrompt.noNewTextRule、negative.noNewText は時計ずらしのないときだけ）と G-07 補足（遮蔽時は遮蔽物と構図を維持: imagePrompt.obstructedRule、遮蔽と判定された撮影だけ）を追加。\n- 自動改善の検証・ロールバック対象外（ユーザー判断のため）。\n\n`
  );
  console.log(`created and activated v${next.version}`);
}
