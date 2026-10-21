import test from 'node:test';
import assert from 'node:assert/strict';
import { withoutLightingChanges, identityConstraints, describeGeneratedImage, descriptionFromVisibleFacts, actionWithBelongings,occupiedHandSides } from './fidelity';
import { composeEditInstruction, generateImage } from './orchestrator';

test('remove exposure edits while retaining the requested motion and hands', () => {
  assert.equal(withoutLightingChanges('The person stands up and the lighting becomes warmer.'), 'The person stands up');
  const motion = 'The right hand holds the microphone and the left hand holds the tablet.';
  assert.equal(withoutLightingChanges(motion), motion);
  assert.equal(withoutLightingChanges('The room becomes brighter.'), '');
});
test('only true hand-supported source evidence establishes occupied hand sides for support constraints',()=>{
 const source={position:'center',pose:'seated',clothes:'white shirt',facing:'away',holding:''};
 assert.deepEqual(occupiedHandSides({...source,holdingFacts:[{item:'laptop',hand:'both',evidence:'surface_contact'}]}),[]);
 assert.deepEqual(occupiedHandSides({...source,holdingFacts:[{item:'cable',hand:'both',evidence:'hand_supported'}]}),['left','right']);
 assert.deepEqual(occupiedHandSides({...source,holding:'case in left hand'}),['left']);
 assert.deepEqual(occupiedHandSides({...source,holding:'cable in both hands'}),['left','right']);
});

test('people count, belongings and face references are explicit without a new pose restriction', () => {
  const text = identityConstraints([{ position: 'left', pose: 'standing', clothes: 'black shirt', facing: 'camera', holding: 'tablet', hair: 'long brown hair' }], 2);
  assert.match(text, /Exactly 2 existing persons/);
  assert.match(text, /tablet/);
  assert.match(text, /image1 alone determines/);
  const prompt = composeEditInstruction({ predictionPrompt: 'The person stands up.', presence: 1, tone: .7, referenceFrames: true, personCount: 2 });
  assert.match(prompt, /stands up/);
  assert.doesNotMatch(prompt, /noticeable.*change of the light|brighter or dimmer|warmer or cooler/);
});

test('actual workflow connects identity images to image2/image3 of the positive encoder', async t => {
  let workflow: any;
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/upload/image')) return Response.json({ name: 'ref-' + Math.random() + '.png' });
    if (url.endsWith('/prompt')) { workflow = JSON.parse(String(init?.body)).prompt; return Response.json({ prompt_id: 'fidelity-test' }); }
    if (url.includes('/history/')) return Response.json({ 'fidelity-test': { status: { status_str: 'success' }, outputs: { '80': { images: [{ filename: 'test.png', type: 'output', subfolder: '' }] } } } });
    if (url.includes('/view?')) return new Response(new Uint8Array([1,2,3]));
    throw new Error('Unexpected URL ' + url);
  });
  await generateImage({ originalImageDataUrl: 'data:image/png;base64,dGVzdA==', faceImageDataUrl: 'data:image/png;base64,dGVzdA==', referenceImages: ['data:image/png;base64,dGVzdA=='], predictionPrompt: 'The person stands up.', presence: 1, personCount: 1, imageBackend: 'local' });
  assert.deepEqual(workflow['30'].inputs.image2, ['11', 0]);
  assert.deepEqual(workflow['30'].inputs.image3, ['16', 0]);
  assert.match(workflow['30'].inputs.prompt, /image2 shows the same people at another moment, only for their face and hair/);
});

test('display description uses finished pixels and never the requested action', async t => {
  let body: any;
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return Response.json({ response: JSON.stringify({ people: [{posture:'standing',leftHand:{visibility:'visible',height:'shoulder_or_above',contact:'none',palm:'open'},rightHand:{visibility:'visible',height:'unclear',contact:'unclear',palm:'unclear'}}] }), done_reason: 'stop' }); });
  assert.equal(await describeGeneratedImage('data:image/png;base64,cmVzdWx0', -25), '25秒前、人物が片手を上げている。');
  assert.deepEqual(body.images, ['cmVzdWx0']);
  assert.equal(body.think, false);
  assert.doesNotMatch(body.prompt, /stands up from the chair/);
});

