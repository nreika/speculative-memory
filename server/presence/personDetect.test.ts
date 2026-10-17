import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPerson, parsePersonResponse } from './personDetect.js';

const IMG = 'data:image/jpeg;base64,AAAA';
const answer = (response: string) =>
  (async () => new Response(JSON.stringify({ response }), { status: 200 })) as unknown as typeof fetch;

test('parsePersonResponse handles normal, loose and contradictory answers', () => {
  assert.deepEqual(parsePersonResponse('{"person": true, "count": 2}'), { person: true, count: 2 });
  assert.deepEqual(parsePersonResponse('{"person": false, "count": 0}'), { person: false, count: 0 });
  assert.deepEqual(parsePersonResponse('{"person": false}'), { person: false });
  assert.deepEqual(parsePersonResponse('{"count": 1}'), { person: true, count: 1 });
  assert.deepEqual(parsePersonResponse('Sure: {"person": "true", "count": 1} ok'), { person: true, count: 1 });
  assert.deepEqual(parsePersonResponse('{"person": false, "count": 3}'), { person: true, count: 3 });
  assert.equal(parsePersonResponse('nope'), null);
  assert.equal(parsePersonResponse('{}'), null);
  assert.equal(parsePersonResponse(undefined), null);
});

test('detectPerson sends one image, num_predict 32, format json', async () => {
  let sent: any;
  const f = (async (_u: string, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ response: '{"person": true, "count": 1}' }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await detectPerson(IMG, { ollamaUrl: 'http://x:1/', model: 'm', fetchImpl: f });
  assert.equal(r.person, true);
  assert.equal(r.count, 1);
  assert.equal(r.model, 'm');
  assert.deepEqual(sent.images, ['AAAA']);
  assert.equal(sent.format, 'json');
  assert.equal(sent.options.num_predict, 32);
  assert.equal(sent.stream, false);
});

test('detectPerson reports unknown (person null) on bad input, HTTP error, junk answer, exception', async () => {
  assert.equal((await detectPerson('not an image', { fetchImpl: answer('{}') })).person, null);
  const http = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
  const r1 = await detectPerson(IMG, { fetchImpl: http });
  assert.equal(r1.person, null);
  assert.match(r1.error!, /500/);
  assert.equal((await detectPerson(IMG, { fetchImpl: answer('garbage') })).person, null);
  const boom = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const r2 = await detectPerson(IMG, { fetchImpl: boom });
  assert.equal(r2.person, null);
  assert.match(r2.error!, /ECONNREFUSED/);
});
