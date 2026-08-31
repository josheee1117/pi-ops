import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildExecutionPlan, effectiveMaxGate } from './execution-plan.mjs';
import { executeRuns, parseTapResults } from './runner.mjs';
import { realizeEvidence, resolveGateStatus } from './evidence.mjs';
import { newRunId, writeEvidenceArtifacts } from './artifacts.mjs';
import { collectMachineGaps, evaluateMaintenanceBudget, resolvePlanStatus } from './core.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const FIXTURE = 'tools/test-governance/src/fixtures/runner-fixture.test.mjs';
const COMMAND_OK = 'tools/test-governance/src/fixtures/command-ok.sh';
const COMMAND_FAIL = 'tools/test-governance/src/fixtures/command-fail.sh';

function catalogEntry(id, testName, level = 'C', executionClass = 'UNIT') {
  return {
    id,
    featureId: 'feature.one',
    executionClass,
    location: { file: FIXTURE, testName },
    proofs: [{ invariantId: 'INV-ONE', level }],
  };
}

function featureItem(requiredEvidence, selected, reason = 'DIRECT') {
  return {
    feature: {
      id: 'feature.one',
      invariants: [{ id: 'INV-ONE', statement: 'proof is realized', requiredEvidence }],
    },
    reason,
    matchedFiles: [],
    plan: { selected: selected.map((entry) => ({ ...entry, covers: entry.proofs })), gaps: [] },
  };
}

function policyPlan(items) {
  return {
    base: 'base-sha',
    head: 'head-sha',
    changedFiles: ['apps/example/src/example.ts'],
    status: 'READY',
    features: items,
    architecture: { status: 'PASS', violations: [] },
    unmappedProductionFiles: [],
  };
}

test('execution plan maps a selected TEST_NAME entry to a deterministic test-file run', () => {
  const entry = catalogEntry('entry-pass', 'runner observes a passing selected test');
  const plan = buildExecutionPlan({ plan: policyPlan([featureItem({ C: 1 }, [entry])]), catalogEntries: [entry] });
  assert.equal(plan.runs.length, 1);
  assert.equal(plan.runs[0].kind, 'TEST_FILE');
  assert.equal(plan.runs[0].file, FIXTURE);
  assert.deepEqual(plan.runs[0].testNames, ['runner observes a passing selected test']);
  assert.equal(plan.runs[0].gate, 1);
});

test('execution plan fails closed when a selected entry is absent from the validated catalog', () => {
  const entry = catalogEntry('missing-entry', 'runner observes a passing selected test');
  assert.throws(
    () => buildExecutionPlan({ plan: policyPlan([featureItem({ C: 1 }, [entry])]), catalogEntries: [] }),
    /selected catalog entry is missing/,
  );
});

test('execution plan maps a selected command entry', () => {
  const entry = {
    id: 'command-pass', featureId: 'feature.one', executionClass: 'SMOKE',
    command: `bash ${COMMAND_OK}`, location: { file: COMMAND_OK },
    proofs: [{ invariantId: 'INV-ONE', level: 'A' }],
  };
  const plan = buildExecutionPlan({ plan: policyPlan([featureItem({ A: 1 }, [entry])]), catalogEntries: [entry] });
  assert.equal(plan.runs.length, 1);
  assert.equal(plan.runs[0].kind, 'COMMAND');
  assert.equal(plan.runs[0].gate, 3);
  assert.equal(plan.runs[0].executable, 'bash');
  assert.deepEqual(plan.runs[0].args, [COMMAND_OK]);
});

test('identical command entries deduplicate to one underlying run', () => {
  const entries = ['a', 'b'].map((id) => ({
    id, featureId: 'feature.one', executionClass: 'UNIT', command: `bash ${COMMAND_OK}`,
    location: { file: COMMAND_OK }, proofs: [{ invariantId: 'INV-ONE', level: 'C' }],
  }));
  const plan = buildExecutionPlan({ plan: policyPlan([featureItem({ C: 1 }, entries)]), catalogEntries: entries });
  assert.equal(plan.runs.length, 1);
  assert.deepEqual(plan.runs[0].entries.map((entry) => entry.id), ['a', 'b']);
});

