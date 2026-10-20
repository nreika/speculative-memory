import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePeople, groundTruthNote, synthesizeScenarios, describePeople, DESCRIBE_PROMPT } from './peopleDescribe';
import { headCropFor } from './referenceCrop';
import { planScenariosLocal } from './vlmClient';
import { buildSceneExtrasNote } from './sceneExtras';
import { hasBigArmMotion, modestMotion } from './peopleDescribe';
import { behindViewSentence } from './orchestrator';
import { buildNegativePrompt } from './comfyClient';
import { isWeakScenario, synthesizeEmptyRoom } from './peopleDescribe';
import { compactPeopleInstruction } from './compactPeople';

const PEOPLE = [{ position: 'left front', pose: 'seated in a mesh chair', clothes: 'grey striped shirt', facing: 'away' }];

test('parsePeople / groundTruthNote', () => {
  const p = parsePeople(JSON.stringify({ people: PEOPLE }));
  assert.equal(p.length, 1);
  const note = groundTruthNote(p, 1);
  assert.match(note, /^GROUND TRUTH \(from a person detector\): 1 person\(s\) are visible: a person seated in a mesh chair, at the left front, wearing grey striped shirt, facing away\./);
  assert.match(note, /Do not say the room is empty\./);
  assert.deepEqual(parsePeople('nope'), []);
});

test('describePeople: one image call keeps head bounds and requires per-item support and attachment evidence', async () => {
  let body: any;
  let calls = 0;
  const r = await describePeople('data:image/jpeg;base64,dGVzdA==', {
    fetchImpl: (async (_u: any, init: any) => { calls++; body = JSON.parse(init.body); return new Response(JSON.stringify({ response: JSON.stringify({ people: PEOPLE }) })); }) as any,
  });
  assert.equal(calls, 1);
  const person = body.format.properties.people.items;
  assert.ok(person.required.includes('head_box'));
  assert.ok(person.required.includes('holding') && person.required.includes('worn') && person.required.includes('hair'));
  assert.deepEqual(person.properties.holding.items.required,['item','hand','evidence']);
  assert.deepEqual(person.properties.worn.items.required,['item','attachment']);
  const head = person.properties.head_box.anyOf;
  assert.deepEqual(head, [{type:'array',items:{type:'number',minimum:0,maximum:1000},minItems:4,maxItems:4},{type:'null'}]);
  assert.deepEqual(body.format.required, ['people','obstructed','obstructedBy','belongings']);
  assert.deepEqual(body.images, ['dGVzdA==']);
  assert.equal(body.think, false);
  assert.equal(body.options.num_predict, 768);
  assert.equal(r.people.length, 1);
  assert.equal(r.people[0].headBox, null);
});

test('the describe prompt has a valid complete JSON example, with position guidance outside it', () => {
  const example = DESCRIBE_PROMPT.match(/Example: (\{.*?\})\. /)?.[1];
  assert.ok(example);
  const value = JSON.parse(example);
  assert.deepEqual(value.people[0].head_box, [20,100,220,400]);
  assert.equal(value.people[0].facing, 'away');
  assert.equal(value.obstructed, false);
  assert.equal(value.obstructedBy, '');
  assert.deepEqual(value.people[0].holding,[]);
  assert.deepEqual(value.people[0].worn,[]);
  assert.match(DESCRIBE_PROMPT, /Visible hair from behind or a partly cropped head still needs a box/);
});

test('two visible heads produce individual usable references, including back-facing hair and an edge crop', async () => {
  const observed = [
    {...PEOPLE[0],hair:'straight black shoulder-length hair',head_box:[0,500,220,740]},
    {position:'right background',pose:'seated behind monitor',clothes:'dark shirt',hair:'short black hair',facing:'left',holding:'',worn:'',head_box:[850,570,1000,710]},
  ];
  let calls = 0;
  const r = await describePeople('data:image/jpeg;base64,dGVzdA==', {
    fetchImpl: (async () => {calls++;return Response.json({response:JSON.stringify({people:observed,obstructed:false,obstructedBy:''}),done_reason:'stop'});}) as any,
  });
  assert.equal(calls, 1);
  assert.equal(r.ok, true);
  assert.equal(r.people.length, 2);
  assert.deepEqual(r.people.map(p=>p.headBox), observed.map(p=>p.head_box));
  const crops = r.people.map(p=>headCropFor(p.headBox,1280,720));
  assert.ok(crops.every(Boolean));
  assert.equal(crops[0]!.x, 0);
  assert.ok(crops[1]!.x+crops[1]!.width<=1280);
  assert.equal(r.people[0].facing, 'away');
  assert.equal(r.people[1].position, 'right background');
  assert.equal(r.obstructed, false);
});

