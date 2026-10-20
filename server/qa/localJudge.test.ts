import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  QaQueue,
  classifyEvidence,
  judgeImage,
  normalizeDefectType,
  parsePairAnswer,
  parseSingleAnswer,
  patchPromptsJson,
  summarizeQa,
  completedQaCaptureIds,
  latestQaRows,
  buildPairPrompt,
  LOCAL_INSPECTION_VERSION,
  PAIR_ANSWER_SCHEMA,
  type QaRow,
} from './localJudge';

const instances = (count: number | null, side: string) => count === null ? null :
  Array.from({length:count},(_,i)=>({id:side+String(i+1),support:'surface',holder:'none'}));
const inventoryCount = (category:string,a:number|null,b:number|null) => ({
  category,a,b,instancesA:instances(a,'a-'+category+'-'),instancesB:instances(b,'b-'+category+'-'),
});
const completePair = (raw: string): string => {
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j.added) && Array.isArray(j.removed)) return JSON.stringify({
      counts:[],changed:[],uncertain:[],...j,
      ...(Array.isArray(j.counts) ? {counts:j.counts.map((c:any)=>'category' in c ? c : inventoryCount(c.item,c.a,c.b))} : {}),
    });
  } catch {}
  return raw;
};

const TINY = 'data:image/png;base64,iVBORw0KGgo=';

test('normalizeDefectType maps free text onto the fixed classes', () => {
  assert.equal(normalizeDefectType('fabricated_object'), 'fabricated_object');
  assert.equal(normalizeDefectType('Floating'), 'floating');
  assert.equal(normalizeDefectType('extra person added'), 'fabricated_person');
  assert.equal(normalizeDefectType('object disappeared'), 'missing_object');
  assert.equal(normalizeDefectType('hand deformed'), 'anatomy');
  assert.equal(normalizeDefectType('???'), 'other');
});

test('parse pair / single answers: strings or objects, junk tolerated', () => {
  assert.deepEqual(parsePairAnswer('{"added":["beige jacket",{"object_type":"laptop","where":"left"}],"removed":[]}'), {
    added: ['beige jacket', 'laptop left'],
    removed: [],
  });
  assert.deepEqual(parsePairAnswer('noise {"added":[],"removed":["white paper bag"]} tail'), { added: [], removed: ['white paper bag'] });
  assert.equal(parsePairAnswer('not json'), null);
  assert.equal(parsePairAnswer('{"foo":1}'), null);
  assert.deepEqual(parseSingleAnswer('{"defects":[{"type":"floating","where":"desk","note":"laptop in the air"},{"type":"mismatch","where":"x","note":"y"}]}'), [
    { type: 'floating', where: 'desk', note: 'laptop in the air' },
    { type: 'mismatch', where: 'x', note: 'y' },
  ]);
  assert.deepEqual(parseSingleAnswer('{"defects":[]}'), []);
  assert.equal(parseSingleAnswer('{}'), null);
});

test('entity additions are not waived by an instruction mentioning their names', () => {
  const instruction = 'A beige jacket is pulled from the back of the chair to the left, revealing a black laptop under it.';
  const defects = classifyEvidence(
    { a: { added: ['beige jacket', 'laptop'], removed: [] }, b: { added: ['white paper bag'], removed: [] }, single: [] },
    instruction
  );
  assert.deepEqual(defects.map((d) => [d.type, d.where]), [['fabricated_object', 'beige jacket'], ['fabricated_object', 'laptop'], ['lost_belongings', 'white paper bag']]);
});

test('classification: person movement does not authorize an added person', () => {
  const d1 = classifyEvidence({ a: { added: ['white tote bag on the chair'], removed: [] }, b: { added: [], removed: ['white tote bag on the chair'] }, single: [] }, 'The light dims slightly.');
  assert.deepEqual(d1.map((d) => d.type), ['fabricated_object']); // both passes agree: one entry, not two
  const d2 = classifyEvidence({ a: { added: ['a person'], removed: [] }, b: null, single: [] }, 'The light dims slightly.');
  assert.deepEqual(d2.map((d) => d.type), ['fabricated_person']);
  const d3 = classifyEvidence({ a: { added: ['woman'], removed: [] }, b: null, single: [] }, 'The person in the black t-shirt turns their head slightly.');
  assert.deepEqual(d3.map(d => d.type), ['fabricated_person']);
  const d4 = classifyEvidence({ a: { added: [], removed: [] }, b: { added: [], removed: [] }, single: [{ type: 'floating', where: 'laptop', note: 'hovers' }] }, 'x');
  assert.deepEqual(d4.map((d) => d.type), ['floating']);
});

function mockFetch(t: any, answers: string[]) {
  let n = 0;
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_u: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ response: completePair(answers[Math.min(n++, answers.length - 1)]) }));
  });
  return bodies;
}

test('judgeImage: three calls (pair, swapped pair, single), 2 images for the pairs, json format, bounded pair/single output budgets', async (t) => {
  const bodies = mockFetch(t, ['{"added":["white tote bag"],"removed":[]}', '{"added":[],"removed":["white tote bag"]}', '{"defects":[]}']);
  const r = await judgeImage({ nowImage: TINY, image: TINY, predictionPrompt: 'The light dims.' }, { ollamaUrl: 'http://x', model: 'm' });
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].images.length, 2);
  assert.equal(bodies[2].images.length, 1);
  assert.deepEqual(bodies[0].format, PAIR_ANSWER_SCHEMA);
  assert.deepEqual(bodies[1].format, PAIR_ANSWER_SCHEMA);
  assert.equal(bodies[2].format, 'json');
  assert.equal(bodies[0].options.num_predict, 512);
  assert.equal(bodies[2].options.num_predict, 256);
  assert.equal(bodies[0].options.num_ctx, 8192, "same ctx as recognition and planning, or Ollama reloads the runner");
  assert.equal(bodies[0].think, false);
  assert.equal(r.ok, false);
  assert.deepEqual(r.defects.map((d) => d.type), ['fabricated_object']);
  assert.equal(r.score, 0.75);
  assert.equal(r.model, 'm');
});

