import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFeaturePlan,
  collectMachineGaps,
  evaluateGuardFile,
  evaluateMaintenanceBudget,
  extractTestNames,
  findUnmappedProductionFiles,
  matchesPath,
  resolveAffectedFeatures,
  resolvePlanStatus,
  validateCatalogArtifacts,
  validateGovernanceConfig,
  validateKnownCommand,
} from './core.mjs';

const feature = {
  id: 'investigation.reconciliation',
  riskClass: 'critical',
  riskScore: 12,
  maintenanceBudget: 12,
  paths: ['apps/agent/src/investigation-reconciler.ts', 'apps/agent/src/store.ts'],
  invariants: [{ id: 'INV-GEN-01', statement: 'dynamic evidence does not start another generation', requiredEvidence: { A: 1, C: 1 } }],
};

const featureDoc = {
  schemaVersion: 1,
  governedRoots: ['apps/*/src/**', 'packages/*/src/**'],
  unmappedIgnore: ['**/*.test.ts', '**/__tests__/**', 'docs/**', 'tools/**'],
  features: [feature],
};

const emptyCatalog = { schemaVersion: 1, entries: [] };
const emptyGuards = { schemaVersion: 1, guards: [] };

test('matches exact and recursive governance paths', () => {
  assert.equal(matchesPath('apps/pi-runtime/src/model.ts', 'apps/pi-runtime/src/**'), true);
  assert.equal(matchesPath('apps/pi-runtime/test/model.ts', 'apps/pi-runtime/src/**'), false);
  assert.equal(matchesPath('apps/agent/src/store.ts', 'apps/agent/src/store.ts'), true);
});

test('matches single-star governed roots like apps/*/src/**', () => {
  assert.equal(matchesPath('apps/agent/src/new-service.ts', 'apps/*/src/**'), true);
  assert.equal(matchesPath('apps/agent/test/new-service.ts', 'apps/*/src/**'), false);
  assert.equal(matchesPath('packages/protocol/src/index.ts', 'packages/*/src/**'), true);
});

test('resolves governed features from changed files', () => {
  const result = resolveAffectedFeatures(['README.md', 'apps/agent/src/investigation-reconciler.ts'], [feature]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].matchedFiles, ['apps/agent/src/investigation-reconciler.ts']);
  assert.equal(result[0].reason, 'DIRECT');
});

// ── Blocker 2: unmapped production changes ────────────────────────────────────

test('unmapped production file is detected under governed roots', () => {
  const unmapped = findUnmappedProductionFiles(
    ['apps/agent/src/new-dangerous-service.ts'],
    [feature],
    { governedRoots: featureDoc.governedRoots, unmappedIgnore: featureDoc.unmappedIgnore },
  );
  assert.deepEqual(unmapped, ['apps/agent/src/new-dangerous-service.ts']);
});

test('mapped production file is not unmapped', () => {
  const unmapped = findUnmappedProductionFiles(
    ['apps/agent/src/investigation-reconciler.ts'],
    [feature],
    { governedRoots: featureDoc.governedRoots, unmappedIgnore: featureDoc.unmappedIgnore },
  );
  assert.deepEqual(unmapped, []);
});

test('test files, docs, and governance tool files do not create unmapped failures', () => {
  const unmapped = findUnmappedProductionFiles(
    [
      'apps/agent/src/__tests__/whatever.test.ts',
      'docs/testing/test-strategy.md',
      'tools/test-governance/src/core.mjs',
      'README.md',
    ],
    [feature],
    { governedRoots: featureDoc.governedRoots, unmappedIgnore: featureDoc.unmappedIgnore },
  );
  assert.deepEqual(unmapped, []);
});

test('unmapped production change forces UNMAPPED_PRODUCTION_CHANGE status', () => {
  assert.equal(
    resolvePlanStatus({ architectureViolations: [], unmappedProductionFiles: ['apps/agent/src/x.ts'], hasGaps: false, budgetExceeded: false }),
    'UNMAPPED_PRODUCTION_CHANGE',
  );
});

test('config validation rejects missing governedRoots', () => {
  const errors = validateGovernanceConfig({ schemaVersion: 1, features: [feature] }, emptyCatalog, emptyGuards);
  assert.ok(errors.some((error) => error.includes('governedRoots')));
});

// ── Blocker 3: feature impact propagation ───────────────────────────────────

