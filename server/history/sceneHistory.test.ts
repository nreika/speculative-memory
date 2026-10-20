import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendHistory, readHistory, recentEntries, latestPerson, resetHistory, historyText } from './sceneHistory';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hist-')), 'logs', 'scene-history.jsonl');
const e = (min: number, has: boolean, d: string, now: number) => ({
  time: new Date(now - min * 60_000).toISOString(), captureId: `c${min}`, sceneDescription: d, hasPerson: has, observation: d,
});

test('append/read, window, limit and latest person', () => {
  const f = tmp();
  const now = Date.now();
  for (const x of [e(50, true, 'old man', now), e(12, true, 'a woman at the desk', now), e(5, false, 'empty room', now), e(1, false, 'empty room 2', now)]) appendHistory(x, f);
  const all = readHistory(f);
  assert.equal(all.length, 4);
  assert.deepEqual(recentEntries(all, { limit: 8, windowMin: 30, now }).map((x) => x.captureId), ['c12', 'c5', 'c1']);
  assert.deepEqual(recentEntries(all, { limit: 2, windowMin: 30, now }).map((x) => x.captureId), ['c5', 'c1']);
  assert.equal(latestPerson(all, 10, now), null);
  assert.equal(latestPerson(all, 15, now)?.entry.captureId, 'c12');
  assert.equal(historyText([{ observation: 'a' }, { observation: 'b' }]), '1. a\n2. b');
});

test('reset moves the file into logs/archive and leaves an empty file', () => {
  const f = tmp();
  appendHistory(e(1, false, 'x', Date.now()), f);
  const dest = resetHistory(f)!;
  assert.ok(fs.existsSync(dest));
  assert.equal(readHistory(f).length, 0);
  assert.equal(readHistory(dest).length, 1);
  assert.equal(resetHistory(f), null);
});

import { buildHistoryContextNote } from '../../services/promptBuilder';
import { composeEditInstruction } from '../generation/orchestrator';
import { findFabricatedScenarios, mentionsPerson } from '../generation/scenarioGuard';

test('history note lists observations oldest first and names the recent person', () => {
  const note = buildHistoryContextNote({
    observations: ['An empty office.', 'A man sits at a desk.'],
    recentPerson: { description: 'A man sits at a desk.', minutesAgo: 3 },
  });
  assert.match(note, /1\. An empty office\.\n2\. A man sits at a desk\./);
  assert.match(note, /3 minutes ago/);
  assert.equal(buildHistoryContextNote({ observations: [], recentPerson: null }), '');
});

test('recent person allows people in scenarios; Japanese empty-room text is not a person', () => {
  const s = [{ prediction_prompt: 'The man stands up.', scenario_description: 'x', label: 'a' }] as any;
  assert.deepEqual(findFabricatedScenarios('An empty office.', s), [0]);
  assert.deepEqual(findFabricatedScenarios('An empty office.', s, true), []);
  assert.equal(mentionsPerson('無人のオフィスに椅子がある'), false);
  assert.equal(mentionsPerson('男性が机に座っている'), true);
});

test('image prompt: empty room and reference person sentences', () => {
  const none = composeEditInstruction({ predictionPrompt: 'A chair rotates.', presence: 0 });
  assert.match(none, /according to: A chair rotates\./);
  assert.doesNotMatch(none, /person|people|figure|silhouette|hand|arm|nobody|no one/i);
  const ref = composeEditInstruction({ predictionPrompt: 'A chair rotates.', presence: 0.8, referencePerson: true });
  assert.match(ref, /second reference image/);
  assert.doesNotMatch(ref, /The room is empty/);
});

test('negated person words mean an empty room', () => {
  assert.equal(mentionsPerson('An office space with visible chairs, with no people present.'), false);
  assert.equal(mentionsPerson('The room is empty; nobody is visible.'), false);
  assert.equal(mentionsPerson('A man sits at a desk with no hands on the keyboard.'), true);
});

test('real log sentence and other emptiness phrases count as unoccupied', () => {
  const real = 'An office space with visible chairs, shelves, and overhead industrial pipes and ductwork, with no people present.';
  assert.equal(mentionsPerson(real), false);
  for (const t of ['The room has no one in it.', 'Nobody present, chairs only.', 'Chairs, without any people.', 'There is no person in the frame.', 'An unoccupied office.']) {
    assert.equal(mentionsPerson(t), false, t);
  }
  assert.equal(findFabricatedScenarios(real, [{ prediction_prompt: 'The person leans back.', scenario_description: 'x', label: 'a' }] as any).length, 1);
});

import { formatHistory } from './sceneHistory';

const at = (now: number, minAgo: number, has: boolean, d: string) => ({
  time: new Date(now - minAgo * 60_000).toISOString(), captureId: `c${minAgo}`, sceneDescription: d, observation: d, hasPerson: has,
});

test('formatHistory: merges identical lines, adds times and elapsed minutes', () => {
  const now = Date.now();
  const f = formatHistory([
    at(now, 12, false, 'An empty office.'), at(now, 8, false, 'An empty office!'), at(now, 2, false, 'an empty office'),
    at(now, 1, true, 'A man sits at a desk.'),
  ], now);
  assert.equal(f.lines.length, 2);
  assert.match(f.lines[0], /^\u00d73 \(\d\d:\d\d\u2013\d\d:\d\d, latest 2 min ago, no change for 10 min\) /);
  assert.match(f.lines[1], /^\[\d\d:\d\d, 1 min ago\] A man sits/);
  assert.match(f.text, /^1\. \u00d73/);
});

test('formatHistory: arrival/departure from hasPerson transitions; steady and empty cases', () => {
  const now = Date.now();
  const f = formatHistory([at(now, 20, false, 'empty'), at(now, 15, true, 'man'), at(now, 9, false, 'empty again')], now);
  assert.match(f.people, /^People: a person arrived at \d\d:\d\d; left at \d\d:\d\d; the room has been empty for 9 min$/);
  const g = formatHistory([at(now, 10, false, 'empty'), at(now, 1, false, 'empty')], now);
  assert.match(g.people, /the room has been empty for 10 min/);
  const h = formatHistory([at(now, 6, true, 'man'), at(now, 1, true, 'man')], now);
  assert.match(h.people, /no one has entered or left in the last 6 min/);
  const e = formatHistory([], now);
  assert.deepEqual([e.lines, e.people, e.text], [[], '', '']);
});

test('quarantine excludes only its exact capture and preserves original log bytes',()=>{
 const file=tmp();const records=[{time:'2026-10-18T01:00:00',captureId:'valid',sceneDescription:'A person standing',hasPerson:true,observation:'A person standing'},{time:'2026-10-18T02:00:00',captureId:'bad-test',sceneDescription:'Empty',hasPerson:false,observation:'Empty'}];
 for(const row of records)appendHistory(row,file);const original=fs.readFileSync(file);fs.writeFileSync(file+'.quarantine.jsonl',JSON.stringify({captureId:'bad-test',reason:'confirmed placeholder test'})+'\n');assert.deepEqual(readHistory(file).map(r=>r.captureId),['valid']);assert.deepEqual(fs.readFileSync(file),original);
 fs.writeFileSync(file+'.quarantine.jsonl','');assert.deepEqual(readHistory(file).map(r=>r.captureId),['valid','bad-test']);
});
