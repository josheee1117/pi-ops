import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalizeCommand,
  catalogEntryKind,
  changedPathsOf,
  extractTestNames,
  findUnmappedProductionFiles,
  parseNameStatus,
  proofSourceId,
  resolveAffectedFeatures,
  validateGovernanceConfig,
} from './core.mjs';
import { buildExecutionPlan, gateForExecutionClass } from './execution-plan.mjs';
import { realizeEvidence } from './evidence.mjs';
import { createPlanning } from './planning.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const ARTIFACT = 'deploy/local/smoke.sh';

// ── Blocker 1: command → artifact binding ────────────────────────────────────

test('canonical bash script command is valid', () => {
  const { canonical, error } = canonicalizeCommand(`bash ${ARTIFACT}`, {
    fileExists: () => true,
    declaredFile: ARTIFACT,
  });
  assert.equal(error, undefined);
  assert.deepEqual(canonical, {
    executable: 'bash',
    args: [ARTIFACT],
    target: ARTIFACT,
    display: `bash ${ARTIFACT}`,
  });
});

test('harmless extra whitespace still canonicalizes', () => {
  const { canonical, error } = canonicalizeCommand(`  bash   ${ARTIFACT}  `, {
    fileExists: () => true,
    declaredFile: ARTIFACT,
  });
  assert.equal(error, undefined);
  assert.deepEqual(canonical.args, [ARTIFACT]);
});

test('echoing the artifact path cannot bind a command proof', () => {
  const { error } = canonicalizeCommand(`echo ${ARTIFACT}`, { fileExists: () => true, declaredFile: ARTIFACT });
  assert.match(error, /UNVERIFIED_COMMAND/);
});

test('compound shell command forms are all rejected', () => {
  const unsafe = [
    `bash ${ARTIFACT} || true`,
    `bash ${ARTIFACT} && echo ok`,
    `bash ${ARTIFACT} | cat`,
    `false; bash ${ARTIFACT}`,
    `bash ${ARTIFACT} > /dev/null`,
    `sh ${ARTIFACT}`,
  ];
  for (const command of unsafe) {
    const { error, canonical } = canonicalizeCommand(command, { fileExists: () => true, declaredFile: ARTIFACT });
    assert.equal(canonical, undefined, command);
    assert.match(error, /UNVERIFIED_COMMAND|CATALOG_COMMAND_TARGET_MISMATCH/, command);
  }
});

test('a missing command artifact is rejected', () => {
  const { error } = canonicalizeCommand(`bash ${ARTIFACT}`, { fileExists: () => false, declaredFile: ARTIFACT });
  assert.match(error, /command file missing/);
});

test('command targets must stay repository-relative', () => {
  for (const target of ['/tmp/proof.sh', '../proof.sh', 'tools/../proof.sh']) {
    const { error } = canonicalizeCommand(`bash ${target}`, { fileExists: () => true, declaredFile: target });
    assert.match(error, /repository-relative/, target);
  }
});

test('pnpm script resolving exactly to the canonical bash target is valid', () => {
  const { canonical, error } = canonicalizeCommand('pnpm smoke:local', {
    packageScripts: { 'smoke:local': `bash ${ARTIFACT}` },
    fileExists: () => true,
    declaredFile: ARTIFACT,
  });
  assert.equal(error, undefined);
  assert.deepEqual(canonical.args, ['run', 'smoke:local']);
  assert.equal(canonical.target, ARTIFACT);
});

test('a pnpm script that only mentions the artifact is rejected', () => {
  for (const scriptText of [
    `echo ${ARTIFACT}`,
    `bash ${ARTIFACT} || true`,
    `bash ${ARTIFACT} && echo done`,
    `bash ${ARTIFACT} | cat`,
    `sh ${ARTIFACT}`,
  ]) {
    const { error } = canonicalizeCommand('pnpm smoke:local', {
      packageScripts: { 'smoke:local': scriptText },
      fileExists: () => true,
      declaredFile: ARTIFACT,
    });
    assert.match(error, /CATALOG_COMMAND_TARGET_MISMATCH/, scriptText);
  }
});