test('null, missing or invalid head bounds stay explicitly absent without dropping or fabricating the person', () => {
  for (const head_box of [null, undefined, [100,300,90,400], [0,0,1001,300], [0,0,NaN,300], [0,0,10,10], [10,20,30]]) {
    const people = parsePeople(JSON.stringify({people:[{...PEOPLE[0],hair:'visible black hair',holding:[{item:'tablet',hand:'left',evidence:'hand_supported'}],worn:[{item:'wrist strap',attachment:'body_attached'}],head_box}]}));
    assert.equal(people.length, 1);
    assert.equal(people[0].headBox, null);
    assert.equal(headCropFor(people[0].headBox,1280,720), undefined);
    assert.equal(people[0].hair, 'visible black hair');
    assert.equal(people[0].holding, 'tablet in left hand');
    assert.equal(people[0].worn, 'wrist strap');
  }
});

test('keyboard/laptop contact and a furniture-supported bag never become held or worn preservation instructions', () => {
  const holding = [{item:'laptop',hand:'left',evidence:'surface_contact'}];
  const worn = [{item:'black backpack',attachment:'furniture_supported'}];
  const people = parsePeople(JSON.stringify({people:[{...PEOPLE[0],holding,worn,head_box:[100,200,300,400]}]}));
  assert.equal(people.length,1);
  assert.equal(people[0].holding,'');
  assert.equal(people[0].worn,'');
  assert.deepEqual(people[0].holdingFacts,holding);
  assert.deepEqual(people[0].wornFacts,worn);
  assert.deepEqual(people[0].headBox,[100,200,300,400]);
  const prompt=compactPeopleInstruction(people,1,'The person raises one free hand.');
  assert.doesNotMatch(prompt,/Keep laptop with|Keep black backpack attached|continuously keeps laptop/);
});

test('real hand-supported items and body-attached accessories survive even alongside rejected candidates', () => {
  const people=parsePeople(JSON.stringify({people:[{...PEOPLE[0],
    holding:[{item:'white cup',hand:'right',evidence:'hand_supported'},{item:'keyboard',hand:'left',evidence:'surface_contact'}],
    worn:[{item:'wrist case',attachment:'body_attached'},{item:'backpack',attachment:'furniture_supported'},{item:'bag',attachment:'nearby_only'}],
  }]}));
  assert.equal(people[0].holding,'white cup in right hand');
  assert.equal(people[0].worn,'wrist case');
  assert.equal(people[0].holdingFacts?.length,2);
  assert.equal(people[0].wornFacts?.length,3);
});

test('support and attachment decisions depend on observed evidence rather than a forbidden object-name list', () => {
  const people=parsePeople(JSON.stringify({people:[{...PEOPLE[0],
    holding:[{item:'laptop',hand:'both',evidence:'hand_supported'}],
    worn:[{item:'black backpack',attachment:'body_attached'}],
  }]}));
  assert.equal(people[0].holding,'laptop in both hands');
  assert.equal(people[0].worn,'black backpack');
});

test('uncertain, malformed and legacy unverified assertions do not erase a person or authorize ownership', () => {
  for(const [holding,worn] of [
    ['laptop','black backpack'],
    [[{item:'laptop',hand:'left',evidence:'unclear'}],[{item:'bag',attachment:'unclear'}]],
    [[{item:'laptop',hand:'left'}],[{item:'bag'}]],
    [[{item:'laptop',hand:'unknown',evidence:'hand_supported'}],[{item:'bag',attachment:'probably_worn'}]],
  ]) {
    const people=parsePeople(JSON.stringify({people:[{...PEOPLE[0],holding,worn}]}));
    assert.equal(people.length,1);
    assert.equal(people[0].holding,'');
    assert.equal(people[0].worn,'');
  }
});

test('one describe request preserves multiple people, head references and obstruction while filtering uncertain belongings',async()=>{
  let calls=0;let body:any;
  const observed=[
    {...PEOPLE[0],holding:[{item:'cup',hand:'left',evidence:'hand_supported'}],worn:[],head_box:[0,100,200,300]},
    {position:'right background',pose:'seated',clothes:'plain top',facing:'away',hair:'dark hair',holding:[{item:'laptop',hand:'both',evidence:'surface_contact'}],worn:[{item:'bag',attachment:'furniture_supported'}],head_box:[700,100,850,300]},
  ];
  const result=await describePeople('data:image/jpeg;base64,dGVzdA==',{fetchImpl:(async(_u:any,init:any)=>{calls++;body=JSON.parse(init.body);return Response.json({response:JSON.stringify({people:observed,obstructed:true,obstructedBy:'chair back'}),done_reason:'stop'});}) as any});
  assert.equal(calls,1);
  assert.equal(body.options.num_predict,768);
  assert.equal(result.ok,true);
  assert.equal(result.people.length,2);
  assert.deepEqual(result.people.map(p=>p.headBox),observed.map(p=>p.head_box));
  assert.equal(result.people[0].holding,'cup in left hand');
  assert.equal(result.people[1].holding,'');
  assert.equal(result.people[1].worn,'');
  assert.equal(result.obstructed,true);
  assert.equal(result.obstructedBy,'chair back');
});

