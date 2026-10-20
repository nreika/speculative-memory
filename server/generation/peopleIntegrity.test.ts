import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePeopleIntegrity, generateUniquePeople, targetedCorrection, type PeopleIntegrity } from './peopleIntegrity';

test('reject a duplicate identity even when two output people match the original count', () => {
  assert.equal(parsePeopleIntegrity({ sourceCount: 2, outputToSource: [0,0] }, 2).ok, false);
  assert.equal(parsePeopleIntegrity({ sourceCount: 1, outputToSource: [0,0] }, 1).ok, false);
  assert.equal(parsePeopleIntegrity({ sourceCount: 2, outputToSource: [1,0] }, 2).ok, true);
  assert.equal(parsePeopleIntegrity({ sourceCount: 2, outputToSource: [0,-1] }, 2).ok, false);
  assert.equal(parsePeopleIntegrity({ sourceCount: 2, outputToSource: [0] }, 2).ok, false);
  assert.equal(parsePeopleIntegrity({ sourceCount: 1, outputToSource: [0] }, 2).ok, false);
  assert.equal(parsePeopleIntegrity({ sourceCount: 0, outputToSource: [] }, 0).ok, true);
  assert.equal(parsePeopleIntegrity('bad', 1).ok, null);
});

test('never returns the rejected output; retries once with correction', async () => {
  const rejected: string[] = [];
  const result = await generateUniquePeople({
    generate: async (attempt, correction) => { if (attempt) assert.match(correction,/exactly once/); return 'image'+attempt; },
    inspect: async image => parsePeopleIntegrity({sourceCount:2,outputToSource:image==='image0'?[0,0]:[0,1]},2),
    rejected: image => { rejected.push(image); },
  });
  assert.equal(result.image,'image1');
  assert.equal(result.attempts,2);
  assert.deepEqual(rejected,['image0']);
});

test('failed or unknown checks block publication rather than falling back to an unverified image', async () => {
  let rejected = 0;
  await assert.rejects(generateUniquePeople({ generate: async ()=>'bad', inspect: async ()=>{throw new Error('offline');}, rejected:()=>{rejected++;} }),/no image published/);
  assert.equal(rejected,2);
});

const belongingsVerdict: PeopleIntegrity = { ok: false, sourceCount: 1, outputToSource: [0], defect: 'missing_belongings', reason: 'missing_belongings: not visible in the output: blue backpack' };

test('second attempt names the first defect (missing belongings / framing / hands)', async () => {
  const corrections: string[] = [];
  const result = await generateUniquePeople({
    generate: async (attempt, correction) => { corrections.push(correction); return 'image'+attempt; },
    inspect: async image => image==='image0' ? { ...belongingsVerdict } : { ok: true, sourceCount: 1, outputToSource: [0], reason: 'ok' } as PeopleIntegrity,
    rejected: () => {}, maxAttempts: 2, expectedPeople: 1, onExhausted: 'skip',
  });
  assert.equal(result.image,'image1');
  assert.equal(corrections[0],'');
  assert.match(corrections[1],/The blue backpack must remain fully visible exactly where it is in the input; the person stands beside it, not in front of it\./);
  assert.doesNotMatch(corrections[1],/exactly once/);
  assert.match(targetedCorrection({ ok:false, sourceCount:1, outputToSource:[0], defect:'framing_drift', reason:'framing_drift: output frame differs from the source (dy -5.2%, rotation -2.7 deg)' }),/exact framing, scale and rotation/);
  assert.match(targetedCorrection({ ok:false, sourceCount:1, outputToSource:[0], defect:'extra_hand', reason:'extra_hand: finished person 1 shows 3 hands; missing_belongings: not visible in the output: black jacket, blue backpack' }),/exactly two hands[\s\S]*The black jacket and the blue backpack|The black jacket and the blue backpack[\s\S]*exactly two hands/);
  assert.match(targetedCorrection({ ok:false, sourceCount:0, outputToSource:[-1], reason:'Expected 0 people, found 1' },{expectedPeople:0}),/No person may appear/);
});

test('two rejections skip the scene instead of failing the capture; undecidable skips too', async () => {
  const rejected: number[] = [];
  const result = await generateUniquePeople({
    generate: async attempt => 'bad'+attempt, inspect: async () => ({ ...belongingsVerdict }),
    rejected: (_i, _v, attempt) => { rejected.push(attempt); }, maxAttempts: 2, expectedPeople: 1, onExhausted: 'skip',
  });
  assert.equal(result.skipped,true);
  assert.equal(result.image,undefined);
  assert.equal('defect' in result && result.defect,'missing_belongings');
  assert.deepEqual(rejected,[1,2]);
  // 2026-10-20: an undecidable verdict skips the scene too (the capture keeps the previous image); 'throw' mode still throws.
  const unknown = await generateUniquePeople({ generate: async ()=>'x', inspect: async ()=>{throw new Error('offline');}, rejected:()=>{}, onExhausted:'skip' });
  assert.equal(unknown.skipped,true);assert.equal('defect' in unknown && unknown.defect,'inspection_unavailable');assert.equal(unknown.image,undefined);
  await assert.rejects(generateUniquePeople({ generate: async ()=>'x', inspect: async ()=>{throw new Error('offline');}, rejected:()=>{} }),/no image published/);
});

test('occupied path unchanged: identity rejection retries with the identity correction, default still throws', async () => {
  const corrections: string[] = [];
  await assert.rejects(generateUniquePeople({
    generate: async (attempt, correction) => { corrections.push(correction); return 'image'+attempt; },
    inspect: async () => parsePeopleIntegrity({sourceCount:2,outputToSource:[0,0]},2),
    rejected: () => {},
  }),/failed after 2 attempts/);
  assert.equal(corrections[1],'Render each original individual exactly once. Keep the original person-to-clothes and person-to-belongings assignments. Fully erase each moved body from its previous position. The reference portraits identify the existing people only.');
});
