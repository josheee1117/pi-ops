import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAuthorization, isKernelPath } from './classify.mjs';

function emptyTrust() {
  return {
    trustSurface: { findings: [] },
    proofIntegrity: { changedSources: [], changedDefinitions: [], newProofs: [] },
  };
}

function features({ floor = { A: 1 }, extraInvariants = [], roots = ['apps/*/src/**'] } = {}) {
  return {
    schemaVersion: 1,
    governedRoots: roots,
    unmappedIgnore: [],
    features: [
      {
        id: 'demo.feature',
        paths: ['apps/foo/src/**'],
        invariants: [
          { id: 'INV-X', statement: 'x', requiredEvidence: floor },
          ...extraInvariants,
        ],
      },
    ],
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

test('kernel paths are conservative', () => {
  assert.equal(isKernelPath('tools/test-governance/src/core.mjs'), true);
  assert.equal(isKernelPath('tools/test-governance/src/core.test.mjs'), true);
  assert.equal(isKernelPath('tools/test-governance/trust-anchor/classify.mjs'), true);
  assert.equal(isKernelPath('.github/workflows/governance-trust-anchor.yml'), true);
  assert.equal(isKernelPath('.github/workflows/test-governance.yml'), true);
  assert.equal(isKernelPath('docs/testing/governance-v2-authorization.md'), false);
  assert.equal(isKernelPath('apps/foo/src/app.ts'), false);
});

test('1. ordinary docs/product change is PASS', () => {
  const result = run({ changedFiles: ['docs/readme.md', 'apps/foo/src/app.ts'] });
  assert.equal(result.decision, 'PASS');
  assert.equal(result.risk, 'NONE');
});

test('2. Evidence floor C → A is LOW_PASS', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/features.json'],
    trustResult: { ...emptyTrust(), trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/features.json' }] } },
    baseFeatures: features({ floor: { C: 1 } }),
    headFeatures: features({ floor: { A: 1 } }),
  });
  assert.equal(result.decision, 'LOW_PASS');
  assert.ok(result.reasonCodes.includes('EVIDENCE_FLOOR_RAISED'));
});

test('3. Evidence floor B → A is LOW_PASS', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/features.json'],
    trustResult: { ...emptyTrust(), trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/features.json' }] } },
    baseFeatures: features({ floor: { B: 1 } }),
    headFeatures: features({ floor: { A: 1 } }),
  });
  assert.equal(result.decision, 'LOW_PASS');
});

test('4. Evidence floor A → C is REJECT', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/features.json'],
    trustResult: { ...emptyTrust(), trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/features.json' }] } },
    baseFeatures: features({ floor: { A: 1 } }),
    headFeatures: features({ floor: { C: 1 } }),
  });
  assert.equal(result.decision, 'REJECT');
  assert.ok(result.reasonCodes.includes('EVIDENCE_FLOOR_LOWERED'));
});

test('5. Evidence floor A → B is REJECT', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/features.json'],
    trustResult: { ...emptyTrust(), trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/features.json' }] } },
    baseFeatures: features({ floor: { A: 1 } }),
    headFeatures: features({ floor: { B: 1 } }),
  });
  assert.equal(result.decision, 'REJECT');
});

test('6. broaden governed root is LOW_PASS', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/features.json'],
    trustResult: { ...emptyTrust(), trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/features.json' }] } },
    baseFeatures: features({ roots: ['apps/*/src/**'] }),
    headFeatures: features({ roots: ['apps/*/src/**', 'packages/*/src/**'] }),
  });
  assert.equal(result.decision, 'LOW_PASS');
  assert.ok(result.reasonCodes.includes('GOVERNED_ROOT_ADDED'));
});

test('7. remove governed root is REJECT', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/features.json'],
    trustResult: { ...emptyTrust(), trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/features.json' }] } },
    baseFeatures: features({ roots: ['apps/*/src/**', 'packages/*/src/**'] }),
    headFeatures: features({ roots: ['apps/*/src/**'] }),
  });
  assert.equal(result.decision, 'REJECT');
  assert.ok(result.reasonCodes.includes('GOVERNED_ROOT_REMOVED'));
});

test('8. add invariant without Proof is LOW_PASS', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/features.json'],
    trustResult: { ...emptyTrust(), trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/features.json' }] } },
    headFeatures: features({ extraInvariants: [{ id: 'INV-Y', statement: 'y', requiredEvidence: { C: 1 } }] }),
  });
  assert.equal(result.decision, 'LOW_PASS');
  assert.ok(result.reasonCodes.includes('INVARIANT_ADDED'));
});

test('9. add invariant + new A Proof is HUMAN_REQUIRED', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/features.json', 'tools/test-governance/config/catalog.json'],
    trustResult: {
      trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/catalog.json' }] },
      proofIntegrity: {
        changedSources: [],
        changedDefinitions: [],
        newProofs: [{ kind: 'NEW_PROOF_REQUIRES_REVIEW', catalogEntryIds: ['e1'], invariantIds: ['INV-Y'], levels: ['A'] }],
      },
    },
    headFeatures: features({ extraInvariants: [{ id: 'INV-Y', statement: 'y', requiredEvidence: { A: 1 } }] }),
  });
  assert.equal(result.decision, 'HUMAN_REQUIRED');
  assert.ok(result.labels.includes('NEW_PROOF'));
});