test('impacted features are included when a shared contract feature changes', () => {
  const protocol = {
    id: 'protocol.contract',
    riskClass: 'high',
    riskScore: 9,
    maintenanceBudget: 6,
    paths: ['packages/protocol/src/**'],
    impacts: ['event.ingress', 'evidence.collection'],
    invariants: [{ id: 'INV-PRO-01', statement: 'schema', requiredEvidence: { C: 1 } }],
  };
  const ingress = {
    id: 'event.ingress',
    riskClass: 'high',
    riskScore: 11,
    maintenanceBudget: 10,
    paths: ['apps/agent/src/app.ts'],
    invariants: [{ id: 'INV-ING-01', statement: 'token', requiredEvidence: { C: 1 } }],
  };
  const result = resolveAffectedFeatures(['packages/protocol/src/index.ts'], [protocol, ingress]);
  assert.equal(result.length, 2);
  assert.equal(result[0].feature.id, 'protocol.contract');
  assert.equal(result[0].reason, 'DIRECT');
  assert.equal(result[1].feature.id, 'event.ingress');
  assert.equal(result[1].reason, 'IMPACTED_BY protocol.contract');
});

test('impact cycles terminate and deduplicate deterministically', () => {
  const a = {
    id: 'a', riskClass: 'low', riskScore: 1, maintenanceBudget: 1,
    paths: ['apps/agent/src/a.ts'], impacts: ['b'],
    invariants: [{ id: 'INV-A', statement: 'a', requiredEvidence: { C: 1 } }],
  };
  const b = {
    id: 'b', riskClass: 'low', riskScore: 1, maintenanceBudget: 1,
    paths: ['apps/agent/src/b.ts'], impacts: ['a'],
    invariants: [{ id: 'INV-B', statement: 'b', requiredEvidence: { C: 1 } }],
  };
  const result = resolveAffectedFeatures(['apps/agent/src/a.ts'], [a, b]);
  assert.equal(result.length, 2);
  assert.equal(result[0].feature.id, 'a');
  assert.equal(result[1].reason, 'IMPACTED_BY a');
});

test('multiple impact parents merge into one deterministic reason', () => {
  const mk = (id, paths, impacts) => ({
    id, riskClass: 'low', riskScore: 1, maintenanceBudget: 1, paths, impacts: impacts ?? [],
    invariants: [{ id: `INV-${id.toUpperCase()}`, statement: id, requiredEvidence: { C: 1 } }],
  });
  const protocol = mk('protocol.contract', ['packages/protocol/src/**'], ['runtime.boundary']);
  const modelSafe = mk('evidence.model-safe-projection', ['apps/agent/src/incident-context.ts'], ['runtime.boundary']);
  const boundary = mk('runtime.boundary', ['apps/pi-runtime/src/**']);
  const result = resolveAffectedFeatures(
    ['packages/protocol/src/index.ts', 'apps/agent/src/incident-context.ts'],
    [protocol, modelSafe, boundary],
  );
  const boundaryItem = result.find((item) => item.feature.id === 'runtime.boundary');
  assert.ok(boundaryItem);
  assert.equal(
    boundaryItem.reason,
    'IMPACTED_BY evidence.model-safe-projection,protocol.contract',
  );
  assert.equal(result.filter((item) => item.feature.id === 'runtime.boundary').length, 1);
});

test('DIRECT takes precedence over merged impact reasons', () => {
  const mk = (id, paths, impacts) => ({
    id, riskClass: 'low', riskScore: 1, maintenanceBudget: 1, paths, impacts: impacts ?? [],
    invariants: [{ id: `INV-${id.toUpperCase()}`, statement: id, requiredEvidence: { C: 1 } }],
  });
  const protocol = mk('protocol.contract', ['packages/protocol/src/**'], ['runtime.boundary']);
  const boundary = mk('runtime.boundary', ['apps/pi-runtime/src/**']);
  const result = resolveAffectedFeatures(
    ['packages/protocol/src/index.ts', 'apps/pi-runtime/src/model.ts'],
    [protocol, boundary],
  );
  const boundaryItem = result.find((item) => item.feature.id === 'runtime.boundary');
  assert.equal(boundaryItem.reason, 'DIRECT');
  assert.deepEqual(boundaryItem.matchedFiles, ['apps/pi-runtime/src/model.ts']);
});

