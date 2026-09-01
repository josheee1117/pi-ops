import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTrust } from './check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER_SOURCE = readFileSync(join(HERE, 'check.mjs'), 'utf8');
const WORKFLOW_SOURCE = readFileSync(join(HERE, '../../../.github/workflows/governance-trust-anchor.yml'), 'utf8');

function pkg({ smoke = 'bash deploy/local/smoke.sh', extraScripts = {} } = {}) {
  return {
    name: 'fixture',
    private: true,
    packageManager: 'pnpm@10.15.0',
    engines: { node: '>=22' },
    scripts: {
      'test:gate': 'node tools/test-governance/src/cli.mjs gate',
      'test:plan': 'node tools/test-governance/src/cli.mjs plan',
      'test:run': 'node tools/test-governance/src/cli.mjs run',
      'test:arch': 'node tools/test-governance/src/cli.mjs arch',
      'test:governance': 'pnpm test:governance:self',
      'test:governance:self': 'node --test tools/test-governance/src/*.test.mjs',
      'smoke:local': smoke,
      ...extraScripts,
    },
    devDependencies: { typescript: '^5.9.3' },
  };
}

function featuresDoc(invariantIds = ['INV-X']) {
  return {
    schemaVersion: 1,
    trustRootVersion: 1,
    features: [
      {
        id: 'demo.feature',
        riskClass: 'low',
        riskScore: 1,
        maintenanceBudget: 4,
        paths: ['apps/foo/src/**'],
        invariants: invariantIds.map((id) => ({
          id,
          statement: id,
          requiredEvidence: { A: 1 },
        })),
      },
    ],
  };
}

function testEntry({
  id = 'proof-test',
  status = 'ACTIVE',
  invariantId = 'INV-X',
  level = 'A',
  file = 'apps/foo/src/__tests__/a.test.ts',
  testName = 'real assertion',
} = {}) {
  return {
    id,
    featureId: 'demo.feature',
    status,
    maintenanceCost: 1,
    executionClass: 'UNIT',
    location: { file, testName },
    proofs: [{ invariantId, level }],
  };
}

function commandEntry({
  id = 'proof-smoke',
  status = 'ACTIVE',
  invariantId = 'INV-X',
  level = 'A',
  file = 'deploy/local/smoke.sh',
  command = 'pnpm smoke:local',
} = {}) {
  return {
    id,
    featureId: 'demo.feature',
    status,
    maintenanceCost: 1,
    executionClass: 'SMOKE',
    command,
    location: { file },
    proofs: [{ invariantId, level }],
  };
}

function catalog(entries) {
  return { schemaVersion: 1, entries };
}

