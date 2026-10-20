import test from 'node:test';import assert from 'node:assert/strict';
import {createBrowserFacePresentation} from './browserFacePresentation';
import type {BrowserDisplaySnapshot} from './browserDisplay';
const fixture=():BrowserDisplaySnapshot=>({schema:1,revision:'source',screen:{id:'screen-1',label:'Test',accent:'#000'},clock:{serverNowMs:1,worldNowMs:1,rate:1,scope:'x'},selection:{mode:'pinned',contentId:'image'},temporalRelation:'unknown',selectionStatus:'selected',view:{visible:true,labels:true,subtitles:true,fade:false,faceBlur:{enabled:true,strengthPx:12}},content:{id:'image',scope:'x',provenance:'actual',imageUrl:'/captures/source.jpg',targetAtMs:null,recordedAtMs:1,generatedAtMs:null,sourceRecordedAtMs:1,caption:'source'}});
test('disabled or empty output does not inspect; enabled attaches boxes without mutating saved content',async()=>{
 let calls=0;const present=createBrowserFacePresentation(async()=>{calls++;return{status:'detected',boxes:[{x:.1,y:.2,width:.2,height:.3}]};});
 const disabled=fixture();disabled.view!.faceBlur!.enabled=false;assert.equal(await present(disabled),disabled);const empty=fixture();empty.content=null;assert.equal(await present(empty),empty);assert.equal(calls,0);
 const original=fixture(),before=structuredClone(original),shown=await present(original);assert.equal(calls,1);assert.deepEqual(original,before);assert.equal(shown.content?.imageUrl,original.content?.imageUrl);assert.equal(shown.content?.faceRegions?.length,1);assert.notEqual(shown.revision,original.revision);
});
test('missing detection or failure never substitutes full-frame blur or a different image',async()=>{
 for(const status of ['no-faces','unavailable','error'] as const){const shown=await createBrowserFacePresentation(async()=>({status,boxes:[]}))(fixture());assert.deepEqual(shown.content?.faceRegions,[]);assert.equal(shown.content?.faceRegionStatus,status);assert.equal(shown.content?.imageUrl,'/captures/source.jpg');}
 const shown=await createBrowserFacePresentation(async()=>{throw Error('private detail');})(fixture());assert.equal(shown.content?.faceRegionStatus,'error');assert.deepEqual(shown.content?.faceRegions,[]);
});