test('smoke test files map directly to local.integration', () => {
  const localIntegration = {
    id: 'local.integration',
    riskClass: 'high',
    riskScore: 11,
    maintenanceBudget: 10,
    paths: ['apps/agent/src/smoke/**', 'deploy/local/**'],
    invariants: [{ id: 'INV-LOCINT-01', statement: 'smoke chain', requiredEvidence: { A: 1 } }],
  };
  const result = resolveAffectedFeatures(['apps/agent/src/smoke/pi-reasoner.smoke.ts'], [localIntegration]);
  assert.equal(result.length, 1);
  assert.equal(result[0].feature.id, 'local.integration');
  assert.equal(result[0].reason, 'DIRECT');
});

test('config validation rejects invalid impact feature ids', () => {
  const doc = {
    schemaVersion: 1,
    governedRoots: ['apps/**'],
    features: [{ ...feature, impacts: ['no.such.feature'] }],
  };
  const errors = validateGovernanceConfig(doc, emptyCatalog, emptyGuards);
  assert.ok(errors.some((error) => error.includes('invalid impact Feature no.such.feature')));
});

// ── Blocker 4: ghost tests and command validation ──────────────────────────

test('extractTestNames finds declared test names but not comments or describe blocks', () => {
  const source = [
    "describe('suite', () => {",
    "  it('real test', () => {});",
    "  // it('commented out', () => {});",
    "  test('mjs test', () => {});",
    "});",
  ].join('\n');
  assert.deepEqual(extractTestNames(source), ['real test', 'mjs test']);
});

test('block-commented test declarations are ghosts', () => {
  const source = [
    "/*",
    "it('block ghost', () => {});",
    "*/",
    "it('real one', () => {});",
  ].join('\n');
  assert.deepEqual(extractTestNames(source), ['real one']);
});

test('test-like strings and templates are ghosts', () => {
  const source = [
    'const x = "it(\'string ghost\', () => {})";',
    'const y = `test(\'template ghost\', () => {})`;',
    "const z = 'test(\'quoted ghost\', 1)';",
    'it("double quoted real", () => {});',
  ].join('\n');
  assert.deepEqual(extractTestNames(source), ['double quoted real']);
});

test('property and word-suffixed it( calls are not test declarations', () => {
  const source = [
    "obj.it('property call', 1);",
    "submit('suffixed submit', 1);",
    "it('real', 1);",
  ].join('\n');
  assert.deepEqual(extractTestNames(source), ['real']);
});

test('catalog validation fails on a ghost testName', () => {
  const catalog = {
    schemaVersion: 1,
    entries: [{
      id: 'ghost',
      featureId: feature.id,
      status: 'ACTIVE',
      location: { file: 'apps/agent/src/__tests__/real.test.ts', testName: 'deleted test name' },
      proofs: [{ invariantId: 'INV-GEN-01', level: 'C' }],
    }],
  };
  const options = {
    fileExists: () => true,
    readFile: () => "it('real test', () => {});",
  };
  const errors = validateCatalogArtifacts(catalog, options);
  assert.ok(errors.some((error) => error.includes('CATALOG_GHOST_TEST')));
});

test('catalog validation fails when a selected test name is ambiguous', () => {
  const catalog = {
    schemaVersion: 1,
    entries: [{
      id: 'ambiguous',
      featureId: feature.id,
      status: 'ACTIVE',
      location: { file: 'apps/agent/src/__tests__/real.test.ts', testName: 'same name' },
      proofs: [{ invariantId: 'INV-GEN-01', level: 'C' }],
    }],
  };
  const errors = validateCatalogArtifacts(catalog, {
    fileExists: () => true,
    readFile: () => "it('same name', () => {});\ntest('same name', () => {});",
  });
  assert.ok(errors.some((error) => error.includes('CATALOG_AMBIGUOUS_TEST')));
});

test('catalog validation fails on missing location file', () => {
  const catalog = {
    schemaVersion: 1,
    entries: [{
      id: 'gone',
      featureId: feature.id,
      status: 'ACTIVE',
      location: { file: 'apps/agent/src/__tests__/missing.test.ts' },
      proofs: [],
    }],
  };
  const errors = validateCatalogArtifacts(catalog, { fileExists: () => false, readFile: () => '' });
  assert.ok(errors.some((error) => error.includes('does not exist')));
});

test('known pnpm command validates against package scripts', () => {
  const scripts = { 'smoke:local': 'bash x.sh' };
  const options = { packageScripts: scripts, declaredFile: 'x.sh', fileExists: () => true };
  assert.equal(validateKnownCommand('pnpm smoke:local', options), null);
  assert.match(validateKnownCommand('pnpm smoke:nope', options), /missing package script/);
});

