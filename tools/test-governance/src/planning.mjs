import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildFeaturePlan,
  evaluateGuardFile,
  findUnmappedProductionFiles,
  matchesPath,
  resolveAffectedFeatures,
  resolvePlanStatus,
} from './core.mjs';

/**
 * Git-backed planning shared by the CLI and the gate. Pure decision logic
 * stays in core.mjs; this module only reads repository state.
 */
export function createPlanning(root) {
  function git(args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  }

  function repoFiles() {
    const output = git(['ls-files']);
    return output ? output.split('\n').filter(Boolean) : [];
  }

  function changedFiles(options) {
    if (options.files.length > 0) return options.files;
    const output = git(['diff', '--name-only', '--diff-filter=ACMR', `${options.base}...${options.head}`]);
    return output ? output.split('\n').filter(Boolean) : [];
  }

  function evaluateArchitecture(guardDoc) {
    const violations = [];
    for (const file of repoFiles()) {
      if (!guardDoc.guards.some((guard) => guard.scope.some((pattern) => matchesPath(file, pattern)))) continue;
      let content;
      try {
        content = readFileSync(resolve(root, file), 'utf8');
      } catch {
        continue;
      }
      for (const guard of guardDoc.guards) violations.push(...evaluateGuardFile(guard, file, content));
    }
    return violations;
  }

  function buildPlan(config, options) {
    const files = changedFiles(options);
    const settings = {
      governedRoots: config.features.governedRoots ?? [],
      unmappedIgnore: config.features.unmappedIgnore ?? [],
    };
    const architectureViolations = evaluateArchitecture(config.guards);
    const unmappedProductionFiles = findUnmappedProductionFiles(files, config.features.features, settings);
    const affected = resolveAffectedFeatures(files, config.features.features).map((item) => ({
      ...item,
      plan: buildFeaturePlan(item.feature, config.catalog.entries),
    }));
    const hasGaps = affected.some((item) => item.plan.gaps.length > 0);
    const budgetExceeded = affected.some((item) => item.plan.budgetStatus === 'BUDGET_EXCEEDED');
    return {
      base: options.files.length > 0 ? '<explicit-files>' : options.base,
      head: options.head,
      changedFiles: files,
      architecture: { status: architectureViolations.length === 0 ? 'PASS' : 'FAIL', violations: architectureViolations },
      unmappedProductionFiles,
      features: affected,
      status: resolvePlanStatus({ architectureViolations, unmappedProductionFiles, hasGaps, budgetExceeded }),
    };
  }

  return {
    git,
    repoFiles,
    changedFiles,
    evaluateArchitecture,
    buildPlan,
  };
}
