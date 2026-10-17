/**
 * One-off (2026-10-17, user-approved after scripts/obstruct-ab.ts): G-07 supplement 3 — when obstructed, the first sentence of
 * the image prompt says the obstruction is the frontmost layer. Not tracked by the automatic improver.
 */
import '../server/loadEnv';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { getRulebook, listVersions, setActive, writeRulebook } from '../server/generation/rulebook';

const LEAD =
  'The {by} is the frontmost layer of the whole image; everything seen through {through} stays dim, blurred and partially hidden by {pattern}, exactly as in the input.';

const cur = getRulebook();
if (cur.imagePrompt.obstructedLeadRule === LEAD) {
  console.log(`v${cur.version} already has it`);
} else {
  const next = JSON.parse(JSON.stringify(cur));
  next.version = Math.max(cur.version, ...listVersions()) + 1;
  next.parent = cur.version;
  next.createdAt = new Date().toISOString();
  next.note = 'user-approved G-07 supplement 3: obstruction is the frontmost layer (first sentence, obstructed only)';
  next.imagePrompt.obstructedLeadRule = LEAD;
  writeRulebook(next);
  setActive(next.version, { by: 'user', reason: 'G-07 supplement 3 (obstruction lead sentence)' });
  appendFileSync(
    path.join(process.cwd(), 'rulebook', 'CHANGELOG.md'),
    `## v${next.version} — ${next.createdAt}（ユーザー承認）\n- 元: v${cur.version}。G-07 補足 3: 遮蔽と判定された撮影では、画像プロンプトの先頭に「遮蔽物（obstructedBy）が画像の最前面で、透けて見える物はぼやけて暗いまま」の文を置く（imagePrompt.obstructedLeadRule）。実験 scripts/obstruct-ab.ts（同 seed・同プロンプト）で、現行はモニターがメッシュの手前に出る・先頭に置くと奥に収まる・denoise 0.6 も収まる（不採用）。\n- 自動改善の検証・ロールバック対象外（ユーザー判断のため）。\n\n`
  );
  console.log(`created and activated v${next.version}`);
}
