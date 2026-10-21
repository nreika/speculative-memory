import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createOperatorLibrary} from './operatorLibrary';

test('library list is cached briefly so repeated snapshots do not rescan', async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lib-'));
  await fs.writeFile(path.join(root,'a.csv'),'seconds,action,target,value\n');
  const lib=createOperatorLibrary(root,'python');
  const first=await lib.list();assert.deepEqual(first.map(r=>r.file),['a.csv']);
  await fs.writeFile(path.join(root,'b.csv'),'x');
  assert.deepEqual((await lib.list()).map(r=>r.file),['a.csv']);
  first.push({file:'zzz',name:'zzz'});
  assert.equal((await lib.list()).length,1);
  await fs.rm(root,{recursive:true,force:true});
});

test('checker returns every error with row and offending text; upload refuses an invalid CSV and leaves the library unchanged', async()=>{
  const python=process.env.OPERATOR_TEST_PYTHON??path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lib-bad-'));
  const lib=createOperatorLibrary(root,python);
  const csv='seconds,action,target,value\n0,scenario,,TWO-ERR\n1,bogus_action,,x\n2,prompt,A,ok\n3,prompt,Z,bad target\n4,end,,\n';
  await assert.rejects(lib.upload({csv:{name:'bad.csv',text:csv},assets:[]}),(error:any)=>{
    assert.equal(error.formatErrors.length,2);
    assert.deepEqual(error.formatErrors.map((e:any)=>e.row),[3,5]);
    assert.equal(error.formatErrors[0].text,'1,bogus_action,,x');assert.equal(error.formatErrors[1].text,'3,prompt,Z,bad target');
    assert.match(error.message,/FORMAT ERROR: 2 problems/);return true;
  });
  assert.deepEqual(await lib.list(),[]);
});