test('judgeImage: nothing found = ok; a failing or unparseable call = ok:null (unknown), never ok', async (t) => {
  mockFetch(t, ['{"added":[],"removed":[]}', '{"added":[],"removed":[]}', '{"defects":[]}']);
  const ok = await judgeImage({ nowImage: TINY, image: TINY, predictionPrompt: 'x' }, { ollamaUrl: 'http://x', model: 'm' });
  assert.equal(ok.ok, true);
  assert.equal(ok.score, 1);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('boom', { status: 500 }));
  const err = await judgeImage({ nowImage: TINY, image: TINY, predictionPrompt: 'x' }, { ollamaUrl: 'http://x', model: 'm' });
  assert.equal(err.ok, null);
  assert.match(String(err.error), /500/);
  t.mock.restoreAll();
  mockFetch(t, ['garbage', 'garbage', 'garbage']);
  const bad = await judgeImage({ nowImage: TINY, image: TINY, predictionPrompt: 'x' }, { ollamaUrl: 'http://x', model: 'm' });
  assert.equal(bad.ok, null);
  const noImg = await judgeImage({ nowImage: 'nope', image: TINY, predictionPrompt: 'x' }, {});
  assert.equal(noImg.ok, null);
});

test('queue: one job at a time, in order', async () => {
  const q = new QaQueue(() => false, { pollMs: 5 });
  let running = 0;
  let maxRunning = 0;
  const order: string[] = [];
  for (const id of ['a', 'b', 'c']) {
    q.enqueue({
      captureId: id,
      sceneKey: 's',
      run: async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 10));
        order.push(id);
        running -= 1;
      },
    });
  }
  await q.idle();
  assert.equal(maxRunning, 1);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('queue: nothing runs while a capture is busy; an interrupt aborts the running job and it is retried later', async () => {
  let busy = true;
  const q = new QaQueue(() => busy, { pollMs: 5 });
  const log: string[] = [];
  let attempt = 0;
  q.enqueue({
    captureId: 'a',
    sceneKey: 's',
    run: async (signal) => {
      attempt += 1;
      log.push(`start${attempt}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, attempt === 1 ? 500 : 5);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        });
      });
      if (!signal.aborted) log.push('done');
    },
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(log, [], 'busy: not started');
  busy = false;
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(log, ['start1']);
  busy = true;
  q.interrupt(); // a capture starts
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(log, ['start1'], 'aborted job waits while busy');
  busy = false;
  await q.idle();
  assert.deepEqual(log, ['start1', 'start2', 'done']);
});

test('queue: trim drops the oldest waiting jobs', async () => {
  const q = new QaQueue(() => true, { pollMs: 1000 });
  for (let i = 0; i < 5; i++) q.enqueue({ captureId: String(i), sceneKey: 's', run: async () => {} });
  assert.equal(q.trim(3), 2);
  assert.equal(q.length, 3);
  q.stop();
});

function row(over: Partial<QaRow>): QaRow {
  return { time: '2026-10-16T10:00:00.000Z', captureId: 'c', sceneKey: 'gen_a', file: 'f', ok: true, score: 1, defects: [], model: 'm', elapsedMs: 1000, rulebookVersion: 1, ...over };
}

test('summary: defect rate by rulebook version, per type, unknowns counted apart', () => {
  const rows = [
    row({}),
    row({ ok: false, score: 0.75, defects: [{ type: 'fabricated_object', where: 'a', note: 'n' }] }),
    row({ ok: false, score: 0.5, defects: [{ type: 'fabricated_object', where: 'a', note: 'n' }, { type: 'floating', where: 'b', note: 'n' }] }),
    row({ ok: null, score: null, error: 'timeout' }),
    row({ rulebookVersion: 2 }),
    row({ rulebookVersion: 2 }),
  ];
  const g = summarizeQa(rows, 'rulebookVersion');
  assert.deepEqual(g.map((x) => x.key), ['1', '2']);
  const v1 = g[0];
  assert.equal(v1.images, 4);
  assert.equal(v1.judged, 3);
  assert.equal(v1.unknown, 1);
  assert.equal(v1.defective, 2);
  assert.equal(v1.defectRate, 0.667);
  assert.deepEqual(v1.byType.fabricated_object, { count: 2, rate: 0.667 });
  assert.deepEqual(v1.byType.floating, { count: 1, rate: 0.333 });
  assert.equal(g[1].defectRate, 0);
});

test('patchPromptsJson adds qaLocal to the right scene of the archive file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-arch-'));
  fs.writeFileSync(path.join(dir, '2026-10-16_00-00-00_prompts.json'), JSON.stringify({ scenes: [{ sceneKey: 'gen_a' }, { sceneKey: 'gen_b' }] }));
  assert.equal(patchPromptsJson(dir, 'gen_b', { ok: false }), true);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, '2026-10-16_00-00-00_prompts.json'), 'utf8'));
  assert.equal(doc.scenes[0].qaLocal, undefined);
  assert.deepEqual(doc.scenes[1].qaLocal, { ok: false });
  assert.equal(patchPromptsJson(dir, 'gen_z', {}), false);
  assert.equal(patchPromptsJson(null, 'gen_a', {}), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('G-14 / G-15 classes: held items that vanish are lost_belongings, free text maps to new_face', () => {
  const d = classifyEvidence({ a: { added: [], removed: ['microphone in the right hand'] }, b: null, single: [] }, 'The person turns their head.');
  assert.deepEqual(d.map((x) => x.type), ['lost_belongings']);
  assert.equal(normalizeDefectType('new face drawn'), 'new_face');
  assert.equal(normalizeDefectType('lost belongings'), 'lost_belongings');
});

test('G-16 / obstruction classes: new text or clock, vanished obstruction', () => {
  const t = classifyEvidence({ a: { added: ['clock text on the laptop screens'], removed: ['black chair backrest in the foreground'] }, b: null, single: [] }, 'The light dims slightly.');
  assert.deepEqual(t.map((x) => x.type).sort(), ['new_text_or_clock', 'obstruction_removed']);
  assert.equal(normalizeDefectType('garbled clock'), 'new_text_or_clock');
  assert.equal(normalizeDefectType('obstruction removed'), 'obstruction_removed');
});

test('depth_order_broken class', () => {
  assert.equal(normalizeDefectType('depth order broken'), 'depth_order_broken');
  assert.equal(normalizeDefectType('monitors pasted in front of the mesh'), 'depth_order_broken');
});

test('light_artifact class', () => {
  assert.equal(normalizeDefectType('rainbow light streaks'), 'light_artifact');
  assert.equal(normalizeDefectType('lens flare'), 'light_artifact');
});

test('malformed pair fields and members never become empty valid evidence', () => {
  for (const value of [
    {added: []}, {removed: []}, {added: null, removed: []}, {added: 'none', removed: []},
    {added: [], removed: {}}, {added: [null], removed: []}, {added: [false], removed: []},
    {added: [''], removed: []}, {added: [{}], removed: []}, {added: [['person']], removed: []},
    {added: [{object: 'cup', count: 2}], removed: []},
    {added: ['a','b','c','d','e','f',42], removed: []},
  ]) assert.equal(parsePairAnswer(JSON.stringify(value)), null, JSON.stringify(value));
});

test('malformed single defects never become empty valid evidence', () => {
  for (const defects of [null, 'none', {}, [null], [5], [[]], [{}],
    [{type: 'floating', where: 'desk'}], [{type: '', where: 'desk', note: 'x'}],
    [{type: 'floating', where: {}, note: 'x'}], [{type: 'anatomy', where: 'arm', note: null}]]) {
    assert.equal(parseSingleAnswer(JSON.stringify({defects})), null, JSON.stringify(defects));
  }
});

test('any failed one of the three inspections yields unknown and preserves valid findings', async () => {
  const clean = ['{"added":[],"removed":[]}', '{"added":[],"removed":[]}', '{"defects":[]}'];
  for (let broken = 0; broken < 3; broken++) {
    const answers = [...clean]; answers[broken] = broken === 2 ? '{"defects":false}' : '{"added":[],"removed":null}';
    let i = 0;
    const r = await judgeImage({nowImage:TINY,image:TINY,predictionPrompt:'The person raises a hand.'}, {
      fetchImpl: async () => new Response(JSON.stringify({response:completePair(answers[i++])})),
    });
    assert.equal(r.ok,null, `broken inspection ${broken}`); assert.equal(r.score,null); assert.match(r.error!, /unparseable/);
  }
  let i=0;
  const answers=['{"added":["another person"],"removed":[]}', 'garbage', '{"defects":[]}'];
  const r=await judgeImage({nowImage:TINY,image:TINY,predictionPrompt:'The person raises a hand.'}, {
    fetchImpl:async()=>new Response(JSON.stringify({response:completePair(answers[i++])})),
  });
  assert.equal(r.ok,null); assert.equal(r.defects[0].type,'fabricated_person');
});

test('requested movement permits unchanged entities, never duplicate people or held-item loss/ownership change', () => {
  const instruction='The person raises their right hand while holding a cup.';
  assert.deepEqual(classifyEvidence({a:{added:[],removed:[]},b:{added:[],removed:[]},single:[]},instruction),[]);
  for (const item of ['another person raising a hand','a duplicate person','an extra cup','cup in another person hand']) {
    const defects=classifyEvidence({a:{added:[item],removed:[]},b:null,single:[]},instruction);
    assert.equal(defects.length,1,item);
  }
  const d=classifyEvidence({a:{added:['cup held by another person'],removed:['cup from original holder']},b:null,single:[]},instruction);
  assert.equal(d.length,2); assert.ok(d.some(x=>x.type==='lost_belongings'));
  const lost=classifyEvidence({a:{added:[],removed:['cup in right hand']},b:null,single:[]},instruction);
  assert.equal(lost[0].type,'lost_belongings');
});

test('accepted quality excludes rejected attempts but preserves separate rejection evidence', () => {
  const rows=[row({}),row({sceneKey:'gen_a.rejected1',ok:false,defects:[{type:'fabricated_person',where:'left',note:'duplicate'}]}),
    row({sceneKey:'gen_a.rejected2',ok:null,score:null})];
  const s=summarizeQa(rows)[0];
  assert.equal(s.images,1); assert.equal(s.defectRate,0); assert.deepEqual(s.byType,{});
  assert.equal(s.rejected.images,2); assert.equal(s.rejected.judged,1); assert.equal(s.rejected.unknown,1);
  assert.equal(s.rejected.defectRate,1); assert.equal(s.rejected.byType.fabricated_person.count,1);
  assert.equal(s.completedCaptures,0);
});

test('validation counts complete accepted captures, excluding partial, unknown and rejected-only captures', () => {
  const complete=['gen_a','gen_b','gen_c'].map(sceneKey=>row({captureId:'complete',sceneKey}));
  const rows=[...complete,...complete.slice(0,2).map(r=>({...r,captureId:'partial'})),
    ...complete.map(r=>({...r,captureId:'unknown',ok:r.sceneKey==='gen_c'?null:r.ok})),
    row({captureId:'rejected-only',sceneKey:'gen_a.rejected1',ok:false}),
    row({captureId:'one-planned',sceneCount:1})];
  assert.deepEqual([...completedQaCaptureIds(rows)].sort(),['complete','one-planned']);
  const recheck=row({captureId:'complete',sceneKey:'gen_c',ok:null,time:'2026-10-16T11:00:00Z'});
  assert.equal(completedQaCaptureIds([...rows,recheck]).has('complete'),false);
});

test('rejected attempts with different files survive deduplication; rechecks of the same attempt replace it', () => {
  const r=row({sceneKey:'gen_a.rejected1',file:'attempt1.png',ok:false});
  const latest=latestQaRows([r,{...r,file:'rerun1.png'},{...r,time:'2026-10-16T11:00:00Z',ok:true}]);
  assert.equal(latest.length,2); assert.equal(latest.find(x=>x.file==='attempt1.png')?.ok,true);
});


test('preservation schema requires counts, changed and uncertain; malformed inventory is unknown', () => {
  const clean={added:[],removed:[],counts:[],changed:[],uncertain:[]};
  assert.equal(parsePairAnswer('{"added":[],"removed":[]}',true),null);
  for (const counts of [null,{},[{item:'device',a:-1,b:1}],[{item:'device',a:'1',b:2}],
    [{item:'device',a:1.5,b:2}],[{item:'device',a:1}],
    [{item:'device',a:1,b:2},{item:'Device',a:2,b:2}]]) {
    assert.equal(parsePairAnswer(JSON.stringify({...clean,counts}),true),null);
  }
  assert.equal(parsePairAnswer(JSON.stringify({...clean,changed:[{}]}),true),null);
  assert.equal(parsePairAnswer(JSON.stringify({...clean,uncertain:'none'}),true),null);
  assert.deepEqual(parsePairAnswer(JSON.stringify({...clean,counts:[{item:'tablet',a:null,b:1}]}),true)?.counts,[{item:'tablet',a:null,b:1}]);
});

test('inventory detects an extra instance even when noun-difference lists are empty, in both orders', () => {
  const forward={added:[],removed:[],counts:[{item:'tablet',a:1,b:2},{item:'bag',a:0,b:1}]};
  const reverse={added:[],removed:[],counts:[{item:'tablet',a:2,b:1},{item:'bag',a:1,b:0}]};
  const defects=classifyEvidence({a:forward,b:reverse,single:[]},'The person raises their hand.');
  assert.deepEqual(defects.map(d=>[d.type,d.where]),[['fabricated_object','tablet'],['fabricated_object','bag']]);
  assert.deepEqual(classifyEvidence({a:{...forward,counts:[{item:'tablet',a:1,b:1}]},b:null,single:[]},'turn'),[]);
});

test('a person mentioned as an object holder does not turn an object duplication into a person duplication', () => {
  const defects=classifyEvidence({a:{added:['tablet held by a person','bag on a woman','person carrying a bag'],removed:[]},b:null,single:[]},'');
  assert.deepEqual(defects.map(d=>d.type),['fabricated_object','fabricated_object','fabricated_person']);
});

test('screen content changes and impossible support survive even when instance counts match', () => {
  const changed={type:'screen_changed' as const,where:'left display',note:'different visible interface'};
  const defects=classifyEvidence({a:{added:[],removed:[],counts:[{item:'display',a:1,b:1}],changed:[changed]},b:null,
    single:[{type:'implausible_placement',where:'device',note:'intersects the support surface'}]},'');
  assert.deepEqual(defects.map(d=>d.type),['screen_changed','implausible_placement']);
});

test('unknown inventory or ownership yields unknown; findings and raw evidence remain available', async () => {
  for (const unresolved of [{counts:[{item:'cup',a:null,b:2}]},{uncertain:['holder occluded']}]) {
    const pair=completePair(JSON.stringify({added:['extra cup'],removed:[],counts:[],changed:[],uncertain:[],...unresolved}));
    const answers=[pair,completePair('{"added":[],"removed":[]}'),'{"defects":[]}'];let i=0;
    const r=await judgeImage({nowImage:TINY,image:TINY,predictionPrompt:'raise hand'}, {
      fetchImpl:async()=>new Response(JSON.stringify({response:answers[i++]})),
    });
    assert.equal(i,3);assert.equal(r.ok,null);assert.match(r.error!,/uncertain/);
    assert.equal(r.defects[0].type,'fabricated_object');assert.equal(r.evidence?.pair,pair);
    assert.equal(r.inspectionVersion,LOCAL_INSPECTION_VERSION);
  }
});

test('live inspection cannot accept a legacy empty answer as complete preservation evidence', async () => {
  let i=0;
  const answers=['{"added":[],"removed":[]}','{"added":[],"removed":[]}','{"defects":[]}'];
  const r=await judgeImage({nowImage:TINY,image:TINY,predictionPrompt:''},{fetchImpl:async()=>new Response(JSON.stringify({response:answers[i++]}))});
  assert.equal(r.ok,null);assert.match(r.error!,/unparseable/);assert.equal(i,3);
});

test('a later transport failure does not discard earlier clear findings or raw answers', async () => {
  const pair=completePair('{"added":["extra cup"],"removed":[]}');let i=0;
  const r=await judgeImage({nowImage:TINY,image:TINY,predictionPrompt:''},{fetchImpl:async()=> {
    if(i++===0)return new Response(JSON.stringify({response:pair}));throw new Error('offline');
  }});
  assert.equal(r.ok,null);assert.equal(r.defects[0].type,'fabricated_object');assert.equal(r.evidence?.pair,pair);
});


test('inconsistent forward/reverse inventories cannot pass even when each claims no count change', async () => {
  const pair=(count:number)=>completePair(JSON.stringify({added:[],removed:[],counts:[{item:'tablet',a:count,b:count}],changed:[],uncertain:[]}));
  const answers=[pair(1),pair(2),'{"defects":[]}'];let i=0;
  const r=await judgeImage({nowImage:TINY,image:TINY,predictionPrompt:''},{fetchImpl:async()=>new Response(JSON.stringify({response:answers[i++]}))});
  assert.equal(r.ok,null);assert.match(r.error!,/inconsistent count/);
});


const groupedPair=(counts:unknown[],over:Record<string,unknown>={})=>JSON.stringify({added:[],removed:[],counts,changed:[],uncertain:[],...over});
async function inspectInventory(forward:string,reverse:string) {
  const answers=[forward,reverse,'{"defects":[]}'];let calls=0;
  const result=await judgeImage({nowImage:TINY,image:TINY,predictionPrompt:'The existing object is moved.'},{
    fetchImpl:async()=>new Response(JSON.stringify({response:answers[calls++]})),
  });
  assert.equal(calls,3);
  assert.equal(result.evidence?.pair,forward);assert.equal(result.evidence?.swappedPair,reverse);
  assert.equal(result.inspectionVersion,LOCAL_INSPECTION_VERSION);
  return result;
}

test('category totals catch a held copy plus a remaining surface copy with empty difference lists',async()=>{
  for(const category of ['tool','camera tripod','standing lamp']) {
    const forward=inventoryCount(category,1,2);
    forward.instancesB![0]={id:'b1',support:'hand',holder:'person1'};
    forward.instancesB![1]={id:'b2',support:'table',holder:'none'};
    const reverse=inventoryCount(category,2,1);
    reverse.instancesA=forward.instancesB;reverse.instancesB=forward.instancesA;
    const result=await inspectInventory(groupedPair([forward]),groupedPair([reverse]));
    assert.equal(result.ok,false,category);
    assert.deepEqual(result.defects.map(d=>[d.type,d.where]),[['fabricated_object',category]]);
  }
});

test('one physical item changing support or grip does not become a duplication or disappearance',async()=>{
  for(const [before,after] of [
    [{support:'table',holder:'none'},{support:'one hand',holder:'person1'}],
    [{support:'left hand',holder:'person1'},{support:'right hand',holder:'person1'}],
    [{support:'table, touched by a hand',holder:'none'},{support:'table',holder:'none'}],
  ]) {
    const forward=inventoryCount('tool',1,1);
    forward.instancesA![0]={id:'a1',...before};forward.instancesB![0]={id:'b1',...after};
    const reverse={...forward,instancesA:forward.instancesB,instancesB:forward.instancesA};
    const result=await inspectInventory(groupedPair([forward]),groupedPair([reverse]));
    assert.equal(result.ok,true);assert.deepEqual(result.defects,[]);
  }
});

test('a clear ownership transfer remains a defect despite unchanged category totals',async()=>{
  const c=inventoryCount('tool',1,1);
  c.instancesA![0].holder='person1';c.instancesB![0].holder='person2';
  const changed=[{type:'mismatch',where:'tool owner',note:'transferred from person1 to person2'}];
  const result=await inspectInventory(groupedPair([c],{changed}),groupedPair([{...c,instancesA:c.instancesB,instancesB:c.instancesA}]));
  assert.equal(result.ok,false);assert.equal(result.defects[0].type,'mismatch');
});

test('total and physical instance disagreement or duplicate IDs cannot pass or establish a false count change',async()=>{
  const variants=[
    {...inventoryCount('tool',1,2),instancesB:instances(1,'b')},
    {...inventoryCount('tool',1,2),instancesB:[{id:'same',support:'hand',holder:'person1'},{id:'same',support:'table',holder:'none'}]},
  ];
  for(const c of variants) {
    const result=await inspectInventory(groupedPair([c]),groupedPair([inventoryCount('tool',1,1)]));
    assert.equal(result.ok,null);assert.match(result.error!,/mismatch|repeated physical instance/);
    assert.deepEqual(result.defects,[]);
  }
});

test('unknown totals, support, holder or instance visibility remain unknown',async()=>{
  const variants=[
    inventoryCount('tool',null,1),
    {...inventoryCount('tool',1,1),instancesA:null},
    {...inventoryCount('tool',1,1),instancesA:[{id:'a1',support:null,holder:'none'}]},
    {...inventoryCount('tool',1,1),instancesA:[{id:'a1',support:'table',holder:null}]},
  ];
  for(const c of variants) {
    const result=await inspectInventory(groupedPair([c]),groupedPair([inventoryCount('tool',1,1)]));
    assert.equal(result.ok,null);assert.match(result.error!,/uncertain/);
  }
});

test('each image instance ID must be unique across categories and aliases are not silently merged',async()=>{
  const a=inventoryCount('tool',1,1),b=inventoryCount('device',1,1);
  b.instancesA![0].id=a.instancesA![0].id;
  const repeated=await inspectInventory(groupedPair([a,b]),groupedPair([inventoryCount('tool',1,1),inventoryCount('device',1,1)]));
  assert.equal(repeated.ok,null);assert.match(repeated.error!,/repeated physical instance/);
  const unmatched=await inspectInventory(groupedPair([inventoryCount('portable device',1,1)]),groupedPair([inventoryCount('device',1,1)]));
  assert.equal(unmatched.ok,null);assert.match(unmatched.error!,/unmatched category/);
});

test('category normalization preserves compounds and only ignores case and whitespace',async()=>{
  const result=await inspectInventory(groupedPair([inventoryCount(' Camera  Tripod ',1,1)]),groupedPair([inventoryCount('camera tripod',1,1)]));
  assert.equal(result.ok,true);
  const duplicate=groupedPair([inventoryCount('Standing lamp',1,1),inventoryCount('standing  lamp',1,1)]);
  assert.equal(parsePairAnswer(duplicate,true,true),null);
});

test('v3 requires explicit category and instance structure; legacy state split counts remain unknown',async()=>{
  const legacy=groupedPair([{item:'hand holding tool',a:0,b:1},{item:'tool on surface',a:0,b:1}]);
  const result=await inspectInventory(legacy,groupedPair([inventoryCount('tool',2,1)]));
  assert.equal(result.ok,null);assert.match(result.error!,/unparseable/);
  assert.equal(parsePairAnswer(legacy,true,true),null);
  assert.ok(parsePairAnswer(legacy,true),'historical v2 reader remains available without reinterpretation');
  for(const bad of [
    {...inventoryCount('tool',1,1),instancesA:[{id:'a1',support:'hand'}]},
    {...inventoryCount('tool',1,1),instancesB:{}},
    {...inventoryCount('tool',1,1),instancesA:[{id:'',support:'hand',holder:'person1'}]},
  ]) assert.equal(parsePairAnswer(groupedPair([bad]),true,true),null);
});

test('pair prompt separates category totals, physical instances, supports and owners without an object-specific alias list',()=>{
  const prompt=buildPairPrompt();
  assert.match(prompt,/ONE counts row per canonical singular category/);
  assert.match(prompt,/one object, supported by furniture/);
  assert.match(prompt,/Total a\/b must equal/);
  assert.match(prompt,/"category".*"instancesA".*"support".*"holder"/);
});


test('confirmed zero instances are distinct from unknown and total loss remains a defect',async()=>{
  const absent=await inspectInventory(groupedPair([inventoryCount('tool',0,0)]),groupedPair([inventoryCount('tool',0,0)]));
  assert.equal(absent.ok,true);
  const lost=await inspectInventory(groupedPair([inventoryCount('tool',1,0)]),groupedPair([inventoryCount('tool',0,1)]));
  assert.equal(lost.ok,false);
  assert.deepEqual(lost.defects.map(d=>[d.type,d.where]),[['missing_object','tool']]);
});


const recordedIncompleteF005 = [{"sceneKey": "gen_a", "error": "unparseable answer: pair", "elapsedMs": 10934, "evidence": {"pair": "{\n  \"added\":[],\n  \"removed\":[],\n  \"counts\":[{\n    \"category\": \"object type\",\n    \"a\": 2,\n    \"b\": 1,\n    \"instancesA\": [{\n      \"id\": \"a1\",\n      \"support\": \"surface\",\n      \"holder\": null\n    }, {\n      \"id\": \"a2\",\n      \"support\": \"hand\",\n      \"holder\": \"person1\"\n    }]\n  }],\n  \"changed\":[],\n  \"uncertain\": []\n}", "swappedPair": "{\n  \"added\":[],\n  \"removed\":[],\n  \"counts\":[{\n    \"category\": \"object type\",\n    \"a\": 2,\n    \"b\": 3,\n    \"instancesA\": [\n      {\n        \"id\": \"a1\",\n        \"support\": \"surface\",\n        \"holder\": null\n      },\n      {\n        \"id\": \"a2\",\n        \"support\": \"hand\",\n        \"holder\": \"person1\"\n      }\n    ],\n    \"instancesB\": [\n      {\n        \"id\": \"b1\",\n        \"support\": \"hand\",\n        \"holder\": \"person1\"\n      },\n      {\n        \"id\": \"b2\",\n        \"support\": \"surface\",\n        \"holder\": null\n      },\n      {\n        \"id\": \"b3\",\n        \"support\": \"surface\",\n        \"holder\": null\n      }\n    ]\n  }],\n  \"changed\":[],\n  \"uncertain\": []\n}", "single": "{\n  \"defects\": []\n}"}}, {"sceneKey": "gen_b", "error": "unparseable answer: pair", "elapsedMs": 11137, "evidence": {"pair": "{\n  \"added\":[],\n  \"removed\":[],\n  \"counts\":[{\n    \"category\": \"object type\",\n    \"a\": 2,\n    \"b\": 1,\n    \"instancesA\": [{\n      \"id\": \"a1\",\n      \"support\": \"surface\",\n      \"holder\": null\n    }, {\n      \"id\": \"a2\",\n      \"support\": \"hand\",\n      \"holder\": \"person\"\n    }]\n  }],\n  \"changed\":[],\n  \"uncertain\": []\n}", "swappedPair": "{\n  \"added\":[],\n  \"removed\":[],\n  \"counts\":[{\n    \"category\": \"object type\",\n    \"a\": 2,\n    \"b\": 1,\n    \"instancesA\": [\n      {\n        \"id\": \"a1\",\n        \"support\": \"surface\",\n        \"holder\": null\n      },\n      {\n        \"id\": \"a2\",\n        \"support\": \"hand\",\n        \"holder\": \"person\"\n      }\n    ],\n    \"instancesB\": [\n      {\n        \"id\": \"b1\",\n        \"support\": \"hand\",\n        \"holder\": \"person\"\n      }\n    ]\n  }],\n  \"changed\":[\n    {\"type\":\"screen_changed\",\"where\":\"location\",\"note\":\"difference\"}\n  ],\n  \"uncertain\":[\"The object held in the first image is not clearly identifiable as a distinct physical item from its appearance and context. The second image shows an identical-looking handheld device, but it's unclear if this represents one or two separate objects due to lack of clear visual distinction.\"],\n  \"mismatch\": []\n}", "single": "{\n  \"defects\": []\n}"}}, {"sceneKey": "gen_c", "error": "unparseable answer: swapped pair", "elapsedMs": 9779, "evidence": {"pair": "{\n  \"added\":[],\n  \"removed\":[],\n  \"counts\":[{\n    \"category\": \"object type\",\n    \"a\": 2,\n    \"b\": 1,\n    \"instancesA\": [\n      {\n        \"id\": \"a1\",\n        \"support\": \"surface\",\n        \"holder\": null\n      },\n      {\n        \"id\": \"a2\",\n        \"support\": \"hand\",\n        \"holder\": \"person\"\n      }\n    ],\n    \"instancesB\": [\n      {\n        \"id\": \"b1\",\n        \"support\": \"hand\",\n        \"holder\": \"person\"\n      }\n    ]\n  }],\n  \"changed\": [],\n  \"uncertain\": []\n}", "swappedPair": "{\n  \"added\":[],\n  \"removed\":[],\n  \"counts\":[{\n    \"category\": \"object type\",\n    \"a\": 2,\n    \"b\": 1,\n    \"instancesA\": [{\n      \"id\": \"a1\",\n      \"support\": \"surface\",\n      \"holder\": null\n    }, {\n      \"id\": \"a2\",\n      \"support\": \"hand\",\n      \"holder\": \"person\"\n    }]\n  }],\n  \"changed\":[],\n  \"uncertain\": []\n}", "single": "{\n  \"defects\": []\n}"}}];

test('saved F005 incomplete model answers remain unknown; missing instance lists are never repaired',async()=>{
 for(const recorded of recordedIncompleteF005){
  const answers=[recorded.evidence.pair,recorded.evidence.swappedPair,recorded.evidence.single];
  let calls=0;
  const result=await judgeImage({nowImage:TINY,image:TINY,predictionPrompt:'The person keeps both grips.'},{fetchImpl:async()=>Response.json({response:answers[calls++]})});
  assert.equal(calls,3);assert.equal(result.ok,null);assert.equal(result.score,null);assert.match(result.error!,/unparseable/);
  assert.deepEqual(result.evidence,recorded.evidence);
  for(const raw of answers.slice(0,2)){
   const parsed=JSON.parse(raw);parsed.counts[0].category='portable tool';
   if(!('instancesB' in parsed.counts[0]))assert.equal(parsePairAnswer(JSON.stringify(parsed),true,true),null);
  }
 }
});
test('literal placeholder categories cannot become a clean inventory, while concrete valid categories remain accepted',()=>{
 for(const category of ['object type','OBJECT   TYPE','category'])assert.equal(parsePairAnswer(groupedPair([inventoryCount(category,1,1)]),true,true),null);
 for(const category of ['cup','camera tripod','hand tool'])assert.ok(parsePairAnswer(groupedPair([inventoryCount(category,1,1)]),true,true));
 assert.ok(parsePairAnswer(groupedPair([inventoryCount('object type',1,1)]),true),'historical non-inventory reader is not reinterpreted');
});
test('pair schema requires both image inventories and preserves explicit unknown instead of demanding guessed lists',()=>{
 const counts=PAIR_ANSWER_SCHEMA.properties.counts.items;
 assert.deepEqual(counts.required,['category','a','b','instancesA','instancesB']);
 for(const key of ['instancesA','instancesB'] as const)assert.ok(counts.properties[key].anyOf.some(option=>option.type==='null'));
 assert.doesNotMatch(buildPairPrompt(),/"category":"object type"|"where":"location"|"note":"difference"/);
});


test('existing Ollama diagnostics are bounded and whitelisted without another call or image retention',async()=>{
 let calls=0;const clean=groupedPair([inventoryCount('tool',1,1)]);
 const result=await judgeImage({nowImage:TINY,image:TINY,predictionPrompt:'unchanged'}, {fetchImpl:async()=>{
  const i=calls++;return Response.json({response:i===2?'{"defects":[]}':clean,done:true,done_reason:'stop',eval_count:100+i,prompt_eval_count:250,total_duration:1000000,load_duration:0,eval_duration:700000,prompt_eval_duration:300000,context:[1,2,3],images:['private'],secret:'must-not-be-saved'});
 }});
 assert.equal(calls,3);assert.equal(result.ok,true);
 for(const slot of ['pair','swappedPair','single'] as const){
  const d=result.responseDiagnostics![slot]!;assert.equal(d.done_reason,'stop');assert.equal(d.done,true);assert.ok(d.eval_count!>=100);assert.equal(d.load_duration,0);assert.ok(d.requestElapsedMs>=0);
 }
 assert.doesNotMatch(JSON.stringify(result.responseDiagnostics),/context|images|secret|private|must-not-be-saved/);
});
test('token-limit completion remains unknown even if the returned JSON happens to close correctly',async()=>{
 let calls=0;const clean=groupedPair([inventoryCount('tool',1,1)]);
 const result=await judgeImage({nowImage:TINY,image:TINY,predictionPrompt:'unchanged'}, {fetchImpl:async()=>{
  const i=calls++;return Response.json({response:i===2?'{"defects":[]}':clean,done_reason:i===0?'length':'stop',eval_count:i===0?512:20});
 }});
 assert.equal(calls,3);assert.equal(result.ok,null);assert.equal(result.score,null);assert.match(result.error!,/truncated answer: pair/);assert.equal(result.responseDiagnostics?.pair?.eval_count,512);
});


test('live list schema excludes empty objects but historical object-list evidence remains readable',()=>{
 for(const key of ['added','removed','uncertain'] as const){
  const list=PAIR_ANSWER_SCHEMA.properties[key];assert.equal(list.type,'array');assert.equal(list.items.type,'string');assert.equal(list.items.minLength,1);assert.equal('anyOf' in list.items,false);
 }
 const complete=JSON.parse(groupedPair([inventoryCount('tool',1,1)]));
 complete.added=[{object_type:'tool',where:'desk'}];complete.removed=[];complete.uncertain=[{note:'count unclear'}];
 const parsed=parsePairAnswer(JSON.stringify(complete),true,true)!;
 assert.deepEqual(parsed.added,['tool desk']);assert.deepEqual(parsed.uncertain,['count unclear']);
 complete.uncertain=[{}];assert.equal(parsePairAnswer(JSON.stringify(complete),true,true),null);
});
test('a string uncertainty or explicit null count never becomes a clean result under the live schema',async()=>{
 const uncertain=groupedPair([inventoryCount('tool',null,null)],{uncertain:['individual objects are occluded']});
 const result=await inspectInventory(uncertain,uncertain);
 assert.equal(result.ok,null);assert.equal(result.score,null);assert.match(result.error!,/uncertain preservation/);
});


import {personInventoryEvidenceIssues,type VerifiedPersonInventory} from './localJudge';
const castPolicy:VerifiedPersonInventory={verified:true,originalSourceCount:1,expectedInventoryCount:2};
function castEv(extra:Partial<import('./localJudge').PairEvidence>={}) {
 const pair=(a:number,b:number,added:string[],removed:string[])=>parsePairAnswer(JSON.stringify({added,removed,counts:[inventoryCount('person',a,b)],changed:[],uncertain:[]}),true,true)!;
 return {a:pair(1,2,['person'],[]),b:pair(2,1,[],['person']),single:[],...extra};
}
test('explicit cast waiver needs strict roster permission plus exact bidirectional person inventories',()=>{
 const ev=castEv();assert.deepEqual(personInventoryEvidenceIssues(ev,castPolicy),[]);
 assert.equal(classifyEvidence(ev,'add the reference person').some(x=>x.type==='fabricated_person'),true,'text alone grants no exception');
 assert.deepEqual(classifyEvidence(ev,'add reference',castPolicy),[]);
 for(const broken of [castEv({b:null}),castEv({a:{...ev.a,counts:[]}}),castEv({a:{...ev.a,counts:[{...ev.a.counts![0],b:3}]}})]){
  assert.ok(personInventoryEvidenceIssues(broken,castPolicy).length);
  assert.ok(classifyEvidence(broken,'add reference',castPolicy).some(x=>x.type==='fabricated_person'));
 }
 assert.ok(personInventoryEvidenceIssues(ev,{...castPolicy,verified:false as any}).length);
});
test('cast permission keeps all other entities, changed defects, anatomy and explicitly reported duplicate people',()=>{
 const ev=castEv();ev.a.added.push('laptop','a person in red');ev.a.removed.push('cup');
 ev.a.changed=[{type:'screen_changed',where:'monitor',note:'UI replaced'}];
 ev.single=[{type:'anatomy',where:'arm',note:'extra hand'},{type:'fabricated_person',where:'copy',note:'duplicated person'}];
 const ds=classifyEvidence(ev,'add ref',castPolicy);
 for(const type of ['fabricated_object','fabricated_person','lost_belongings','screen_changed','anatomy'])assert.ok(ds.some(d=>d.type===type));
 assert.ok(ds.some(d=>d.where==='a person in red'),'no free-text person alias exemption');
 assert.ok(ds.some(d=>d.where==='copy'),'single-image duplicate never waived');
});
async function runCastJudge(ev:ReturnType<typeof castEv>,policy=castPolicy){
 const answers=[ev.a,ev.b,{defects:ev.single}].map(v=>JSON.stringify(v && 'counts' in v?{...v,counts:(v as any).counts.map((c:any)=>({category:c.item,...c}))}:v));
 const requests:any[]=[];const result=await judgeImage({nowImage:TINY,image:TINY,predictionPrompt:'reference cast',personInventory:policy},{fetchImpl:(async(_u:any,init:any)=>{requests.push(JSON.parse(init.body));return new Response(JSON.stringify({response:answers.shift(),done_reason:'stop'}));})as any});
 return {result,requests};
}
test('live cast pair uses the existing three calls/budgets and preserves image order with reversed explicit expectations',async()=>{
 const {result,requests}=await runCastJudge(castEv());assert.equal(result.ok,true);
 assert.equal(requests.length,3);assert.deepEqual(requests.map(r=>r.options.num_predict),[512,512,256]);
 assert.deepEqual(requests.map(r=>r.images.length),[2,2,1]);
 assert.match(requests[0].prompt,/IMAGE 1 count is 1, expected IMAGE 2 count is 2/);
 assert.match(requests[1].prompt,/IMAGE 1 count is 2, expected IMAGE 2 count is 1/);
 assert.equal(requests[2].prompt.includes('Explicit reference-cast'),false);
});
test('cast live counts missing or null never pass despite otherwise clean output',async()=>{
 for(const counts of [[],[inventoryCount('person',null,2)]]){
  const ev=castEv();ev.a.counts=counts.map((c:any)=>({...c,item:c.category}));
  const {result}=await runCastJudge(ev);assert.equal(result.ok,null);assert.equal(result.score,null);assert.match(result.error!,/person|count|instances/i);
 }
});
test('cast count/instance mismatch and richer duplicate evidence stay strict',async()=>{
 const ev=castEv();ev.a.counts![0].instancesB!.pop();
 assert.equal((await runCastJudge(ev)).result.ok,null);
 const dup=castEv();dup.single=[{type:'fabricated_person',where:'right',note:'same original copied'}];
 assert.equal((await runCastJudge(dup)).result.ok,false);
});


test('cast QA count evidence follows the exact verified roster, not the legacy eight-person parser cap',async()=>{
 const ev=castEv();ev.a.counts=[{item:'person',a:0,b:15,instancesA:[],instancesB:instances(15,'b-person')!}];ev.b.counts=[{item:'person',a:15,b:0,instancesA:instances(15,'a-person')!,instancesB:[]}];
 const policy={verified:true as const,originalSourceCount:0,expectedInventoryCount:15};assert.deepEqual(personInventoryEvidenceIssues(ev,policy),[]);const {result,requests}=await runCastJudge(ev,policy);assert.equal(result.ok,true);assert.equal(requests.length,3);assert.deepEqual(requests.map(r=>r.options.num_predict),[512,512,256]);
});
