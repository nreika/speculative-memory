import test from 'node:test';
import assert from 'node:assert/strict';
import {personFrameShift} from './personFrame';

test('a person that grows, shrinks or moves far from where they are in NOW is flagged', () => {
  const d={width:1280,height:720};
  const far=[200,500,230,560];           // tiny far person
  assert.equal(personFrameShift(far,d,[205,505,238,566],d),null);
  assert.match(personFrameShift(far,d,[600,100,900,700],d)!,/taller/);
  assert.match(personFrameShift([500,100,700,600],d,[520,300,560,340],d)!,/only/);
  assert.match(personFrameShift([100,100,300,600],d,[900,100,1100,600],d)!,/sideways/);
  assert.equal(personFrameShift([100,100,200,300],{width:640,height:360},[110,110,210,305],{width:640,height:360}),null);
  assert.equal(personFrameShift([],d,[1,2,3,4],d),null);
});
