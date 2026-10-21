import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScenarioPredictionPrompt, PAST_SCENE_USER_WORDS } from '../../services/promptBuilder';
import { PAST_SCENE_JSON_RULE, PAST_TRANSLATION_RULE } from './vlmClient';
import { composeEditInstruction } from './orchestrator';
import { emptyRoomObjectChange, isNoChangeSentence, mentionsPerson, sanitizeEmptyRoomPrediction } from './scenarioGuard';
import {
  buildStateLedger, hasJapanesePresentMarker, hasPresentResultPhrase, judgePastContinuity, pastJapaneseText, pastScenePrediction,
  stateLedgerNote, type PastHistoryRow,
} from './pastScene';
import type { PersonInfo } from './peopleDescribe';

test('G-26 planner: the past contract is added for negative distances only, with the user words and the examples', () => {
  const p = buildScenarioPredictionPrompt(null, 3, undefined, { sceneDistancesSec: [30, 30, -30], presence: 0.5, tone: 0.5 } as any);
  assert.match(p, /PAST-SCENE CONTRACT for Scenario 3: this frame is the END state/);
  assert.match(p, /as it plausibly WAS 30 seconds earlier/);
  assert.match(p, /still unopened or still inside its paper bag/);
  assert.match(p, /if a cup is at the mouth now, earlier it was still on the desk; if a bag is open now, earlier it was still closed/);
  assert.match(p, /SMALLEST coherent difference/);
  assert.match(p, /never as a change that ends in the present: no "now"/);
  assert.ok(p.includes('「たとえば、何かを食べている場合、それが未開封になってるとか、紙袋にはいってるとか、ならわかる」'));
  assert.ok(p.includes('すでに10分以上食事しているときに'));
  assert.ok(p.includes(PAST_SCENE_USER_WORDS));
  const future = buildScenarioPredictionPrompt(null, 3, undefined, { sceneDistancesSec: [5, 60, 600], presence: 0.5, tone: 0.5 } as any);
  assert.doesNotMatch(future, /PAST-SCENE CONTRACT/);
  assert.match(PAST_SCENE_JSON_RULE, /END state/);
  assert.match(PAST_TRANSLATION_RULE, /今では/);
});

test('G-26 sanitiser: a "was originally A, now B" past prediction keeps the earlier state A', () => {
  const src = 'The person was originally holding the container with one hand near their mouth, now they have lowered their hand slightly and are holding the container with both hands, looking forward with a neutral expression.';
  assert.ok(hasPresentResultPhrase(src));
  const out = pastScenePrediction(src);
  assert.equal(out, 'The person is holding the container with one hand near their mouth.');
  assert.ok(!hasPresentResultPhrase(out));
  assert.equal(pastScenePrediction('She reaches for the cup, then lifts it to her mouth.'), 'She reaches for the cup.');
  // nothing to rewrite: unchanged
  const plain = 'The cup is still on the desk next to her right hand; both her hands rest on the desk.';
  assert.equal(pastScenePrediction(plain), plain);
});

test('G-26 sanitiser: Japanese display text drops 今では clauses and ends in the past tense', () => {
  const a = pastJapaneseText('30秒前、人物は元々口の近くで片手で容器を握っていたが、今では手をわずかに下げ、両手で容器を握り、中立の表情で前方を見ている。');
  assert.equal(a, '30秒前、人物は口の近くで片手で容器を握っていた。');
  assert.ok(!hasJapanesePresentMarker(a));
  assert.equal(pastJapaneseText('30秒前、パンはまだ紙袋に入っていたが、現在は机の上で開けられている。'), '30秒前、パンはまだ紙袋に入っていた。');
  assert.equal(pastJapaneseText('30秒前、カップはまだ机の上にある。'), '30秒前、カップはまだ机の上にあった。');
  assert.equal(pastJapaneseText('30秒前、右側の人物は左へ頭を向け、モニターを観察する。'), '30秒前、右側の人物は左へ頭を向け、モニターを観察していた。');
  assert.equal(pastJapaneseText('30秒前、女性は袋を握る。'), '30秒前、女性は袋を握っていた。');
  assert.equal(pastJapaneseText('30 seconds before, the cup was on the desk.'), '30 seconds before, the cup was on the desk.');
});

const seatedCup: PersonInfo = { position: 'right front', pose: 'sitting at the desk', clothes: 'white t-shirt', facing: 'side', holding: 'black container with white lid in both hands' };

