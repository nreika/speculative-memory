import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {finalizeOrphanGenerations} from './finalizeOrphans';

test('a run left "running" without a README is marked aborted; finished and fresh runs are untouched', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orph-'));
  const make=(id:string,status:string,readme:boolean,ageMs:number)=>{
    const dir=path.join(root,'2026-10-21',id);fs.mkdirSync(dir,{recursive:true});const f=path.join(dir,id+'_prompts.json');
    fs.writeFileSync(f,JSON.stringify({status,scenes:[]}));const t=new Date(Date.now()-ageMs);fs.utimesSync(f,t,t);
    if(readme)fs.writeFileSync(path.join(dir,id+'_README.txt'),'x');
  };
  make('a','running',false,600_000);make('b','running',true,600_000);make('c','completed',false,600_000);make('d','running',false,1_000);
  assert.equal(finalizeOrphanGenerations(root),1);
  const status=(id:string)=>JSON.parse(fs.readFileSync(path.join(root,'2026-10-21',id,id+'_prompts.json'),'utf8')).status;
  assert.deepEqual(['a','b','c','d'].map(status),['aborted','running','completed','running']);
});
