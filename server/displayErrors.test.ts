import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDisplayErrorLog} from './displayErrors';

test('display errors are validated, written one JSON line each, rate limited and summarised',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'de-')),file=path.join(dir,'display-errors.jsonl');let t=1_000_000;
  const log=createDisplayErrorLog({file,now:()=>t,perMinute:3});
  assert.equal(log.record('bad id','public',[]).ok,false);
  assert.equal(log.record('screen-2','public',[{kind:'nope',detail:'x'}]).accepted,0);
  assert.equal(log.record('screen-2','tailnet',[{kind:'timeout',detail:'snapshot',ms:8001,count:2},{kind:'slow-image',detail:'/captures/a.png',ms:2500}]).accepted,2);
  assert.equal(log.record('screen-3','public',[{kind:'connection',detail:'x'},{kind:'js-error',detail:'y'}]).status,429);
  await new Promise(r=>setTimeout(r,50));
  const rows=fs.readFileSync(file,'utf8').trim().split('\n').map(l=>JSON.parse(l));
  assert.equal(rows.length,2);assert.equal(rows[0].device,'tailnet');assert.equal(rows[0].count,2);assert.equal(rows[1].ms,2500);
  assert.deepEqual(log.summary().sort(),['screen-2: slow-image x1 (max 2.5s)','screen-2: timeout x2 (max 8.0s)']);
  t+=11*60_000;assert.deepEqual(log.summary(),[]);
});