test('identical exact tests deduplicate to one file run and one test name', () => {
  const entries = ['a', 'b'].map((id) => catalogEntry(id, 'runner observes a passing selected test'));
  const plan = buildExecutionPlan({ plan: policyPlan([featureItem({ C: 1 }, entries)]), catalogEntries: entries });
  assert.equal(plan.runs.length, 1);
  assert.deepEqual(plan.runs[0].testNames, ['runner observes a passing selected test']);
});

test('runner executes a validated command once and maps its result to every entry', () => {
  const entries = ['command-a', 'command-b'].map((id) => ({
    id, featureId: 'feature.one', executionClass: 'UNIT', command: `bash ${COMMAND_OK}`,
    location: { file: COMMAND_OK }, proofs: [{ invariantId: 'INV-ONE', level: 'C' }],
  }));
  const executionPlan = buildExecutionPlan({ plan: policyPlan([featureItem({ C: 1 }, entries)]), catalogEntries: entries });
  const [result] = executeRuns(executionPlan, { repoRoot: ROOT });
  assert.equal(executionPlan.runs.length, 1);
  assert.equal(result.status, 'PASSED');
  assert.match(result.stdout, /command-proof/);
  assert.deepEqual(result.entryStatuses, { 'command-a': 'PASSED', 'command-b': 'PASSED' });
});

test('a failing command realizes no successful execution', () => {
  const entry = {
    id: 'command-fail', featureId: 'feature.one', executionClass: 'UNIT', command: `bash ${COMMAND_FAIL}`,
    location: { file: COMMAND_FAIL }, proofs: [{ invariantId: 'INV-ONE', level: 'C' }],
  };
  const executionPlan = buildExecutionPlan({ plan: policyPlan([featureItem({ C: 1 }, [entry])]), catalogEntries: [entry] });
  const [result] = executeRuns(executionPlan, { repoRoot: ROOT });
  assert.equal(result.exitCode, 7);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.entryStatuses[entry.id], 'FAILED');
});

test('runner executes the real selected test and observes its TAP result', () => {
  const entry = catalogEntry('entry-pass', 'runner observes a passing selected test');
  const executionPlan = buildExecutionPlan({ plan: policyPlan([featureItem({ C: 1 }, [entry])]), catalogEntries: [entry] });
  const [result] = executeRuns(executionPlan, { repoRoot: ROOT });
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'PASSED');
  assert.equal(result.entryStatuses[entry.id], 'PASSED');
});

test('selected test not observed cannot PASS even when the test command exits zero', () => {
  const entry = catalogEntry('entry-missing', 'this selected test does not exist');
  const executionPlan = buildExecutionPlan({ plan: policyPlan([featureItem({ C: 1 }, [entry])]), catalogEntries: [entry] });
  const [result] = executeRuns(executionPlan, { repoRoot: ROOT });
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'NOT_RUN');
  assert.equal(result.entryStatuses[entry.id], 'NOT_RUN');
});

test('a skipped selected test cannot PASS', () => {
  const entry = catalogEntry('entry-skip', 'runner observes a skipped selected test');
  const executionPlan = buildExecutionPlan({ plan: policyPlan([featureItem({ C: 1 }, [entry])]), catalogEntries: [entry] });
  const [result] = executeRuns(executionPlan, { repoRoot: ROOT });
  assert.equal(result.status, 'SKIPPED');
  assert.equal(result.entryStatuses[entry.id], 'SKIPPED');
});

test('a failing selected test fails its run', () => {
  const entry = catalogEntry('entry-fail', 'runner observes a conditional failure');
  const executionPlan = buildExecutionPlan({ plan: policyPlan([featureItem({ C: 1 }, [entry])]), catalogEntries: [entry] });
  const [result] = executeRuns(executionPlan, { repoRoot: ROOT, env: { TEST_GOVERNANCE_FORCE_FAILURE: '1' } });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.entryStatuses[entry.id], 'FAILED');
});

test('TAP parser distinguishes pass, fail, and skip directives', () => {
  assert.deepEqual(parseTapResults('ok 1 - pass\nnot ok 2 - fail\nok 3 - skip # SKIP disabled\n'), [
    { name: 'pass', ok: true, directive: null },
    { name: 'fail', ok: false, directive: null },
    { name: 'skip', ok: true, directive: 'SKIP' },
  ]);
});