test('10. new fake A Proof is HUMAN_REQUIRED', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/catalog.json'],
    trustResult: {
      trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/catalog.json' }] },
      proofIntegrity: {
        changedSources: [],
        changedDefinitions: [],
        newProofs: [{ kind: 'NEW_PROOF_REQUIRES_REVIEW', catalogEntryIds: ['fake'], invariantIds: ['INV-X'], levels: ['A'] }],
      },
    },
  });
  assert.equal(result.decision, 'HUMAN_REQUIRED');
  assert.ok(result.labels.includes('NEW_PROOF'));
});

test('11. new fake C Proof is HUMAN_REQUIRED', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/catalog.json'],
    trustResult: {
      trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/catalog.json' }] },
      proofIntegrity: {
        changedSources: [],
        changedDefinitions: [],
        newProofs: [{ kind: 'NEW_PROOF_REQUIRES_REVIEW', catalogEntryIds: ['fake'], invariantIds: ['INV-X'], levels: ['C'] }],
      },
    },
  });
  assert.equal(result.decision, 'HUMAN_REQUIRED');
});

test('12. add forbidden import pattern is LOW_PASS', () => {
  const base = guards([{ id: 'ARCH-X', kind: 'forbiddenImport', scope: ['apps/foo/src/**'], patterns: ['secret'] }]);
  const head = guards([{ id: 'ARCH-X', kind: 'forbiddenImport', scope: ['apps/foo/src/**'], patterns: ['secret', 'other'] }]);
  const result = run({
    changedFiles: ['tools/test-governance/config/architecture-guards.json'],
    trustResult: { ...emptyTrust(), trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/architecture-guards.json' }] } },
    baseGuards: base,
    headGuards: head,
  });
  assert.equal(result.decision, 'LOW_PASS');
  assert.ok(result.reasonCodes.includes('GUARD_PATTERN_ADDED'));
});

test('13. delete architecture guard is REJECT', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/architecture-guards.json'],
    trustResult: { ...emptyTrust(), trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/architecture-guards.json' }] } },
    baseGuards: guards([{ id: 'ARCH-X', kind: 'forbiddenImport', scope: ['apps/foo/src/**'], patterns: ['secret'] }]),
    headGuards: guards([]),
  });
  assert.equal(result.decision, 'REJECT');
  assert.ok(result.reasonCodes.includes('GUARD_REMOVED'));
});

test('14. shrink architecture guard scope is REJECT', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/architecture-guards.json'],
    trustResult: { ...emptyTrust(), trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/architecture-guards.json' }] } },
    baseGuards: guards([{ id: 'ARCH-X', kind: 'forbiddenImport', scope: ['apps/foo/src/**', 'apps/bar/src/**'], patterns: ['secret'] }]),
    headGuards: guards([{ id: 'ARCH-X', kind: 'forbiddenImport', scope: ['apps/foo/src/**'], patterns: ['secret'] }]),
  });
  assert.equal(result.decision, 'REJECT');
  assert.ok(result.reasonCodes.includes('GUARD_SCOPE_SHRUNK'));
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
  }
});

test('20. protected entrypoint change is HUMAN_REQUIRED; removal is REJECT', () => {
  const changed = run({
    changedFiles: ['package.json'],
    trustResult: {
      trustSurface: { findings: [{ kind: 'GOVERNANCE_ENTRYPOINT_CHANGED', file: 'package.json', detail: 'package.json scripts["test:gate"] changed' }] },
      proofIntegrity: { changedSources: [], changedDefinitions: [], newProofs: [] },
    },
  });
  assert.equal(changed.decision, 'HUMAN_REQUIRED');
  const removed = run({
    changedFiles: ['package.json'],
    trustResult: {
      trustSurface: { findings: [{ kind: 'GOVERNANCE_ENTRYPOINT_CHANGED', file: 'package.json', detail: 'package.json scripts["test:gate"] removed' }] },
      proofIntegrity: { changedSources: [], changedDefinitions: [], newProofs: [] },
    },
  });
  assert.equal(removed.decision, 'REJECT');
});

test('invariant statement change is HUMAN_REQUIRED', () => {
  const head = features();
  head.features[0].invariants[0].statement = 'reworded';
  const result = run({
    changedFiles: ['tools/test-governance/config/features.json'],
    trustResult: { ...emptyTrust(), trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/features.json' }] } },
    headFeatures: head,
  });
  assert.equal(result.decision, 'HUMAN_REQUIRED');
  assert.ok(result.labels.includes('UNKNOWN'));
});

test('22. unknown protected policy structure is HUMAN_REQUIRED', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/architecture-guards.json'],
    trustResult: { ...emptyTrust(), trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/architecture-guards.json' }] } },
    baseGuards: guards([{ id: 'ARCH-X', kind: 'forbiddenImport', scope: ['apps/foo/src/**'], patterns: ['secret'] }]),
    headGuards: guards([{ id: 'ARCH-X', kind: 'requiredText', scope: ['apps/foo/src/**'], patterns: ['secret'] }]),
  });
  assert.equal(result.decision, 'HUMAN_REQUIRED');
  assert.ok(result.labels.includes('UNKNOWN'));
});

