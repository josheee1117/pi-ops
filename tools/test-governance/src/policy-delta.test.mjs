import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluatePolicyDelta } from './policy-delta.mjs';

function feature(id, paths, invariants, impacts) {
  return { id, paths, invariants, ...(impacts ? { impacts } : {}) };
}

function invariant(id, statement, requiredEvidence) {
  return { id, statement, requiredEvidence };
}

function guard(id, kind, scope, patterns) {
  return { id, kind, scope, patterns };
}

function featuresDoc(features, governedRoots = ['apps/*/src/**']) {
  return { schemaVersion: 1, governedRoots, features };
}

function guardsDoc(guards) {
  return { schemaVersion: 1, guards };
}

function catalogDoc(entries) {
  return { schemaVersion: 1, entries };
}

function testEntry(id, overrides = {}) {
  return {
    id,
    featureId: 'feature.one',
    status: 'ACTIVE',
    executionClass: 'UNIT',
    location: { file: 'apps/agent/src/x.test.ts', testName: 'a real test' },
    proofs: [{ invariantId: 'INV-ONE', level: 'C' }],
    ...overrides,
  };
}

function evaluate(base, head) {
  return evaluatePolicyDelta({
    baseFeatures: base.features,
    headFeatures: head.features,
    baseCatalog: base.catalog,
    headCatalog: head.catalog,
    baseGuards: base.guards,
    headGuards: head.guards,
  });
}

function baseState({ features = [], catalog = [], guards = [], governedRoots } = {}) {
  return { features: featuresDoc(features, governedRoots), catalog: catalogDoc(catalog), guards: guardsDoc(guards) };
}

function kinds(result) {
  return result.blockingChanges.map((change) => change.kind);
}

const ONE_FEATURE = [feature('feature.one', ['apps/agent/src/one.ts'], [invariant('INV-ONE', 'one', { A: 1, C: 2 })])];

// ── architecture guards ──────────────────────────────────────────────────────

test('1. removing an architecture guard blocks', () => {
  const base = baseState({ guards: [guard('G1', 'forbiddenImport', ['apps/**'], ['evil'])] });
  const head = baseState({ guards: [] });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.deepEqual(kinds(delta), ['GUARD_REMOVED']);
});

test('2. removing a forbidden pattern blocks', () => {
  const base = baseState({ guards: [guard('G1', 'forbiddenImport', ['apps/**'], ['evil', 'worse'])] });
  const head = baseState({ guards: [guard('G1', 'forbiddenImport', ['apps/**'], ['evil'])] });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.deepEqual(kinds(delta), ['GUARD_PATTERN_REMOVED']);
});

test('3. shrinking guard scope blocks', () => {
  const base = baseState({ guards: [guard('G1', 'forbiddenText', ['apps/**', 'packages/**'], ['secret'])] });
  const head = baseState({ guards: [guard('G1', 'forbiddenText', ['apps/**'], ['secret'])] });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.deepEqual(kinds(delta), ['GUARD_SCOPE_SHRUNK']);
});

test('4. adding a guard is allowed', () => {
  const base = baseState({ guards: [] });
  const head = baseState({ guards: [guard('G1', 'forbiddenImport', ['apps/**'], ['evil'])] });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'PASS');
  assert.deepEqual(delta.blockingChanges, []);
  assert.ok(delta.changes.some((change) => change.kind === 'GUARD_ADDED'));
});

test('guard kind changes always require review', () => {
  const pairs = [
    ['forbiddenImport', 'requiredText'],
    ['forbiddenText', 'requiredText'],
    ['requiredText', 'forbiddenText'],
    ['forbiddenText', 'forbiddenImport'],
  ];
  for (const [before, after] of pairs) {
    const base = baseState({ guards: [guard('G1', before, ['apps/**'], ['canary'])] });
    const head = baseState({ guards: [guard('G1', after, ['apps/**'], ['canary'])] });
    const delta = evaluate(base, head);
    assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING', `${before} -> ${after}`);
    assert.deepEqual(kinds(delta), ['POLICY_REVIEW_REQUIRED'], `${before} -> ${after}`);
  }
});

// ── governed roots ───────────────────────────────────────────────────────────

test('5. removing a governed root blocks', () => {
  const base = baseState({ features: ONE_FEATURE, governedRoots: ['apps/*/src/**', 'packages/*/src/**'] });
  const head = baseState({ features: ONE_FEATURE, governedRoots: ['apps/*/src/**'] });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.deepEqual(kinds(delta), ['GOVERNED_ROOT_REMOVED']);
});