test('visible facts never invent holdings or claim that a requested transition occurred', () => {
  const text = descriptionFromVisibleFacts({people:[{posture:'standing',leftHand:{visibility:'visible',height:'shoulder_or_above',contact:'none',palm:'open'},rightHand:{visibility:'visible',height:'shoulder_or_above',contact:'none',palm:'open'}}],description:'マイクを持って立ち上がった'},15);
  assert.equal(text,'15秒後、人物が両手を上げている。');
  assert.doesNotMatch(text,/マイク|立ち上が/);
  assert.throws(()=>descriptionFromVisibleFacts({people:[{posture:'cheering',hands:'unknown'}]},30));
});

test('cheering retains the tablet grip and leaves the other actor in place', () => {
  const people = [{position:'left',pose:'standing',clothes:'black shirt',facing:'right',holding:'tablet in left hand',worn:'white case on wrist'}, {position:'right',pose:'standing',clothes:'teal sweatshirt',facing:'left',hair:'short hair'}];
  const action = actionWithBelongings('The person in the black shirt is cheering.',people);
  assert.match(action,/free hand/);
  assert.match(action,/tablet in left hand/);
  assert.match(action,/other person \(teal sweatshirt\) keeps the original posture/);
  assert.doesNotMatch(identityConstraints(people,2),/short hair/);
});

test('a cup grip near the face is not an open palm or a free raised hand', () => {
  const text = descriptionFromVisibleFacts({people:[{posture:'seated',leftHand:{visibility:'visible',height:'shoulder_or_above',contact:'held_object',palm:'not_open'},rightHand:{visibility:'visible',height:'below_shoulder',contact:'held_object',palm:'unclear'}}]},15);
  assert.equal(text, '15秒後、人物が物を持つ手が肩以上の高さにある。');
  assert.doesNotMatch(text, /手を上げ|手を開|カップ/);
});

test('a real empty raised hand remains visible in the caption while the other hand holds an item', () => {
  const text = descriptionFromVisibleFacts({people:[{posture:'seated',leftHand:{visibility:'visible',height:'shoulder_or_above',contact:'none',palm:'open'},rightHand:{visibility:'visible',height:'below_shoulder',contact:'held_object',palm:'not_open'}}]},30);
  assert.equal(text, '30秒後、人物が片手を上げ、もう片方の手で物を持っている。');
});

test('touching shoulder/clothing and uncertain raised grips never become an open-palm gesture', () => {
  const p={posture:'seated',leftHand:{visibility:'visible',height:'shoulder_or_above',contact:'body_or_clothing',palm:'not_open'},rightHand:{visibility:'visible',height:'unclear',contact:'unclear',palm:'unclear'}};
  assert.equal(descriptionFromVisibleFacts({people:[p]},-25),'25秒前、人物が手を体に添えている。');
  p.leftHand.contact='unclear';
  assert.equal(descriptionFromVisibleFacts({people:[p]},-25),'25秒前、人物が座っている。片手が肩以上の高さにある。');
  assert.equal(descriptionFromVisibleFacts({people:[{posture:'seated',hands:'one_open'}]},15),'15秒後、人物が座っている。');
});

test('caption rejects partial or malformed hand evidence rather than inventing a gesture', () => {
  assert.throws(()=>descriptionFromVisibleFacts({people:[{posture:'seated',leftHand:{visibility:'visible',height:'shoulder_or_above',contact:'none',palm:'open'}}]},15), /hand evidence/);
});

test('the tablet-holding cropped person is described without inventing standing posture or an open hand', () => {
  const text = descriptionFromVisibleFacts({people:[{posture:'upper_body_only',leftHand:{visibility:'visible',height:'below_shoulder',contact:'held_object',palm:'not_open'},rightHand:{visibility:'visible',height:'below_shoulder',contact:'body_or_clothing',palm:'not_open'}}]},30);
  assert.equal(text,'30秒後、人物が片手を体に添え、もう片方の手で物を持っている。');
  assert.doesNotMatch(text,/立って|手を上げ|手を開|タブレット/);
});