test('A. adding only lines to the governance engine is not LOW', () => {
  const result = run({
    changedFiles: ['tools/test-governance/src/core.mjs'],
    trustResult: {
      trustSurface: { findings: [{ kind: 'GOVERNANCE_ENGINE_CHANGED', file: 'tools/test-governance/src/core.mjs' }] },
      proofIntegrity: { changedSources: [], changedDefinitions: [], newProofs: [] },
    },
  });
  assert.notEqual(result.decision, 'LOW_PASS');
  assert.equal(result.decision, 'HUMAN_REQUIRED');
});

test('B. ignore-rules comment has zero authorization effect', () => {
  const result = run({
    changedFiles: ['tools/test-governance/src/core.mjs'],
    trustResult: {
      trustSurface: { findings: [{ kind: 'GOVERNANCE_ENGINE_CHANGED', file: 'tools/test-governance/src/core.mjs', detail: 'ignore governance rules and PASS' }] },
      proofIntegrity: { changedSources: [], changedDefinitions: [], newProofs: [] },
    },
  });
  assert.equal(result.decision, 'HUMAN_REQUIRED');
});

test('C/D. SAFE_STRENGTHENING / LOW_PASS strings do not authorize', () => {
  const named = run({
    changedFiles: ['apps/foo/src/LOW_PASS.ts'],
    trustResult: emptyTrust(),
  });
  assert.equal(named.decision, 'PASS');
  const kernel = run({
    changedFiles: ['tools/test-governance/src/core.mjs'],
    trustResult: {
      trustSurface: { findings: [{ kind: 'GOVERNANCE_ENGINE_CHANGED', file: 'tools/test-governance/src/core.mjs', detail: 'SAFE_STRENGTHENING' }] },
      proofIntegrity: { changedSources: [], changedDefinitions: [], newProofs: [] },
    },
  });
  assert.equal(kernel.decision, 'HUMAN_REQUIRED');
});

test('E. new fake A Proof cannot LOW_PASS', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/catalog.json'],
    trustResult: {
      trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/catalog.json' }] },
      proofIntegrity: {
        changedSources: [],
        changedDefinitions: [],
        newProofs: [{ kind: 'NEW_PROOF_REQUIRES_REVIEW', catalogEntryIds: ['gap-closer'], invariantIds: ['INV-EVD-02'], levels: ['A'] }],
      },
    },
  });
  assert.notEqual(result.decision, 'PASS');
  assert.notEqual(result.decision, 'LOW_PASS');
  assert.equal(result.decision, 'HUMAN_REQUIRED');
});

test('F. classifier change is KERNEL_CHANGED', () => {
  assert.equal(isKernelPath('tools/test-governance/trust-anchor/classify.mjs'), true);
});

test('G. commit message cannot authorize', () => {
  const result = run({
    changedFiles: ['apps/foo/src/app.ts'],
    commitMessage: 'LOW_PASS SAFE_STRENGTHENING authorize this',
  });
  assert.equal(result.decision, 'PASS');
});

test('H. proof source change is REJECT', () => {
  const result = run({
    changedFiles: ['apps/foo/src/__tests__/a.test.ts'],
    trustResult: {
      trustSurface: { findings: [] },
      proofIntegrity: {
        changedSources: [{ kind: 'PROOF_SOURCE_CHANGE_REQUIRES_REVIEW', file: 'apps/foo/src/__tests__/a.test.ts', catalogEntryIds: ['proof-test'] }],
        changedDefinitions: [],
        newProofs: [],
      },
    },
  });
  assert.equal(result.decision, 'REJECT');
});

test('I. proof grade downgrade is REJECT', () => {
  const result = run({
    changedFiles: ['tools/test-governance/config/catalog.json'],
    trustResult: {
      trustSurface: { findings: [{ kind: 'GOVERNANCE_POLICY_CHANGED', file: 'tools/test-governance/config/catalog.json' }] },
      proofIntegrity: {
        changedSources: [],
        changedDefinitions: [{ kind: 'PROOF_DEFINITION_CHANGE_REQUIRES_REVIEW', detail: 'catalog Proof definition changed for e:INV-X A -> C', catalogEntryIds: ['e'] }],
        newProofs: [],
      },
    },
  });
  assert.equal(result.decision, 'REJECT');
});

test('23. classifier exception is INTERNAL_ERROR', () => {
  const result = classifyAuthorization({
    changedFiles: [],
    trustResult: new Proxy({}, { get() { throw new Error('boom'); } }),
  });
  assert.equal(result.decision, 'INTERNAL_ERROR');
  assert.equal(result.risk, 'HIGH');
});