test('pnpm command must reference its declared evidence artifact', () => {
  const scripts = { 'smoke:local': 'bash deploy/local/smoke.sh' };
  assert.equal(
    validateKnownCommand('pnpm smoke:local', { packageScripts: scripts, declaredFile: 'deploy/local/smoke.sh' }),
    null,
  );
  assert.match(
    validateKnownCommand('pnpm smoke:local', { packageScripts: { 'smoke:local': 'echo OK' }, declaredFile: 'deploy/local/smoke.sh' }),
    /CATALOG_COMMAND_TARGET_MISMATCH/,
  );
});

test('pnpm run form is accepted and still bound', () => {
  const scripts = { 'smoke:local': 'bash deploy/local/smoke.sh' };
  assert.equal(validateKnownCommand('pnpm run smoke:local', { packageScripts: scripts, declaredFile: 'deploy/local/smoke.sh' }), null);
  assert.match(
    validateKnownCommand('pnpm run smoke:local', { packageScripts: scripts, declaredFile: 'other.sh' }),
    /CATALOG_COMMAND_TARGET_MISMATCH/,
  );
});

test('bash command target must match the declared artifact', () => {
  assert.equal(
    validateKnownCommand('bash deploy/local/smoke.sh', { fileExists: () => true, declaredFile: 'deploy/local/smoke.sh' }),
    null,
  );
  assert.match(
    validateKnownCommand('bash other.sh', { fileExists: () => true, declaredFile: 'deploy/local/smoke.sh' }),
    /CATALOG_COMMAND_TARGET_MISMATCH/,
  );
});

test('bash command validates against the file system', () => {
  assert.equal(validateKnownCommand('bash deploy/local/smoke.sh', { fileExists: () => true }), null);
  assert.match(validateKnownCommand('bash deploy/local/nope.sh', { fileExists: () => false }), /command file missing/);
});

test('unknown command forms are rejected as UNVERIFIED_COMMAND', () => {
  assert.match(validateKnownCommand('make it rain'), /UNVERIFIED_COMMAND/);
});

// ── Blocker 5: maintenance budget ───────────────────────────────────────────

test('reuse of existing tests costs zero and stays within budget', () => {
  const budget = evaluateMaintenanceBudget({ budget: 5, actions: Array.from({ length: 10 }, () => ({ type: 'REUSE' })) });
  assert.equal(budget.plannedMaintenanceDelta, 0);
  assert.equal(budget.budgetStatus, 'WITHIN_BUDGET');
  assert.equal(budget.remainingBudget, 5);
});

test('create beyond budget is reported as BUDGET_EXCEEDED', () => {
  const budget = evaluateMaintenanceBudget({ budget: 5, actions: [{ type: 'CREATE', cost: 6 }] });
  assert.equal(budget.budgetStatus, 'BUDGET_EXCEEDED');
  assert.equal(budget.remainingBudget, -1);
});

test('budget evaluation never changes evidence floors', () => {
  const plan = buildFeaturePlan(feature, [
    { id: 'c-only', featureId: feature.id, status: 'ACTIVE', maintenanceCost: 1, proofs: [{ invariantId: 'INV-GEN-01', level: 'C' }] },
  ]);
  assert.deepEqual(plan.gaps, [{ invariantId: 'INV-GEN-01', level: 'A', missing: 1 }]);
  assert.equal(plan.status, 'NEEDS_EVIDENCE');
});

test('planner reports budget fields without lowering evidence floors', () => {
  const plan = buildFeaturePlan(feature, [
    { id: 'a-proof', featureId: feature.id, status: 'ACTIVE', maintenanceCost: 1, proofs: [{ invariantId: 'INV-GEN-01', level: 'A' }] },
    { id: 'c-proof', featureId: feature.id, status: 'ACTIVE', maintenanceCost: 1, proofs: [{ invariantId: 'INV-GEN-01', level: 'C' }] },
  ]);
  assert.equal(plan.status, 'CATALOG_COVERED');
  assert.equal(plan.maintenanceBudget, 12);
  assert.equal(plan.plannedMaintenanceDelta, 0);
  assert.equal(plan.budgetStatus, 'WITHIN_BUDGET');
});

