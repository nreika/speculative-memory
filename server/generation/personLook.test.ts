import test from 'node:test';
import assert from 'node:assert/strict';
import {personLookMismatch} from './personLook';

test('the drawn recent person must keep the hair length and the clothes colours of the person who was really there', () => {
  assert.equal(personLookMismatch({hair:'short pink-tipped dark hair',clothes:'teal sweatshirt'},{hair:'short dark hair with pink tips',clothes:'teal sweater'}),null);
  assert.match(personLookMismatch({hair:'bald',clothes:'dark shirt'},{hair:'long brown hair',clothes:'navy sleeveless dress'})!,/hair long instead of bald/);
  assert.match(personLookMismatch({hair:'short',clothes:'teal sweatshirt'},{hair:'short',clothes:'white shirt'})!,/clothes white instead of teal/);
  assert.equal(personLookMismatch({hair:'',clothes:''},{hair:'long brown hair',clothes:'red dress'}),null);
  assert.equal(personLookMismatch({hair:'long brown hair',clothes:'dark sleeveless top'},{hair:'long brown hair',clothes:'navy sleeveless dress'}),null);
});