test('the shoulder-touching person still holding a cup has no unsupported raised-hand gesture', () => {
  const text = descriptionFromVisibleFacts({people:[{posture:'upper_body_only',leftHand:{visibility:'visible',height:'shoulder_or_above',contact:'body_or_clothing',palm:'open'},rightHand:{visibility:'visible',height:'shoulder_or_above',contact:'held_object',palm:'not_open'}}]},15);
  assert.equal(text,'15秒後、人物が片手を体に添え、物を持つもう片方の手が肩以上の高さにある。');
  assert.doesNotMatch(text,/手を上げ|手を開/);
});

test('unknown contacts never become gestures even when hand height and open fingers are known', () => {
  for (const contact of ['unclear','held_object','body_or_clothing']) {
    const text = descriptionFromVisibleFacts({people:[{posture:'upper_body_only',leftHand:{visibility:'visible',height:'shoulder_or_above',contact,palm:'open'},rightHand:{visibility:'visible',height:'unclear',contact:'unclear',palm:'unclear'}}]},15);
    assert.doesNotMatch(text,/手を上げ|手を開/);
  }
  const text = descriptionFromVisibleFacts({people:[{posture:'upper_body_only',leftHand:{visibility:'visible',height:'unclear',contact:'none',palm:'unclear'},rightHand:{visibility:'visible',height:'unclear',contact:'unclear',palm:'unclear'}}]},15);
  assert.equal(text,'15秒後、人物の上半身が写っている。');
});

test('two visibly open free hands are counted individually and old coarse facts stay conservative', () => {
  const hand = {visibility:'visible',height:'below_shoulder',contact:'none',palm:'open'};
  assert.equal(descriptionFromVisibleFacts({people:[{posture:'seated',leftHand:hand,rightHand:hand}]},15),'15秒後、人物が両手を開いている。');
  for (const hands of ['both_raised','one_raised','one_open','low_or_hidden','unclear']) {
    assert.equal(descriptionFromVisibleFacts({people:[{posture:'seated',hands}]},15),'15秒後、人物が座っている。');
  }
});

test('invalid or missing hand/posture evidence is rejected instead of leaking an inherited property', () => {
  const unknown = {visibility:'visible',height:'unclear',contact:'unclear',palm:'unclear'};
  for (const person of [null,{}, {posture:'toString',leftHand:unknown,rightHand:unknown}, {posture:'seated'}, {posture:'seated',leftHand:{...unknown,contact:'cup'},rightHand:unknown}]) {
    assert.throws(()=>descriptionFromVisibleFacts({people:[person]},15));
  }
});

test('empty scenes and multiple people keep the signed span and each individual observation', () => {
  const unknown = {visibility:'visible',height:'unclear',contact:'unclear',palm:'unclear'};
  const holding = {posture:'upper_body_only',leftHand:{visibility:'visible',height:'below_shoulder',contact:'held_object',palm:'not_open'},rightHand:unknown};
  const seated = {posture:'seated',leftHand:unknown,rightHand:unknown};
  assert.equal(descriptionFromVisibleFacts({people:[]},-25),'25秒前、室内の様子が写っている。');
  assert.equal(descriptionFromVisibleFacts({people:[holding,seated]},15),'15秒後、2人の人物が写っている。1人目は物を持っている。2人目は座っている。');
});

test('caption rejects a truncated observation and never displays its unfinished evidence', async t => {
  t.mock.method(globalThis,'fetch',async()=>Response.json({response:'{"people":[',done_reason:'length'}));
  await assert.rejects(describeGeneratedImage('data:image/png;base64,cmVzdWx0',15),/truncated/);
});

const actorPeople = (first = 'red top', second = 'blue top') => [
  {position:'left',pose:'standing',clothes:first,facing:'right',holding:'tablet in left hand'},
  {position:'right',pose:'seated',clothes:second,facing:'left',holding:'cup in right hand'},
];

test('short clothing descriptions identify a unique actor without a garment or colour allow-list', () => {
  for (const [first, second] of [['red top','blue top'],['tan tee','ivory coat'],['ochre tunic','violet blouse']]) {
    const people = actorPeople(first,second);
    const text = actionWithBelongings(`The person in the ${first} is cheering.`,people);
    assert.match(text,/free hand/);
    assert.match(text,/tablet in left hand/);
    assert.ok(text.includes(`The other person (${second}) keeps the original posture`));
    assert.doesNotMatch(text,/person continuously keeps cup in right hand/);
  }
});

