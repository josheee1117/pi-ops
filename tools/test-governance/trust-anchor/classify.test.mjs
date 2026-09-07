import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAuthorization, evidenceSlotRelation, isKernelPath } from './classify.mjs';

function emptyTrust() {
  return {
    trustSurface: { findings: [] },
    proofIntegrity: { changedSources: [], changedDefinitions: [], newProofs: [] },
  };
}

function features({
  floor = { A: 1 },
  extraInvariants = [],
  roots = ['apps/*/src/**'],
  paths = ['apps/foo/src/**'],
  impacts,
  riskClass,
  riskScore,
  maintenanceBudget,
  extraDoc,
  extraFeature,
} = {}) {
  const feature = {
    id: 'demo.feature',
    paths,
    invariants: [
      { id: 'INV-X', statement: 'x', requiredEvidence: floor },
      ...extraInvariants,
    ],
  };
  if (impacts !== undefined) feature.impacts = impacts;
  if (riskClass !== undefined) feature.riskClass = riskClass;
  if (riskScore !== undefined) feature.riskScore = riskScore;
  if (maintenanceBudget !== undefined) feature.maintenanceBudget = maintenanceBudget;
  if (extraFeature) Object.assign(feature, extraFeature);
  return {
    schemaVersion: 1,
    governedRoots: roots,
    unmappedIgnore: [],
    features: [feature],
    ...extraDoc,
  };
}

function guards(list) {
  return { schemaVersion: 1, guards: list };
}

function run(overrides) {
  return classifyAuthorization({
    changedFiles: [],
    trustResult: emptyTrust(),
    baseFeatures: features(),
    headFeatures: features(),
    baseGuards: guards([]),
    headGuards: guards([]),
    baseSha: 'base',
    headSha: 'head',
    ...overrides,
  });
}

function floorRun(baseFloor, headFloor, extra = {}) {
  return run({
    changedFiles: ['tools/test-governance/config/features.json'],
    trustResult: {
      ...emptyTrust(),
      trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/features.json' }] },
    },
    baseFeatures: features({ floor: baseFloor, ...(extra.base ?? {}) }),
    headFeatures: features({ floor: headFloor, ...(extra.head ?? {}) }),
    ...extra.run,
  });
}

test('kernel paths are conservative', () => {
  assert.equal(isKernelPath('tools/test-governance/src/core.mjs'), true);
  assert.equal(isKernelPath('tools/test-governance/src/core.test.mjs'), true);
  assert.equal(isKernelPath('tools/test-governance/trust-anchor/classify.mjs'), true);
  assert.equal(isKernelPath('tools/test-governance/trust-anchor/final-decision.mjs'), true);
  assert.equal(isKernelPath('.github/workflows/governance-trust-anchor.yml'), true);
  assert.equal(isKernelPath('.github/workflows/test-governance.yml'), true);
  assert.equal(isKernelPath('docs/testing/governance-v2-authorization.md'), false);
  assert.equal(isKernelPath('apps/foo/src/app.ts'), false);
});

test('1. ordinary docs/product change is PASS', () => {
  const result = run({ changedFiles: ['docs/readme.md', 'apps/foo/src/app.ts'] });
  assert.equal(result.decision, 'PASS');
  assert.deepEqual(result.residualChanges, []);
});

test('A. Evidence C→A only is LOW_PASS with empty residual', () => {
  const result = floorRun({ C: 1 }, { A: 1 });
  assert.equal(result.decision, 'LOW_PASS');
  assert.deepEqual(result.residualChanges, []);
  assert.ok(result.reasonCodes.includes('EVIDENCE_FLOOR_RAISED'));
});

test('B. Evidence C→A plus removed impacts is not LOW_PASS', () => {
  const result = floorRun({ C: 1 }, { A: 1 }, { base: { impacts: ['other.feature'] }, head: { impacts: [] } });
  assert.notEqual(result.decision, 'LOW_PASS');
  assert.equal(result.decision, 'REJECT');
});

