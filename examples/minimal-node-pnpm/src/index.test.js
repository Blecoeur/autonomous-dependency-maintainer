import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, greet } from './index.js';

test('add returns the sum', () => {
  assert.equal(add(2, 3), 5);
});

test('greet formats a greeting', () => {
  assert.equal(greet('world'), 'Hello, world!');
});
