import test from 'node:test';
import assert from 'node:assert/strict';

test('runner observes a passing selected test', () => {
  assert.equal(2 + 2, 4);
});

test('runner observes a skipped selected test', { skip: true }, () => {});

test('runner observes a conditional failure', () => {
  assert.notEqual(process.env.TEST_GOVERNANCE_FORCE_FAILURE, '1');
});
