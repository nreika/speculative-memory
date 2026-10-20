import test from 'node:test';
import assert from 'node:assert/strict';
import {sharedOllamaContextLength} from './sharedOllamaContext';
test('same model context has a single default and shared explicit override for all phases',()=>{
 assert.equal(sharedOllamaContextLength({}),8192);assert.equal(sharedOllamaContextLength({VLM_NUM_CTX:'16384'}),16384);
});
test('invalid or undersized context cannot truncate the existing planner capacity',()=>{
 for(const value of ['2048','4096','0','-1','NaN','Infinity','8192.5','999999'])assert.equal(sharedOllamaContextLength({VLM_NUM_CTX:value}),8192);
});
