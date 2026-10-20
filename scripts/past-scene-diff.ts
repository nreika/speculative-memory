/**
 * Offline (no VLM / ComfyUI call): rebuild the past-scene (C) texts of archived captures with the G-26 helpers and print
 * old/new as Markdown. Usage: npx tsx scripts/past-scene-diff.ts <archive dir>...
 * The planner output itself cannot be re-run offline; the new contract only changes what the VLM writes live.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pastScenePrediction, pastJapaneseText, pastMomentLead, pastMainChangeLine, buildStateLedger, judgePastContinuity, stateLedgerNote } from '../server/generation/pastScene';
import { emptyRoomObjectChange } from '../server/generation/scenarioGuard';
import { readHistory, recentEntries, historyLimit, historyWindowMin } from '../server/history/sceneHistory';

const history = readHistory();
const out: string[] = [];
for (const dir of process.argv.slice(2)) {
  const base = path.basename(dir);
  const j = JSON.parse(fs.readFileSync(path.join(dir, `${base}_prompts.json`), 'utf8'));
  const c = j.scenes.find((s: any) => s.letter === 'C');
  const g = j.vlm?.guard ?? {};
  const people = g.people ?? [];
  const now = Date.parse(j.capturedAt);
  const empty = people.length === 0;
  const ledger = buildStateLedger({ history: recentEntries(history, { limit: historyLimit(), windowMin: historyWindowMin(), now }), people, sceneNow: g.scene, now });
  const cont = judgePastContinuity({ ledger, people, spanSec: c.distanceSec });
  const newPred = empty ? (emptyRoomObjectChange(g.scene, j.vlm?.parsedScenarios?.[0]?.foreground_object, c.distanceSec, 2) ?? c.predictionPrompt) : pastScenePrediction(c.predictionPrompt);
  const oldMain = /\n\nMain change that must be clearly visible: [^\n]*$/;
  let img = String(c.imagePromptFull).split(c.predictionPrompt).join(newPred).replace(newPred.replace(/\.$/, '') + '..', newPred);
  img = pastMomentLead(c.distanceSec, empty, cont.verdict) + (oldMain.test(img) ? img.replace(oldMain, pastMainChangeLine(newPred)) : img);
  out.push(`## ${base} (C, ${c.distanceSec} s${empty ? ', empty room' : ''})`, '',
    `- history: ${ledger.rows} rows; continuity = **${cont.verdict}** (${cont.reason})`, '',
    '| | old | new |', '|---|---|---|',
    `| predictionPrompt | ${c.predictionPrompt} | ${newPred} |`,
    `| display (ja) | ${c.scenarioDescription} | ${pastJapaneseText(c.scenarioDescription)} (offline: sanitiser on the old text; live, the translation is made from the new English with the past-tense rule) |`, '',
    '<details><summary>planner note added (STATE LEDGER / continuity)</summary>', '', '```', stateLedgerNote({ ledger, continuity: cont, pastSpanSec: c.distanceSec }) || '(none)', '```', '</details>', '',
    '<details><summary>imagePromptFull old</summary>', '', '```', c.imagePromptFull, '```', '</details>', '',
    '<details><summary>imagePromptFull new</summary>', '', '```', img, '```', '</details>', '');
}
process.stdout.write(out.join('\n') + '\n');