test('shared colour or identical clothing does not guess an actor or freeze another person', () => {
  for (const people of [actorPeople('red top','red shirt'),actorPeople('red top','red top'),actorPeople('red top','red long-sleeved top')]) {
    const action = people[1].clothes === 'red shirt' ? 'The person in red is cheering.' : 'The person in the red top is cheering.';
    assert.equal(actionWithBelongings(action,people),action);
  }
});

test('a complete distinctive description resolves same-colour people with different garments', () => {
  const people = actorPeople('red shirt','red top');
  for (const action of ['The person wearing a red shirt is cheering.','The red shirt woman is cheering.']) {
    const text = actionWithBelongings(action,people);
    assert.match(text,/free hand/);
    assert.match(text,/tablet in left hand/);
    assert.match(text,/other person \(red top\) keeps the original posture/);
  }
});

test('clothing words must name a person, rather than match a nearby object or part of another colour', () => {
  const people = actorPeople('red top','redwood top');
  const text = actionWithBelongings('The person in the red top is cheering.',people);
  assert.match(text,/other person \(redwood top\)/);
  for (const action of ['The person is cheering while holding a red cup.','The person points at a red top on the table.','The person in purple is cheering.']) {
    assert.equal(actionWithBelongings(action,people),action);
  }
});

test('multiple named actors remain unchanged rather than silently assigning the event to one person', () => {
  for (const action of ['Both people are cheering.','The person in the red top is cheering while the person in the blue top smiles.','They are cheering.']) {
    assert.equal(actionWithBelongings(action,actorPeople()),action);
  }
});

test('supported-surface contact is not reported as holding an item or displaying an open palm', () => {
  const surface = {visibility:'visible',height:'below_shoulder',contact:'surface_contact',palm:'open'};
  const text = descriptionFromVisibleFacts({people:[{posture:'seated',leftHand:surface,rightHand:surface}]},15);
  assert.equal(text,'15秒後、人物が両手を物に添えている。');
  assert.doesNotMatch(text,/持って|上げ|開いて|キーボード/);
});

test('one observed free raised hand survives contact by the other hand with a supported surface', () => {
  const raised = {visibility:'visible',height:'shoulder_or_above',contact:'none',palm:'unclear'};
  const surface = {visibility:'visible',height:'below_shoulder',contact:'surface_contact',palm:'not_open'};
  for (const [leftHand,rightHand] of [[raised,surface],[surface,raised]]) {
    const text = descriptionFromVisibleFacts({people:[{posture:'seated',leftHand,rightHand}]},-25);
    assert.equal(text,'25秒前、人物が片手を上げ、もう片方の手を物に添えている。');
    assert.doesNotMatch(text,/持って/);
  }
});

test('one actual grip and the other free raised hand remain independent with either left/right assignment', () => {
  const grip = {visibility:'visible',height:'below_shoulder',contact:'held_object',palm:'not_open'};
  const raised = {visibility:'visible',height:'shoulder_or_above',contact:'none',palm:'unclear'};
  for (const [leftHand,rightHand] of [[grip,raised],[raised,grip]]) {
    assert.equal(descriptionFromVisibleFacts({people:[{posture:'seated',leftHand,rightHand}]},15),'15秒後、人物が片手を上げ、もう片方の手で物を持っている。');
  }
});

test('only the ambiguous hand loses detail; it neither acquires nor suppresses the other hand’s facts', () => {
  const unknown = {visibility:'visible',height:'unclear',contact:'unclear',palm:'unclear'};
  const surface = {visibility:'visible',height:'below_shoulder',contact:'surface_contact',palm:'unclear'};
  const raised = {visibility:'visible',height:'shoulder_or_above',contact:'none',palm:'unclear'};
  assert.equal(descriptionFromVisibleFacts({people:[{posture:'seated',leftHand:surface,rightHand:unknown}]},15),'15秒後、人物が片手を物に添えている。');
  assert.equal(descriptionFromVisibleFacts({people:[{posture:'seated',leftHand:unknown,rightHand:raised}]},15),'15秒後、人物が片手を上げている。');
  assert.equal(descriptionFromVisibleFacts({people:[{posture:'seated',leftHand:surface,rightHand:{...raised,contact:'unclear'}}]},15),'15秒後、人物が片手を物に添えている。片手が肩以上の高さにある。');
});