test('adding a governed root is allowed', () => {
  const base = baseState({ features: ONE_FEATURE, governedRoots: ['apps/*/src/**'] });
  const head = baseState({ features: ONE_FEATURE, governedRoots: ['apps/*/src/**', 'packages/*/src/**'] });
  assert.equal(evaluate(base, head).status, 'PASS');
});

// ── unmappedIgnore exemption surface ────────────────────────────────────────

function evaluateIgnoreDelta(baseIgnore, headIgnore) {
  return evaluatePolicyDelta({
    baseFeatures: { schemaVersion: 1, governedRoots: ['apps/*/src/**'], features: [], unmappedIgnore: baseIgnore },
    headFeatures: { schemaVersion: 1, governedRoots: ['apps/*/src/**'], features: [], unmappedIgnore: headIgnore },
    baseCatalog: { schemaVersion: 1, entries: [] },
    headCatalog: { schemaVersion: 1, entries: [] },
    baseGuards: { schemaVersion: 1, guards: [] },
    headGuards: { schemaVersion: 1, guards: [] },
  });
}

test('expanding unmappedIgnore blocks', () => {
  const delta = evaluateIgnoreDelta(['docs/**'], ['docs/**', 'apps/**']);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.deepEqual(kinds(delta), ['UNMAPPED_IGNORE_EXPANDED']);
});

test('reducing unmappedIgnore is allowed strengthening', () => {
  const delta = evaluateIgnoreDelta(['docs/**', 'apps/generated/**'], ['docs/**']);
  assert.equal(delta.status, 'PASS');
  assert.ok(delta.changes.some((change) => change.kind === 'UNMAPPED_IGNORE_REDUCED'));
});

test('an unchanged unmappedIgnore set passes', () => {
  const delta = evaluateIgnoreDelta(['docs/**', 'tools/**'], ['docs/**', 'tools/**']);
  assert.equal(delta.status, 'PASS');
});

// ── features / invariants / floors ───────────────────────────────────────────

test('6. removing a Feature blocks', () => {
  const base = baseState({ features: ONE_FEATURE });
  const head = baseState({ features: [] });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.deepEqual(kinds(delta), ['FEATURE_REMOVED']);
});

test('7. removing a Feature path blocks', () => {
  const base = baseState({ features: [feature('feature.one', ['apps/agent/src/one.ts', 'apps/agent/src/two.ts'], [])] });
  const head = baseState({ features: [feature('feature.one', ['apps/agent/src/one.ts'], [])] });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.deepEqual(kinds(delta), ['FEATURE_PATH_REMOVED']);
});

test('8. removing an impact edge blocks', () => {
  const base = baseState({
    features: [
      feature('feature.one', ['apps/agent/src/one.ts'], [], ['feature.two']),
      feature('feature.two', ['apps/agent/src/two.ts'], []),
    ],
  });
  const head = baseState({
    features: [
      feature('feature.one', ['apps/agent/src/one.ts'], []),
      feature('feature.two', ['apps/agent/src/two.ts'], []),
    ],
  });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.deepEqual(kinds(delta), ['IMPACT_EDGE_REMOVED']);
});

test('9. removing an Invariant blocks', () => {
  const base = baseState({ features: [feature('feature.one', ['a.ts'], [invariant('INV-ONE', 'one', { A: 1 }), invariant('INV-TWO', 'two', { C: 1 })])] });
  const head = baseState({ features: [feature('feature.one', ['a.ts'], [invariant('INV-ONE', 'one', { A: 1 })])] });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.deepEqual(kinds(delta), ['INVARIANT_REMOVED']);
});

test('10. lowering A1 -> A0 blocks', () => {
  const base = baseState({ features: [feature('feature.one', ['a.ts'], [invariant('INV-ONE', 'one', { A: 1 })])] });
  const head = baseState({ features: [feature('feature.one', ['a.ts'], [invariant('INV-ONE', 'one', {})])] });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.deepEqual(kinds(delta), ['EVIDENCE_FLOOR_LOWERED']);
});

test('11. lowering C2 -> C1 blocks', () => {
  const base = baseState({ features: [feature('feature.one', ['a.ts'], [invariant('INV-ONE', 'one', { C: 2 })])] });
  const head = baseState({ features: [feature('feature.one', ['a.ts'], [invariant('INV-ONE', 'one', { C: 1 })])] });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.deepEqual(kinds(delta), ['EVIDENCE_FLOOR_LOWERED']);
});