function writeJson(repo, relative, value) {
  writeFileSync(join(repo, relative), `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(seed, mutate) {
  const repo = mkdtempSync(join(tmpdir(), 'pi-ops-anchor-'));
  const gitCmd = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  gitCmd(['init', '-q']);
  gitCmd(['config', 'user.email', 'governance@example.com']);
  gitCmd(['config', 'user.name', 'Governance Test']);
  mkdirSync(join(repo, 'apps/foo/src/__tests__'), { recursive: true });
  mkdirSync(join(repo, 'tools/test-governance/src'), { recursive: true });
  mkdirSync(join(repo, 'tools/test-governance/config'), { recursive: true });
  mkdirSync(join(repo, 'tools/test-governance/trust-anchor'), { recursive: true });
  mkdirSync(join(repo, 'deploy/local'), { recursive: true });
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(repo, 'apps/foo/src/app.ts'), 'export const app = 1;\n');
  writeFileSync(join(repo, 'apps/foo/src/__tests__/a.test.ts'), 'test("real assertion", () => { assert.equal(1, 1); });\n');
  writeFileSync(join(repo, 'deploy/local/smoke.sh'), '#!/bin/sh\nexit 1\n');
  writeFileSync(join(repo, 'tools/test-governance/src/gate.mjs'), 'export const gate = 1;\n');
  writeFileSync(join(repo, 'tools/test-governance/trust-anchor/check.mjs'), CHECKER_SOURCE);
  writeFileSync(join(repo, '.github/workflows/governance-trust-anchor.yml'), WORKFLOW_SOURCE);
  writeFileSync(join(repo, '.github/workflows/test-governance.yml'), 'name: Test Governance Gate\n');
  writeJson(repo, 'package.json', pkg());
  writeJson(repo, 'tools/test-governance/config/features.json', featuresDoc());
  writeJson(repo, 'tools/test-governance/config/architecture-guards.json', { schemaVersion: 1, guards: [] });
  writeJson(repo, 'tools/test-governance/config/catalog.json', catalog(seed.entries ?? [testEntry()]));
  gitCmd(['add', '-A']);
  gitCmd(['commit', '-qm', 'base']);
  const base = gitCmd(['rev-parse', 'HEAD']);
  mutate(repo);
  gitCmd(['add', '-A']);
  gitCmd(['commit', '-qm', 'head']);
  const head = gitCmd(['rev-parse', 'HEAD']);
  return {
    repo,
    base,
    head,
    cleanup: () => rmSync(repo, { recursive: true, force: true }),
  };
}

function run(fx) {
  return checkTrust({ cwd: fx.repo, base: fx.base, head: fx.head });
}

test('A. product-only change is PASS', () => {
  const fx = fixture({}, (repo) => {
    writeFileSync(join(repo, 'apps/foo/src/app.ts'), 'export const app = 2;\n');
  });
  try {
    const result = run(fx);
    assert.equal(result.status, 'PASS');
    assert.deepEqual(result.trustSurface.findings, []);
    assert.deepEqual(result.proofIntegrity.changedSources, []);
    assert.deepEqual(result.proofIntegrity.newProofs, []);
  } finally {
    fx.cleanup();
  }
});

test('B. Governance Engine modification requires review', () => {
  const fx = fixture({}, (repo) => {
    writeFileSync(join(repo, 'tools/test-governance/src/gate.mjs'), 'export const gate = 2;\n');
  });
  try {
    const result = run(fx);
    assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
    assert.ok(result.trustSurface.findings.some((item) => item.kind === 'GOVERNANCE_ENGINE_CHANGED'));
  } finally {
    fx.cleanup();
  }
});

test('C. HEAD anchor modification is detected by the BASE checker', () => {
  const fx = fixture({}, (repo) => {
    writeFileSync(join(repo, 'tools/test-governance/trust-anchor/check.mjs'), 'console.log(JSON.stringify({ status: "PASS" }));\n');
  });
  try {
    const baseChecker = join(fx.repo, 'base-checker.mjs');
    writeFileSync(baseChecker, execFileSync('git', ['show', `${fx.base}:tools/test-governance/trust-anchor/check.mjs`], { cwd: fx.repo, encoding: 'utf8' }));
    const spawned = spawnSync(process.execPath, [baseChecker, '--base', fx.base, '--head', fx.head, '--json', '--cwd', fx.repo], {
      encoding: 'utf8',
    });
    assert.notEqual(spawned.status, 0);
    const result = JSON.parse(spawned.stdout);
    assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
    assert.ok(result.trustSurface.findings.some((item) => item.kind === 'GOVERNANCE_ANCHOR_CHANGED'));
  } finally {
    fx.cleanup();
  }
});

test('D. governance workflow modification requires review', () => {
  const fx = fixture({}, (repo) => {
    writeFileSync(join(repo, '.github/workflows/governance-trust-anchor.yml'), `${WORKFLOW_SOURCE}\n# changed\n`);
  });
  try {
    const result = run(fx);
    assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
    assert.ok(result.trustSurface.findings.some((item) => item.kind === 'GOVERNANCE_WORKFLOW_CHANGED'));
  } finally {
    fx.cleanup();
  }
});

test('E. same test name with changed body requires proof source review', () => {
  const fx = fixture({}, (repo) => {
    writeFileSync(join(repo, 'apps/foo/src/__tests__/a.test.ts'), 'test("real assertion", () => { assert.ok(true); });\n');
  });
  try {
    const result = run(fx);
    assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
    assert.ok(result.proofIntegrity.changedSources.some((item) => item.kind === 'PROOF_SOURCE_CHANGE_REQUIRES_REVIEW'));
  } finally {
    fx.cleanup();
  }
});

test('F. smoke script trivialization requires proof source review', () => {
  const fx = fixture({ entries: [commandEntry()] }, (repo) => {
    writeFileSync(join(repo, 'deploy/local/smoke.sh'), '#!/bin/sh\nexit 0\n');
  });
  try {
    const result = run(fx);
    assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
    assert.ok(result.proofIntegrity.changedSources.some((item) => item.file === 'deploy/local/smoke.sh'));
  } finally {
    fx.cleanup();
  }
});

test('G. command script rebind requires proof source review', () => {
  const fx = fixture({ entries: [commandEntry()] }, (repo) => {
    writeJson(repo, 'package.json', pkg({ smoke: 'bash deploy/local/fake.sh' }));
  });
  try {
    const result = run(fx);
    assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
    assert.ok(result.proofIntegrity.changedSources.some((item) => item.file === 'package.json'));
  } finally {
    fx.cleanup();
  }
});

test('H. new trivial A Proof requires review', () => {
  const fx = fixture({ entries: [] }, (repo) => {
    writeJson(repo, 'tools/test-governance/config/catalog.json', catalog([testEntry({ level: 'A' })]));
  });
  try {
    const result = run(fx);
    assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
    assert.ok(result.proofIntegrity.newProofs.some((item) => item.kind === 'NEW_PROOF_REQUIRES_REVIEW' && item.levels.includes('A')));
  } finally {
    fx.cleanup();
  }
});

test('I. new trivial C Proof requires review', () => {
  const fx = fixture({ entries: [] }, (repo) => {
    writeJson(repo, 'tools/test-governance/config/catalog.json', catalog([testEntry({ level: 'C' })]));
  });
  try {
    const result = run(fx);
    assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
    assert.ok(result.proofIntegrity.newProofs.some((item) => item.kind === 'NEW_PROOF_REQUIRES_REVIEW' && item.levels.includes('C')));
  } finally {
    fx.cleanup();
  }
});

