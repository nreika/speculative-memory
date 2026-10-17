import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPublicUrl,
  isValidNotifyHost,
  normalizeRemoteAddress,
  resolvePublicBaseUrl,
  resolveNotifyHost,
} from './notifyTarget.js';

test('isValidNotifyHost accepts IPv4 / hostnames and rejects junk', () => {
  for (const ok of ['127.0.0.1', '192.168.0.12', '100.64.1.2', 'laptop', 'my-laptop.local']) {
    assert.equal(isValidNotifyHost(ok), true, ok);
  }
  for (const bad of ['', ' ', '999.1.1.1', 'a b', 'x;rm', 'http://x', '-bad', 42, null, undefined]) {
    assert.equal(isValidNotifyHost(bad as any), false, String(bad));
  }
});

test('normalizeRemoteAddress unwraps IPv4-mapped IPv6 and loopback', () => {
  assert.equal(normalizeRemoteAddress('::ffff:192.168.0.5'), '192.168.0.5');
  assert.equal(normalizeRemoteAddress('::1'), '127.0.0.1');
  assert.equal(normalizeRemoteAddress('10.0.0.3'), '10.0.0.3');
  assert.equal(normalizeRemoteAddress('fe80::1'), null);
  assert.equal(normalizeRemoteAddress(undefined), null);
});

test('resolveNotifyHost: explicit host > sender > default', () => {
  const defaultHost = '127.0.0.1';
  assert.equal(resolveNotifyHost({ body: {}, remoteAddress: '::ffff:192.168.0.5', defaultHost }), '127.0.0.1');
  assert.equal(
    resolveNotifyHost({ body: { notifyToSender: true }, remoteAddress: '::ffff:192.168.0.5', defaultHost }),
    '192.168.0.5'
  );
  assert.equal(
    resolveNotifyHost({ body: { notifyToSender: true, notifyHost: '100.1.2.3' }, remoteAddress: '192.168.0.5', defaultHost }),
    '100.1.2.3'
  );
  assert.equal(resolveNotifyHost({ body: { notifyHost: 'bad host!' }, remoteAddress: '1.2.3.4', defaultHost }), defaultHost);
  assert.equal(resolveNotifyHost({ body: { notifyToSender: 'yes' }, remoteAddress: '1.2.3.4', defaultHost }), defaultHost);
  assert.equal(resolveNotifyHost({ body: undefined, remoteAddress: undefined, defaultHost }), defaultHost);
});

test('buildPublicUrl joins base and path without doubling slashes', () => {
  assert.equal(buildPublicUrl('http://h:3000', '/captures/a.png'), 'http://h:3000/captures/a.png');
  assert.equal(buildPublicUrl('http://h:3000/', '/captures/a.png'), 'http://h:3000/captures/a.png');
  assert.equal(buildPublicUrl('http://h:3000', 'captures/a.png'), 'http://h:3000/captures/a.png');
  assert.equal(buildPublicUrl('http://h:3000', 'http://x/y.png'), 'http://x/y.png');
});

test('resolvePublicBaseUrl defaults to loopback on the server port', () => {
  assert.equal(resolvePublicBaseUrl(undefined, 3000), 'http://127.0.0.1:3000');
  assert.equal(resolvePublicBaseUrl('  ', 3101), 'http://127.0.0.1:3101');
  assert.equal(resolvePublicBaseUrl('http://192.168.0.2:3000/', 3000), 'http://192.168.0.2:3000');
});
