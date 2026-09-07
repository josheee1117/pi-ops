import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAuthorization,
  isMachineReviewPath,
  isTrustRootPath,
  validatePolicyShape,
} from './classify.mjs';
import { finalDecision } from './final-decision.mjs';

function features(overrides = {}) {
  return {
    schemaVersion: 1,
    trustRootVersion: 1,
    governedRoots: ['apps/**'],
    unmappedIgnore: [],
    features: [{
      id: 'demo',
      riskClass: 'high',
      riskScore: 1,
      maintenanceBudget: 1,
      paths: ['apps/demo/**'],
      impacts: [],
      invariants: [{ id: 'INV-DEMO', statement: 'demo remains true', requiredEvidence: { C: 1 } }],
    }],
    ...overrides,
  };
}

function guards(items = [{ id: 'ARCH-DEMO', description: 'demo', kind: 'forbiddenText', scope: ['apps/demo/**'], patterns: ['unsafe'] }]) {
  return { schemaVersion: 1, guards: items };
}

function emptyTrust() {
  return {
    trustSurface: { findings: [] },
    proofIntegrity: { changedSources: [], changedDefinitions: [], newProofs: [] },
  };
}

function classify(changedFiles, extras = {}) {
  return classifyAuthorization({
    changedFiles,
    trustResult: emptyTrust(),
    baseFeatures: features(),
    headFeatures: features(),
    baseGuards: guards(),
    headGuards: guards(),
    baseSha: 'base',
    headSha: 'head',
    ...extras,
  });
}

test('K0 trust root is narrow and K1 governance surface is machine reviewed', () => {
  for (const file of [
    '.github/workflows/governance-trust-anchor.yml',
    'tools/test-governance/trust-anchor/check.mjs',
    'tools/test-governance/trust-anchor/classify.mjs',
    'tools/test-governance/trust-anchor/final-decision.mjs',
    'tools/test-governance/trust-anchor/machine-review.mjs',
  ]) assert.equal(isTrustRootPath(file), true, file);

  for (const file of [
    '.github/workflows/test-governance.yml',
    'tools/test-governance/src/core.mjs',
    'tools/test-governance/trust-anchor/check.test.mjs',
    'tools/test-governance/trust-anchor/classify.test.mjs',
  ]) {
    assert.equal(isTrustRootPath(file), false, file);
    assert.equal(isMachineReviewPath(file), true, file);
  }
});

test('K1 governance implementation routes to MACHINE_REVIEW, not Environment', () => {
  const result = classify(['tools/test-governance/src/core.mjs']);
  assert.equal(result.decision, 'HUMAN_REQUIRED');
  assert.equal(result.route, 'MACHINE_REVIEW');
  assert.deepEqual(result.trustRootChanges, []);
  assert.deepEqual(result.machineReviewChanges, ['tools/test-governance/src/core.mjs']);
});

test('K0 trust-root change routes to BREAK_GLASS', () => {
  const result = classify(['tools/test-governance/trust-anchor/classify.mjs']);
  assert.equal(result.decision, 'HUMAN_REQUIRED');
  assert.equal(result.route, 'BREAK_GLASS');
  assert.deepEqual(result.trustRootChanges, ['tools/test-governance/trust-anchor/classify.mjs']);
});

test('duplicate feature ids are rejected before Map normalization', () => {
  const invalid = features();
  invalid.features.push({ ...invalid.features[0] });
  const result = classify(['tools/test-governance/config/features.json'], { headFeatures: invalid });
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.route, 'NONE');
  assert.ok(result.shapeProblems.some((item) => item.code === 'DUPLICATE_FEATURE_ID'));
});

test('duplicate invariant ids across features are rejected', () => {
  const invalid = features();
  invalid.features.push({
    id: 'demo-2', paths: ['apps/demo2/**'], impacts: [],
    invariants: [{ id: 'INV-DEMO', statement: 'duplicate', requiredEvidence: { C: 1 } }],
  });
  const result = classify(['tools/test-governance/config/features.json'], { headFeatures: invalid });
  assert.equal(result.decision, 'REJECT');
  assert.ok(result.shapeProblems.some((item) => item.code === 'DUPLICATE_INVARIANT_ID'));
});

test('duplicate guard ids are rejected', () => {
  const duplicate = guards([
    { id: 'ARCH-X', kind: 'forbiddenText', scope: ['a/**'], patterns: ['x'] },
    { id: 'ARCH-X', kind: 'forbiddenText', scope: ['b/**'], patterns: ['y'] },
  ]);
  const result = classify(['tools/test-governance/config/architecture-guards.json'], { headGuards: duplicate });
  assert.equal(result.decision, 'REJECT');
  assert.ok(result.shapeProblems.some((item) => item.code === 'DUPLICATE_GUARD_ID'));
});

test('missing ids and invalid structural arrays fail closed', () => {
  const invalid = features();
  invalid.features[0].id = '';
  invalid.features[0].paths = 'not-an-array';
  const problems = validatePolicyShape({ features: invalid, guards: guards() });
  assert.ok(problems.some((item) => item.code === 'MISSING_FEATURE_ID'));
  assert.ok(problems.some((item) => item.code === 'INVALID_ARRAY'));
  const result = classify(['tools/test-governance/config/features.json'], { headFeatures: invalid });
  assert.equal(result.decision, 'REJECT');
});

test('invalid BASE policy is INTERNAL_ERROR, not a HEAD authorization decision', () => {
  const invalidBase = features();
  invalidBase.features.push({ ...invalidBase.features[0] });
  const result = classify(['apps/demo/file.ts'], { baseFeatures: invalidBase });
  assert.equal(result.decision, 'INTERNAL_ERROR');
});

test('final state machine uses machine result for K1 and Environment only for break-glass', () => {
  assert.equal(finalDecision({ detectStatus: 'success', detectDecision: 'HUMAN_REQUIRED', detectRoute: 'MACHINE_REVIEW', machineReviewStatus: 'success', authorizeStatus: 'skipped' }), 'PASS');
  assert.equal(finalDecision({ detectStatus: 'success', detectDecision: 'HUMAN_REQUIRED', detectRoute: 'MACHINE_REVIEW', machineReviewStatus: 'failure', authorizeStatus: 'success' }), 'FAIL');
  assert.equal(finalDecision({ detectStatus: 'success', detectDecision: 'HUMAN_REQUIRED', detectRoute: 'BREAK_GLASS', machineReviewStatus: 'skipped', authorizeStatus: 'success' }), 'PASS');
  assert.equal(finalDecision({ detectStatus: 'success', detectDecision: 'HUMAN_REQUIRED', detectRoute: 'BREAK_GLASS', machineReviewStatus: 'success', authorizeStatus: 'skipped' }), 'FAIL');
});