test('touching an elevated supported surface does not itself claim a free-hand gesture', () => {
  const text = descriptionFromVisibleFacts({people:[{posture:'standing',leftHand:{visibility:'visible',height:'shoulder_or_above',contact:'surface_contact',palm:'open'},rightHand:{visibility:'visible',height:'unclear',contact:'unclear',palm:'unclear'}}]},15);
  assert.equal(text,'15秒後、人物が片手を物に添えている。');
  assert.doesNotMatch(text,/持って|上げ|開いて/);
});

test('a real held item and supported-surface contact can be described together without merging their roles', () => {
  const text = descriptionFromVisibleFacts({people:[{posture:'seated',leftHand:{visibility:'visible',height:'below_shoulder',contact:'held_object',palm:'not_open'},rightHand:{visibility:'visible',height:'below_shoulder',contact:'surface_contact',palm:'open'}}]},15);
  assert.equal(text,'15秒後、人物が片手で物を持ち、もう片方の手を物に添えている。');
});

test('an observed empty raised fist is a raised hand even without an open palm', () => {
  const fist={visibility:'visible',height:'shoulder_or_above',contact:'none',palm:'not_open'};
  const surface={visibility:'visible',height:'below_shoulder',contact:'surface_contact',palm:'not_open'};
  for(const [leftHand,rightHand] of [[fist,surface],[surface,fist]]) {
    const text=descriptionFromVisibleFacts({people:[{posture:'seated',leftHand,rightHand}]},-25);
    assert.equal(text,'25秒前、人物が片手を上げ、もう片方の手を物に添えている。');
    assert.doesNotMatch(text,/持って/);
  }
});

test('the single caption observation requires a visible object rather than inferring one from a fist',async t=>{
  let calls=0;let body:any;
  t.mock.method(globalThis,'fetch',async(_input:unknown,init?:RequestInit)=>{calls++;body=JSON.parse(String(init?.body));return Response.json({response:JSON.stringify({people:[{posture:'seated',leftHand:{visibility:'visible',height:'below_shoulder',contact:'surface_contact',palm:'not_open'},rightHand:{visibility:'visible',height:'shoulder_or_above',contact:'none',palm:'not_open'}}]}),done_reason:'stop'});});
  assert.equal(await describeGeneratedImage('data:image/png;base64,cmVzdWx0',-25),'25秒前、人物が片手を上げ、もう片方の手を物に添えている。');
  assert.equal(calls,1);
  assert.match(body.prompt,/A closed or bent hand alone is NOT evidence of an object/);
  assert.match(body.prompt,/A visibly empty raised fist is contact none and palm not_open/);
  assert.equal(body.options.num_predict,1024);
});


test('occupied high hands retain static height with either left/right assignment, without a free gesture',()=>{
  const highGrip={visibility:'visible',height:'shoulder_or_above',contact:'held_object',palm:'not_open'};
  const unknown={visibility:'visible',height:'unclear',contact:'unclear',palm:'unclear'};
  for(const [leftHand,rightHand] of [[highGrip,unknown],[unknown,highGrip]]){
    const text=descriptionFromVisibleFacts({people:[{posture:'seated',leftHand,rightHand}]},15);
    assert.equal(text,'15秒後、人物が物を持つ手が肩以上の高さにある。');
    assert.doesNotMatch(text,/手を上げ|手を開/);
  }
});

test('a free raised hand and a separate high occupied hand both keep their geometry',()=>{
  const free={visibility:'visible',height:'shoulder_or_above',contact:'none',palm:'not_open'};
  const grip={visibility:'visible',height:'shoulder_or_above',contact:'held_object',palm:'not_open'};
  for(const [leftHand,rightHand] of [[free,grip],[grip,free]])assert.equal(descriptionFromVisibleFacts({people:[{posture:'upper_body_only',leftHand,rightHand}]},30),'30秒後、人物が片手を上げ、物を持つもう片方の手が肩以上の高さにある。');
});