test('command runs carry a canonical argv instead of a shell string', () => {
  const entry = {
    id: 'cmd', featureId: 'feature.one', executionClass: 'SMOKE',
    command: 'pnpm smoke:local', location: { file: ARTIFACT },
    proofs: [{ invariantId: 'INV-ONE', level: 'A' }],
  };
  const plan = buildExecutionPlan({
    plan: policyPlan([featureItem({ A: 1 }, [entry])]),
    catalogEntries: [entry],
    packageScripts: { 'smoke:local': `bash ${ARTIFACT}` },
  });
  assert.equal(plan.runs[0].executable, 'pnpm');
  assert.deepEqual(plan.runs[0].args, ['run', 'smoke:local']);
  assert.equal(plan.runs[0].commandTarget, ARTIFACT);
});

test('an uncanonicalizable catalog command cannot reach the runner', () => {
  const entry = {
    id: 'cmd-bad', featureId: 'feature.one', executionClass: 'SMOKE',
    command: `bash ${ARTIFACT} || true`, location: { file: ARTIFACT },
    proofs: [{ invariantId: 'INV-ONE', level: 'A' }],
  };
  assert.throws(
    () => buildExecutionPlan({ plan: policyPlan([featureItem({ A: 1 }, [entry])]), catalogEntries: [entry] }),
    /UNEXECUTABLE_CATALOG_COMMAND/,
  );
});

// ── Blocker 2: proof source identity ─────────────────────────────────────────

const featureDoc = {
  schemaVersion: 1,
  governedRoots: ['apps/*/src/**'],
  features: [{
    id: 'feature.one',
    paths: ['apps/agent/src/one.ts'],
    invariants: [
      { id: 'INV-ONE', statement: 'one', requiredEvidence: { C: 2 } },
      { id: 'INV-TWO', statement: 'two', requiredEvidence: { C: 1 } },
    ],
  }],
};
const emptyGuards = { schemaVersion: 1, guards: [] };

function testEntry(id, testName, proofs) {
  return {
    id,
    featureId: 'feature.one',
    status: 'ACTIVE',
    executionClass: 'UNIT',
    location: { file: 'apps/agent/src/__tests__/x.test.ts', testName },
    proofs,
  };
}

test('two catalog aliases for one real test are rejected as duplicate proof sources', () => {
  const errors = validateGovernanceConfig(featureDoc, {
    schemaVersion: 1,
    entries: [
      testEntry('entry-a', 'same test', [{ invariantId: 'INV-ONE', level: 'C' }]),
      testEntry('entry-b', 'same test', [{ invariantId: 'INV-ONE', level: 'C' }]),
    ],
  }, emptyGuards);
  assert.ok(errors.some((error) => error.includes('CATALOG_DUPLICATE_PROOF_SOURCE')));
});

test('duplicate command proof sources are rejected', () => {
  const commandEntry = (id) => ({
    id, featureId: 'feature.one', status: 'ACTIVE', executionClass: 'SMOKE',
    command: 'pnpm smoke:local', location: { file: ARTIFACT },
    proofs: [{ invariantId: 'INV-ONE', level: 'C' }],
  });
  const errors = validateGovernanceConfig(
    featureDoc,
    { schemaVersion: 1, entries: [commandEntry('cmd-a'), commandEntry('cmd-b')] },
    emptyGuards,
    { packageScripts: { 'smoke:local': `bash ${ARTIFACT}` } },
  );
  assert.ok(errors.some((error) => error.includes('CATALOG_DUPLICATE_PROOF_SOURCE')));
});

test('a pnpm alias and its bash equivalent are one command proof source', () => {
  const packageScripts = { 'smoke:local': `bash ${ARTIFACT}` };
  const viaPnpm = { id: 'a', command: 'pnpm smoke:local', location: { file: ARTIFACT } };
  const viaBash = { id: 'b', command: `bash ${ARTIFACT}`, location: { file: ARTIFACT } };
  const proof = { invariantId: 'INV-ONE', level: 'C' };
  assert.equal(
    proofSourceId(viaPnpm, proof, { packageScripts }),
    proofSourceId(viaBash, proof, { packageScripts }),
  );
});

test('one test proving two different invariants stays valid', () => {
  const errors = validateGovernanceConfig(featureDoc, {
    schemaVersion: 1,
    entries: [testEntry('entry-multi', 'same test', [
      { invariantId: 'INV-ONE', level: 'C' },
      { invariantId: 'INV-TWO', level: 'C' },
    ])],
  }, emptyGuards);
  assert.deepEqual(errors.filter((error) => error.includes('DUPLICATE_PROOF_SOURCE')), []);
});