test('J. existing Proof grade change requires review', () => {
  const fx = fixture({ entries: [testEntry({ level: 'C' })] }, (repo) => {
    writeJson(repo, 'tools/test-governance/config/catalog.json', catalog([testEntry({ level: 'A' })]));
  });
  try {
    const result = run(fx);
    assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
    assert.ok(result.proofIntegrity.changedDefinitions.some((item) => item.kind === 'PROOF_DEFINITION_CHANGE_REQUIRES_REVIEW'));
  } finally {
    fx.cleanup();
  }
});

test('K. unchanged BASE accepted Proofs are reused when product code changes', () => {
  const fx = fixture({ entries: [testEntry()] }, (repo) => {
    writeFileSync(join(repo, 'apps/foo/src/app.ts'), 'export const app = 9;\n');
  });
  try {
    const result = run(fx);
    assert.equal(result.status, 'PASS');
    assert.deepEqual(result.proofIntegrity.changedSources, []);
    assert.deepEqual(result.proofIntegrity.changedDefinitions, []);
    assert.deepEqual(result.proofIntegrity.newProofs, []);
  } finally {
    fx.cleanup();
  }
});

test('PINNED proof source changes use the PINNED reason', () => {
  const fx = fixture({ entries: [testEntry({ status: 'PINNED' })] }, (repo) => {
    writeFileSync(join(repo, 'apps/foo/src/__tests__/a.test.ts'), 'test("real assertion", () => { assert.ok(true); });\n');
  });
  try {
    const result = run(fx);
    assert.ok(result.proofIntegrity.changedSources.some((item) => item.kind === 'PINNED_PROOF_SOURCE_CHANGE_REQUIRES_REVIEW'));
  } finally {
    fx.cleanup();
  }
});

test('accepted proof source deletion requires review', () => {
  const fx = fixture({ entries: [testEntry()] }, (repo) => {
    rmSync(join(repo, 'apps/foo/src/__tests__/a.test.ts'));
  });
  try {
    const result = run(fx);
    assert.equal(result.status, 'GOVERNANCE_REVIEW_REQUIRED');
    assert.ok(result.proofIntegrity.changedSources.some((item) => /deleted/.test(item.detail)));
  } finally {
    fx.cleanup();
  }
});

test('policy config modification requires review', () => {
  const fx = fixture({}, (repo) => {
    writeJson(repo, 'tools/test-governance/config/features.json', featuresDoc(['INV-X', 'INV-Y']));
  });
  try {
    const result = run(fx);
    assert.ok(result.trustSurface.findings.some((item) => item.kind === 'GOVERNANCE_POLICY_CHANGED'));
  } finally {
    fx.cleanup();
  }
});

test('protected package entrypoint change requires review', () => {
  const fx = fixture({}, (repo) => {
    writeJson(repo, 'package.json', pkg({ extraScripts: { 'test:gate': 'echo bypass' } }));
  });
  try {
    const result = run(fx);
    assert.ok(result.trustSurface.findings.some((item) => item.kind === 'GOVERNANCE_ENTRYPOINT_CHANGED'));
  } finally {
    fx.cleanup();
  }
});

test('one shared proof source file emits a single source finding', () => {
  const fx = fixture({
    entries: [
      testEntry({ id: 'one', invariantId: 'INV-X', level: 'A' }),
      testEntry({ id: 'two', invariantId: 'INV-X', level: 'C' }),
    ],
  }, (repo) => {
    writeFileSync(join(repo, 'apps/foo/src/__tests__/a.test.ts'), 'test("real assertion", () => { assert.ok(true); });\n');
  });
  try {
    const result = run(fx);
    const sources = result.proofIntegrity.changedSources.filter((item) => item.file === 'apps/foo/src/__tests__/a.test.ts');
    assert.equal(sources.length, 1);
    assert.deepEqual(sources[0].catalogEntryIds, ['one', 'two']);
  } finally {
    fx.cleanup();
  }
});

test('workflow file never checks out or installs HEAD for execution', () => {
  assert.match(WORKFLOW_SOURCE, /pull_request_target/);
  assert.match(WORKFLOW_SOURCE, /github\.event\.pull_request\.base\.sha/);
  assert.match(WORKFLOW_SOURCE, /persist-credentials:\s*false/);
  assert.match(WORKFLOW_SOURCE, /node tools\/test-governance\/trust-anchor\/check\.mjs/);
  const checkout = WORKFLOW_SOURCE.match(/uses: actions\/checkout@v4\n(?:[ \t]+.*\n)+/);
  assert.ok(checkout, 'checkout step is present');
  assert.match(checkout[0], /base\.sha/);
  assert.doesNotMatch(checkout[0], /head\.sha/);
  assert.doesNotMatch(WORKFLOW_SOURCE, /pnpm install/);
  assert.doesNotMatch(WORKFLOW_SOURCE, /npm install/);
  assert.doesNotMatch(WORKFLOW_SOURCE, /pnpm test/);
  assert.doesNotMatch(WORKFLOW_SOURCE, /npm test/);
});