test('known height with unknown contact remains static evidence and preserves the other hand contact',()=>{
  const uncertain={visibility:'visible',height:'shoulder_or_above',contact:'unclear',palm:'unclear'};
  const contacts=[['held_object','物を持っている'],['surface_contact','片手を物に添えている'],['body_or_clothing','手を体に添えている']];
  for(const [contact,phrase] of contacts)for(const [leftHand,rightHand] of [[uncertain,{visibility:'visible',height:'below_shoulder',contact,palm:'not_open'}],[{visibility:'visible',height:'below_shoulder',contact,palm:'not_open'},uncertain]]){
    const text=descriptionFromVisibleFacts({people:[{posture:'seated',leftHand,rightHand}]},15);
    assert.equal(text,`15秒後、人物が${phrase}。片手が肩以上の高さにある。`);
    assert.doesNotMatch(text,/手を上げ|手を開/);
  }
  assert.equal(descriptionFromVisibleFacts({people:[{posture:'seated',leftHand:uncertain,rightHand:uncertain}]},15),'15秒後、人物が座っている。両手が肩以上の高さにある。');
});

test('high body and surface contacts retain their conservative contact descriptions',()=>{
  for(const [contact,expected] of [['body_or_clothing','手を体に添えている'],['surface_contact','両手を物に添えている']]){
    const hand={visibility:'visible',height:'shoulder_or_above',contact,palm:'open'};
    assert.equal(descriptionFromVisibleFacts({people:[{posture:'seated',leftHand:hand,rightHand:hand}]},15),`15秒後、人物が${expected}。`);
  }
});


test('invisible or uncertain hands cannot contribute invented grip, open palm or raised claims',()=>{
  const real={visibility:'visible',height:'below_shoulder',contact:'held_object',palm:'not_open'};
  for(const visibility of ['not_visible','unclear'])for(const contact of ['none','held_object','surface_contact','body_or_clothing']){
    const hidden={visibility,height:'shoulder_or_above',contact,palm:'open'};
    for(const [leftHand,rightHand] of [[hidden,real],[real,hidden]])assert.equal(descriptionFromVisibleFacts({people:[{posture:'upper_body_only',leftHand,rightHand}]},15,true),'15秒後、人物が物を持っている。');
  }
});

test('historical saved hand facts remain reproducible while new observations require visibility',()=>{
  const leftHand={height:'shoulder_or_above',contact:'none',palm:'not_open'};
  const rightHand={height:'shoulder_or_above',contact:'held_object',palm:'not_open'};
  const facts={people:[{posture:'seated',leftHand,rightHand}]};
  assert.equal(descriptionFromVisibleFacts(facts,15),'15秒後、人物が片手を上げ、物を持つもう片方の手が肩以上の高さにある。');
  assert.throws(()=>descriptionFromVisibleFacts(facts,15,true),/hand visibility/);
  assert.equal(descriptionFromVisibleFacts({people:[{posture:'seated',leftHand:{...leftHand,visibility:'not_visible'},rightHand:{...rightHand,visibility:'visible'}}]},15,true),'15秒後、人物が物を持つ手が肩以上の高さにある。');
});


