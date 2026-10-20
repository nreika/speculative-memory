import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {completedConeResult,availableConeScenes,coneGeometry,localImagePath} from './timeline.mjs';

function event(id,count=3,ended=10000){
  const scope='test:run',images={},browserBatch=[];
  for(const key of ['now','a','b','c'].slice(0,count+1)){
    const sceneKey=key==='now'?'now':'gen_'+key;
    images[key]=`/captures/${id}-${key}.png`;
    browserBatch.push({id:id+':'+sceneKey,captureId:id,sceneKey,scope,
      provenance:key==='now'?'actual':'generated',imageUrl:images[key],
      distanceSecSigned:key==='now'?null:({a:15,b:30,c:-30})[key]});
  }
  return {captureId:id,result:'completed',startedAt:new Date(ended-1000).toISOString(),
    endedAt:new Date(ended).toISOString(),browserFollow:{scope},images,browserBatch};
}
const old=event('old'),fresh=event('fresh',3,20000);

test('Continuous can advance NOW before polling without resetting the previous completed cone',()=>{
  const previous=completedConeResult([old]);
  for(const result of ['running','failed','cancelled']){
    const partial=event('new',1,20000);partial.result=result;
    assert.equal(completedConeResult([partial,old],previous),previous);
  }
  const next=event('next',1,30000);next.result='running';
  assert.equal(completedConeResult([next,fresh],previous).captureId,'fresh');
});

test('authoritative one/two/three-image completions work on first load with no active request',()=>{
  for(const count of [1,2,3]){
    const result=completedConeResult([event('one',count)]);
    assert.equal(result.imageCount,count);assert.equal(result.scenes.now.content.captureId,'one');
    assert.equal(result.scenes.a.content.distanceSecSigned,15);
    assert.equal(Boolean(result.scenes.b),count>=2);assert.equal(Boolean(result.scenes.c),count===3);
  }
});

test('partial archives, cancellation after restart and invalid capture/scope/media never replace a valid cone',()=>{
  const previous=completedConeResult([old]);
  const mutations=[
    row=>{row.result='cancelled';}, row=>{row.result='failed';}, row=>{row.result='running';},
    row=>{row.browserBatch.pop();}, row=>{delete row.images.c;},
    row=>{row.browserBatch[1].captureId='other';},row=>{row.browserBatch[1].scope='other';},
    row=>{row.browserBatch[1].id='other:gen_a';},row=>{row.browserBatch[1].provenance='actual';},
    row=>{row.browserBatch[1].imageUrl='/captures/other.png';},
    row=>{row.browserBatch[1]=row.browserBatch[2];},
    row=>{row.browserBatch[1].imageUrl=row.images.a='https://example.com/a.png';},
    row=>{row.browserBatch[1].imageUrl=row.images.a='/captures/../private.png';},
    row=>{row.endedAt=null;},row=>{row.startedAt='invalid';},
    row=>{row.browserBatch[1].distanceSecSigned=undefined;},
    row=>{row.browserBatch[1].sceneKey='gen_c';},
  ];
  for(const mutate of mutations){const row=structuredClone(fresh);mutate(row);assert.equal(completedConeResult([row],previous),previous);}
  assert.equal(completedConeResult(null,previous),previous);
});

test('completed rows are selected by completion time; older polls never roll back the cone',()=>{
  const result=completedConeResult([fresh,old]);assert.equal(result.captureId,'fresh');
  assert.equal(completedConeResult([old],result),result);
  assert.equal(completedConeResult([old,fresh]).captureId,'fresh');
});

test('unknown offsets stay unknown and first-visit provisional data never mixes capture IDs',()=>{
  const row=structuredClone(fresh);row.browserBatch[1].distanceSecSigned=null;
  const result=completedConeResult([row]);assert.equal(coneGeometry({a:result.scenes.a.content.distanceSecSigned}).points[0].distance,null);
  const previous=completedConeResult([old]);
  const provisional=availableConeScenes({...previous.scenes,now:result.scenes.now,a:result.scenes.a});
  assert.equal(provisional.now,result.scenes.now);assert.equal(provisional.a,result.scenes.a);
  assert.equal(provisional.b,null);assert.equal(provisional.c,null);
});

test('SVG nodes persist through polls, Each progress and errors, then update once on completed result',()=>{
  const source=fs.readFileSync(new URL('./control.mjs',import.meta.url),'utf8');let resets=0;
  const elements={cone:{replaceChildren(){resets++;},append(){}},'cone-result':{setAttribute(){}},'cone-settings':{setAttribute(){}},'cone-status':{}};
  const completed=completedConeResult([old]);
  const context={availableConeScenes,coneGeometry,localImagePath,JSON,
    $:id=>elements[id],svgNode:()=>({}),field:()=>({value:99}),
    scenes:['a','b','c'],colors:{a:'orange',b:'pink',c:'blue'},
    latest:{capture:{phase:'idle'},errors:[]},captureProgress:null,
    displayedScenes:completed.scenes,coneMode:'result',coneScenes:null,coneRenderKey:null,coneCompleted:completed};
  vm.runInNewContext(source.slice(source.indexOf('function renderCone(){'))+';this.renderCone=renderCone',context);
  context.renderCone();assert.equal(resets,1);
  context.latest.capture.phase='generating';context.displayedScenes=completedConeResult([fresh]).scenes;
  context.renderCone();assert.equal(resets,1);assert.equal(context.coneScenes.now.content.captureId,'old');
  context.coneMode='settings';context.renderCone();assert.equal(resets,2);
  context.coneMode='result';context.renderCone();assert.equal(resets,3);
  assert.equal(context.coneScenes.a.content.distanceSecSigned,15);
  context.latest.capture.phase='idle';context.latest.errors=[{operator:'native',message:'failed'}];
  context.renderCone();assert.equal(resets,3);
  context.coneCompleted=completedConeResult([fresh]);context.renderCone();assert.equal(resets,4);
  context.coneCompleted=structuredClone(context.coneCompleted);context.renderCone();assert.equal(resets,4);
});
