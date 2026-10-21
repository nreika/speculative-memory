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
  const reply = (response: string) => { let n = 0; return (async () => { n++; let body = response; try { const v = JSON.parse(response); if (v && typeof v === 'object' && 'scenario_description' in v) body = JSON.stringify(n === 1 ? { prediction_prompt: v.prediction_prompt } : { japanese: v.scenario_description }); } catch { /* raw text */ } return new Response(JSON.stringify({ response: body }), { status: 200 }); }) as unknown as typeof fetch; };
  const base = { tone: 1, english: 'Leans slightly forward.', japanese: 'わずかに前傾する。', seconds: 30, objects: ['box'] };
  assert.equal(await rewriteForTone({ ...base, fetchImpl: reply(JSON.stringify({ prediction_prompt: 'Leans slightly forward again.', scenario_description: '30秒後、わずかに動く。' })) }), null);
  assert.equal(await rewriteForTone({ ...base, fetchImpl: reply('not json') }), null);
  assert.equal(await rewriteForTone({ ...base, fetchImpl: (async () => new Response('', { status: 400 })) as unknown as typeof fetch }), null);
  const ok = await rewriteForTone({ ...base, fetchImpl: reply(JSON.stringify({ prediction_prompt: 'The person lifts the box high and holds it against their chest.', scenario_description: '30秒後、人物が箱を高く持ち上げ、胸に抱える。' })) });
  assert.equal(ok?.prediction_prompt, 'The person lifts the box high and holds it against their chest.');
});

test('trailing English in the Japanese line is cut; mixed English inside is refused', async () => {
  const reply = (response: string) => { let n = 0; return (async () => { n++; let body = response; try { const v = JSON.parse(response); if (v && typeof v === 'object' && 'scenario_description' in v) body = JSON.stringify(n === 1 ? { prediction_prompt: v.prediction_prompt } : { japanese: v.scenario_description }); } catch { /* raw text */ } return new Response(JSON.stringify({ response: body }), { status: 200 }); }) as unknown as typeof fetch; };
  const base = { tone: 1, english: 'Leans slightly forward.', japanese: 'わずかに前傾する。', seconds: 30, objects: ['box'] };
  const cut = await rewriteForTone({ ...base, fetchImpl: reply(JSON.stringify({ prediction_prompt: 'The person twists the upper body and swings both arms wide.', scenario_description: '30秒後、人物が体を回転させ、両腕を広げ、部屋の中央に向きChanged.' })) });
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
  const reply = (response: string) => { let n = 0; return (async () => { n++; let body = response; try { const v = JSON.parse(response); if (v && typeof v === 'object' && 'scenario_description' in v) body = JSON.stringify(n === 1 ? { prediction_prompt: v.prediction_prompt } : { japanese: v.scenario_description }); } catch { /* raw text */ } return new Response(JSON.stringify({ response: body }), { status: 200 }); }) as unknown as typeof fetch; };
  const base = { tone: 1, english: 'Lifts the lid slightly.', japanese: '蓋をわずかに持ち上げる。', seconds: 45, objects: ['green box', 'lid'] };
  assert.equal(await rewriteForTone({ ...base, fetchImpl: reply(JSON.stringify({ prediction_prompt: 'The person stands up straight and raises both arms.', scenario_description: '45秒後、人物が立ち上がり両腕を上げる。' })) }), null);
  const ok = await rewriteForTone({ ...base, fetchImpl: reply(JSON.stringify({ prediction_prompt: 'The person picks the green box up off the stack and holds it against their chest.', scenario_description: '45秒後、人物が緑の箱を持ち上げ、胸に抱える。' })) });
  assert.ok(ok);
});

test('rewrites with CJK in the English line or repeating a recent action are refused', async () => {
  const { rememberToneAction } = await import('./toneEnforce');
  const reply = (response: string) => { let n = 0; return (async () => { n++; let body = response; try { const v = JSON.parse(response); if (v && typeof v === 'object' && 'scenario_description' in v) body = JSON.stringify(n === 1 ? { prediction_prompt: v.prediction_prompt } : { japanese: v.scenario_description }); } catch { /* raw text */ } return new Response(JSON.stringify({ response: body }), { status: 200 }); }) as unknown as typeof fetch; };
  const base = { tone: 1, english: 'Lifts the lid slightly.', japanese: '蓋をわずかに持ち上げる。', seconds: 45, objects: ['green box', 'lid'] };
  assert.equal(await rewriteForTone({ ...base, fetchImpl: reply(JSON.stringify({ prediction_prompt: 'The person猛地将整个垃圾桶高高举起。', scenario_description: '45秒後、人物が箱を高く持ち上げる。' })) }), null);
  rememberToneAction('The person pulls the lid open with the right hand.');
  assert.equal(await rewriteForTone({ ...base, fetchImpl: reply(JSON.stringify({ prediction_prompt: 'The person pulls the lid open with the right hand.', scenario_description: '45秒後、人物が右手で蓋を開ける。' })) }), null);
});

test('a rewrite that invents an object not seen in the photo is refused', async () => {
  const { inventsObject } = await import('./toneEnforce');
  assert.equal(inventsObject('The person grabs the nearby coffee mug with both hands.', 'The person turns their head.', ['laptop', 'backpack']), true);
  assert.equal(inventsObject('The person lifts the laptop with both hands.', 'The person turns their head.', ['laptop']), false);
  assert.equal(inventsObject('The person raises both hands and spreads the fingers.', 'The person turns their head.', []), false);
});