test('a person visible only by hair or head bounds is retained even when the body fields are unknown', () => {
  const people = parsePeople(JSON.stringify({people:[
    {position:'',pose:'',clothes:'',hair:'cropped black hair',holding:'',worn:'',facing:'',head_box:null},
    {position:'',pose:'',clothes:'',hair:'',holding:'',worn:'',facing:'',head_box:[0,0,100,100]},
  ]}));
  assert.equal(people.length, 2);
  assert.equal(people[0].headBox, null);
  assert.deepEqual(people[1].headBox, [0,0,100,100]);
});

test('synthesizeScenarios: extra wins; else motion by distance', () => {
  const base = [0, 1, 2].map(() => ({ prediction_prompt: 'x', scenario_description: 'y', label: 'L' })) as any;
  const s = synthesizeScenarios({
    people: PEOPLE, distances: [30, 30, 150], keys: ['gen_a', 'gen_b', 'gen_c'],
    extras: { gen_a: '帰ろうとしている' }, extrasEnglish: { gen_a: 'is about to leave, standing up and heading for the exit' }, base,
  });
  assert.match(s.sceneNow, /^A person seated in a mesh chair/);
  assert.match(s.scenes[0].prediction_prompt, /^The person already in the photo is about to leave/);
  assert.match(s.scenes[1].prediction_prompt, /adjusts their posture/);
  assert.match(s.scenes[2].prediction_prompt, /stands up and steps toward the exit/);
  assert.match(s.scenes[2].scenario_description, /^2 minutes 30 seconds later, the person/);
});

test('planner keeps denying a detected person within budget -> synthesized, at most 3 plan calls', async (t) => {
  let plans = 0;
  t.mock.method(globalThis, 'fetch', async (_i: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (!body.images) return new Response(JSON.stringify({ response: '{}' }));
    plans += 1;
    const item = (p: string) => ({ prediction_prompt: p, scenario_description: '30 seconds later, x.', label: 'L' });
    return new Response(JSON.stringify({ response: JSON.stringify({
      clock_visible: false, scene_description: 'An empty room. No people are visible.',
      scenarios: [item('No change.'), item('No change at all.'), item('Nothing changes.')],
    }) }));
  });
  const trace: any = {};
  const out = await planScenariosLocal({
    imageDataUrl: 'data:image/jpeg;base64,dGVzdA==', prompt: 'p', scenarioCount: 3, trace,
    detector: { person: true, count: 1, elapsedMs: 5 }, people: PEOPLE, sceneDistances: [30, 30, 150],
  });
  assert.ok(plans <= 3);
  assert.equal(trace.guard.synthesized, true);
  assert.equal(trace.guard.unoccupied, false);
  assert.match(out[0].prediction_prompt, /^The person on the left front/);
  assert.match(String(trace.promptFull ?? ''), /GROUND TRUTH/);
});

test('empty room: one planner call; weak answers replaced by distinct server templates', async (t) => {
  let plans = 0;
  t.mock.method(globalThis, 'fetch', async (_i: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (!body.images) return new Response(JSON.stringify({ response: '{}' }));
    plans += 1;
    const item = (p: string) => ({ prediction_prompt: p, scenario_description: '30 seconds later, x.', label: 'L' });
    return new Response(JSON.stringify({ response: JSON.stringify({
      clock_visible: false, scene_description: 'An empty room with a curtain, chairs and shelves.',
      scenarios: [item('No change needed; the room remains empty.'), item('A chair rotates a little to the left.'), item('No change.')],
    }) }));
  });
  const trace: any = {};
  const out = await planScenariosLocal({
    imageDataUrl: 'data:image/jpeg;base64,dGVzdA==', prompt: 'p', scenarioCount: 3, trace,
    detector: { person: false, count: 0, elapsedMs: 5 }, people: [], sceneDistances: [30, 30, 150],
  });
  assert.equal(plans, 1);
  assert.equal(out[1].prediction_prompt, 'A chair rotates a little to the left.');
  assert.ok(!isWeakScenario(out[0].prediction_prompt) && !isWeakScenario(out[2].prediction_prompt));
  assert.notEqual(out[0].prediction_prompt, out[2].prediction_prompt);
});

