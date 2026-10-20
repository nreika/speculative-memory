// One hidden Node process owns the HTTP server and its append-only logs.
// No cmd/tsx parent is left holding redirected log handles after a restart.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
for (const [stream, name] of [[process.stdout, 'server.log'], [process.stderr, 'server.err.log']]) {
  const fd = fs.openSync(path.join(root, 'logs', name), 'a');
  stream.write = (chunk, encoding, callback) => {
    fs.writeSync(fd, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8'));
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') done();
    return true;
  };
}
await import('../server.ts');
