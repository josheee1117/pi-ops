import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFeaturePlan,
  evaluateGuardFile,
  matchesPath,
  resolveAffectedFeatures,
  validateGovernanceConfig
} from './core.mjs';

const feature = {
  id: 'investigation.reconciliation',
  riskClass: 'critical',
  riskScore: 12,
  maintenanceBudget: 12,
  paths: ['apps/agent/src/investigation-reconciler.ts', 'apps/agent/src/store.ts'],
  invariants: [{ id: 'INV-GEN-01', statement: 'dynamic evidence does not start another generation', requiredEvidence: { A: 1, C: 1 } }]
};

test('matches exact and recursive governance paths', () => {
  assert.equal(matchesPath('apps/pi-runtime/src/model.ts', 'apps/pi-runtime/src/**'), true);
  assert.equal(matchesPath('apps/pi-runtime/test/model.ts', 'apps/pi-runtime/src/**'), false);
  assert.equal(matchesPath('apps/agent/src/store.ts', 'apps/agent/src/store.ts'), true);
});

test('resolves governed features from changed files', () => {
  const result = resolveAffectedFeatures(['README.md', 'apps/agent/src/investigation-reconciler.ts'], [feature]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].matchedFiles, ['apps/agent/src/investigation-reconciler.ts']);
});

test('planner reuses the smallest catalog set that closes evidence slots', () => {
  const plan = buildFeaturePlan(feature, [
    { id: 'unit-dynamic', featureId: feature.id, status: 'PINNED', maintenanceCost: 1, proofs: [{ invariantId: 'INV-GEN-01', level: 'C' }] },
    { id: 'smoke-dynamic', featureId: feature.id, status: 'ACTIVE', maintenanceCost: 4, proofs: [{ invariantId: 'INV-GEN-01', level: 'A' }] },
    { id: 'redundant-c', featureId: feature.id, status: 'ACTIVE', maintenanceCost: 5, proofs: [{ invariantId: 'INV-GEN-01', level: 'C' }] }
  ]);
  assert.equal(plan.status, 'CATALOG_COVERED');
  assert.deepEqual(plan.selected.map((entry) => entry.id).sort(), ['smoke-dynamic', 'unit-dynamic']);
  assert.equal(plan.gaps.length, 0);
});

test('planner reports evidence gaps instead of silently lowering the floor', () => {
  const plan = buildFeaturePlan(feature, [
    { id: 'unit-only', featureId: feature.id, status: 'ACTIVE', maintenanceCost: 1, proofs: [{ invariantId: 'INV-GEN-01', level: 'C' }] }
  ]);
  assert.equal(plan.status, 'NEEDS_EVIDENCE');
  assert.deepEqual(plan.gaps, [{ invariantId: 'INV-GEN-01', level: 'A', missing: 1 }]);
});

test('architecture guard detects forbidden runtime imports', () => {
  const violations = evaluateGuardFile(
    { id: 'ARCH-RUNTIME-NODE', kind: 'forbiddenImport', scope: ['apps/pi-runtime/src/**'], patterns: ['node-agent'] },
    'apps/pi-runtime/src/model.ts',
    "import x from '../../node-agent/src/index.js';"
  );
  assert.equal(violations.length, 1);
});

test('config validation rejects catalog proofs for an unknown invariant', () => {
  const errors = validateGovernanceConfig(
    { schemaVersion: 1, features: [feature] },
    { schemaVersion: 1, entries: [{ id: 'bad', featureId: feature.id, status: 'ACTIVE', proofs: [{ invariantId: 'UNKNOWN', level: 'A' }] }] },
    { schemaVersion: 1, guards: [] }
  );
  assert.ok(errors.some((error) => error.includes('UNKNOWN')));
});