test('empty room: planner returns nothing -> three different server scenarios, no throw', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_i: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (!body.images) return new Response(JSON.stringify({ response: '{}' }));
    return new Response(JSON.stringify({ response: JSON.stringify({ clock_visible: false, scene_description: 'An empty room.', scenarios: [] }) }));
  });
  const trace: any = {};
  const out = await planScenariosLocal({ imageDataUrl: 'data:image/jpeg;base64,dGVzdA==', prompt: 'p', scenarioCount: 3, trace, sceneDistances: [30, 30, -150] });
  assert.equal(out.length, 3);
  assert.equal(new Set(out.map((s) => s.prediction_prompt)).size, 3);
  assert.equal(trace.guard.synthesized, true);
  assert.equal(synthesizeEmptyRoom({ distances: [30], count: 1 }).length, 1);
});

function mockExtras(t: any, opts: { rewrite: string | null }) {
  const seen = { plan: 0, rewrite: 0, judge: 0, rewriteBody: null as any };
  t.mock.method(globalThis, 'fetch', async (_i: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (/Rewrite the following Japanese instruction/.test(body.prompt)) {
      seen.rewrite += 1;
      seen.rewriteBody = body;
      return new Response(JSON.stringify({ response: opts.rewrite === null ? '{}' : JSON.stringify({ en: opts.rewrite }) }));
    }
    if (/Does this English scenario fulfil/.test(body.prompt)) { seen.judge += 1; return new Response(JSON.stringify({ response: '{"ok":true}' })); }
    if (/Translate this Japanese instruction/.test(body.prompt)) return new Response(JSON.stringify({ response: '{"en":"heading home"}' }));
    if (body.images) {
      seen.plan += 1;
      const item = (p: string) => ({ prediction_prompt: p, scenario_description: '30 seconds later, x.', label: 'L' });
      return new Response(JSON.stringify({ response: JSON.stringify({
        clock_visible: false, scene_description: 'A woman sits at a desk with a cup.',
        scenarios: [item('The person turns slightly to their left.'), item('The person reaches for a cup.'), item('The person looks at the monitor.')],
      }) }));
    }
    return new Response(JSON.stringify({ response: '{}' }));
  });
  return seen;
}
const IMG = 'data:image/jpeg;base64,dGVzdA==';

test('extras: empty frame (detector false and the text names nobody) -> ignored with a reason for TD', async (t) => {
  const seen = mockExtras(t, { rewrite: 'The man stands up.' });
  const trace: any = {};
  // the planner mock says "A woman sits at a desk"; use a frame text without people
  t.mock.method(globalThis, 'fetch', async (_i: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (/Rewrite the following Japanese instruction/.test(body.prompt)) return new Response(JSON.stringify({ response: '{"en":"The man stands up."}' }));
    if (body.images) {
      const item = (p: string) => ({ prediction_prompt: p, scenario_description: '30 seconds later, x.', label: 'L' });
      return new Response(JSON.stringify({ response: JSON.stringify({ clock_visible: false, scene_description: 'An empty office with a curtain and a monitor.', scenarios: [item('The light dims.'), item('The curtain sways.'), item('The monitor screen flickers.')] }) }));
    }
    return new Response(JSON.stringify({ response: '{}' }));
  });
  void seen;
  const out = await planScenariosLocal({
    imageDataUrl: IMG, prompt: 'p', scenarioCount: 3, trace,
    detector: { person: false, count: 0, elapsedMs: 5 }, people: [], sceneExtras: { gen_a: '帰ろうとしている' },
  });
  assert.deepEqual(trace.guard.extrasStatus, { gen_a: 'ignored: frame empty' });
  assert.doesNotMatch(out[0].prediction_prompt, /man/);
});

test('extras: detector found nobody (people 0) while the planner text names a person -> the frame is empty, extras ignored with a reason', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_i: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.images) {
      const item = (p: string) => ({ prediction_prompt: p, scenario_description: '30 seconds later, x.', label: 'L' });
      return new Response(JSON.stringify({ response: JSON.stringify({ clock_visible: false, scene_description: 'Two people stand in an office.', scenarios: [item('The woman turns her head.'), item('The man in the cap turns his head.'), item('The woman looks down.')] }) }));
    }
    return new Response(JSON.stringify({ response: '{}' }));
  });
  const trace: any = {};
  const out = await planScenariosLocal({
    imageDataUrl: IMG, prompt: 'p', scenarioCount: 3, trace, sceneDistances: [30, 30, 30],
    detector: { person: false, count: 0, elapsedMs: 5 }, people: [], sceneExtras: { gen_b: '立ち上がってる' },
  });
  assert.equal(trace.guard.unoccupied, true);
  assert.deepEqual(trace.guard.extrasStatus, { gen_b: 'ignored: frame empty' });
  assert.ok(out.every((s) => !/woman|man/.test(s.prediction_prompt)));
});

