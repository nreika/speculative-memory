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
