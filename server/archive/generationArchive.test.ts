import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { temporalLabels, GenerationArchive, generationIdFromFilename, archiveRootDir, DEFAULT_ARCHIVE_DIR } from './generationArchive';
import { crc32, readPngText } from './pngMetadata';

function tinyPng() {
  const c = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    c('IHDR', ihdr),
    c('IDAT', zlib.deflateSync(Buffer.from([0, 1, 2, 3]))),
    c('IEND', Buffer.alloc(0)),
  ]);
}

const baseCtx = {
  generationId: '2026-10-15_06-08-12',
  captureId: 'cap1',
  source: 'td-native',
  capturedAt: '2026-10-15T06:08:12+09:00',
  backend: 'local',
  vlmModel: 'm',
  imageModel: 'qwen',
  params: { sceneDistancesSec: [30, -30], presence: 0.3, tone: 0.3, imageCount: 2 },
};

test('generation id parsing and root dir', () => {
  assert.equal(generationIdFromFilename('record_2026-10-15_06-08-12.jpg'), '2026-10-15_06-08-12');
  assert.equal(generationIdFromFilename('nothing.jpg'), null);
  assert.equal(archiveRootDir({}), DEFAULT_ARCHIVE_DIR);
  assert.equal(archiveRootDir({ GENERATION_ARCHIVE_DIR: 'X:\\a' }), 'X:\\a');
});

