/**
 * One-off (2026-10-17, user-approved): G-07 supplement 2 — things behind an obstruction (mesh chair back) stay behind and as
 * blurred/dark as in the input. Appended to obstructedRule (obstructed captures only) + negative.obstructed (obstructed only).
 * Not tracked by the automatic improver.
 */
import '../server/loadEnv';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { getRulebook, listVersions, setActive, writeRulebook } from '../server/generation/rulebook';

const SENTENCE =
  'Things behind the obstruction stay behind it: do not bring them in front of the obstruction or make their outlines sharper; keep them exactly as hazy, dark or mesh-filtered as they appear in the input.';
const NEG = 'sharp monitor in front of the mesh, objects in front of the chair back, objects pasted on top of the obstruction';

const cur = getRulebook();
if (!cur.imagePrompt.obstructedRule) throw new Error('active version has no obstructedRule (run rulebook-add-g16.ts first)');
if (cur.imagePrompt.obstructedRule.includes(SENTENCE) && cur.negative.obstructed === NEG) {
  console.log(`v${cur.version} already has it`);
} else {
  const next = JSON.parse(JSON.stringify(cur));
  next.version = Math.max(cur.version, ...listVersions()) + 1;
  next.parent = cur.version;
  next.createdAt = new Date().toISOString();
  next.note = 'user-approved G-07 supplement 2: depth order behind an obstruction';
  if (!next.imagePrompt.obstructedRule.includes(SENTENCE)) next.imagePrompt.obstructedRule += ' ' + SENTENCE;
  next.negative.obstructed = NEG;
  writeRulebook(next);
  setActive(next.version, { by: 'user', reason: 'G-07 supplement 2 (depth order behind an obstruction)' });
  appendFileSync(
    path.join(process.cwd(), 'rulebook', 'CHANGELOG.md'),
    `## v${next.version} — ${next.createdAt}（ユーザー承認）\n- 元: v${cur.version}。G-07 補足 2（遮蔽物の奥の物を手前に出さない・輪郭をくっきりさせない）: imagePrompt.obstructedRule に 1 文、negative.obstructed（遮蔽と判定された撮影だけ）を追加。根拠: Gen_b_2026-10-17_12-49-13（-541 B）。\n- 自動改善の検証・ロールバック対象外（ユーザー判断のため）。\n\n`
  );
  console.log(`created and activated v${next.version}`);
}
