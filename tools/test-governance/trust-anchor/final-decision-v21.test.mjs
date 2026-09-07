import test from 'node:test';
import assert from 'node:assert/strict';
import { finalDecision } from './final-decision.mjs';

test('MACHINE_REVIEW_REQUIRED passes only with successful machine review', () => {
  assert.equal(finalDecision({
    detectStatus: 'success',
    detectDecision: 'MACHINE_REVIEW_REQUIRED',
    machineReviewStatus: 'success',
    authorizeStatus: 'skipped',
  }), 'PASS');

  for (const status of ['failure', 'skipped', 'cancelled', undefined]) {
    assert.equal(finalDecision({
      detectStatus: 'success',
      detectDecision: 'MACHINE_REVIEW_REQUIRED',
      machineReviewStatus: status,
      authorizeStatus: 'success',
    }), 'FAIL');
  }
});

test('BREAK_GLASS_REQUIRED passes only with successful environment authorization', () => {
  assert.equal(finalDecision({
    detectStatus: 'success',
    detectDecision: 'BREAK_GLASS_REQUIRED',
    machineReviewStatus: 'skipped',
    authorizeStatus: 'success',
  }), 'PASS');

  for (const status of ['failure', 'skipped', 'cancelled', undefined]) {
    assert.equal(finalDecision({
      detectStatus: 'success',
      detectDecision: 'BREAK_GLASS_REQUIRED',
      machineReviewStatus: 'success',
      authorizeStatus: status,
    }), 'FAIL');
  }
});