test('12. increasing A1 -> A2 is allowed', () => {
  const base = baseState({ features: [feature('feature.one', ['a.ts'], [invariant('INV-ONE', 'one', { A: 1 })])] });
  const head = baseState({ features: [feature('feature.one', ['a.ts'], [invariant('INV-ONE', 'one', { A: 2 })])] });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'PASS');
  assert.ok(delta.changes.some((change) => change.kind === 'EVIDENCE_FLOOR_RAISED'));
});

test('13. adding C1 to an existing A1 is allowed', () => {
  const base = baseState({ features: [feature('feature.one', ['a.ts'], [invariant('INV-ONE', 'one', { A: 1 })])] });
  const head = baseState({ features: [feature('feature.one', ['a.ts'], [invariant('INV-ONE', 'one', { A: 1, C: 1 })])] });
  assert.equal(evaluate(base, head).status, 'PASS');
});

test('14. changing an invariant statement together with its Proof mapping blocks', () => {
  const base = baseState({
    features: [feature('feature.one', ['a.ts'], [invariant('INV-ONE', 'original claim', { C: 1 })])],
    catalog: [testEntry('e1', { proofs: [{ invariantId: 'INV-ONE', level: 'C' }] })],
  });
  const head = baseState({
    features: [feature('feature.one', ['a.ts'], [invariant('INV-ONE', 'rewritten claim', { C: 1 })])],
    catalog: [testEntry('e1', { proofs: [{ invariantId: 'INV-ONE', level: 'C' }], location: { file: 'apps/agent/src/y.test.ts', testName: 'another test' } })],
  });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.deepEqual(kinds(delta), ['POLICY_REVIEW_REQUIRED']);
});

test('any existing invariant statement change blocks, even wording-only', () => {
  const base = baseState({
    features: [feature('feature.one', ['a.ts'], [invariant('INV-ONE', 'claim A', { A: 1 })])],
    catalog: [testEntry('e1', { proofs: [{ invariantId: 'INV-ONE', level: 'A' }] })],
  });
  const head = baseState({
    features: [feature('feature.one', ['a.ts'], [invariant('INV-ONE', 'claim A.', { A: 1 })])],
    catalog: [testEntry('e1', { proofs: [{ invariantId: 'INV-ONE', level: 'A' }] })],
  });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.deepEqual(kinds(delta), ['POLICY_REVIEW_REQUIRED']);
});

test('semantic statement weakening with identical floor and Proofs blocks', () => {
  const base = baseState({
    features: [feature('feature.one', ['a.ts'], [invariant('INV-ONE', 'Only a valid ingest token may POST /v1/events.', { A: 1 })])],
    catalog: [testEntry('e1', { proofs: [{ invariantId: 'INV-ONE', level: 'A' }] })],
  });
  const head = baseState({
    features: [feature('feature.one', ['a.ts'], [invariant('INV-ONE', 'Requests should normally contain an ingest token.', { A: 1 })])],
    catalog: [testEntry('e1', { proofs: [{ invariantId: 'INV-ONE', level: 'A' }] })],
  });
  assert.deepEqual(kinds(evaluate(base, head)), ['POLICY_REVIEW_REQUIRED']);
});

test('an unchanged statement and a new invariant are allowed', () => {
  const base = baseState({ features: [feature('feature.one', ['a.ts'], [invariant('INV-ONE', 'claim A', { A: 1 })])] });
  const head = baseState({
    features: [feature('feature.one', ['a.ts'], [invariant('INV-ONE', 'claim A', { A: 1 }), invariant('INV-TWO', 'new claim', { C: 1 })])],
  });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'PASS');
  assert.ok(delta.changes.some((change) => change.kind === 'INVARIANT_ADDED'));
});

test('changing the statement of a PINNED-referenced invariant blocks', () => {
  const base = baseState({
    features: [feature('feature.one', ['a.ts'], [invariant('INV-PIN', 'pinned claim', { A: 1 })])],
    catalog: [testEntry('p1', { status: 'PINNED', proofs: [{ invariantId: 'INV-PIN', level: 'A' }] })],
  });
  const head = baseState({
    features: [feature('feature.one', ['a.ts'], [invariant('INV-PIN', 'reworded pinned claim', { A: 1 })])],
    catalog: [testEntry('p1', { status: 'PINNED', proofs: [{ invariantId: 'INV-PIN', level: 'A' }] })],
  });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.deepEqual(kinds(delta), ['POLICY_REVIEW_REQUIRED']);
});

// ── catalog / PINNED protection ──────────────────────────────────────────────

