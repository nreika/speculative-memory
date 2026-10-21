import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHistoryJa} from './historyJa';

test('history lines are Japanese: archived nowText first, then a cached translation, English only while it is pending', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hja-')),id='2026-10-21_17-30-00',dir=path.join(root,'2026-10-21',id);fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,id+'_prompts.json'),JSON.stringify({nowText:'空のオフィスで、机と椅子がある。'}));
  const calls:string[]=[];
  const ja=createHistoryJa({archiveRoot:root,imageNowOf:c=>c==='cap1'?`/captures/record_${id}.jpg`:undefined,translate:async e=>{calls.push(e);return '机の前に人が座っている。';}});
  assert.equal(ja.textFor({captureId:'cap1',observation:'An empty office.'}),'空のオフィスで、机と椅子がある。');
  assert.equal(ja.textFor({captureId:'cap2',observation:'A person sits at a desk.'}),'A person sits at a desk.');
  await new Promise(r=>setTimeout(r,20));
  assert.equal(ja.textFor({captureId:'cap2',observation:'A person sits at a desk.'}),'机の前に人が座っている。');
  assert.equal(calls.length,1);
  assert.equal(ja.textFor({captureId:'cap3',observation:'すでに日本語です。'}),'すでに日本語です。');
});

test('the People footer is Japanese', async () => {
  const {peopleFooterJa}=await import('./historyJa');
  assert.equal(peopleFooterJa('People: left at 17:42; the room has been empty for 4 min'),'人物: 17:42 に退出。部屋は 4 分間無人');
  assert.equal(peopleFooterJa('People: the room has been empty for 7 min'),'人物: 部屋は 7 分間無人');
  assert.equal(peopleFooterJa('People: a person arrived at 09:01; present now for 3 min'),'人物: 09:01 に人が来た。今は 3 分間在室');
});

test('history line prefixes are Japanese', async () => {
  const {historyLinePrefixJa}=await import('./historyJa');
  assert.equal(historyLinePrefixJa('[17:40, 8 min ago] オフィス。'),'[17:40, 8 分前] オフィス。');
  assert.equal(historyLinePrefixJa('\u00d76 (17:42\u201317:47, latest 1 min ago, no change for 5 min) 空の部屋。'),'\u00d76（17:42\u201317:47、最新 1 分前、5 分間変化なし） 空の部屋。');
});
