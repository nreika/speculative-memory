import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createInstructionCaptionLookup} from './instructionCaptions';

test('lookup returns the caption, the real action and the exact image prompt of the same archived scene', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ic-')),id='2026-10-21_12-00-00',dir=path.join(root,id.slice(0,10),id);fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,id+'_prompts.json'),JSON.stringify({captureId:'cap1',generationId:id,scenes:[{letter:'A',sceneKey:'gen_a',file:id+'_A.png',plannedDescription:'30秒後、両腕を高く上げて背伸びをする。',predictionPrompt:'The person raises both arms high in a stretch.',imagePromptFull:'Same field of view ... The person raises both arms high in a stretch.',identityReferenceCount:1,referenceImage:'attached',identityReferenceCrops:[{x:1,y:2,width:30,height:40}]}]}));
  const lookup=createInstructionCaptionLookup(root,()=>[{captureId:'cap1',images:{now:`/captures/record_${id}.jpg`,a:'/captures/Gen_a.png'}}]);
  const r=lookup({captureId:'cap1',sceneKey:'gen_a',imageUrl:'/captures/Gen_a.png'})!;
  assert.equal(r.plannedDescription,'30秒後、両腕を高く上げて背伸びをする。');
  assert.equal(r.predictionPrompt,'The person raises both arms high in a stretch.');
  assert.match(r.imagePromptFull!,/raises both arms high in a stretch\.$/);
  assert.match(r.referenceNote!,/^1 identity reference image\(s\) \(attached\)/);
  // The shown action is the archived action: the same text the *_prompt.txt / prompts.json hold for this scene.
  const archived=JSON.parse(fs.readFileSync(path.join(dir,id+'_prompts.json'),'utf8')).scenes[0];
  assert.equal(r.predictionPrompt,archived.predictionPrompt);
});

test('the display JPEG URL finds the same caption as the original PNG URL', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ic2-')),id='2026-10-21_12-00-00',dir=path.join(root,id.slice(0,10),id);fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,id+'_prompts.json'),JSON.stringify({captureId:'cap1',generationId:id,scenes:[{letter:'A',sceneKey:'gen_a',file:id+'_A.png',plannedDescription:'30秒後、片腕を横へ伸ばす。',predictionPrompt:'The person reaches to the side.'}]}));
  const lookup=createInstructionCaptionLookup(root,()=>[{captureId:'cap1',images:{now:`/captures/record_${id}.jpg`,a:'/captures/Gen_a_2026-10-21_12-00-30.png'}}]);
  assert.equal(lookup({captureId:'cap1',sceneKey:'gen_a',imageUrl:'/captures/display/Gen_a_2026-10-21_12-00-30.jpg'})!.plannedDescription,'30秒後、片腕を横へ伸ばす。');
  assert.equal(lookup({captureId:'cap1',sceneKey:'gen_a',imageUrl:'/captures/Gen_a_2026-10-21_12-00-30.png'})!.plannedDescription,'30秒後、片腕を横へ伸ばす。');
  assert.equal(lookup({captureId:'cap1',sceneKey:'gen_a',imageUrl:'/captures/display/Gen_a_other.jpg'}),undefined);
});
