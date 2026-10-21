import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {renameRetry} from './renameRetry';

test('renameRetry renames and rethrows non-transient errors immediately', async()=>{
  const d=await fs.mkdtemp(path.join(os.tmpdir(),'rr-'));
  await fs.writeFile(path.join(d,'a'),'1');
  await renameRetry(path.join(d,'a'),path.join(d,'b'));
  assert.equal(await fs.readFile(path.join(d,'b'),'utf8'),'1');
  await assert.rejects(renameRetry(path.join(d,'missing'),path.join(d,'c')),{code:'ENOENT'});
  await fs.rm(d,{recursive:true,force:true});
});