test('plan status precedence is deterministic', () => {
  assert.equal(resolvePlanStatus({ architectureViolations: [{}], unmappedProductionFiles: ['x'], hasGaps: true, budgetExceeded: true }), 'ARCHITECTURE_VIOLATION');
  assert.equal(resolvePlanStatus({ architectureViolations: [], unmappedProductionFiles: ['x'], hasGaps: true, budgetExceeded: true }), 'UNMAPPED_PRODUCTION_CHANGE');
  assert.equal(resolvePlanStatus({ architectureViolations: [], unmappedProductionFiles: [], hasGaps: true, budgetExceeded: true }), 'NEEDS_EVIDENCE');
  assert.equal(resolvePlanStatus({ architectureViolations: [], unmappedProductionFiles: [], hasGaps: false, budgetExceeded: true }), 'BUDGET_EXCEEDED');
  assert.equal(resolvePlanStatus({ architectureViolations: [], unmappedProductionFiles: [], hasGaps: false, budgetExceeded: false }), 'READY');
});

// ── machine gap collection ──────────────────────────────────────────────────

test('collectMachineGaps reports every missing evidence slot across features', () => {
  const gaps = collectMachineGaps([feature], [
    { id: 'c-only', featureId: feature.id, status: 'ACTIVE', maintenanceCost: 1, proofs: [{ invariantId: 'INV-GEN-01', level: 'C' }] },
  ]);
  assert.deepEqual(gaps, [{ featureId: 'investigation.reconciliation', invariantId: 'INV-GEN-01', level: 'A', missing: 1 }]);
});

// ── legacy planner behavior ─────────────────────────────────────────────────

test('planner reuses the smallest catalog set that closes evidence slots', () => {
  const plan = buildFeaturePlan(feature, [
    { id: 'unit-dynamic', featureId: feature.id, status: 'PINNED', maintenanceCost: 1, proofs: [{ invariantId: 'INV-GEN-01', level: 'C' }] },
    { id: 'smoke-dynamic', featureId: feature.id, status: 'ACTIVE', maintenanceCost: 4, proofs: [{ invariantId: 'INV-GEN-01', level: 'A' }] },
    { id: 'redundant-c', featureId: feature.id, status: 'ACTIVE', maintenanceCost: 5, proofs: [{ invariantId: 'INV-GEN-01', level: 'C' }] },
  ]);
  assert.equal(plan.status, 'CATALOG_COVERED');
  assert.deepEqual(plan.selected.map((entry) => entry.id).sort(), ['smoke-dynamic', 'unit-dynamic']);
  assert.equal(plan.gaps.length, 0);
});

test('planner reports evidence gaps instead of silently lowering the floor', () => {
  const plan = buildFeaturePlan(feature, [
    { id: 'unit-only', featureId: feature.id, status: 'ACTIVE', maintenanceCost: 1, proofs: [{ invariantId: 'INV-GEN-01', level: 'C' }] },
  ]);
  assert.equal(plan.status, 'NEEDS_EVIDENCE');
  assert.deepEqual(plan.gaps, [{ invariantId: 'INV-GEN-01', level: 'A', missing: 1 }]);
});

test('architecture guard detects forbidden runtime imports', () => {
  const violations = evaluateGuardFile(
    { id: 'ARCH-RUNTIME-NODE', kind: 'forbiddenImport', scope: ['apps/pi-runtime/src/**'], patterns: ['node-agent'] },
    'apps/pi-runtime/src/model.ts',
    "import x from '../../node-agent/src/index.js';",
  );
  assert.equal(violations.length, 1);
});

test('config validation rejects unknown catalog executionClass', () => {
  const errors = validateGovernanceConfig(
    featureDoc,
    { schemaVersion: 1, entries: [{ id: 'bad-class', featureId: feature.id, status: 'ACTIVE', executionClass: 'E2E', proofs: [{ invariantId: 'INV-GEN-01', level: 'C' }] }] },
    emptyGuards,
  );
  assert.ok(errors.some((error) => error.includes('executionClass')));
});

test('config validation rejects catalog proofs for an unknown invariant', () => {
  const errors = validateGovernanceConfig(
    featureDoc,
    { schemaVersion: 1, entries: [{ id: 'bad', featureId: feature.id, status: 'ACTIVE', proofs: [{ invariantId: 'UNKNOWN', level: 'A' }] }] },
    emptyGuards,
  );
  assert.ok(errors.some((error) => error.includes('UNKNOWN')));
});
