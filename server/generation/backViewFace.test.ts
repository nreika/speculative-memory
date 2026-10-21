import test from 'node:test';
import assert from 'node:assert/strict';
import {withBackViewFace} from './backViewFace';

test('a face in the output of a faceless (back view) original rejects; other cases pass', async () => {
  const ok={ok:true as boolean|null,reason:'fine'};
  const reject=await withBackViewFace(ok,Promise.resolve(0),'x',async()=>1);
  assert.equal(reject.ok,false);assert.equal((reject as any).defect,'face_on_back_view');
  assert.equal((await withBackViewFace(ok,Promise.resolve(0),'x',async()=>0)).ok,true);
  assert.equal((await withBackViewFace(ok,Promise.resolve(1),'x',async()=>1)).ok,true);
  assert.equal((await withBackViewFace(ok,Promise.resolve(null),'x',async()=>2)).ok,true);
  assert.equal((await withBackViewFace(ok,Promise.resolve(0),'x',async()=>null)).ok,true);
  const bad={ok:false as boolean|null,reason:'count',defect:'extra_hand'};
  assert.equal((await withBackViewFace(bad,Promise.resolve(0),'x',async()=>3)).defect,'extra_hand');
});
