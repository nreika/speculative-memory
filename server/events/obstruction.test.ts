import test from 'node:test';
import assert from 'node:assert/strict';
import { obstructedSince, withObstructionNote, OBSTRUCTION_NOTE } from './obstruction';
import type { CaptureEvent } from './captureEvents';

const ev = (n: number, o?: boolean, extra: Partial<CaptureEvent> = {}): CaptureEvent =>
  ({ captureId: `c${n}`, startedAt: `2026-10-16T20:0${n}:00.000Z`, result: 'completed', obstructed: o, ...extra }) as CaptureEvent;

test('obstructedSince: start of the newest consecutive run of true', () => {
  assert.equal(obstructedSince([ev(1, false), ev(2, true), ev(3, true)]), ev(2).startedAt);
  assert.equal(obstructedSince([ev(1, true), ev(2, false)]), null);
  assert.equal(obstructedSince([]), null);
});

test('obstructedSince: skips tests and unknown verdicts', () => {
  assert.equal(obstructedSince([ev(1, true), ev(2, undefined), ev(3, false, { test: true }), ev(4, true)]), ev(1).startedAt);
});

test('withObstructionNote appends once', () => {
  assert.equal(withObstructionNote('部屋は静か。', null), '部屋は静か。');
  const s = withObstructionNote('部屋は静か。', 'x');
  assert.equal(s, '部屋は静か。' + OBSTRUCTION_NOTE);
  assert.equal(withObstructionNote(s, 'x'), s);
});