test('15. deleting a PINNED entry blocks', () => {
  const base = baseState({ catalog: [testEntry('p1', { status: 'PINNED' })] });
  const head = baseState({ catalog: [] });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.deepEqual(kinds(delta), ['PINNED_ENTRY_REMOVED']);
});

test('16. PINNED -> ACTIVE blocks', () => {
  const base = baseState({ catalog: [testEntry('p1', { status: 'PINNED' })] });
  const head = baseState({ catalog: [testEntry('p1', { status: 'ACTIVE' })] });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.deepEqual(kinds(delta), ['PINNED_STATUS_CHANGED']);
});

test('PINNED -> DOMINATED and PINNED -> RETIRED block', () => {
  for (const status of ['DOMINATED', 'RETIRED', 'QUARANTINED']) {
    const base = baseState({ catalog: [testEntry('p1', { status: 'PINNED' })] });
    const head = baseState({ catalog: [testEntry('p1', { status })] });
    assert.deepEqual(kinds(evaluate(base, head)), ['PINNED_STATUS_CHANGED'], status);
  }
});

test('17. historicalRegression true -> false blocks', () => {
  const base = baseState({ catalog: [testEntry('p1', { historicalRegression: true })] });
  const head = baseState({ catalog: [testEntry('p1', {})] });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.deepEqual(kinds(delta), ['HISTORICAL_REGRESSION_FLIPPED']);
});

test('18. removing a Proof from a PINNED entry blocks', () => {
  const base = baseState({
    catalog: [testEntry('p1', {
      status: 'PINNED',
      proofs: [{ invariantId: 'INV-ONE', level: 'C' }, { invariantId: 'INV-ONE', level: 'A' }],
    })],
  });
  const head = baseState({
    catalog: [testEntry('p1', { status: 'PINNED', proofs: [{ invariantId: 'INV-ONE', level: 'C' }] })],
  });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.ok(kinds(delta).includes('PINNED_PROOF_REMOVED'));
});

test('changing the backing source of a PINNED entry blocks', () => {
  const base = baseState({ catalog: [testEntry('p1', { status: 'PINNED' })] });
  const head = baseState({ catalog: [testEntry('p1', { status: 'PINNED', location: { file: 'apps/agent/src/moved.test.ts', testName: 'a real test' } })] });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.ok(kinds(delta).includes('PINNED_SOURCE_CHANGED'));
});

test('19. relabeling an existing C Proof as A on the same source blocks', () => {
  const base = baseState({ catalog: [testEntry('e1', { proofs: [{ invariantId: 'INV-ONE', level: 'C' }] })] });
  const head = baseState({ catalog: [testEntry('e1', { proofs: [{ invariantId: 'INV-ONE', level: 'A' }] })] });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
  assert.deepEqual(kinds(delta), ['EVIDENCE_GRADE_CHANGE_REQUIRES_REVIEW']);
});

test('B -> A on the same backing source blocks', () => {
  const base = baseState({ catalog: [testEntry('e1', { proofs: [{ invariantId: 'INV-ONE', level: 'B' }] })] });
  const head = baseState({ catalog: [testEntry('e1', { proofs: [{ invariantId: 'INV-ONE', level: 'A' }] })] });
  assert.deepEqual(kinds(evaluate(base, head)), ['EVIDENCE_GRADE_CHANGE_REQUIRES_REVIEW']);
});

test('20. adding a new Proof is allowed', () => {
  const base = baseState({ catalog: [testEntry('e1', { proofs: [{ invariantId: 'INV-ONE', level: 'C' }] })] });
  const head = baseState({
    catalog: [
      testEntry('e1', { proofs: [{ invariantId: 'INV-ONE', level: 'C' }] }),
      testEntry('e2', { proofs: [{ invariantId: 'INV-ONE', level: 'A' }] }),
    ],
  });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'PASS');
  assert.ok(delta.changes.some((change) => change.kind === 'CATALOG_ENTRY_ADDED'));
});

test('removing an ACTIVE proof is surfaced but not blocking', () => {
  const base = baseState({
    catalog: [
      testEntry('e1', { proofs: [{ invariantId: 'INV-ONE', level: 'C' }] }),
      testEntry('e2', { proofs: [{ invariantId: 'INV-ONE', level: 'A' }] }),
    ],
  });
  const head = baseState({ catalog: [testEntry('e1', { proofs: [{ invariantId: 'INV-ONE', level: 'C' }] })] });
  const delta = evaluate(base, head);
  assert.equal(delta.status, 'PASS');
  assert.ok(delta.changes.some((change) => change.kind === 'CATALOG_ENTRY_REMOVED'));
});