test('describePeople: a reply cut off by the token budget (done_reason length) or broken JSON is unknown, not "nobody"', async () => {
  const mk = (response: string, done_reason: string) => (async () => new Response(JSON.stringify({ response, done_reason }))) as any;
  const cut = await describePeople('data:image/jpeg;base64,dGVzdA==', { fetchImpl: mk('{"people":[{"position":"left front","pose":"seated","clothes":"cap","hair":"lon', 'length') });
  assert.equal(cut.ok, false);
  assert.equal(cut.doneReason, 'length');
  assert.match(cut.rawHead ?? '', /^\{"people"/);
  const lenOk = await describePeople('data:image/jpeg;base64,dGVzdA==', { fetchImpl: mk('{"people":[]}', 'length') });
  assert.equal(lenOk.ok, false);
  const broken = await describePeople('data:image/jpeg;base64,dGVzdA==', { fetchImpl: mk('not json', 'stop') });
  assert.equal(broken.ok, false);
  const empty = await describePeople('data:image/jpeg;base64,dGVzdA==', { fetchImpl: mk('{"people":[]}', 'stop') });
  assert.deepEqual([empty.ok, empty.people.length], [true, 0]);
});


test('large arm motions are recognised; small ones are not', () => {
  for (const t of ['The person raises both hands above their head.', 'The person lifts both arms overhead and smiles.', 'The man stretches and yawns.', 'She waves at the camera.', 'Both arms raised, banzai.', 'The woman raises her hands into the air.']) {
    assert.ok(hasBigArmMotion(t), t);
  }
  for (const t of ['The person turns their head slightly to the left.', 'The man stands up from the chair and walks toward the door.', 'The person rests a hand on the desk.', 'The person adjusts their posture in the chair.']) {
    assert.ok(!hasBigArmMotion(t), t);
  }
  assert.match(modestMotion(PEOPLE, 0), /^The person on the left front \(grey striped shirt\) adjusts their posture/);
});

test('big arm motion: word match and the short semantic check replace the scene (no retry); extras are exempt', async (t) => {
  let plans = 0;
  let judges = 0;
  t.mock.method(globalThis, 'fetch', async (_i: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (/Does this action involve raising/.test(body.prompt)) {
      judges += 1;
      assert.equal(body.options.num_predict, 16);
      return new Response(JSON.stringify({ response: JSON.stringify({ arms_above_shoulders: /moving upward and back/.test(body.prompt) }) }));
    }
    if (!body.images) return new Response(JSON.stringify({ response: '{}' }));
    plans += 1;
    const item = (p: string) => ({ prediction_prompt: p, scenario_description: '30 seconds later, x.', label: 'L' });
    return new Response(JSON.stringify({ response: JSON.stringify({
      clock_visible: false, scene_description: 'A woman sits at a desk with a cup.',
      scenarios: [item('The person raises both hands above their head.'), item('The person looks at the cup.'), item('The person stands up, both arms moving upward and back.')],
    }) }));
  });
  const trace: any = {};
  const out = await planScenariosLocal({
    imageDataUrl: IMG, prompt: 'p', scenarioCount: 3, maxAttempts: 2, trace, sceneDistances: [30, 30, 30],
    detector: { person: true, count: 1, elapsedMs: 5 }, people: PEOPLE,
  });
  assert.equal(plans, 1);
  assert.equal(judges, 1); // scene 1: word match; scene 2 has no arm words (skipped); only scene 3 needs the semantic check
  assert.deepEqual(trace.guard.armsRaised, [0, 2]);
  assert.equal(out[1].prediction_prompt, 'The person looks at the cup.');
  assert.ok(out.every((s) => !hasBigArmMotion(s.prediction_prompt) && !/moving upward/.test(s.prediction_prompt)));
});

test('recent person drawn in an empty frame: extras ignored; behind view carries the scale rule; negatives', async (t) => {
  const seen = mockExtras(t, { rewrite: 'The man stands up.' });
  const out = await planScenariosLocal({
    imageDataUrl: IMG, prompt: 'p', scenarioCount: 3, allowPerson: true,
    detector: { person: false, count: 0, elapsedMs: 5 }, people: [], sceneExtras: { gen_a: '万歳' },
  });
  assert.ok(out.length === 3);
  void seen;
  const s = behindViewSentence({ clothes: 'teal shirt', hair: 'long black hair', position: 'left front' });
  assert.match(s, /at their original place \(left front, e\.g\. at the far desk\) at the same scale as in the reference image: a full figure in the middle or background of the room, never close to the camera, never filling the frame\./);
  const neg = buildNegativePrompt(false, false, true);
  assert.match(neg, /giant person, person too close to camera, oversized figure, cropped body filling frame/);
  assert.match(buildNegativePrompt(false), /arms raised overhead, stretching arms up, waving/);
});


import { lookupAction, buildExtraSentence, serverExtraDescription, clothesJa } from './sceneExtras';

test('extras dictionary: common instructions map to concrete action phrases (never the current pose)', () => {
  assert.equal(lookupAction('立ち上がってる')?.en, 'stands up from the chair');
  assert.equal(lookupAction('帰ろうとしている')?.en, 'gets ready to leave, picks up their belongings and heads for the exit');
  assert.equal(lookupAction('座る')?.en, 'sits down');
  assert.equal(lookupAction('振り向く')?.en, 'turns around to face the camera');
  assert.equal(lookupAction('両手を上げて喜んでいる')?.en, 'raises both arms above their head, smiling');
  assert.equal(lookupAction('立ち上がってる / 笑顔で')?.en, 'stands up from the chair and smiles');
  assert.equal(lookupAction('ふしぎな踊り'), null);
});

test('extras sentence and display text are templates (clothes from the people record)', () => {
  assert.equal(buildExtraSentence('stands up from the chair', 'teal shirt'), 'The person in the teal shirt stands up from the chair.');
  assert.equal(buildExtraSentence('stands up from the chair'), 'The person already in the photo stands up from the chair.');
  assert.equal(clothesJa('teal long-sleeved shirt'), '青緑の長袖のシャツ');
  assert.equal(clothesJa('blue shirt'), '青いシャツ');
  assert.equal(clothesJa('sparkly cape'), null);
  assert.equal(serverExtraDescription(30, '立ち上がる', 'blue shirt'), '30秒後、青いシャツの人物が立ち上がる。');
  assert.equal(serverExtraDescription(-150, '帰ろうとする'), '2分30秒前、写っている人物が帰ろうとする。');
});

test('extras end to end: dictionary action keeps the extra as the main event (-67 style input), no image call', async (t) => {
  const calls: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_i: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    if (body.images) {
      const item = (p: string) => ({ prediction_prompt: p, scenario_description: '30 seconds later, x.', label: 'L' });
      return new Response(JSON.stringify({ response: JSON.stringify({ clock_visible: false, scene_description: 'A woman sits at a desk with a cup and a monitor.', scenarios: [item('The person turns.'), item('The person in the teal shirt leans forward over the desk.'), item('The person looks at the monitor.')] }) }));
    }
    return new Response(JSON.stringify({ response: '{}' }));
  });
  const trace: any = {};
  const out = await planScenariosLocal({
    imageDataUrl: IMG, prompt: 'p', scenarioCount: 3, trace, sceneDistances: [30, 30, 30],
    detector: { person: true, count: 1, elapsedMs: 5 }, people: [{ position: 'right front', pose: 'seated', clothes: 'teal shirt', facing: 'right' }],
    sceneExtras: { gen_b: '立ち上がってる' },
  });
  assert.equal(out[1].prediction_prompt, 'The person in the teal shirt stands up from the chair.');
  assert.equal(out[1].scenario_description, '30秒後、青緑のシャツの人物が立ち上がる。');
  assert.match(out[1].prediction_prompt, /stands up/);
  assert.doesNotMatch(out[1].prediction_prompt, /leans|sits at|remains/);
  assert.equal(calls.filter((b) => b.images).length, 1, 'only the planner call carries an image');
  assert.equal(trace.guard.extras.gen_b.english, 'The person in the teal shirt stands up from the chair.');
});

