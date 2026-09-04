import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalDecision } from './final-decision.mjs';

const WORKFLOW = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../.github/workflows/governance-trust-anchor.yml'),
  'utf8',
);

test('A. checker PASS does not require authorization and can PASS', () => {
  assert.equal(finalDecision({
    detectStatus: 'success',
    detectDecision: 'PASS',
    authorizeStatus: 'skipped',
  }), 'PASS');
});

test('B. HUMAN_REQUIRED requires authorization', () => {
  assert.equal(finalDecision({
    detectStatus: 'success',
    detectDecision: 'HUMAN_REQUIRED',
    authorizeStatus: 'skipped',
  }), 'FAIL');
});

test('C. HUMAN_REQUIRED plus authorization success is PASS', () => {
  assert.equal(finalDecision({
    detectStatus: 'success',
    detectDecision: 'HUMAN_REQUIRED',
    authorizeStatus: 'success',
  }), 'PASS');
});

test('D. HUMAN_REQUIRED plus authorization skipped is FAIL', () => {
  assert.equal(finalDecision({
    detectStatus: 'success',
    detectDecision: 'HUMAN_REQUIRED',
    authorizeStatus: 'skipped',
  }), 'FAIL');
});

test('E. HUMAN_REQUIRED plus authorization failed is FAIL', () => {
  assert.equal(finalDecision({
    detectStatus: 'success',
    detectDecision: 'HUMAN_REQUIRED',
    authorizeStatus: 'failure',
  }), 'FAIL');
});

test('LOW_PASS does not require authorization', () => {
  assert.equal(finalDecision({
    detectStatus: 'success',
    detectDecision: 'LOW_PASS',
    authorizeStatus: 'skipped',
  }), 'PASS');
});

test('REJECT never goes to authorization and is FAIL', () => {
  assert.equal(finalDecision({
    detectStatus: 'success',
    detectDecision: 'REJECT',
    authorizeStatus: 'success',
  }), 'FAIL');
});

test('legacy REVIEW_REQUIRED still requires authorization', () => {
  assert.equal(finalDecision({
    detectStatus: 'success',
    detectDecision: 'REVIEW_REQUIRED',
    authorizeStatus: 'success',
  }), 'PASS');
});

test('F. detector internal error is FAIL', () => {
  assert.equal(finalDecision({
    detectStatus: 'failure',
    detectDecision: 'INTERNAL_ERROR',
    authorizeStatus: 'skipped',
  }), 'FAIL');
});

test('G. unknown detector decision is FAIL', () => {
  assert.equal(finalDecision({
    detectStatus: 'success',
    detectDecision: 'WEIRD',
    authorizeStatus: 'success',
  }), 'FAIL');
});

test('H. workflow uses governance-review environment', () => {
  assert.match(WORKFLOW, /environment:\n\s+name: governance-review/);
});

test('I. workflow checks GOVERNANCE_REVIEW_CONFIGURED', () => {
  assert.match(WORKFLOW, /GOVERNANCE_REVIEW_CONFIGURED/);
  assert.match(WORKFLOW, /ARMED" != "true"/);
});

test('J. workflow contains no magic review bypass', () => {
  assert.doesNotMatch(WORKFLOW, /ALLOW_GOVERNANCE_CHANGE/);
  assert.doesNotMatch(WORKFLOW, /github\.actor/);
  assert.doesNotMatch(WORKFLOW, /github\.event\.label/);
  assert.doesNotMatch(WORKFLOW, /commit message/);
});
