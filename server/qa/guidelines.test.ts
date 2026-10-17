import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseGuidelines } from './guidelines';

test('USER_GUIDELINES.md is listed: fixed rules, operations, candidates, addition history', () => {
  const g = parseGuidelines(fs.readFileSync('rulebook/USER_GUIDELINES.md', 'utf8'));
  const ids = g.items.map((i) => i.id);
  for (const id of ['G-01', 'G-13', 'G-14', 'G-15', 'R-02']) assert.ok(ids.includes(id), id);
  assert.equal(g.items.find((i) => i.id === 'G-08')?.date, '2026-10-16');
  assert.equal(g.items.find((i) => i.id === 'G-14')?.date, '2026-10-16');
  assert.ok(g.history.length >= 3);
});
