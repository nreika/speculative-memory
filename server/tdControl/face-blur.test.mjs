import {test} from 'node:test';
import assert from 'node:assert/strict';
import {faceBlurKey,faceBlurRegions,faceBlurImage} from './face-blur.mjs';
test('face regions become an ellipse centred on the face box, scaled to the image',()=>{
 const [e]=faceBlurRegions({faceRegions:[{x:.1,y:.2,width:.2,height:.3}]},1000,500);
 assert.ok(Math.abs(e.cx-200)<.001);assert.ok(Math.abs(e.cy-175)<.001);
 assert.ok(Math.abs(e.rx-100)<.001);assert.ok(Math.abs(e.ry-84)<.001);
});
test('invalid or missing regions never blur the whole image',()=>{
 assert.deepEqual(faceBlurRegions({faceRegions:[{x:-1,y:0,width:1,height:1},{x:0,y:0,width:NaN,height:1}]},100,100),[]);
 assert.equal(faceBlurImage({src:'/original.png',naturalWidth:100,naturalHeight:100},{faceRegions:[]},{faceBlur:{enabled:true,strengthPx:12}}),'/original.png');
});
test('enabled state, strength and arriving regions invalidate rendered image',()=>{
 const c={id:'same-image'},off={faceBlur:{enabled:false,strengthPx:12}},on={faceBlur:{enabled:true,strengthPx:12}};
 assert.notEqual(faceBlurKey(c,off),faceBlurKey(c,on));
 assert.notEqual(faceBlurKey(c,on),faceBlurKey({...c,faceRegions:[{x:.1,y:.1,width:.2,height:.2}]},on));
});
