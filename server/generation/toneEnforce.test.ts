import test from 'node:test';
import assert from 'node:assert/strict';
import { toneMismatch, rewriteForTone } from './toneEnforce';

test('weak wording at LIVELY/DRAMATIC tone is a mismatch; calm tone accepts it', () => {
  assert.equal(toneMismatch(1, 'The person leans slightly forward.'), 'too_weak');
  assert.equal(toneMismatch(0.7, 'Looks at the monitor.', '人物の頭がわずかに右に向く。'), 'too_weak');
  assert.equal(toneMismatch(0.2, 'The person leans slightly forward.'), null);
  assert.equal(toneMismatch(0.05, 'The person stands up and walks to the door.'), 'too_strong');
  assert.equal(toneMismatch(1, 'The person stands up and raises both arms.'), null);
});

test('a rewrite that is still weak, malformed or failing keeps the original (null)', async () => {
  const reply = (response: string) => (async () => new Response(JSON.stringify({ response }), { status: 200 })) as unknown as typeof fetch;
  const base = { tone: 1, english: 'Leans slightly forward.', japanese: 'わずかに前傾する。', seconds: 30 };
  assert.equal(await rewriteForTone({ ...base, fetchImpl: reply(JSON.stringify({ prediction_prompt: 'Leans slightly forward again.', scenario_description: '30秒後、わずかに動く。' })) }), null);
  assert.equal(await rewriteForTone({ ...base, fetchImpl: reply('not json') }), null);
  assert.equal(await rewriteForTone({ ...base, fetchImpl: (async () => new Response('', { status: 400 })) as unknown as typeof fetch }), null);
  const ok = await rewriteForTone({ ...base, fetchImpl: reply(JSON.stringify({ prediction_prompt: 'The person lifts the box high and holds it against their chest.', scenario_description: '30秒後、人物が箱を高く持ち上げ、胸に抱える。' })) });
  assert.equal(ok?.prediction_prompt, 'The person lifts the box high and holds it against their chest.');
});

test('trailing English in the Japanese line is cut; mixed English inside is refused', async () => {
  const reply = (response: string) => (async () => new Response(JSON.stringify({ response }), { status: 200 })) as unknown as typeof fetch;
  const base = { tone: 1, english: 'Leans slightly forward.', japanese: 'わずかに前傾する。', seconds: 30 };
  const cut = await rewriteForTone({ ...base, fetchImpl: reply(JSON.stringify({ prediction_prompt: 'The person spins around with both arms wide.', scenario_description: '30秒後、人物が体を回転させ、両腕を広げ、部屋の中央に向きChanged.' })) });
  assert.equal(cut?.scenario_description, '30秒後、人物が体を回転させ、両腕を広げ、部屋の中央に向き。');
  assert.equal(await rewriteForTone({ ...base, fetchImpl: reply(JSON.stringify({ prediction_prompt: 'The person stands up and raises both arms.', scenario_description: '30秒後、人物がstands upして両腕を上げる。' })) }), null);
});

test('fallback wording removes weak words so the plan matches a high tone', async () => {
  const { forceToneWording } = await import('./toneEnforce');
  const r = forceToneWording('too_weak', 'The right hand lifts the lid slightly upward.', '45秒後、右手が蓋をわずかに持ち上げる。');
  assert.equal(r.prediction_prompt, 'The right hand lifts the lid clearly upward.');
  assert.equal(r.scenario_description, '45秒後、右手が蓋を大きく持ち上げる。');
  assert.equal(toneMismatch(1, r.prediction_prompt, r.scenario_description), null);
});

test('a rewrite that makes the person stand up or step back is refused (framing / face rule)', async () => {
  const reply = (response: string) => (async () => new Response(JSON.stringify({ response }), { status: 200 })) as unknown as typeof fetch;
  const base = { tone: 1, english: 'Lifts the lid slightly.', japanese: '蓋をわずかに持ち上げる。', seconds: 45 };
  assert.equal(await rewriteForTone({ ...base, fetchImpl: reply(JSON.stringify({ prediction_prompt: 'The person stands up straight and raises both arms.', scenario_description: '45秒後、人物が立ち上がり両腕を上げる。' })) }), null);
  const ok = await rewriteForTone({ ...base, fetchImpl: reply(JSON.stringify({ prediction_prompt: 'The person picks the green box up off the stack and holds it against their chest.', scenario_description: '45秒後、人物が緑の箱を持ち上げ、胸に抱える。' })) });
  assert.ok(ok);
});

test('rewrites with CJK in the English line or repeating a recent action are refused', async () => {
  const { rememberToneAction } = await import('./toneEnforce');
  const reply = (response: string) => (async () => new Response(JSON.stringify({ response }), { status: 200 })) as unknown as typeof fetch;
  const base = { tone: 1, english: 'Lifts the lid slightly.', japanese: '蓋をわずかに持ち上げる。', seconds: 45 };
  assert.equal(await rewriteForTone({ ...base, fetchImpl: reply(JSON.stringify({ prediction_prompt: 'The person猛地将整个垃圾桶高高举起。', scenario_description: '45秒後、人物が箱を高く持ち上げる。' })) }), null);
  rememberToneAction('The person pulls the lid open with the right hand.');
  assert.equal(await rewriteForTone({ ...base, fetchImpl: reply(JSON.stringify({ prediction_prompt: 'The person pulls the lid open with the right hand.', scenario_description: '45秒後、人物が右手で蓋を開ける。' })) }), null);
});