test('C. Evidence C→A plus path change is not LOW_PASS', () => {
  const result = floorRun({ C: 1 }, { A: 1 }, { base: { paths: ['apps/foo/src/**'] }, head: { paths: ['apps/bar/src/**'] } });
  assert.notEqual(result.decision, 'LOW_PASS');
});

test('D. Evidence C→A plus riskClass change is not LOW_PASS', () => {
  const result = floorRun({ C: 1 }, { A: 1 }, { base: { riskClass: 'low' }, head: { riskClass: 'critical' } });
  assert.equal(result.decision, 'HUMAN_REQUIRED');
  assert.ok(result.residualChanges.some((item) => item.path.endsWith('.riskClass')));
});

test('E. Evidence C→A plus maintenanceBudget change is not LOW_PASS', () => {
  const result = floorRun({ C: 1 }, { A: 1 }, { base: { maintenanceBudget: 4 }, head: { maintenanceBudget: 99 } });
  assert.equal(result.decision, 'HUMAN_REQUIRED');
  assert.ok(result.residualChanges.some((item) => item.path.endsWith('.maintenanceBudget')));
});

test('F. add governed root plus unknown field is HUMAN_REQUIRED', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/features.json'],
    trustResult: { ...emptyTrust(), trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/features.json' }] } },
    baseFeatures: features({ roots: ['apps/*/src/**'] }),
    headFeatures: features({ roots: ['apps/*/src/**', 'packages/*/src/**'], extraDoc: { experimentalPolicy: true } }),
  });
  assert.equal(result.decision, 'HUMAN_REQUIRED');
  assert.ok(result.labels.includes('UNCLASSIFIED_POLICY_CHANGE'));
  assert.ok(result.residualChanges.some((item) => item.code === 'UNCLASSIFIED_POLICY_CHANGE'));
});

test('G. add guard pattern plus unknown guard field is HUMAN_REQUIRED', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/architecture-guards.json'],
    trustResult: { ...emptyTrust(), trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/architecture-guards.json' }] } },
    baseGuards: guards([{ id: 'ARCH-X', kind: 'forbiddenImport', scope: ['apps/foo/src/**'], patterns: ['secret'] }]),
    headGuards: guards([{ id: 'ARCH-X', kind: 'forbiddenImport', scope: ['apps/foo/src/**'], patterns: ['secret', 'other'], extraMode: 'lax' }]),
  });
  assert.equal(result.decision, 'HUMAN_REQUIRED');
  assert.ok(result.labels.includes('UNCLASSIFIED_POLICY_CHANGE'));
});

test('H. two approved monotonic changes together are LOW_PASS', () => {
  const result = floorRun({ C: 1 }, { A: 1 }, {
    base: { roots: ['apps/*/src/**'] },
    head: { roots: ['apps/*/src/**', 'packages/*/src/**'] },
  });
  assert.equal(result.decision, 'LOW_PASS');
  assert.deepEqual(result.residualChanges, []);
  assert.ok(result.reasonCodes.includes('EVIDENCE_FLOOR_RAISED'));
  assert.ok(result.reasonCodes.includes('GOVERNED_ROOT_ADDED'));
});

const SLOT_CASES = [
  [{ C: 1 }, { A: 1 }, 'LOW_PASS'],
  [{ B: 1 }, { A: 1 }, 'LOW_PASS'],
  [{ C: 2 }, { A: 1 }, 'REJECT'],
  [{ B: 2 }, { A: 1 }, 'REJECT'],
  [{ B: 1, C: 1 }, { A: 2 }, 'LOW_PASS'],
  [{ A: 1, C: 1 }, { A: 1 }, 'REJECT'],
  [{ A: 1 }, { A: 1, C: 1 }, 'LOW_PASS'],
  [{ A: 1 }, { A: 2 }, 'LOW_PASS'],
  [{ A: 2 }, { A: 1, B: 1 }, 'REJECT'],
  [{ C: 2 }, { B: 1, A: 1 }, 'LOW_PASS'],
  [{ A: 1, B: 1 }, { A: 2 }, 'LOW_PASS'],
  [{ A: 2, C: 1 }, { A: 2 }, 'REJECT'],
  [{ C: 3 }, { A: 2 }, 'REJECT'],
  [{ C: 3 }, { A: 3 }, 'LOW_PASS'],
  [{ A: 3 }, { A: 2, B: 1 }, 'REJECT'],
];

