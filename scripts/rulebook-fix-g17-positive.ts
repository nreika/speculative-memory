/**
 * 2026-10-17: G-17 correction. Experiment (scripts/obstruct-ab.ts, same seed): the v12 sentence "No lens flare, no light streaks,
 * no rainbow lines, ..." made the image model DRAW rainbow streaks (like negated person words, G-01); replacing it by a positive
 * sentence removed them. Next version = active with the positive wording (and the planner line without artifact words).
 */
import '../server/loadEnv';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { getRulebook, listVersions, setActive, writeRulebook } from '../server/generation/rulebook';

const POSITIVE = 'The lighting stays natural and soft, exactly like an ordinary unprocessed photograph.';
const OLD_VLM = 'In an empty room the light may change only in brightness and colour temperature; never describe light rays, streaks, flares, glow or moved shadows.';
const NEW_VLM = 'In an empty room describe the light change only as the room becoming slightly brighter, dimmer, warmer or cooler.';

const cur = getRulebook();
if (cur.imagePrompt.noLightArtifactRule === POSITIVE) {
  console.log(`v${cur.version} already has the positive wording`);
} else {
  const next = JSON.parse(JSON.stringify(cur));
  next.version = Math.max(cur.version, ...listVersions()) + 1;
  next.parent = cur.version;
  next.createdAt = new Date().toISOString();
  next.note = 'G-17 fix: positive wording (the negated artifact words made the model draw them)';
  next.imagePrompt.noLightArtifactRule = POSITIVE;
  next.vlm.extraInstructions = next.vlm.extraInstructions.map((l: string) => (l === OLD_VLM ? NEW_VLM : l));
  writeRulebook(next);
  setActive(next.version, { by: 'user', reason: 'G-17 fix: positive wording instead of negated artifact words' });
  appendFileSync(
    path.join(process.cwd(), 'rulebook', 'CHANGELOG.md'),
    `## v${next.version} — ${next.createdAt}（G-17 の修正）\n- 元: v${cur.version}。v12 の「No lens flare, no light streaks, no rainbow lines…」は、名指しした虹色の光条をむしろ描かせた（同 seed の実験: v12 再現=光条あり、肯定表現に置換=光条なし。人物語の否定文 G-01 と同じ逆効果）。noLightArtifactRule を肯定表現「The lighting stays natural and soft, exactly like an ordinary unprocessed photograph.」に置換、計画への 1 文も光条等の語を使わない言い方に変更。\n\n`
  );
  console.log(`created and activated v${next.version}`);
}