test('G-26 image prompt: the past scene carries the EARLIER-moment lead and main-difference line; the future scene does not', () => {
  const c = composeEditInstruction({ predictionPrompt: 'The container is still closed on the desk; both hands rest beside it.', people: [seatedCup], personCount: 1, compactPeople: true, presence: 0.5, tone: 0.5, distanceSec: -30 });
  // 2026-10-21 rebuild: one temporal sentence ("N before image1: ..."), no "undo", the action stated once.
  assert.match(c, /This is 30 seconds before image1: a slightly earlier moment of the same activity\./);
  assert.doesNotMatch(c, /undo|Main difference|Main change/i);
  assert.equal(c.split('The container is still closed on the desk').length - 1, 1);
  const ongoing = composeEditInstruction({ predictionPrompt: 'The container is a little lower.', people: [seatedCup], personCount: 1, compactPeople: true, presence: 0.5, distanceSec: -30, pastContinuity: 'ongoing' });
  assert.match(ongoing, /the same activity one step earlier/);
  const a = composeEditInstruction({ predictionPrompt: 'The person lifts the container.', people: [seatedCup], personCount: 1, compactPeople: true, presence: 0.5, tone: 0.5, distanceSec: 30 });
  assert.doesNotMatch(a, /before image1|EARLIER moment/);
  assert.match(a, /This is 30 seconds later/);
  const generic = composeEditInstruction({ predictionPrompt: 'The cup is still on the desk.', people: [seatedCup], personCount: 1, presence: 0.5, distanceSec: -120 });
  assert.match(generic, /This is 2 minutes before image1/);
  const empty = composeEditInstruction({ predictionPrompt: 'The black office chair still sits a few centimetres further to the right than in the photo.', presence: 0, distanceSec: -30 });
  assert.match(empty, /This is 30 seconds before image1/);
  assert.doesNotMatch(empty, /undo/i);
  assert.ok(!mentionsPerson(empty.split('\n\n')[0]), empty.split('\n\n')[0]);
});

test('G-26 empty room: the past scene gets the REVERSE object change (earlier spot), futures unchanged', () => {
  const W = 'An office with a black office chair and a white shopping bag on the floor.';
  assert.equal(emptyRoomObjectChange(W, null, 30, 0), 'The black office chair is turned a few degrees to the right.');
  const past = emptyRoomObjectChange(W, null, -30, 0)!;
  assert.equal(past, 'The black office chair is still turned a few degrees further to the right than in the photo: its earlier position, before it was turned to the position shown in the photo.');
  const bag = emptyRoomObjectChange(W, null, -30, 1)!;
  assert.match(bag, /still sits a few centimetres further to the left than in the photo: its earlier spot, before it was moved to the spot shown in the photo\./);
  for (const s of [past, bag]) {
    assert.equal(sanitizeEmptyRoomPrediction(s), s.replace(/\.$/, ''));
    assert.ok(!mentionsPerson(s) && !isNoChangeSentence(s) && !hasPresentResultPhrase(s), s);
  }
});

const NOW = Date.parse('2026-10-20T07:15:00Z');
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const eating = (minAgo: number): PastHistoryRow => ({ time: at(minAgo), hasPerson: true, observation: 'A person in a white t-shirt sits at the desk eating from a black container.', people: [{ pose: 'sitting', clothes: 'white t-shirt' }] });

test('G-26 ledger: an activity already seen for 10 minutes is ongoing -> a slightly earlier moment, futures continue it', () => {
  const ledger = buildStateLedger({ history: [eating(10), eating(7), eating(4), eating(1.5)], people: [seatedCup], now: NOW });
  const s = ledger.states.find((x) => x.key === 'object:container')!;
  assert.equal(s.seenNow, true);
  assert.equal(s.durationMin, 10);
  assert.equal(s.lastAbsent, null);
  const c = judgePastContinuity({ ledger, people: [seatedCup], spanSec: -30 });
  assert.equal(c.verdict, 'ongoing');
  assert.equal(c.sinceMin, 10);
  const note = stateLedgerNote({ ledger, continuity: c, pastSpanSec: -30 });
  assert.match(note, /STATE LEDGER \(server-built from HISTORY, 4 rows/);
  assert.match(note, /- container: seen now; this run since \d\d:\d\d \(10 min\)/);
  assert.match(note, /FUTURE CONTINUITY: scenarios AFTER this frame continue the activities/);
  assert.match(note, /the SAME activity was already going on: show a slightly earlier moment of it .*never the unopened/);
});

test('G-26 ledger: a state that began within 2x the span is NEW -> reversal; no history -> smallest difference', () => {
  const before: PastHistoryRow = { time: at(0.9), hasPerson: true, observation: 'A person in a white t-shirt sits at the desk looking at the monitor.', people: [{ pose: 'sitting', clothes: 'white t-shirt' }] };
  const ledger = buildStateLedger({ history: [{ ...before, time: at(8) }, before], people: [seatedCup], now: NOW });
  const c = judgePastContinuity({ ledger, people: [seatedCup], spanSec: -30 });
  assert.equal(c.verdict, 'new');
  assert.match(stateLedgerNote({ ledger, continuity: c, pastSpanSec: -30 }), /is NEW .*reverse that most recent change/);
  // previous row older than 2x span: not enough evidence for a reversal -> smallest coherent difference
  const old = buildStateLedger({ history: [{ ...before, time: at(5) }], people: [seatedCup], now: NOW });
  assert.equal(judgePastContinuity({ ledger: old, people: [seatedCup], spanSec: -30 }).verdict, 'unknown');
  const none = buildStateLedger({ history: [], people: [seatedCup], now: NOW });
  const u = judgePastContinuity({ ledger: none, people: [seatedCup], spanSec: -30 });
  assert.equal(u.verdict, 'unknown');
  const note = stateLedgerNote({ ledger: none, continuity: u, pastSpanSec: -30 });
  assert.doesNotMatch(note, /STATE LEDGER|FUTURE CONTINUITY/);
  assert.match(note, /SMALLEST coherent difference: a slightly earlier moment of the same state, never a bold reversal/);
});