test('both occupied hands never acquire a fictional free hand during cheering',()=>{
 const base={position:'center',pose:'standing',clothes:'blue sweatshirt',facing:'left',holding:'black cable in both hands'};
 const variants=[base,{...base,holding:'black cable',holdingFacts:[{item:'black cable',hand:'both' as const,evidence:'hand_supported' as const}]},{...base,holding:'two objects',holdingFacts:[{item:'one',hand:'left' as const,evidence:'hand_supported' as const},{item:'two',hand:'right' as const,evidence:'hand_supported' as const}]}];
 for(const source of variants){
  const text=actionWithBelongings('The person in the blue sweatshirt is cheering.',[source]);
  assert.match(text,/upper torso sideways into a clearly visible diagonal/);assert.match(text,/one shoulder distinctly higher than the other/);assert.match(text,/Both elbows, gripping hands and the original held belongings move together/);assert.match(text,/both occupied hands keep their original grips/);assert.doesNotMatch(text,/free hand|open palm|lifts/);assert.ok(text.includes(source.holding));
 }
});
test('back-facing both-hand cheering does not demand a new visible facial expression',()=>{
 const text=actionWithBelongings('The person is cheering.',[{position:'center',pose:'standing',clothes:'blue sweatshirt',facing:'away',holding:'cable in both hands'}]);
 assert.match(text,/upper torso sideways into a clearly visible diagonal/);assert.match(text,/one shoulder distinctly higher than the other/);assert.match(text,/Both elbows, gripping hands and the original held belongings move together/);assert.doesNotMatch(text,/expression|smil|free hand|open palm/);
});
test('surface contacts do not invent hand occupation and an unrelated action retains its meaning',()=>{
 const source={position:'center',pose:'standing',clothes:'blue sweatshirt',facing:'left',holding:'cup in left hand',holdingFacts:[{item:'desk',hand:'both' as const,evidence:'surface_contact' as const}]};
 const cheering=actionWithBelongings('The person is cheering.',[source]);assert.match(cheering,/free hand/);assert.doesNotMatch(cheering,/both occupied/);
 const neutral=actionWithBelongings('The person turns their head.',[{...source,holding:'cable in both hands'}]);assert.match(neutral,/turns their head/);assert.doesNotMatch(neutral,/energetic change|free hand/);
});
test('plain cheering uses confirmed source surface contact to leave PC work for a visible pose without a new hand',()=>{
 const source={position:'center front',pose:'seated in a chair',clothes:'white shirt',facing:'away',holding:'',holdingFacts:[{item:'laptop',hand:'both' as const,evidence:'surface_contact' as const}]};
 const result=actionWithBelongings('The person in the white shirt is cheering.',[source]);
 assert.match(result,/one empty hand away from its original surface contact to shoulder height/);assert.match(result,/other hand stays in its original supported-surface contact/);assert.match(result,/upper torso leans sideways into a clearly visible diagonal/);assert.match(result,/one shoulder distinctly higher/);assert.match(result,/do not leave its old hand at the surface/);
 assert.doesNotMatch(result,/smil|expression|jump|both arms|stands|remains seated|chair.*fixed/i);
 for(const hand of ['left','right'] as const){const one=actionWithBelongings('The person is cheering.',[{...source,holdingFacts:[{item:'desk',hand,evidence:'surface_contact'}]}]);assert.ok(one.includes(`empty ${hand} hand`));assert.match(one,/other hand preserves its original contact or grip/);assert.doesNotMatch(one,/other hand stays in its original supported-surface contact/);}
});
test('missing, ambiguous or potentially occupied hands cannot become a source-grounded free gesture',()=>{
 const source={position:'center',pose:'seated',clothes:'white shirt',facing:'away',holding:''};const original='The person in the white shirt is cheering.';
 const variants=[source,{...source,holdingFacts:[]},{...source,holdingFacts:[{item:'laptop',hand:'unclear' as const,evidence:'surface_contact' as const}]},{...source,holdingFacts:[{item:'laptop',hand:'both' as const,evidence:'unclear' as const}]},{...source,holdingFacts:[{item:'laptop',hand:'both' as const,evidence:'surface_contact' as const},{item:'pen',hand:'right' as const,evidence:'unclear' as const}]}];
 for(const p of variants)assert.equal(actionWithBelongings(original,[p]),original);
 const p={...source,holdingFacts:[{item:'laptop',hand:'both' as const,evidence:'surface_contact' as const}]};
 for(const concrete of ['The person in the white shirt is cheering while keeping both hands on the desk.','The person in the white shirt turns their head.','The person is cheering. Keep both hands on the desk.','Keeping both hands on the desk, the person is cheering.','The person in the white shirt stands up and is cheering.','The person is cheering; both hands stay on the desk.'])assert.equal(actionWithBelongings(concrete,[p]),concrete);
 assert.equal(actionWithBelongings(original,[p,{...p,position:'right'}]),original);
});
test('plain cheering guard rejects instructions before or after the generic clause',()=>{
 const source={position:'center',pose:'seated',clothes:'white shirt',facing:'away',holding:'',holdingFacts:[{item:'laptop',hand:'both' as const,evidence:'surface_contact' as const}]};
 for(const instruction of ['The person is cheering. Keep both hands on the desk.','Keeping both hands on the desk, the person is cheering.','The person in the white shirt stands up and is cheering.'])assert.equal(actionWithBelongings(instruction,[source]),instruction);
 assert.match(actionWithBelongings('The person in the white shirt is cheering.',[source]),/Move that original arm to its new position/);
});