test('the same test may hold distinct A and C proof identities for one invariant', () => {
  const entry = { id: 'e', location: { file: 'x.test.ts', testName: 'same test' } };
  assert.notEqual(
    proofSourceId(entry, { invariantId: 'INV-ONE', level: 'A' }),
    proofSourceId(entry, { invariantId: 'INV-ONE', level: 'C' }),
  );
});

test('realizeEvidence defensively dedups duplicate proof sources', () => {
  const aliasA = testEntry('alias-a', 'same test', [{ invariantId: 'INV-ONE', level: 'C' }]);
  const aliasB = testEntry('alias-b', 'same test', [{ invariantId: 'INV-ONE', level: 'C' }]);
  const item = {
    feature: { id: 'feature.one', invariants: [{ id: 'INV-ONE', statement: 'one', requiredEvidence: { C: 2 } }] },
    reason: 'DIRECT',
    plan: { selected: [aliasA, aliasB], gaps: [] },
  };
  const evidence = realizeEvidence({
    features: [item],
    executionResults: [{ runId: 'run-001', gate: 1, entryStatuses: { 'alias-a': 'PASSED', 'alias-b': 'PASSED' } }],
  });
  const invariant = evidence.features[0].invariants[0];
  assert.equal(invariant.potential.C, 1);
  assert.equal(invariant.realized.C, 1);
  assert.equal(invariant.satisfied, false);
  assert.equal(evidence.allSatisfied, false);
});

// ── Blocker 3: deletions and renames ────────────────────────────────────────

test('name-status output parses adds, modifies, deletes, and renames', () => {
  const changes = parseNameStatus([
    'A\tapps/agent/src/added.ts',
    'M\tapps/agent/src/modified.ts',
    'D\tapps/agent/src/deleted.ts',
    'R094\tapps/agent/src/old.ts\tapps/agent/src/new.ts',
  ].join('\n'));
  assert.deepEqual(changes, [
    { status: 'A', path: 'apps/agent/src/added.ts' },
    { status: 'M', path: 'apps/agent/src/modified.ts' },
    { status: 'D', path: 'apps/agent/src/deleted.ts' },
    { status: 'R', oldPath: 'apps/agent/src/old.ts', newPath: 'apps/agent/src/new.ts' },
  ]);
  assert.deepEqual(changedPathsOf(changes), [
    'apps/agent/src/added.ts',
    'apps/agent/src/modified.ts',
    'apps/agent/src/deleted.ts',
    'apps/agent/src/old.ts',
    'apps/agent/src/new.ts',
  ]);
});

