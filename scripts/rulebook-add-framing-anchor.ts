/**
 * One-off (2026-10-20): true-positive framing_drift rejections on camera input (output zoomed / tilted / shifted against the
 * NOW frame). Prompt-only first: derive the next rulebook version from the active one with one framing anchor sentence for
 * every scene (imagePrompt.framingAnchorRule, placed right after the obstruction lead, which stays first). The camera
 * sentences of quality.longSpan ("identical camera position, zoom and viewpoint ... Do not zoom, shift or re-compose the view")
 * are merged into it, so the prompt does not say the same thing twice. Not tracked by the automatic improver.
 *
 * Usage:
 *   node_modules\.bin\tsx.cmd scripts\rulebook-add-framing-anchor.ts                     # write the new version only (NOT activated)
 *   node_modules\.bin\tsx.cmd scripts\rulebook-add-framing-anchor.ts --activate-existing # activate the newest version carrying it
 * The running server hot-reloads the rulebook (getRulebook re-reads on mtime): activating changes live prompts at once.
 * Re-running adds another version only when the active version lacks the sentence.
 */
import '../server/loadEnv';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { getRulebook, hasFramingAnchor, listVersions, loadRulebook, setActive, withFramingAnchor, writeRulebook } from '../server/generation/rulebook';

function main() {
  const args = process.argv.slice(2);
  const reason = 'framing anchor 2026-10-20 (framing_drift on camera input, prompt-only first)';
  if (args.includes('--activate-existing')) {
    const v = [...listVersions()].reverse().find((n) => { const rb = loadRulebook(n); return !!rb && hasFramingAnchor(rb); });
    if (v === undefined) throw new Error('no rulebook version carries the framing anchor; run without flags first');
    setActive(v, { by: 'user', reason });
    console.log(`activated v${v}`);
    return;
  }
  const cur = getRulebook();
  if (hasFramingAnchor(cur)) {
    console.log(`v${cur.version} already has the framing anchor`);
    return;
  }
  const existing = [...listVersions()].reverse().find((n) => { const rb = loadRulebook(n); return !!rb && rb.parent === cur.version && hasFramingAnchor(rb); });
  if (existing !== undefined) {
    console.log(`v${existing} already carries the framing anchor (not active). Activate: node_modules\\.bin\\tsx.cmd scripts\\rulebook-add-framing-anchor.ts --activate-existing`);
    return;
  }
  const next = withFramingAnchor(cur, Math.max(cur.version, ...listVersions()) + 1);
  writeRulebook(next);
  appendFileSync(
    path.join(process.cwd(), 'rulebook', 'CHANGELOG.md'),
    `\n## v${next.version} — ${next.createdAt}（framing_drift 対策・プロンプトのみ先行）\n- 元: v${cur.version}。全シーンの画像プロンプトに固定文 imagePrompt.framingAnchorRule を追加（「入力と同じ画角・ズーム・チルト・カメラ位置。四辺に接する内容はそのまま。構図変更・クロップ・ズームをしない」）。遮蔽時は既存の obstructedLeadRule が先頭のまま、その直後に置く。\n- quality.longSpan のカメラ文（identical camera position, zoom and viewpoint / Do not zoom, shift or re-compose the view）はこの文に統合して削除（重複させない）。\n- 書き出しのみ（未有効化）。有効化: node_modules\\.bin\\tsx.cmd scripts\\rulebook-add-framing-anchor.ts --activate-existing\n- 自動改善の検証・ロールバック対象外（ユーザー判断のため）。\n`
  );
  console.log(`created v${next.version} (not activated)`);
}

if (process.argv[1] && /rulebook-add-framing-anchor/.test(process.argv[1])) main();