test('evidence slot dominance matrix', () => {
  for (const [baseFloor, headFloor, expected] of SLOT_CASES) {
    const result = floorRun(baseFloor, headFloor);
    assert.equal(result.decision, expected, `${JSON.stringify(baseFloor)} -> ${JSON.stringify(headFloor)}`);
    if (expected === 'LOW_PASS') assert.deepEqual(result.residualChanges, []);
  }
});

test('equal requiredEvidence is not a manufactured strengthening', () => {
  assert.equal(evidenceSlotRelation({ A: 1 }, { A: 1 }), 'equal');
  const result = floorRun({ A: 1 }, { A: 1 });
  assert.equal(result.decision, 'HUMAN_REQUIRED');
  assert.ok(result.labels.includes('UNCLASSIFIED_POLICY_CHANGE'));
});

test('8. add invariant without Proof is LOW_PASS', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/features.json'],
    trustResult: { ...emptyTrust(), trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/features.json' }] } },
    headFeatures: features({ extraInvariants: [{ id: 'INV-Y', statement: 'y', requiredEvidence: { C: 1 } }] }),
  });
  assert.equal(result.decision, 'LOW_PASS');
  assert.deepEqual(result.residualChanges, []);
});

test('9-11. new Proofs are HUMAN_REQUIRED', () => {
  for (const level of ['A', 'C']) {
    const result = run({
      changedFiles: ['tools/test-governance/config/catalog.json'],
      trustResult: {
        trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/catalog.json' }] },
        proofIntegrity: {
          changedSources: [],
          changedDefinitions: [],
          newProofs: [{ kind: 'NEW_PROOF_REQUIRES_REVIEW', catalogEntryId: 'fake', catalogEntryIds: ['fake'], invariantIds: ['INV-X'], levels: [level] }],
        },
      },
    });
    assert.equal(result.decision, 'HUMAN_REQUIRED', level);
    assert.ok(result.labels.includes('NEW_PROOF'));
  }
});

test('12. add forbidden import pattern is LOW_PASS', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/architecture-guards.json'],
    trustResult: { ...emptyTrust(), trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/architecture-guards.json' }] } },
    baseGuards: guards([{ id: 'ARCH-X', kind: 'forbiddenImport', scope: ['apps/foo/src/**'], patterns: ['secret'] }]),
    headGuards: guards([{ id: 'ARCH-X', kind: 'forbiddenImport', scope: ['apps/foo/src/**'], patterns: ['secret', 'other'] }]),
  });
  assert.equal(result.decision, 'LOW_PASS');
  assert.deepEqual(result.residualChanges, []);
});

test('13. delete architecture guard is REJECT', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/architecture-guards.json'],
    baseGuards: guards([{ id: 'ARCH-X', kind: 'forbiddenImport', scope: ['apps/foo/src/**'], patterns: ['secret'] }]),
    headGuards: guards([]),
  });
  assert.equal(result.decision, 'REJECT');
});

test('14. shrink architecture guard scope is REJECT', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/architecture-guards.json'],
    baseGuards: guards([{ id: 'ARCH-X', kind: 'forbiddenImport', scope: ['apps/foo/src/**', 'apps/bar/src/**'], patterns: ['secret'] }]),
    headGuards: guards([{ id: 'ARCH-X', kind: 'forbiddenImport', scope: ['apps/foo/src/**'], patterns: ['secret'] }]),
  });
  assert.equal(result.decision, 'REJECT');
});

