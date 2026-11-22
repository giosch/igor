import assert from 'node:assert/strict';
import test from 'node:test';
import { clamp } from './clamp.js';

test('clamps values on both sides of the interval', () => {
  assert.equal(clamp(-2, 0, 5), 0);
  assert.equal(clamp(3, 0, 5), 3);
  assert.equal(clamp(9, 0, 5), 5);
});