test('extras: unknown instruction -> pure text translation call (num_predict 64), never the image', async (t) => {
  let tbody: any = null;
  t.mock.method(globalThis, 'fetch', async (_i: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (/Translate the COMPLETE Japanese instruction/.test(body.prompt)) { tbody = body; return new Response(JSON.stringify({ response: '{"action":"does a little dance"}' })); }
    if (body.images) {
      const item = (p: string) => ({ prediction_prompt: p, scenario_description: '30 seconds later, x.', label: 'L' });
      return new Response(JSON.stringify({ response: JSON.stringify({ clock_visible: false, scene_description: 'A woman sits at a desk.', scenarios: [item('The person turns.'), item('The person nods.'), item('The person looks.')] }) }));
    }
    return new Response(JSON.stringify({ response: '{}' }));
  });
  const out = await planScenariosLocal({
    imageDataUrl: IMG, prompt: 'p', scenarioCount: 3, sceneDistances: [30, 30, 30],
    detector: { person: true, count: 1, elapsedMs: 5 }, people: [], sceneExtras: { gen_a: 'ふしぎな踊り' },
  });
  assert.equal(tbody.options.num_predict, 64);
  assert.equal(tbody.images, undefined);
  assert.equal(out[0].prediction_prompt, 'The person already in the photo does a little dance.');
  assert.equal(out[0].scenario_description, '30秒後、写っている人物がふしぎな踊り。');
});

