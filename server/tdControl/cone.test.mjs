import test from 'node:test';
import assert from 'node:assert/strict';
import {coneGeometry} from './timeline.mjs';
test('signed times use opposite sides of the source',()=>{
 const g=coneGeometry({a:15,b:30,c:-25});
 assert.ok(g.points[0].axisX>500);assert.ok(g.points[1].axisX>g.points[0].axisX);assert.ok(g.points[2].axisX<500);
 assert.equal(g.points[2].label,'−25 sec');
});
test('unknown times do not borrow another setting',()=>{
 const g=coneGeometry({a:null,b:undefined,c:NaN});
 assert.ok(g.points.every(p=>p.distance===null&&p.label==='time unknown'));
});
test('zero time stays zero',()=>{assert.equal(coneGeometry({a:0,b:0,c:0}).points[0].label,'NOW');});
test('large values remain within the graph',()=>{
 const g=coneGeometry({a:3600,b:-3600,c:110});
 assert.equal(g.range,3600);assert.ok(g.points.every(p=>p.axisX>=50&&p.axisX<=950));
});