test('PASS execution realizes its declared proof', () => {
  const entry = catalogEntry('entry-pass', 'runner observes a passing selected test');
  const item = featureItem({ C: 1 }, [entry]);
  const evidence = realizeEvidence({
    features: [item],
    executionResults: [{ runId: 'run-1', gate: 1, entryStatuses: { [entry.id]: 'PASSED' } }],
  });
  assert.equal(evidence.allSatisfied, true);
  assert.deepEqual(evidence.features[0].invariants[0].realized, { A: 0, B: 0, C: 1 });
});

test('FAILED and NOT_RUN executions realize no proof', () => {
  for (const status of ['FAILED', 'NOT_RUN']) {
    const entry = catalogEntry(`entry-${status}`, 'runner observes a passing selected test');
    const evidence = realizeEvidence({
      features: [featureItem({ C: 1 }, [entry])],
      executionResults: [{ runId: 'run-1', gate: 1, entryStatuses: { [entry.id]: status } }],
    });
    assert.equal(evidence.allSatisfied, false);
    assert.deepEqual(evidence.features[0].invariants[0].realized, { A: 0, B: 0, C: 0 });
  }
});

test('C evidence cannot satisfy an A requirement', () => {
  const entry = catalogEntry('entry-c', 'runner observes a passing selected test', 'C');
  const evidence = realizeEvidence({
    features: [featureItem({ A: 1 }, [entry])],
    executionResults: [{ runId: 'run-1', gate: 1, entryStatuses: { [entry.id]: 'PASSED' } }],
  });
  assert.equal(evidence.allSatisfied, false);
  assert.equal(evidence.features[0].invariants[0].realized.A, 0);
  assert.equal(evidence.features[0].invariants[0].realized.C, 1);
});

test('a potential A proof whose execution fails does not realize A', () => {
  const entry = catalogEntry('entry-a', 'runner observes a conditional failure', 'A');
  const evidence = realizeEvidence({
    features: [featureItem({ A: 1 }, [entry])],
    executionResults: [{ runId: 'run-1', gate: 1, entryStatuses: { [entry.id]: 'FAILED' } }],
  });
  assert.equal(evidence.features[0].invariants[0].potential.A, 1);
  assert.equal(evidence.features[0].invariants[0].realized.A, 0);
  assert.equal(evidence.allSatisfied, false);
});

test('policy failures prevent gate PASS before execution evidence is considered', () => {
  for (const policyStatus of ['NEEDS_EVIDENCE', 'ARCHITECTURE_VIOLATION', 'UNMAPPED_PRODUCTION_CHANGE']) {
    assert.equal(resolveGateStatus({ policyStatus, executionResults: [], evidence: { allSatisfied: true } }), 'POLICY_BLOCKED');
  }
});

test('execution failure and missing realized evidence have distinct gate states', () => {
  assert.equal(resolveGateStatus({
    policyStatus: 'READY', executionResults: [{ status: 'FAILED' }], evidence: { allSatisfied: false, features: [] },
  }), 'EXECUTION_FAILED');
  assert.equal(resolveGateStatus({
    policyStatus: 'READY', executionResults: [{ status: 'NOT_RUN' }],
    evidence: { allSatisfied: false, features: [{ invariants: [{ satisfied: false, liveProviderBlocked: false }] }] },
  }), 'EVIDENCE_NOT_REALIZED');
});

test('Gate 4 requires both max-gate 4 and explicit live-provider authorization', () => {
  assert.equal(effectiveMaxGate(4, false), 3);
  assert.equal(effectiveMaxGate(3, true), 3);
  assert.equal(effectiveMaxGate(4, true), 4);
  const entry = catalogEntry('live', 'runner observes a passing selected test', 'C', 'LIVE_PROVIDER');
  const executionPlan = buildExecutionPlan({
    plan: policyPlan([featureItem({ C: 1 }, [entry])]), catalogEntries: [entry], maxGate: 4, allowLiveProvider: false,
  });
  const results = executeRuns(executionPlan, { repoRoot: ROOT });
  const evidence = realizeEvidence({ features: policyPlan([featureItem({ C: 1 }, [entry])]).features, executionResults: results });
  assert.equal(results[0].status, 'NOT_RUN');
  assert.equal(resolveGateStatus({ policyStatus: 'READY', executionResults: results, evidence }), 'LIVE_PROVIDER_REQUIRED');
});