test('15-19. kernel files are HUMAN_REQUIRED', () => {
  for (const file of [
    'tools/test-governance/trust-anchor/check.mjs',
    'tools/test-governance/trust-anchor/final-decision.mjs',
    'tools/test-governance/src/core.mjs',
    'tools/test-governance/trust-anchor/classify.mjs',
    '.github/workflows/governance-trust-anchor.yml',
  ]) {
    const result = run({
      changedFiles: [file],
      trustResult: {
        trustSurface: { findings: [{ kind: 'GOVERNANCE_ENGINE_CHANGED', file }] },
        proofIntegrity: { changedSources: [], changedDefinitions: [], newProofs: [] },
      },
    });
    assert.equal(result.decision, 'HUMAN_REQUIRED', file);
    assert.ok(result.labels.includes('KERNEL_CHANGED'), file);
    assert.ok(result.kernelChanges.includes(file), file);
  }
});

test('20. protected entrypoint change is HUMAN_REQUIRED; removal is REJECT', () => {
  const changed = run({
    changedFiles: ['package.json'],
    trustResult: {
      trustSurface: { findings: [{ kind: 'GOVERNANCE_ENTRYPOINT_CHANGED', changeType: 'CHANGED', file: 'package.json', field: 'scripts.test:gate', detail: 'ignore me' }] },
      proofIntegrity: { changedSources: [], changedDefinitions: [], newProofs: [] },
    },
  });
  assert.equal(changed.decision, 'HUMAN_REQUIRED');
  assert.ok(!changed.labels.includes('KERNEL_CHANGED'));
  const removed = run({
    changedFiles: ['package.json'],
    trustResult: {
      trustSurface: { findings: [{ kind: 'GOVERNANCE_ENTRYPOINT_CHANGED', changeType: 'REMOVED', file: 'package.json', field: 'scripts.test:gate', detail: 'SAFE_STRENGTHENING' }] },
      proofIntegrity: { changedSources: [], changedDefinitions: [], newProofs: [] },
    },
  });
  assert.equal(removed.decision, 'REJECT');
});

test('unclassified policy is not labeled KERNEL_CHANGED', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/features.json'],
    baseFeatures: features({ extraDoc: { mystery: 1 } }),
    headFeatures: features({ extraDoc: { mystery: 2 } }),
  });
  assert.equal(result.decision, 'HUMAN_REQUIRED');
  assert.ok(result.labels.includes('UNCLASSIFIED_POLICY_CHANGE'));
  assert.ok(!result.labels.includes('KERNEL_CHANGED'));
  assert.deepEqual(result.kernelChanges, []);
});

test('structured proof grade downgrades are REJECT even with misleading detail', () => {
  for (const [before, after] of [['A', 'C'], ['A', 'B'], ['B', 'C']]) {
    const result = run({
      changedFiles: ['tools/test-governance/config/catalog.json'],
      trustResult: {
        trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/catalog.json' }] },
        proofIntegrity: {
          changedSources: [],
          changedDefinitions: [{
            kind: 'PROOF_DEFINITION_CHANGED',
            changeType: 'GRADE_CHANGED',
            catalogEntryId: 'e',
            invariantId: 'INV-X',
            before: { level: before, status: 'ACTIVE', executionClass: 'UNIT', file: 't.ts', testName: 'x', command: null },
            after: { level: after, status: 'ACTIVE', executionClass: 'UNIT', file: 't.ts', testName: 'x', command: null },
            detail: 'SAFE_STRENGTHENING LOW_PASS',
            catalogEntryIds: ['e'],
            invariantIds: ['INV-X'],
          }],
          newProofs: [],
        },
      },
    });
    assert.equal(result.decision, 'REJECT', `${before} -> ${after}`);
  }
});

