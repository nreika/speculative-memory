import test from 'node:test';
import assert from 'node:assert/strict';
import { withEnglishSpan, withJapaneseSpan } from './spanFix';

test('Japanese span is rebuilt from the signed distance (15 / 30 / -25 / 150 / 600)', () => {
  assert.equal(withJapaneseSpan('30秒後、男性が立ち上がる。', 15), '15秒後、男性が立ち上がる。');
  assert.equal(withJapaneseSpan('25秒後、男性が座る。', 30), '30秒後、男性が座る。');
  assert.equal(withJapaneseSpan('25秒前、男性が座る。', -25), '25秒前、男性が座る。');
  assert.equal(withJapaneseSpan('2分後、光が変わる。', 150), '2分30秒後、光が変わる。');
  assert.equal(withJapaneseSpan('1分30秒前、光が変わる。', -600), '10分前、光が変わる。');
  assert.equal(withJapaneseSpan('光が変わる。', 600), '10分後、光が変わる。');
});

test('English span is rebuilt from the signed distance, also when missing', () => {
  assert.equal(withEnglishSpan('30 seconds later, He stands up.', 15), '15 seconds later, he stands up.');
  assert.equal(withEnglishSpan('2 minutes 30 seconds before, The light dims.', -25), '25 seconds before, the light dims.');
  assert.equal(withEnglishSpan('Shortly after, he sits.', 150), '2 minutes 30 seconds later, he sits.');
  assert.equal(withEnglishSpan('The light dims.', 600), '10 minutes later, the light dims.');
  assert.equal(withEnglishSpan('1 minute later, x.', 60), '1 minute later, x.');
});

test('empty text stays empty', () => {
  assert.equal(withJapaneseSpan('', 30), '');
  assert.equal(withEnglishSpan('', 30), '');
});

test('untranslated English is left alone by the Japanese fix', () => {
  assert.equal(withJapaneseSpan('15 seconds later, he sits.', 15), '15 seconds later, he sits.');
});
