import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateGovernanceTrustSurface, TRUST_ROOT_VERSION } from './trust-surface.mjs';
import { parseNameStatus } from './core.mjs';

function featuresDoc(trustRootVersion) {
  return {
    schemaVersion: 1,
    governedRoots: ['apps/*/src/**'],
    features: [],
    ...(trustRootVersion === undefined ? {} : { trustRootVersion }),
  };
}

function packageJson({ scripts = {}, extra = {} } = {}) {
  return {
    name: 'fixture',
    version: '1.0.0',
    packageManager: 'pnpm@10.15.0',
    engines: { node: '>=22' },
    scripts,
    devDependencies: { typescript: '^5.9.3' },
    ...extra,
  };
}

function changed(paths) {
  return paths.map((path) => ({ status: 'M', path }));
}

function evaluate({ baseFeatures, headFeatures, basePackageJson, headPackageJson, changes }) {
  return evaluateGovernanceTrustSurface({
    changes,
    baseFeatures: baseFeatures ?? featuresDoc(TRUST_ROOT_VERSION),
    headFeatures: headFeatures ?? featuresDoc(TRUST_ROOT_VERSION),
    basePackageJson: basePackageJson ?? packageJson(),
    headPackageJson: headPackageJson ?? packageJson(),
  });
}

const ENGINE = (file) => `tools/test-governance/src/${file}`;

// ── required trust surface cases ─────────────────────────────────────────────

test('1. modifying policy-delta.mjs requires review', () => {
  const result = evaluate({ changes: changed([ENGINE('policy-delta.mjs')]) });
  assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
  assert.deepEqual(result.blockingChanges.map((change) => change.kind), ['GOVERNANCE_ENGINE_CHANGE_REQUIRES_REVIEW']);
});

test('2. modifying gate.mjs requires review', () => {
  const result = evaluate({ changes: changed([ENGINE('gate.mjs')]) });
  assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
  assert.deepEqual(result.blockingChanges.map((change) => change.kind), ['GOVERNANCE_ENGINE_CHANGE_REQUIRES_REVIEW']);
});

test('3. modifying governance self-tests requires review', () => {
  const result = evaluate({ changes: changed([ENGINE('policy-delta.test.mjs')]) });
  assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
  assert.deepEqual(result.blockingChanges.map((change) => change.kind), ['GOVERNANCE_ENGINE_CHANGE_REQUIRES_REVIEW']);
});

test('4. modifying the governance workflow requires review', () => {
  const result = evaluate({ changes: changed(['.github/workflows/test-governance.yml']) });
  assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
  assert.deepEqual(result.blockingChanges.map((change) => change.kind), ['GOVERNANCE_WORKFLOW_CHANGE_REQUIRES_REVIEW']);
});

test('5. changing scripts.test:gate requires review', () => {
  const result = evaluate({
    changes: changed(['package.json']),
    basePackageJson: packageJson({ scripts: { 'test:gate': 'old' } }),
    headPackageJson: packageJson({ scripts: { 'test:gate': 'new' } }),
  });
  assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
  assert.deepEqual(result.blockingChanges.map((change) => change.kind), ['GOVERNANCE_ENTRYPOINT_CHANGE_REQUIRES_REVIEW']);
});

test('6. changing scripts.test:plan requires review', () => {
  const result = evaluate({
    changes: changed(['package.json']),
    basePackageJson: packageJson({ scripts: { 'test:plan': 'old' } }),
    headPackageJson: packageJson({ scripts: { 'test:plan': 'new' } }),
  });
  assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
  assert.deepEqual(result.blockingChanges.map((change) => change.kind), ['GOVERNANCE_ENTRYPOINT_CHANGE_REQUIRES_REVIEW']);
});

test('7. an unrelated package.json description change does not trigger trust review', () => {
  const result = evaluate({
    changes: changed(['package.json']),
    basePackageJson: packageJson({ extra: { description: 'before' } }),
    headPackageJson: packageJson({ extra: { description: 'after' } }),
  });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.blockingChanges, []);
});

test('8. ordinary product code only leaves the trust surface PASS', () => {
  const result = evaluate({ changes: changed(['apps/agent/src/app.ts', 'packages/protocol/src/types.ts']) });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.blockingChanges, []);
  assert.deepEqual(result.changes, []);
});

test('changing packageManager or engines.node requires review', () => {
  for (const variant of [
    packageJson({ extra: { packageManager: 'pnpm@9.0.0' } }),
    packageJson({ extra: { engines: { node: '>=20' } } }),
    packageJson({ extra: { devDependencies: { typescript: '^4.0.0' } } }),
  ]) {
    const result = evaluate({ changes: changed(['package.json']), basePackageJson: packageJson(), headPackageJson: variant });
    assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
    assert.ok(result.blockingChanges.every((change) => change.kind === 'GOVERNANCE_ENTRYPOINT_CHANGE_REQUIRES_REVIEW'));
  }
});

test('a new unprotected script is surfaced but does not block', () => {
  const result = evaluate({
    changes: changed(['package.json']),
    basePackageJson: packageJson(),
    headPackageJson: packageJson({ scripts: { build: 'tsc' } }),
  });
  assert.equal(result.status, 'PASS');
  assert.ok(result.changes.some((change) => change.kind === 'PACKAGE_SCRIPT_CHANGED' && !change.blocking));
});

test('renaming an engine file into the trust surface is detected', () => {
  const result = evaluate({
    changes: [{ status: 'R', oldPath: 'scripts/old.mjs', newPath: ENGINE('core.mjs') }],
  });
  assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
});

// ── trust root bootstrap ─────────────────────────────────────────────────────

