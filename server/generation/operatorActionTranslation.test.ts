import test from 'node:test';import assert from 'node:assert/strict';
import {operatorActorPosition,personAtImagePosition,translatedOperatorAction,positionedActorSubject} from './operatorActionTranslation';
test('screen positions are removed before translation without removing anatomical hand instructions',()=>{
 for(const [label,pos] of [['左','left'],['右','right'],['中央','center']])assert.deepEqual(operatorActorPosition(`画面${label}の人物が、左手を上げる。`),{position:pos,actionText:'左手を上げる。'});
 assert.deepEqual(operatorActorPosition('画面の右側にいる人物は片手を上げる。'),{position:'right',actionText:'片手を上げる。'});
 assert.deepEqual(operatorActorPosition('左手を上げる。'),{actionText:'左手を上げる。'});
 assert.equal(operatorActorPosition('画面左の人物が').position,undefined);
});
test('position selects only a unique observed actor; no first-person fallback for ambiguous right or center',()=>{
 const people=[{position:'right background',clothes:'black shirt'},{position:'left front',clothes:'striped shirt'},{position:'center',clothes:'white shirt'}];
 assert.equal(personAtImagePosition(people,'left')?.clothes,'striped shirt');assert.equal(personAtImagePosition(people,'right')?.clothes,'black shirt');assert.equal(personAtImagePosition(people,'center')?.clothes,'white shirt');
 assert.equal(personAtImagePosition([...people,{position:'left',clothes:'blue shirt'}],'left'),undefined);
 assert.equal(personAtImagePosition([{position:'left center'}],'left'),undefined);
 assert.match(positionedActorSubject('right','black shirt'),/on the right side of the image wearing black shirt/);
});
test('screen-left does not invent left hand and opposite-hand instruction remains generic',()=>{
 assert.equal(translatedOperatorAction('画面左の人物が、片手を軽く上げる。','left-hand slightly raises','left'),'slightly raises one hand');
 assert.equal(translatedOperatorAction('画面左の人物が、片手を上げる / 反対の手は机に置く。','left hand raises, right hand places on desk','left'),'raises one hand, places the other hand on desk');
 assert.equal(translatedOperatorAction('画面右の人物が、座る。','right-hand person sits down','right'),'sits down');
});
test('explicit anatomical laterality survives while unrequested side remains unspecified',()=>{
 assert.equal(translatedOperatorAction('画面右の人物が、左手を上げ右手を机に置く。','raises left hand and places right hand on desk','right'),'raises left hand and places right hand on desk');
 assert.equal(translatedOperatorAction('左手を上げ、反対の手は机に置く。','left hand raises; right hand rests on desk'),'raises left hand; rests the other hand on desk');
 assert.equal(translatedOperatorAction('右手を上げる。','raises right hand'),'raises right hand');
});

test('explicit Japanese arm side and English hand side are not treated as image position',()=>{
 assert.equal(translatedOperatorAction('画面左の人物が右腕を上げる。','raises right arm','left'),'raises right arm');
 assert.equal(translatedOperatorAction('画面右の人物が左腕を上げる。','raises left arm','right'),'raises left arm');
 assert.equal(translatedOperatorAction('Raise the left hand and rest the right hand.','raises left hand and rests right hand'),'raises left hand and rests right hand');
});
