/**
 * One-off (2026-10-17, user-approved): G-17 — no light artifacts (lens flare, light streaks, rainbow lines, glow, sparkles);
 * in an empty room the light changes in brightness and colour temperature only. Next rulebook version = active + G-17.
 * Not tracked by the automatic improver.
 */
import '../server/loadEnv';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { getRulebook, listVersions, setActive, writeRulebook } from '../server/generation/rulebook';
import { TONE_IMAGE_RULES } from '../server/generation/ruleTexts';

const NO_ARTIFACT = 'No lens flare, no light streaks, no rainbow lines, no added glow or sparkles.';
const EMPTY_LIGHT = 'In this empty room only the brightness and colour temperature of the light change; the light keeps its shape and the shadows stay where they are.';
const EMPTY_TONE = [
  'Amount of change: keep it minimal. The brightness changes only barely.',
  'Amount of change: keep it small. The brightness and colour temperature shift slightly.',
  'Amount of change: make it clearly visible. The brightness and colour temperature of the room change clearly, somewhat brighter or dimmer, warmer or cooler, as far as the time span allows; only brightness and colour temperature change, the light keeps its shape and the shadows stay where they are.',
  'Amount of change: make it large. A big shift of brightness and colour temperature, or a visible lamp switching on or off, as far as the time span allows; only brightness and colour temperature change, the light keeps its shape and everything else in the room stays identical.',
];
const NEG = 'lens flare, light streaks, rainbow lines, glow, sparkles';
const VLM = 'In an empty room the light may change only in brightness and colour temperature; never describe light rays, streaks, flares, glow or moved shadows.';

const cur = getRulebook();
if (cur.imagePrompt.noLightArtifactRule === NO_ARTIFACT && cur.imagePrompt.emptyRoomLightRule === EMPTY_LIGHT) {
  console.log(`v${cur.version} already has G-17`);
} else {
  const next = JSON.parse(JSON.stringify(cur));
  next.version = Math.max(cur.version, ...listVersions()) + 1;
  next.parent = cur.version;
  next.createdAt = new Date().toISOString();
  next.note = 'user-approved G-17: no light artifacts; empty-room light = brightness and colour temperature only';
  next.imagePrompt.noLightArtifactRule = NO_ARTIFACT;
  next.imagePrompt.emptyRoomLightRule = EMPTY_LIGHT;
  next.toneImage = { people: cur.toneImage?.people ?? TONE_IMAGE_RULES, emptyRoom: EMPTY_TONE };
  if (!next.negative.added.includes(NEG)) next.negative.added.push(NEG);
  if (!next.vlm.extraInstructions.includes(VLM)) next.vlm.extraInstructions.push(VLM);
  writeRulebook(next);
  setActive(next.version, { by: 'user', reason: 'G-17 (no light artifacts; empty-room light = brightness and colour temperature only)' });
  appendFileSync(
    path.join(process.cwd(), 'rulebook', 'CHANGELOG.md'),
    `## v${next.version} — ${next.createdAt}（ユーザー承認）\n- 元: v${cur.version}。G-17: 画像プロンプトに「レンズフレア・光条・虹色の線・光彩・きらめきを描かない」（noLightArtifactRule、両テンプレート）、無人時は「明るさと色温度だけが変わる」（emptyRoomLightRule）、toneImage.emptyRoom の 4 段階から「影が動く・長い影」等の光の形状変化を除去、負のプロンプトと計画への 1 文を追加。\n- 自動改善の検証・ロールバック対象外（ユーザー判断のため）。\n\n`
  );
  console.log(`created and activated v${next.version}`);
}