test('extras sentence: a translated phrase that carries its own subject is cleaned', () => {
  assert.equal(buildExtraSentence('someone is cheering', 'blue top'), 'The person in the blue top is cheering.');
  assert.equal(buildExtraSentence('cheering', 'blue top'), 'The person in the blue top is cheering.');
  assert.equal(buildExtraSentence('the person waves'), 'The person already in the photo waves.');
});

import { hasJaSubject, normalizePredicate } from './sceneExtras';
test('display text: a subject in the operator text is not doubled; colloquial endings are normalised (-73 B and C)', () => {
  assert.equal(serverExtraDescription(-25, 'どちらかの人がはしゃいでる', 'blue sweater'), '25秒前、どちらかの人がはしゃいでいる。');
  assert.equal(serverExtraDescription(30, '立ち上がる', 'blue sweater'), '30秒後、青いセーターの人物が立ち上がる。');
  assert.equal(serverExtraDescription(30, '立ち上がってる', 'blue sweater'), '30秒後、青いセーターの人物が立ち上がっている。');
  assert.equal(serverExtraDescription(30, 'はしゃいでる'), '30秒後、写っている人物がはしゃいでいる。');
  assert.equal(hasJaSubject('誰かが笑ってる'), true);
  assert.equal(hasJaSubject('立ち上がってる'), false);
  assert.equal(normalizePredicate('笑ってる。'), '笑っている');
});

test('recent-person path (-81 style): extras ignored, big arms replaced, planner not told the extras, subject in the display text', async (t) => {
  let plannerPrompt = '';
  t.mock.method(globalThis, 'fetch', async (_i: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (/Does this action involve raising/.test(body.prompt)) return new Response(JSON.stringify({ response: JSON.stringify({ arms_above_shoulders: /raising both arms/.test(body.prompt) }) }));
    if (body.images && /Describe every visible person/.test(body.prompt)) return new Response(JSON.stringify({ response: '{"people":[]}' }));
    if (/Translate every string in this JSON/.test(body.prompt)) {
      const payload = JSON.parse(body.prompt.slice(body.prompt.lastIndexOf('{"scene"')));
      return new Response(JSON.stringify({ response: JSON.stringify({ scene: payload.scene, items: ['30秒後、両腕を上に伸ばして立ち上がる。', '30秒後、人物がゆっくり振り向く。', '25秒前、頭を少し傾ける。'] }) }));
    }
    if (body.images) {
      plannerPrompt = body.prompt;
      const item = (p: string) => ({ prediction_prompt: p, scenario_description: '30 seconds later, x.', label: 'L' });
      return new Response(JSON.stringify({ response: JSON.stringify({ clock_visible: false, scene_description: 'An empty office with a curtain.', scenarios: [item('The person leans forward, raising both arms to hold the edge of the box.'), item('The person is cheering, arms raised wide.'), item('The person tilts their head.')] }) }));
    }
    return new Response(JSON.stringify({ response: '{}' }));
  });
  const trace: any = {};
  const out = await planScenariosLocal({
    imageDataUrl: IMG, prompt: 'p ' + buildSceneExtrasNote({ gen_b: '立ち上がってる', gen_c: 'どちらかの人がはしゃいでる' }), scenarioCount: 3, trace, allowPerson: true,
    detector: { person: false, count: 0, elapsedMs: 5 }, people: [], sceneDistances: [30, 30, -25],
    sceneExtras: { gen_b: '立ち上がってる', gen_c: 'どちらかの人がはしゃいでる' },
  });
  assert.doesNotMatch(plannerPrompt, /MAIN EVENTS requested by the operator/);                       // the planner is not told the extras
  assert.deepEqual(trace.guard.extrasStatus, { gen_b: 'ignored: frame empty', gen_c: 'ignored: frame empty' });
  assert.ok(out.every((s) => !hasBigArmMotion(s.prediction_prompt)));    // big arms replaced even though extras exist
  assert.deepEqual(trace.guard.armsRaised, [0, 1]);
  assert.match(out[0].scenario_description, /^30秒後、人物は/);          // subject added to the display text
});

