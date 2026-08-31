import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Evidence Artifacts. Every gate invocation writes a fresh run directory
 * under artifacts/test-evidence/<HEAD_SHA>/<RUN_ID>/. Artifacts are commit/run
 * execution truth and are never read back as proof for a later run.
 */

export function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `run-${stamp}-${randomBytes(4).toString('hex')}`;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function planArtifact(plan) {
  if (!plan) return null;
  return {
    schemaVersion: 1,
    base: plan.base,
    head: plan.head,
    changedFiles: plan.changedFiles,
    directFeatures: (plan.features ?? []).filter((item) => item.reason === 'DIRECT').map((item) => item.feature.id),
    impactedFeatures: (plan.features ?? []).filter((item) => item.reason !== 'DIRECT')
      .map((item) => ({ id: item.feature.id, reason: item.reason })),
    policyStatus: plan.status,
    unmappedProductionFiles: plan.unmappedProductionFiles,
    architecture: plan.architecture,
    machineGaps: (plan.features ?? []).flatMap((item) => item.plan.gaps.map((gap) => ({
      featureId: item.feature.id,
      invariantId: gap.invariantId,
      level: gap.level,
      missing: gap.missing,
    }))),
    selectedCatalogEntries: (plan.features ?? []).flatMap((item) => item.plan.selected.map((entry) => ({
      featureId: item.feature.id,
      entryId: entry.id,
      covers: entry.covers,
    }))),
    budget: (plan.features ?? []).map((item) => ({
      featureId: item.feature.id,
      maintenanceBudget: item.plan.maintenanceBudget,
      plannedMaintenanceDelta: item.plan.plannedMaintenanceDelta,
      remainingBudget: item.plan.remainingBudget,
      budgetStatus: item.plan.budgetStatus,
    })),
  };
}

function executionArtifact(results) {
  return {
    schemaVersion: 1,
    runs: (results ?? []).map((result) => ({
      runId: result.runId,
      kind: result.kind,
      gate: result.gate,
      file: result.file,
      command: result.command,
      testNames: result.testNames,
      catalogEntryIds: result.catalogEntryIds,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      status: result.status,
      entryStatuses: result.entryStatuses,
    })),
  };
}

function buildSummary({ runId, headSha, gateStatus, plan, executionPlan, executionResults, evidence, staticChecks, error }) {
  const lines = [];
  lines.push('# Test Governance Gate Summary');
  lines.push('');
  lines.push(`- Run: \`${runId}\``);
  lines.push(`- Commit: \`${headSha}\``);
  lines.push(`- Base: \`${plan?.base ?? 'n/a'}\``);
  lines.push(`- Head: \`${plan?.head ?? 'n/a'}\``);
  lines.push(`- Final status: **${gateStatus}**`);
  if (error) lines.push(`- Error: ${error}`);
  lines.push('');
  lines.push('## Static checks');
  for (const [name, value] of Object.entries(staticChecks ?? {})) {
    lines.push(`- ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  if (plan) {
    lines.push('');
    lines.push(`## Changed files (${plan.changedFiles.length})`);
    for (const file of plan.changedFiles) lines.push(`- ${file}`);
    if (plan.unmappedProductionFiles?.length) {
      lines.push('');
      lines.push('## Unmapped production files');
      for (const file of plan.unmappedProductionFiles) lines.push(`- ${file}`);
    }
    lines.push('');
    lines.push(`## Affected features (${plan.features.length})`);
    for (const item of plan.features) lines.push(`- ${item.feature.id} (${item.reason})`);
  }
  if (executionPlan) {
    lines.push('');
    lines.push(`## Execution (${executionPlan.runs.length} runs, max gate ${executionPlan.maxGate})`);
    const resultByRunId = new Map((executionResults ?? []).map((result) => [result.runId, result]));
    for (const run of executionPlan.runs) {
      const result = resultByRunId.get(run.runId);
      const target = run.file ?? run.command;
      const selected = run.entries?.length ?? 0;
      lines.push(`- ${run.runId} [gate ${run.gate}] ${run.kind} ${target} (${selected} entr${selected === 1 ? 'y' : 'ies'}) -> ${result?.status ?? 'PLANNED'}`);
    }
  }
  if (evidence) {
    lines.push('');
    lines.push('## Realized evidence');
    for (const feature of evidence.features) {
      lines.push(`- ${feature.featureId}: ${feature.status}`);
      for (const invariant of feature.invariants) {
        const required = ['A', 'B', 'C'].filter((level) => invariant.required[level] > 0)
          .map((level) => `${level}${invariant.required[level]}`).join(' ');
        const potential = ['A', 'B', 'C'].filter((level) => invariant.potential[level] > 0)
          .map((level) => `${level}${invariant.potential[level]}`).join(' ');
        const realized = ['A', 'B', 'C'].filter((level) => invariant.realized[level] > 0)
          .map((level) => `${level}${invariant.realized[level]}`).join(' ');
        lines.push(`  - ${invariant.invariantId} required[${required || '-'}] potential[${potential || '-'}] realized[${realized || '-'}] -> ${invariant.satisfied ? 'SATISFIED' : 'EXECUTION_EVIDENCE_MISSING'}`);
      }
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function writeEvidenceArtifacts({
  repoRoot,
  headSha,
  runId,
  gateStatus,
  plan,
  executionPlan,
  executionResults,
  evidence,
  staticChecks,
  error,
}) {
  const dir = join(repoRoot, 'artifacts', 'test-evidence', headSha, runId);
  mkdirSync(join(dir, 'logs'), { recursive: true });

  const files = [];
  const planPath = join(dir, 'plan.json');
  writeJson(planPath, { runId, headSha, gateStatus, ...planArtifact(plan) });
  files.push(planPath);

  const identity = { runId, headSha, base: plan?.base ?? null, head: plan?.head ?? null };

  const executionPlanPath = join(dir, 'execution-plan.json');
  writeJson(executionPlanPath, { ...identity, ...(executionPlan ?? {}) });
  files.push(executionPlanPath);

  const executionPath = join(dir, 'execution.json');
  writeJson(executionPath, { ...identity, ...executionArtifact(executionResults) });
  files.push(executionPath);

  const evidencePath = join(dir, 'evidence.json');
  writeJson(evidencePath, { ...identity, ...(evidence ?? {}) });
  files.push(evidencePath);

  for (const result of executionResults ?? []) {
    writeFileSync(join(dir, 'logs', `${result.runId}.stdout.log`), result.stdout ?? '');
    writeFileSync(join(dir, 'logs', `${result.runId}.stderr.log`), result.stderr ?? '');
  }

  const summaryPath = join(dir, 'summary.md');
  writeFileSync(summaryPath, buildSummary({ runId, headSha, gateStatus, plan, executionPlan, executionResults, evidence, staticChecks, error }));
  files.push(summaryPath);

  return { dir, files };
}