test('impact-selected proofs participate in realized evidence', () => {
  const entry = catalogEntry('impacted-pass', 'runner observes a passing selected test');
  const item = featureItem({ C: 1 }, [entry], 'IMPACTED_BY protocol.contract');
  const executionPlan = buildExecutionPlan({ plan: policyPlan([item]), catalogEntries: [entry] });
  const results = executeRuns(executionPlan, { repoRoot: ROOT });
  const evidence = realizeEvidence({ features: [item], executionResults: results });
  assert.equal(evidence.features[0].reason, 'IMPACTED_BY protocol.contract');
  assert.equal(evidence.allSatisfied, true);
});

test('multiple impacted parents do not duplicate an underlying execution', () => {
  const entry = catalogEntry('multi-impact', 'runner observes a passing selected test');
  const item = featureItem({ C: 1 }, [entry], 'IMPACTED_BY evidence.model-safe-projection,protocol.contract');
  const executionPlan = buildExecutionPlan({ plan: policyPlan([item]), catalogEntries: [entry] });
  assert.equal(executionPlan.runs.length, 1);
});

test('evidence artifacts contain base/head/run identity and every required file', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-ops-evidence-'));
  try {
    const plan = policyPlan([]);
    const runId = newRunId(new Date('2026-01-02T03:04:05.000Z'));
    const artifact = writeEvidenceArtifacts({
      repoRoot: root, headSha: 'abc123', runId, gateStatus: 'PASS', plan,
      executionPlan: { schemaVersion: 1, base: plan.base, head: plan.head, runs: [] },
      executionResults: [], evidence: { features: [], allSatisfied: true },
      staticChecks: { config: 'PASS' }, error: null,
    });
    for (const name of ['plan.json', 'execution-plan.json', 'execution.json', 'evidence.json', 'summary.md']) {
      assert.ok(artifact.files.some((file) => file.endsWith(name)), name);
    }
    for (const name of ['plan.json', 'execution-plan.json', 'execution.json', 'evidence.json']) {
      const value = JSON.parse(readFileSync(join(artifact.dir, name), 'utf8'));
      assert.equal(value.runId, runId);
      assert.equal(value.headSha, 'abc123');
      assert.equal(value.base, 'base-sha');
      assert.equal(value.head, 'head-sha');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh run identities prevent an old artifact from becoming current proof', () => {
  const first = newRunId(new Date('2026-01-02T03:04:05.000Z'));
  const second = newRunId(new Date('2026-01-02T03:04:05.000Z'));
  assert.notEqual(first, second);
});

test('maintenance budget semantics remain independent of execution', () => {
  const reused = evaluateMaintenanceBudget({ budget: 5, actions: Array.from({ length: 10 }, () => ({ type: 'REUSE' })) });
  const created = evaluateMaintenanceBudget({ budget: 5, actions: [{ type: 'CREATE', cost: 6 }] });
  assert.equal(reused.plannedMaintenanceDelta, 0);
  assert.equal(reused.budgetStatus, 'WITHIN_BUDGET');
  assert.equal(created.budgetStatus, 'BUDGET_EXCEEDED');
});

test('policy state precedence still fails closed', () => {
  assert.equal(resolvePlanStatus({ architectureViolations: [{}], unmappedProductionFiles: ['x'], hasGaps: true, budgetExceeded: true }), 'ARCHITECTURE_VIOLATION');
  assert.equal(resolvePlanStatus({ architectureViolations: [], unmappedProductionFiles: ['x'], hasGaps: false, budgetExceeded: false }), 'UNMAPPED_PRODUCTION_CHANGE');
});

test('the accepted machine gap set remains exactly three', () => {
  const features = JSON.parse(readFileSync(join(ROOT, 'tools/test-governance/config/features.json'), 'utf8'));
  const catalog = JSON.parse(readFileSync(join(ROOT, 'tools/test-governance/config/catalog.json'), 'utf8'));
  assert.deepEqual(collectMachineGaps(features.features, catalog.entries), [
    { featureId: 'evidence.collection', invariantId: 'INV-EVD-02', level: 'A', missing: 1 },
    { featureId: 'evidence.model-safe-projection', invariantId: 'INV-SAFE-01', level: 'A', missing: 1 },
    { featureId: 'investigation.reconciliation', invariantId: 'INV-STALE-01', level: 'A', missing: 1 },
  ]);
});