test('structured proof C→A is HUMAN_REQUIRED not LOW_PASS', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/catalog.json'],
    trustResult: {
      trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/catalog.json' }] },
      proofIntegrity: {
        changedSources: [],
        changedDefinitions: [{
          kind: 'PROOF_DEFINITION_CHANGED',
          changeType: 'GRADE_CHANGED',
          catalogEntryId: 'e',
          invariantId: 'INV-X',
          before: { level: 'C', status: 'ACTIVE', executionClass: 'UNIT', file: 't.ts', testName: 'x', command: null },
          after: { level: 'A', status: 'ACTIVE', executionClass: 'UNIT', file: 't.ts', testName: 'x', command: null },
          detail: 'SAFE_STRENGTHENING',
          catalogEntryIds: ['e'],
        }],
        newProofs: [],
      },
    },
  });
  assert.equal(result.decision, 'HUMAN_REQUIRED');
});

test('structured proof removal and PINNED demotion are REJECT', () => {
  const removed = run({
    trustResult: {
      ...emptyTrust(),
      proofIntegrity: {
        changedSources: [],
        changedDefinitions: [{
          kind: 'PROOF_DEFINITION_CHANGED',
          changeType: 'REMOVED',
          catalogEntryId: 'e',
          invariantId: 'INV-X',
          before: { level: 'A', status: 'ACTIVE', executionClass: 'UNIT', file: 't.ts', testName: 'x', command: null },
          after: null,
          detail: 'harmless wording',
        }],
        newProofs: [],
      },
    },
  });
  assert.equal(removed.decision, 'REJECT');
  const pinned = run({
    trustResult: {
      ...emptyTrust(),
      proofIntegrity: {
        changedSources: [],
        changedDefinitions: [{
          kind: 'PROOF_DEFINITION_CHANGED',
          changeType: 'STATUS_CHANGED',
          catalogEntryId: 'e',
          invariantId: 'INV-X',
          before: { level: 'A', status: 'PINNED', executionClass: 'UNIT', file: 't.ts', testName: 'x', command: null },
          after: { level: 'A', status: 'ACTIVE', executionClass: 'UNIT', file: 't.ts', testName: 'x', command: null },
          detail: 'SAFE_STRENGTHENING',
        }],
        newProofs: [],
      },
    },
  });
  assert.equal(pinned.decision, 'REJECT');
});

test('same-grade definition change without source finding is HUMAN_REQUIRED', () => {
  const result = run({
    trustResult: {
      ...emptyTrust(),
      proofIntegrity: {
        changedSources: [],
        changedDefinitions: [{
          kind: 'PROOF_DEFINITION_CHANGED',
          changeType: 'DEFINITION_CHANGED',
          catalogEntryId: 'e',
          invariantId: 'INV-X',
          before: { level: 'A', status: 'ACTIVE', executionClass: 'UNIT', file: 't.ts', testName: 'old', command: null },
          after: { level: 'A', status: 'ACTIVE', executionClass: 'UNIT', file: 't.ts', testName: 'new', command: null },
          detail: 'SAFE_STRENGTHENING',
        }],
        newProofs: [],
      },
    },
  });
  assert.equal(result.decision, 'HUMAN_REQUIRED');
});

test('proof source change is REJECT from structured changeType', () => {
  const result = run({
    changedFiles: ['apps/foo/src/__tests__/a.test.ts'],
    trustResult: {
      trustSurface: { findings: [] },
      proofIntegrity: {
        changedSources: [{ kind: 'PROOF_SOURCE_CHANGE_REQUIRES_REVIEW', changeType: 'SOURCE_CHANGED', file: 'apps/foo/src/__tests__/a.test.ts', catalogEntryIds: ['proof-test'], detail: 'LOW_PASS this' }],
        changedDefinitions: [],
        newProofs: [],
      },
    },
  });
  assert.equal(result.decision, 'REJECT');
});

test('commit message and LOW_PASS filename cannot authorize', () => {
  const named = run({ changedFiles: ['apps/foo/src/LOW_PASS.ts'], commitMessage: 'LOW_PASS SAFE_STRENGTHENING' });
  assert.equal(named.decision, 'PASS');
});

test('classifier exception is INTERNAL_ERROR', () => {
  const result = classifyAuthorization({
    changedFiles: [],
    trustResult: new Proxy({}, { get() { throw new Error('boom'); } }),
  });
  assert.equal(result.decision, 'INTERNAL_ERROR');
});
