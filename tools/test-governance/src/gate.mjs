import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildExecutionPlan, effectiveMaxGate } from './execution-plan.mjs';
import { executeRuns } from './runner.mjs';
import { realizeEvidence, resolveGateStatus } from './evidence.mjs';
import { newRunId, writeEvidenceArtifacts } from './artifacts.mjs';
import { createPlanning } from './planning.mjs';

/**
 * Automatic governance gate.
 *
 *   static policy (config, self-tests, typecheck, architecture, unmapped,
 *   evidence floors, budget)  ->  POLICY_BLOCKED unless READY
 *   selected execution         ->  EXECUTION_FAILED on failing/unexecutable runs
 *   realized evidence          ->  EVIDENCE_NOT_REALIZED / LIVE_PROVIDER_REQUIRED
 *   otherwise                   ->  PASS
 *
 * Planner READY (potential proof plan) is intentionally different from
 * Gate PASS (proof actually executed successfully for this change).
 */
export async function runGate(options) {
  const {
    root,
    loadConfig,
    base = 'HEAD~1',
    head = 'HEAD',
    files = [],
    maxGate = 3,
    allowLiveProvider = false,
    skipStatic = false,
  } = options;

  const planning = createPlanning(root);
  const runId = newRunId();
  let headSha = 'unknown';
  try {
    headSha = planning.git(['rev-parse', head]);
  } catch {
    headSha = 'unknown';
  }

  const staticChecks = {
    config: 'PASS',
    selfTests: skipStatic ? 'SKIPPED' : 'PENDING',
    typecheck: skipStatic ? 'SKIPPED' : 'PENDING',
    architecture: 'PENDING',
  };
  let config = null;
  let plan = null;
  let executionPlan = null;
  let executionResults = [];
  let evidence = null;
  let status = 'INTERNAL_ERROR';
  let error = null;

  try {
    try {
      config = loadConfig();
    } catch (configError) {
      staticChecks.config = `FAIL: ${configError instanceof Error ? configError.message : String(configError)}`;
      status = 'POLICY_BLOCKED';
      return finalize();
    }

    if (!skipStatic) {
      const selfTests = runGovernanceSelfTests(root);
      staticChecks.selfTests = selfTests.status;
      if (selfTests.status !== 'PASS') {
        error = `governance self-tests failed:\n${selfTests.output}`;
        status = 'POLICY_BLOCKED';
        return finalize();
      }
      const typecheck = runTypecheck(root);
      staticChecks.typecheck = typecheck.status;
      if (typecheck.status !== 'PASS') {
        error = `typecheck failed:\n${typecheck.output}`;
        status = 'POLICY_BLOCKED';
        return finalize();
      }
    }

    const architectureViolations = planning.evaluateArchitecture(config.guards);
    staticChecks.architecture = architectureViolations.length === 0 ? 'PASS' : 'FAIL';
    plan = planning.buildPlan(config, { base, head, files });

    if (plan.status !== 'READY') {
      error = describePolicyFailure(plan);
      status = 'POLICY_BLOCKED';
      return finalize();
    }

    executionPlan = buildExecutionPlan({
      plan,
      catalogEntries: config.catalog.entries,
      maxGate,
      allowLiveProvider,
      packageScripts: config.packageScripts ?? {},
    });
    executionResults = executeRuns(executionPlan, { repoRoot: root });
    evidence = realizeEvidence({
      features: plan.features,
      executionResults,
      packageScripts: config.packageScripts ?? {},
    });
    status = resolveGateStatus({ policyStatus: plan.status, executionResults, evidence });
    if ((files ?? []).length > 0 && status === 'PASS') {
      // Explicit-files runs skip the base policy delta and the trust surface;
      // they must never masquerade as a trusted commit PASS.
      status = 'EXPLICIT_FILES_UNTRUSTED';
    }
    return finalize();
  } catch (gateError) {
    error = gateError instanceof Error ? gateError.message : String(gateError);
    status = 'INTERNAL_ERROR';
    return finalize();
  }

  function finalize() {
    let artifact = null;
    try {
      artifact = writeEvidenceArtifacts({
        repoRoot: root,
        headSha,
        runId,
        gateStatus: status,
        plan,
        executionPlan,
        executionResults,
        evidence,
        staticChecks,
        error,
      });
    } catch (artifactError) {
      const artifactMessage = artifactError instanceof Error ? artifactError.message : String(artifactError);
      artifact = { dir: null, files: [], error: artifactMessage };
      error = [error, `artifact write failed: ${artifactMessage}`].filter(Boolean).join(' | ');
      status = 'INTERNAL_ERROR';
    }
    return {
      status,
      runId,
      headSha,
      base,
      head,
      plan,
      executionPlan,
      executionResults,
      evidence,
      staticChecks,
      error,
      artifact,
    };
  }
}

function describePolicyFailure(plan) {
  const reasons = [];
  if (plan.trustSurface && plan.trustSurface.status !== 'PASS') {
    for (const change of plan.trustSurface.blockingChanges ?? []) {
      reasons.push(`trust surface ${change.kind}: ${change.detail}`);
    }
  }
  if (plan.policyDelta && plan.policyDelta.status !== 'PASS') {
    for (const change of plan.policyDelta.blockingChanges ?? []) {
      reasons.push(`policy delta ${change.kind}: ${change.detail}`);
    }
  }
  if (plan.architecture.status === 'FAIL') {
    reasons.push(`architecture violations: ${plan.architecture.violations.map((violation) => `${violation.guardId} ${violation.file}`).join('; ')}`);
  }
  if (plan.unmappedProductionFiles.length > 0) {
    reasons.push(`unmapped production changes: ${plan.unmappedProductionFiles.join(', ')}`);
  }
  for (const item of plan.features) {
    for (const gap of item.plan.gaps) {
      reasons.push(`${item.feature.id} missing ${gap.invariantId}:${gap.level} x${gap.missing}`);
    }
    if (item.plan.budgetStatus === 'BUDGET_EXCEEDED') {
      reasons.push(`${item.feature.id} budget exceeded`);
    }
  }
  return reasons.join(' | ') || plan.status;
}

function runGovernanceSelfTests(root) {
  const srcDir = join(root, 'tools', 'test-governance', 'src');
  let testFiles = [];
  try {
    testFiles = readdirSync(srcDir).filter((name) => name.endsWith('.test.mjs')).map((name) => join(srcDir, name));
  } catch {
    return { status: 'FAIL', output: `cannot list ${srcDir}` };
  }
  if (testFiles.length === 0) return { status: 'FAIL', output: 'no governance self-tests found' };
  const res = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
  return { status: res.status === 0 ? 'PASS' : 'FAIL', output: output.slice(-4000) };
}

function runTypecheck(root) {
  const res = spawnSync('pnpm', ['typecheck'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
  return { status: res.status === 0 ? 'PASS' : 'FAIL', output: output.slice(-4000) };
}

export { effectiveMaxGate };