test('an equivalent pnpm alias and bash command keep the same Proof Source identity', () => {
  const scripts = { 'smoke:local': 'bash deploy/local/smoke.sh' };
  const base = baseState({
    catalog: [testEntry('c1', { executionClass: 'SMOKE', command: 'pnpm smoke:local', location: { file: 'deploy/local/smoke.sh' }, proofs: [{ invariantId: 'INV-ONE', level: 'A' }] })],
  });
  const head = baseState({
    catalog: [testEntry('c1', { executionClass: 'SMOKE', command: 'bash deploy/local/smoke.sh', location: { file: 'deploy/local/smoke.sh' }, proofs: [{ invariantId: 'INV-ONE', level: 'A' }] })],
  });
  const delta = evaluatePolicyDelta(
    { baseFeatures: base.features, headFeatures: head.features, baseCatalog: base.catalog, headCatalog: head.catalog, baseGuards: base.guards, headGuards: head.guards },
    { packageScripts: scripts },
  );
  assert.equal(delta.status, 'PASS');
});

// ── real git fixture: BASE policy -> weakened HEAD policy ───────────────────

function policyFixture(mutate) {
  const repo = mkdtempSync(join(tmpdir(), 'pi-ops-policy-'));
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'governance@example.com']);
  git(['config', 'user.name', 'Governance Test']);
  const dir = join(repo, 'tools/test-governance/config');
  mkdirSync(dir, { recursive: true });
  const docs = {
    'features.json': featuresDoc([feature('feature.one', ['apps/agent/src/one.ts'], [invariant('INV-ONE', 'one', { A: 1 })])], ['apps/*/src/**']),
    'catalog.json': catalogDoc([]),
    'architecture-guards.json': guardsDoc([guard('G1', 'forbiddenImport', ['apps/**'], ['evil'])]),
  };
  for (const [name, doc] of Object.entries(docs)) writeFileSync(join(dir, name), `${JSON.stringify(doc, null, 2)}\n`);
  git(['add', '-A']);
  git(['commit', '-qm', 'base policy']);
  const base = git(['rev-parse', 'HEAD']).trim();
  const headDocs = mutate(structuredClone(docs));
  for (const [name, doc] of Object.entries(headDocs)) writeFileSync(join(dir, name), `${JSON.stringify(doc, null, 2)}\n`);
  git(['add', '-A']);
  git(['commit', '-qm', 'head policy']);
  const head = git(['rev-parse', 'HEAD']).trim();
  const readAt = (rev, name) => JSON.parse(execFileSync('git', ['show', `${rev}:tools/test-governance/config/${name}`], { cwd: repo, encoding: 'utf8' }));
  return {
    base,
    head,
    docs: () => ({
      baseFeatures: readAt(base, 'features.json'),
      headFeatures: readAt(head, 'features.json'),
      baseCatalog: readAt(base, 'catalog.json'),
      headCatalog: readAt(head, 'catalog.json'),
      baseGuards: readAt(base, 'architecture-guards.json'),
      headGuards: readAt(head, 'architecture-guards.json'),
    }),
    cleanup: () => rmSync(repo, { recursive: true, force: true }),
  };
}

test('git fixture: a commit that lowers its own floor and deletes a guard is detected as weakening', () => {
  const fixture = policyFixture((docs) => {
    docs['features.json'].features[0].invariants[0].requiredEvidence = { C: 1 };
    docs['architecture-guards.json'].guards = [];
    return docs;
  });
  try {
    const delta = evaluatePolicyDelta(fixture.docs());
    assert.equal(delta.status, 'GOVERNANCE_POLICY_WEAKENING');
    assert.deepEqual(kinds(delta), ['GUARD_REMOVED', 'EVIDENCE_FLOOR_LOWERED']);
  } finally {
    fixture.cleanup();
  }
});

test('git fixture: strengthening the policy between two commits passes', () => {
  const fixture = policyFixture((docs) => {
    docs['features.json'].features[0].invariants[0].requiredEvidence = { A: 1, C: 1 };
    docs['architecture-guards.json'].guards.push(guard('G2', 'forbiddenText', ['packages/**'], ['nope']));
    return docs;
  });
  try {
    const delta = evaluatePolicyDelta(fixture.docs());
    assert.equal(delta.status, 'PASS');
    assert.deepEqual(delta.blockingChanges, []);
  } finally {
    fixture.cleanup();
  }
});