test('bootstrap: BASE without trustRootVersion -> HEAD v1 with engine changes is allowed once', () => {
  const result = evaluate({
    baseFeatures: featuresDoc(undefined),
    headFeatures: featuresDoc(TRUST_ROOT_VERSION),
    changes: changed([ENGINE('gate.mjs')]),
  });
  assert.equal(result.status, 'PASS');
  assert.ok(result.trustRoot.bootstrap);
  const bootstrapFinding = result.changes.find((change) => change.kind === 'TRUST_ROOT_BOOTSTRAP');
  assert.ok(bootstrapFinding && !bootstrapFinding.blocking);
  const engineFinding = result.changes.find((change) => change.kind === 'GOVERNANCE_ENGINE_CHANGE_REQUIRES_REVIEW');
  assert.ok(engineFinding && !engineFinding.blocking);
});

test('after bootstrap, any engine change blocks', () => {
  const result = evaluate({
    baseFeatures: featuresDoc(TRUST_ROOT_VERSION),
    headFeatures: featuresDoc(TRUST_ROOT_VERSION),
    changes: changed([ENGINE('gate.mjs')]),
  });
  assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
  assert.ok(result.blockingChanges.every((change) => change.blocking));
});

test('removing trustRootVersion blocks', () => {
  const result = evaluate({
    baseFeatures: featuresDoc(TRUST_ROOT_VERSION),
    headFeatures: featuresDoc(undefined),
    changes: changed(['apps/agent/src/app.ts']),
  });
  assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
  assert.deepEqual(result.blockingChanges.map((change) => change.kind), ['TRUST_ROOT_VERSION_REMOVED']);
});

test('changing trustRootVersion after bootstrap blocks', () => {
  const result = evaluate({
    baseFeatures: featuresDoc(TRUST_ROOT_VERSION),
    headFeatures: featuresDoc(2),
    changes: changed(['apps/agent/src/app.ts']),
  });
  assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
  assert.deepEqual(result.blockingChanges.map((change) => change.kind), ['TRUST_ROOT_VERSION_CHANGED']);
});

// ── real git fixtures ────────────────────────────────────────────────────────

function trustFixture(mutate) {
  const repo = mkdtempSync(join(tmpdir(), 'pi-ops-trust-'));
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'governance@example.com']);
  git(['config', 'user.name', 'Governance Test']);
  mkdirSync(join(repo, 'tools/test-governance/src'), { recursive: true });
  mkdirSync(join(repo, 'tools/test-governance/config'), { recursive: true });
  mkdirSync(join(repo, 'apps/agent/src'), { recursive: true });
  writeFileSync(join(repo, 'tools/test-governance/src/gate.mjs'), 'export const trusted = true;\n');
  writeFileSync(join(repo, 'tools/test-governance/src/runner.mjs'), 'export const runner = true;\n');
  writeFileSync(join(repo, 'tools/test-governance/config/features.json'), `${JSON.stringify(featuresDoc(TRUST_ROOT_VERSION), null, 2)}\n`);
  writeFileSync(join(repo, 'apps/agent/src/app.ts'), 'export const app = 1;\n');
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify(packageJson({ scripts: { 'test:gate': 'old value' } }), null, 2)}\n`);
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']).trim();
  mutate(repo, git);
  git(['add', '-A']);
  git(['commit', '-qm', 'head']);
  const head = git(['rev-parse', 'HEAD']).trim();
  const readAt = (rev, path) => JSON.parse(execFileSync('git', ['show', `${rev}:${path}`], { cwd: repo, encoding: 'utf8' }));
  const changes = parseNameStatus(git(['diff', '--name-status', '--find-renames', `${base}...${head}`]).trim());
  const docs = () => ({
    changes,
    baseFeatures: readAt(base, 'tools/test-governance/config/features.json'),
    headFeatures: readAt(head, 'tools/test-governance/config/features.json'),
    basePackageJson: readAt(base, 'package.json'),
    headPackageJson: readAt(head, 'package.json'),
  });
  return { base, head, docs, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

test('git fixture: modifying the governance engine between commits requires review', () => {
  const fixture = trustFixture((repo) => {
    writeFileSync(join(repo, 'tools/test-governance/src/gate.mjs'), 'export const trusted = false;\n');
  });
  try {
    const result = evaluateGovernanceTrustSurface(fixture.docs());
    assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
    assert.deepEqual(result.blockingChanges.map((change) => change.kind), ['GOVERNANCE_ENGINE_CHANGE_REQUIRES_REVIEW']);
  } finally {
    fixture.cleanup();
  }
});

test('git fixture: changing the test:gate entrypoint between commits requires review', () => {
  const fixture = trustFixture((repo) => {
    writeFileSync(join(repo, 'package.json'), `${JSON.stringify(packageJson({ scripts: { 'test:gate': 'new value' } }), null, 2)}\n`);
  });
  try {
    const result = evaluateGovernanceTrustSurface(fixture.docs());
    assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
    assert.deepEqual(result.blockingChanges.map((change) => change.kind), ['GOVERNANCE_ENTRYPOINT_CHANGE_REQUIRES_REVIEW']);
  } finally {
    fixture.cleanup();
  }
});

test('git fixture: a product-source-only change leaves the trust surface PASS', () => {
  const fixture = trustFixture((repo) => {
    writeFileSync(join(repo, 'apps/agent/src/app.ts'), 'export const app = 2;\n');
  });
  try {
    const result = evaluateGovernanceTrustSurface(fixture.docs());
    assert.equal(result.status, 'PASS');
    assert.deepEqual(result.blockingChanges, []);
  } finally {
    fixture.cleanup();
  }
});