test('a static "no change" plan is too weak above CALM; plansNearIdentical spots three copies', async () => {
  const {toneMismatch,plansNearIdentical}=await import('./toneEnforce');
  const stat="The person's posture remains unchanged, with no visible movement or change in position.";
  assert.equal(toneMismatch(1,stat,'30秒後、人物の姿勢は変化せず、動きや位置の変化は見られない。'),'too_weak');
  assert.equal(toneMismatch(0.3,stat,''),'too_weak');
  assert.equal(toneMismatch(0.05,stat,''),null);
  assert.equal(toneMismatch(1,'The person lifts the cup and stays seated.','' ),null);
  assert.equal(plansNearIdentical([stat,stat,stat.replace('posture','pose')]),true);
  assert.equal(plansNearIdentical([stat,'The person lifts the notebook from the desk and holds it to the chest.']),false);
});

test('back view: eyes / gaze / face / head-turn plans are caught, tilting and arm actions are not; the fallback is Japanese', async () => {
  const {backViewForbiddenHit,backViewFallback}=await import('./toneEnforce');
  for (const bad of ['The person turns their head to the right, eyes gazing toward the right.','The person looks around the room.','The person smiles and waves.','The person turns around to look behind.','The person glances at the monitor.','The person turns sharply to the left.'])
    assert.equal(backViewForbiddenHit(bad),true,bad);
  for (const ok of ['The back of the head tilts to the right.','The head bows forward over the desk.','The person raises both arms high in a stretch.','The person reaches far to the side to grab the notebook.'])
    assert.equal(backViewForbiddenHit(ok),false,ok);
  const f=backViewFallback(0,30);assert.match(f.scenario_description,/^30秒後、人物が/);assert.equal(backViewForbiddenHit(f.prediction_prompt),false);
  assert.equal(backViewFallback(1,-30).scenario_description.startsWith('30秒前、'),true);
});

test('back view: blink / laugh / scream words are caught too', async () => {
  const {backViewForbiddenHit}=await import('./toneEnforce');
  for (const bad of ['The person lowers their head slightly and blinks.','The person throws the head back and laughs, mouth open.','The person screams.']) assert.equal(backViewForbiddenHit(bad),true,bad);
  assert.equal(backViewForbiddenHit('The person nods slowly and leans forward.'),false);
});

test('the plan must follow the time span: 30 s may continue, 10 min must change the state', async () => {
  const {toneMismatch}=await import('./toneEnforce');
  const {spanChangeRequirement,buildScenarioTimeline}=await import('../../services/promptBuilder');
  const same='The person keeps typing on the laptop with both hands.';
  const changed='The person finishes typing, closes the laptop and puts the mug aside on the desk.';
  assert.equal(toneMismatch(0.5,same,'',30),null);
  assert.equal(toneMismatch(0.5,same,'',600),'too_weak');
  assert.equal(toneMismatch(0.5,changed,'',600),null);
  assert.equal(toneMismatch(0.5,same,'',-900),'too_weak');
  assert.match(spanChangeRequirement(30),/next moment of the same activity/);
  assert.match(spanChangeRequirement(180),/completed or has changed/);
  assert.match(spanChangeRequirement(600),/clearly different state/);
  const line=buildScenarioTimeline([600]);
  assert.match(line,/what plausibly happened during that span/);assert.match(line,/clearly different state/);
});

test('theatrical actions are rejected as implausible; everyday big movements pass', async () => {
  const {toneMismatch}=await import('./toneEnforce');
  for (const bad of ['The person grabs the bottle with both hands, locks the elbows and raises it high overhead.','The person lifts the bottle high above their head with fully extended arms.','The person thrusts a fist in triumph.'])
    assert.equal(toneMismatch(0.65,bad,'',30),'implausible',bad);
  for (const ok of ['The person stretches both arms forward and yawns, then leans back in the chair.','The person pushes the chair back and picks up the bottle to drink from it.'])
    assert.equal(toneMismatch(0.9,ok,'',30),null,ok);
});

test('back view: hands-in-front actions are replaced; similar plans are detected', async () => {
  const {backViewForbiddenHit,planSimilarity}=await import('./toneEnforce');
  for (const bad of ['The person pulls the blue bottle toward their chest with both hands.','The person holds the bottle against their chest.','The person hugs the notebook.']) assert.equal(backViewForbiddenHit(bad),true,bad);
  assert.equal(backViewForbiddenHit('The person reaches to the side with one arm and takes the bottle.'),false);
  const a='The person reaches forward with both hands to grasp the blue water bottle and pulls it firmly.';
  assert.ok(planSimilarity(a,a.replace('firmly','slowly'))>=0.7);
  assert.ok(planSimilarity(a,'The person stretches both arms forward and rolls the shoulders.')<0.4);
});

test('only clear arm / hand / object / whole-body actions on a front view are checked for visibility', async () => {
  const {actionIsCheckable}=await import('./toneEnforce');
  assert.equal(actionIsCheckable('The person lifts the bottle with both hands.',false),true);
  assert.equal(actionIsCheckable('The person stands up from the chair.',false),true);
  assert.equal(actionIsCheckable('The head tilts slightly to the left, eyes remain focused on the cable.',false),false);
  assert.equal(actionIsCheckable('The person blinks slowly and nods.',false),false);
  assert.equal(actionIsCheckable('The person lifts the bottle with both hands.',true),false);
});