test('archive writes the folder layout, prompts.json, README and PNG metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genarch-'));
  const id = baseCtx.generationId;
  const a = new GenerationArchive(baseCtx, root);
  a.saveSource(Buffer.from('jpg'), 'jpg');
  a.setVlm({ promptFull: 'P', rawResponse: '{}', parsedScenarios: [] });
  a.addScene(
    0,
    {
      sceneKey: 'gen_a',
      distanceSec: 30,
      label: 'x',
      predictionPrompt: '立つ',
      scenarioDescription: '30秒後、立つ',
      imagePromptFull: 'stand',
      negativePrompt: 'neg',
      seed: 7,
      elapsedMs: 5,
    },
    tinyPng(),
    'png'
  );
  a.finish('completed');
  const dir = path.join(root, '2026-10-15', id);
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${id}_A.png`, `${id}_A_prompt.txt`, `${id}_NOW.jpg`, `${id}_README.txt`, `${id}_prompts.json`, `${id}_vlm.txt`]);
  const meta = readPngText(fs.readFileSync(path.join(dir, `${id}_A.png`)));
  assert.equal(meta.Scene, 'A');
  assert.equal(meta.ImagePrompt, 'stand');
  assert.equal(meta.PredictionPrompt, '立つ');
  assert.equal(meta.TemporalOffset, '+30s');
  assert.equal(meta.TemporalLabelJa, '30秒先の未来');
  assert.equal(meta.TemporalLabelEn, '30 seconds into the future');
  assert.match(fs.readFileSync(path.join(dir, `${id}_A_prompt.txt`), 'utf8'), /30秒先の未来[\s\S]*stand[\s\S]*neg/);
  const json = JSON.parse(fs.readFileSync(path.join(dir, `${id}_prompts.json`), 'utf8'));
  assert.equal(json.scenes[0].letter, 'A');
  assert.equal(json.status, 'completed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unusable root never throws', () => {
  const blocker = path.join(os.tmpdir(), `genarch-file-${Date.now()}`);
  fs.writeFileSync(blocker, 'x');
  const a = new GenerationArchive(baseCtx, path.join(blocker, 'sub'));
  a.saveSource(Buffer.from('x'), 'jpg');
  a.fail(new Error('boom'));
  fs.rmSync(blocker, { force: true });
});

test('temporal labels', () => {
  assert.deepEqual(temporalLabels(150), { temporalOffset: '+150s', temporalLabelJa: '2分30秒先の未来', temporalLabelEn: '2 minutes 30 seconds into the future' });
  assert.equal(temporalLabels(-30).temporalLabelJa, '30秒前の過去');
  assert.equal(temporalLabels(-60).temporalLabelEn, '1 minute into the past');
  assert.equal(temporalLabels(0).temporalLabelJa, '現在');
});

test('scenario inputs and history context never overwrite canonical NOW or another scene', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'scenario-archive-'));
 const archive=new GenerationArchive(baseCtx,root);
 const raw=Buffer.from('canonical original bytes');archive.saveSource(raw,'jpg');
 archive.setHistoryContext({historyScope:'test:TSC-001:run:L1',testLoop:1});
 archive.setScenarioControl({version:1,assetSha256:'original-asset-hash'});
 const a=archive.saveScenarioInput(0,Buffer.from('scene A'),'png',{imageSha256:'a'});
 const b=archive.saveScenarioInput(1,Buffer.from('scene B'),'png',{imageSha256:'b'});
 archive.finish('completed');
 assert.notEqual(a,b);assert.equal(fs.readFileSync(a!,'utf8'),'scene A');assert.equal(fs.readFileSync(b!,'utf8'),'scene B');
 assert.deepEqual(fs.readFileSync(path.join(archive.dir,baseCtx.generationId+'_NOW.jpg')),raw);
 const doc=JSON.parse(fs.readFileSync(path.join(archive.dir,baseCtx.generationId+'_prompts.json'),'utf8'));
 assert.equal(doc.sourceFile,baseCtx.generationId+'_NOW.jpg');assert.equal(doc.scenarioInputs.A.imageSha256,'a');assert.equal(doc.scenarioInputs.B.imageSha256,'b');assert.equal(doc.historyContext.testLoop,1);
});


test('reference cast archive exit keeps original/allowed inventory separately and removes private image fields',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cast-archive-'));try{
  const archive=new GenerationArchive(baseCtx,root);
  const metadata:any={schema:1,originalSourceCount:1,expectedInventoryCount:2,allowedInventory:[{id:'source:0',origin:'source',personIndex:0,imageNumber:1},{id:'ref:upload:0',origin:'reference',personIndex:0,imageNumber:3,contentId:'upload',sha256:'a'.repeat(64),imageDataUrl:'data:image/png;base64,PRIVATE'}],imageBindings:[{imageNumber:1,role:'source-scene'},{imageNumber:2,role:'source-identity',sourceIndexes:[0]},{imageNumber:3,role:'added-people',contentId:'upload'}],references:[{contentId:'upload',sha256:'a'.repeat(64),peopleCount:1,imageDataUrl:'data:image/png;base64,PRIVATE'}],imageDataUrl:'data:image/png;base64,PRIVATE'};
  archive.addScene(0,{sceneKey:'gen_a',distanceSec:15,label:'A',predictionPrompt:'shared room',scenarioDescription:'add reference',imagePromptFull:'allowed cast',negativePrompt:null,seed:1,elapsedMs:1,sceneReferenceCast:metadata},tinyPng(),'png');archive.finish('completed');
  const text=fs.readFileSync(path.join(archive.dir,baseCtx.generationId+'_prompts.json'),'utf8'),doc=JSON.parse(text);
  assert.equal(doc.scenes[0].sceneReferenceCast.originalSourceCount,1);assert.equal(doc.scenes[0].sceneReferenceCast.expectedInventoryCount,2);assert.equal(doc.scenes[0].sceneReferenceCast.allowedInventory[1].id,'ref:upload:0');assert.doesNotMatch(text,/base64|imageDataUrl|PRIVATE/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('G-24 skipped scene: prompts.json scenes[] carries skipped:true + reason, README names the skip, no image is written', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genarch-skip-'));
  const id = baseCtx.generationId;
  const a = new GenerationArchive({ ...baseCtx, params: { ...baseCtx.params, sceneDistancesSec: [30, 30, -30], imageCount: 3 } }, root);
  a.setEmptyRoom([{ sceneKey: 'gen_b', roll: 0.8, personDrawn: false, skipped: true, skipReason: 'no_recent_activity' }]);
  a.addScene(0, { sceneKey: 'gen_a', distanceSec: 30, label: 'x', predictionPrompt: 'p', scenarioDescription: 'd', imagePromptFull: 'i', negativePrompt: null, seed: 1, elapsedMs: 1 }, tinyPng(), 'png');
  a.addSkippedScene(1, { sceneKey: 'gen_b', distanceSec: 30, reason: 'no_recent_activity', emptyRoom: { roll: 0.8 } });
  a.finish('completed');
  const dir = path.join(root, id.slice(0, 10), id);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, `${id}_prompts.json`), 'utf8'));
  assert.equal(doc.scenes.length, 2);
  assert.deepEqual([doc.scenes[1].letter, doc.scenes[1].sceneKey, doc.scenes[1].skipped, doc.scenes[1].skipReason, doc.scenes[1].file], ['B', 'gen_b', true, 'no_recent_activity', null]);
  assert.equal(doc.emptyRoom[0].skipReason, 'no_recent_activity');
  assert.ok(!fs.existsSync(path.join(dir, `${id}_B.png`)));
  assert.match(fs.readFileSync(path.join(dir, `${id}_README.txt`), 'utf8'), /B \(gen_b\).*skip.*no_recent_activity/);
  fs.rmSync(root, { recursive: true, force: true });
});