import { mentionsSeveralPeople, recentPersonPhrase } from './peopleDescribe';
test('recent person path: one person, quiet motion as the main clause, environment as a subordinate clause; subject only where it is the person', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_i: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (/Translate every string in this JSON/.test(body.prompt)) {
      const payload = JSON.parse(body.prompt.slice(body.prompt.lastIndexOf('{"scene"')));
      return new Response(JSON.stringify({ response: JSON.stringify({ scene: payload.scene, items: ['30秒後、静かに立っている。容器がわずかに前へ押される。', '30秒後、二人が見つめ合う。', '25秒前、人物は静かに座っている。'] }) }));
    }
    if (body.images) {
      const item = (p: string) => ({ prediction_prompt: p, scenario_description: '30 seconds later, x.', label: 'L' });
      return new Response(JSON.stringify({ response: JSON.stringify({ clock_visible: false, scene_description: 'An empty office with a container and a curtain.', scenarios: [item('The container is pushed slightly forward.'), item('Two people look at each other.'), item('The person sits quietly.')] }) }));
    }
    return new Response(JSON.stringify({ response: '{}' }));
  });
  const out = await planScenariosLocal({
    imageDataUrl: IMG, prompt: 'p', scenarioCount: 3, allowPerson: true, sceneDistances: [30, 30, -25],
    detector: { person: false, count: 0, elapsedMs: 5 }, people: [],
  });
  assert.equal(out[0].prediction_prompt, `The person ${recentPersonPhrase(0)}, while the container is pushed slightly forward.`);
  assert.equal(out[1].prediction_prompt, `The person ${recentPersonPhrase(1)}.`);   // several people named -> one-person scene
  assert.equal(out[2].prediction_prompt, 'The person sits quietly.');               // already about the person: kept
  assert.ok(mentionsSeveralPeople('Two people look at each other.') && !mentionsSeveralPeople('The person turns.'));
  // subject is added only because the English sentence is about the person and the Japanese lost it ("容器が" is not touched)
  assert.match(out[0].scenario_description, /^30秒後、人物は静かに立っている/);
  assert.doesNotMatch(out[0].scenario_description, /人物は容器/);
});

test('parseObstruction / describePeople carry the obstruction verdict', async () => {
  const { parseObstruction } = await import('./peopleDescribe');
  assert.deepEqual(parseObstruction(JSON.stringify({ people: [], obstructed: true, obstructedBy: 'chair back' })), { obstructed: true, obstructedBy: 'chair back' });
  assert.deepEqual(parseObstruction(JSON.stringify({ people: [], obstructed: false, obstructedBy: 'stale' })), { obstructed: false, obstructedBy: '' });
  assert.equal(parseObstruction(JSON.stringify({ people: [] })), null);
  assert.equal(parseObstruction('nope'), null);
  const r = await describePeople('data:image/jpeg;base64,dGVzdA==', {
    fetchImpl: (async () => new Response(JSON.stringify({ response: JSON.stringify({ people: [], obstructed: true, obstructedBy: 'chair back' }) }))) as any,
  });
  assert.equal(r.ok, true);
  assert.equal(r.obstructed, true);
  assert.equal(r.obstructedBy, 'chair back');
});

test('parsePeople normalises facing to toward | side | away | unknown and the prompt names those values', () => {
  const facings = ['away', 'facing away', 'back to camera', 'profile', 'side', 'left', 'facing camera', 'toward', 'front', 'down', '', 'unknown'];
  const parsed = facings.map((facing, i) => parsePeople(JSON.stringify({ people: [{ position: `p${i}`, pose: 'seated', clothes: 'shirt', facing }] }))[0]);
  assert.deepEqual(parsed.map(p => p.facing), ['away', 'away', 'away', 'side', 'side', 'side', 'toward', 'toward', 'toward', 'unknown', 'unknown', 'unknown']);
  assert.match(DESCRIBE_PROMPT, /Facing MUST be exactly one of: toward .*side .*away .*unknown/);
  assert.equal(parsePeople(JSON.stringify({ people: [{ position: 'left', pose: 'seated', clothes: 'shirt', facing: '' }] }))[0].clothes, 'shirt');
});