function gitFixture(steps) {
  const repo = mkdtempSync(join(tmpdir(), 'pi-ops-gitfixture-'));
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'governance@example.com']);
  git(['config', 'user.name', 'Governance Test']);
  mkdirSync(join(repo, 'apps/agent/src'), { recursive: true });
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'apps/agent/src/kept.ts'), 'export const kept = 1;\n');
  writeFileSync(join(repo, 'apps/agent/src/critical-service.ts'), 'export const critical = 1;\n');
  writeFileSync(join(repo, 'docs/notes.md'), 'notes\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']).trim();
  steps(git, repo);
  git(['add', '-A']);
  git(['commit', '-qm', 'change']);
  return { repo, base, planning: createPlanning(repo), cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

test('a deleted production file stays visible to real git change discovery', () => {
  const fixture = gitFixture((git) => git(['rm', '-q', 'apps/agent/src/critical-service.ts']));
  try {
    const changes = fixture.planning.changedEntries({ base: fixture.base, head: 'HEAD', files: [] });
    assert.deepEqual(changes, [{ status: 'D', path: 'apps/agent/src/critical-service.ts' }]);
  } finally {
    fixture.cleanup();
  }
});

test('a real git rename yields both old and new paths', () => {
  const fixture = gitFixture((git) => git(['mv', 'apps/agent/src/critical-service.ts', 'apps/agent/src/renamed-service.ts']));
  try {
    const changes = fixture.planning.changedEntries({ base: fixture.base, head: 'HEAD', files: [] });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].status, 'R');
    assert.deepEqual(changedPathsOf(changes), [
      'apps/agent/src/critical-service.ts',
      'apps/agent/src/renamed-service.ts',
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('a deleted governed production file still affects its owning Feature', () => {
  const feature = {
    id: 'owner', paths: ['apps/agent/src/critical-service.ts'],
    invariants: [{ id: 'INV-OWN', statement: 'own', requiredEvidence: { C: 1 } }],
  };
  const paths = changedPathsOf([{ status: 'D', path: 'apps/agent/src/critical-service.ts' }]);
  const affected = resolveAffectedFeatures(paths, [feature]);
  assert.equal(affected.length, 1);
  assert.equal(affected[0].reason, 'DIRECT');
});

test('a deleted unmapped governed production file is UNMAPPED_PRODUCTION_CHANGE', () => {
  const unmapped = findUnmappedProductionFiles(
    changedPathsOf([{ status: 'D', path: 'apps/agent/src/orphan.ts' }]),
    [{ id: 'other', paths: ['apps/agent/src/kept.ts'], invariants: [] }],
    { governedRoots: ['apps/*/src/**'], unmappedIgnore: ['docs/**'] },
  );
  assert.deepEqual(unmapped, ['apps/agent/src/orphan.ts']);
});

test('a rename across Features includes both Features', () => {
  const featureA = { id: 'a', paths: ['apps/agent/src/a.ts'], invariants: [] };
  const featureB = { id: 'b', paths: ['apps/agent/src/b.ts'], invariants: [] };
  const paths = changedPathsOf([{ status: 'R', oldPath: 'apps/agent/src/a.ts', newPath: 'apps/agent/src/b.ts' }]);
  const affected = resolveAffectedFeatures(paths, [featureA, featureB]).map((item) => item.feature.id);
  assert.deepEqual(affected, ['a', 'b']);
});

test('renaming mapped production into an unmapped production path fails closed', () => {
  const feature = { id: 'a', paths: ['apps/agent/src/a.ts'], invariants: [] };
  const paths = changedPathsOf([{ status: 'R', oldPath: 'apps/agent/src/a.ts', newPath: 'apps/agent/src/new-unmapped.ts' }]);
  assert.deepEqual(resolveAffectedFeatures(paths, [feature]).map((item) => item.feature.id), ['a']);
  assert.deepEqual(
    findUnmappedProductionFiles(paths, [feature], { governedRoots: ['apps/*/src/**'], unmappedIgnore: [] }),
    ['apps/agent/src/new-unmapped.ts'],
  );
});

test('renaming production out to docs still governs the old production path', () => {
  const feature = { id: 'a', paths: ['apps/agent/src/a.ts'], invariants: [] };
  const paths = changedPathsOf([{ status: 'R', oldPath: 'apps/agent/src/a.ts', newPath: 'docs/a.md' }]);
  assert.deepEqual(resolveAffectedFeatures(paths, [feature]).map((item) => item.feature.id), ['a']);
});

test('a docs deletion creates no production mapping', () => {
  const feature = { id: 'a', paths: ['apps/agent/src/a.ts'], invariants: [] };
  const paths = changedPathsOf([{ status: 'D', path: 'docs/notes.md' }]);
  assert.deepEqual(resolveAffectedFeatures(paths, [feature]), []);
  assert.deepEqual(
    findUnmappedProductionFiles(paths, [feature], { governedRoots: ['apps/*/src/**'], unmappedIgnore: ['docs/**'] }),
    [],
  );
});

// ── Blocker 4: strict execution shape union ─────────────────────────────────

test('an entry with both testName and command is rejected', () => {
  const errors = validateGovernanceConfig(featureDoc, {
    schemaVersion: 1,
    entries: [{
      id: 'both', featureId: 'feature.one', status: 'ACTIVE', executionClass: 'UNIT',
      command: 'pnpm smoke:local',
      location: { file: 'apps/agent/src/__tests__/x.test.ts', testName: 'name' },
      proofs: [],
    }],
  }, emptyGuards);
  assert.ok(errors.some((error) => error.includes('CATALOG_AMBIGUOUS_EXECUTION_SHAPE')));
  assert.equal(catalogEntryKind({ command: 'x', location: { file: 'f', testName: 't' } }), 'AMBIGUOUS');
});

test('an entry with neither testName nor command is rejected', () => {
  const errors = validateGovernanceConfig(featureDoc, {
    schemaVersion: 1,
    entries: [{
      id: 'neither', featureId: 'feature.one', status: 'ACTIVE', executionClass: 'UNIT',
      location: { file: 'deploy/local/smoke.sh' }, proofs: [],
    }],
  }, emptyGuards);
  assert.ok(errors.some((error) => error.includes('exactly one executable shape')));
});

test('a missing executionClass is rejected for test and command entries', () => {
  const errors = validateGovernanceConfig(featureDoc, {
    schemaVersion: 1,
    entries: [
      { id: 'test-no-class', featureId: 'feature.one', status: 'ACTIVE', location: { file: 'x.test.ts', testName: 'n' }, proofs: [] },
      { id: 'cmd-no-class', featureId: 'feature.one', status: 'ACTIVE', command: 'pnpm smoke:local', location: { file: ARTIFACT }, proofs: [] },
    ],
  }, emptyGuards);
  assert.ok(errors.some((error) => error.includes('test-no-class: executionClass is required')));
  assert.ok(errors.some((error) => error.includes('cmd-no-class: executionClass is required')));
});

test('an unknown executionClass is rejected', () => {
  const errors = validateGovernanceConfig(featureDoc, {
    schemaVersion: 1,
    entries: [{
      id: 'bad-class', featureId: 'feature.one', status: 'ACTIVE', executionClass: 'E2E',
      location: { file: 'x.test.ts', testName: 'n' }, proofs: [],
    }],
  }, emptyGuards);
  assert.ok(errors.some((error) => error.includes('executionClass is required')));
});

test('an unknown execution class can never default to Gate 1', () => {
  assert.throws(() => gateForExecutionClass('E2E'), /UNKNOWN_EXECUTION_CLASS/);
  assert.throws(() => gateForExecutionClass(undefined), /UNKNOWN_EXECUTION_CLASS/);
  assert.equal(gateForExecutionClass('UNIT'), 1);
  assert.equal(gateForExecutionClass('LIVE_PROVIDER'), 4);
});

test('valid TEST and COMMAND entries stay valid', () => {
  const errors = validateGovernanceConfig(
    featureDoc,
    {
      schemaVersion: 1,
      entries: [
        testEntry('good-test', 'a test', [{ invariantId: 'INV-ONE', level: 'C' }]),
        {
          id: 'good-command', featureId: 'feature.one', status: 'ACTIVE', executionClass: 'SMOKE',
          command: 'pnpm smoke:local', location: { file: ARTIFACT },
          proofs: [{ invariantId: 'INV-TWO', level: 'C' }],
        },
      ],
    },
    emptyGuards,
    { packageScripts: { 'smoke:local': `bash ${ARTIFACT}` } },
  );
  assert.deepEqual(errors, []);
});

// ── Blocker 5: dependency / build configuration governance ──────────────────

function realFeatures() {
  return JSON.parse(readFileSync(join(ROOT, 'tools/test-governance/config/features.json'), 'utf8'));
}

test('root package.json and lockfile are governed by build.configuration', () => {
  const doc = realFeatures();
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json']) {
    const affected = resolveAffectedFeatures([file], doc.features);
    assert.ok(
      affected.some((item) => item.feature.id === 'build.configuration' && item.reason === 'DIRECT'),
      `${file} must be DIRECT for build.configuration`,
    );
  }
});

test('dependency configuration changes are never silently ungoverned', () => {
  const doc = realFeatures();
  const settings = { governedRoots: doc.governedRoots, unmappedIgnore: doc.unmappedIgnore };
  for (const file of ['package.json', 'pnpm-lock.yaml', 'apps/agent/package.json']) {
    assert.deepEqual(findUnmappedProductionFiles([file], doc.features, settings), [], file);
    assert.ok(resolveAffectedFeatures([file], doc.features).length > 0, file);
  }
});

test('package-local manifests propagate to their owning scope', () => {
  const doc = realFeatures();
  const idsFor = (file) => resolveAffectedFeatures([file], doc.features).map((item) => item.feature.id);
  assert.ok(idsFor('apps/pi-runtime/package.json').includes('runtime.boundary'));
  assert.ok(idsFor('apps/node-agent/package.json').includes('node.observation'));
  const protocolIds = idsFor('packages/protocol/package.json');
  assert.ok(protocolIds.includes('protocol.contract'));
  assert.ok(protocolIds.includes('event.ingress'), 'protocol impact propagation must continue');
  for (const file of ['apps/pi-runtime/package.json', 'apps/node-agent/package.json', 'packages/protocol/package.json']) {
    assert.ok(idsFor(file).includes('build.configuration'), file);
  }
});

test('apps/agent/package.json affects build.configuration and Agent behavior Features', () => {
  const doc = realFeatures();
  const affected = resolveAffectedFeatures(['apps/agent/package.json'], doc.features);
  const ids = affected.map((item) => item.feature.id);
  for (const expected of [
    'build.configuration',
    'configuration.fail-closed',
    'persistence.migration',
    'event.ingress',
    'investigation.lifecycle',
    'auth.boundary',
  ]) {
    assert.ok(ids.includes(expected) && affected.find((item) => item.feature.id === expected).reason === 'DIRECT', expected);
  }
  assert.ok(ids.length > 1, 'agent manifest must not map to build.configuration only');
});

test('a docs file with a package-like name is not accidentally governed', () => {
  const doc = realFeatures();
  const settings = { governedRoots: doc.governedRoots, unmappedIgnore: doc.unmappedIgnore };
  for (const file of ['docs/package.json', 'docs/testing/pnpm-lock.yaml']) {
    assert.deepEqual(resolveAffectedFeatures([file], doc.features), [], file);
    assert.deepEqual(findUnmappedProductionFiles([file], doc.features, settings), [], file);
  }
});

// ── Blocker 6: AST-based test discovery ─────────────────────────────────────

test('a regex literal cannot fabricate a catalog test', () => {
  const source = [
    "const re = /it('critical regression')/;",
    "const re2 = /test('other ghost')/g;",
    "it('real one', () => {});",
  ].join('\n');
  assert.deepEqual(extractTestNames(source, 'x.test.ts'), ['real one']);
});

test('member and suffixed calls cannot fabricate a catalog test', () => {
  const source = [
    "obj.it('ghost');",
    "foo.test('ghost');",
    "submit('ghost');",
    "describe('suite', () => { it('real', () => {}); });",
  ].join('\n');
  assert.deepEqual(extractTestNames(source, 'x.test.ts'), ['real']);
});

test('comments and strings cannot fabricate a catalog test', () => {
  const source = [
    "// it('line ghost', () => {});",
    '/* it("block ghost", () => {}); */',
    'const s = "it(\'string ghost\')";',
    'const t = `test(\'template ghost\')`;',
    "test('real mjs test', () => {});",
  ].join('\n');
  assert.deepEqual(extractTestNames(source, 'x.test.mjs'), ['real mjs test']);
});

test('dynamic test names are not executable declarations', () => {
  const source = [
    'const name = "dyn";',
    'it(name, () => {});',
    'it(`prefix ${name}`, () => {});',
    "it('static only', () => {});",
  ].join('\n');
  assert.deepEqual(extractTestNames(source, 'x.test.ts'), ['static only']);
});

test('real it and test declarations are still recognized', () => {
  const source = [
    "it('single quoted', () => {});",
    'it("double quoted", () => {});',
    "test('test fn', () => {});",
    'test(`static template`, () => {});',
    "test('with options', { skip: true }, () => {});",
  ].join('\n');
  assert.deepEqual(extractTestNames(source, 'x.test.ts'), [
    'single quoted',
    'double quoted',
    'test fn',
    'static template',
    'with options',
  ]);
});

// ── shared plan helpers ─────────────────────────────────────────────────────

function featureItem(requiredEvidence, selected, reason = 'DIRECT') {
  return {
    feature: { id: 'feature.one', invariants: [{ id: 'INV-ONE', statement: 'one', requiredEvidence }] },
    reason,
    matchedFiles: [],
    plan: { selected, gaps: [] },
  };
}

function policyPlan(items) {
  return {
    base: 'base-sha',
    head: 'head-sha',
    changedFiles: ['apps/agent/src/one.ts'],
    status: 'READY',
    features: items,
    architecture: { status: 'PASS', violations: [] },
    unmappedProductionFiles: [],
  };
}
