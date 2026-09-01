import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildFeaturePlan,
  changedPathsOf,
  evaluateGuardFile,
  missingRequiredTextScopes,
  findUnmappedProductionFiles,
  matchesPath,
  parseNameStatus,
  resolveAffectedFeatures,
  resolvePlanStatus,
} from './core.mjs';
import { evaluatePolicyDelta } from './policy-delta.mjs';
import { evaluateGovernanceTrustSurface } from './trust-surface.mjs';

const POLICY_FILES = {
  features: 'tools/test-governance/config/features.json',
  catalog: 'tools/test-governance/config/catalog.json',
  guards: 'tools/test-governance/config/architecture-guards.json',
};
const PACKAGE_JSON = 'package.json';
const EMPTY_BASE_POLICY = {
  features: { schemaVersion: 1, governedRoots: [], features: [] },
  catalog: { schemaVersion: 1, entries: [] },
  guards: { schemaVersion: 1, guards: [] },
};

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

  /**
   * Structured change discovery. `--name-status --find-renames` keeps
   * deletions and both sides of a rename visible; the previous
   * `--name-only --diff-filter=ACMR` silently dropped deletions (fail-open).
   */
  function changedEntries(options) {
    if (options.files.length > 0) return options.files.map((path) => ({ status: 'M', path }));
    const output = git(['diff', '--name-status', '--find-renames', `${options.base}...${options.head}`]);
    return parseNameStatus(output);
  }

  function changedFiles(options) {
    return changedPathsOf(changedEntries(options));
  }

  function evaluateArchitecture(guardDoc) {
    const files = repoFiles();
    const guards = guardDoc.guards ?? [];
    const violations = [...missingRequiredTextScopes(guards, files)];
    for (const file of files) {
      if (!guards.some((guard) => guard.scope.some((pattern) => matchesPath(file, pattern)))) continue;
      let content;
      try {
        content = readFileSync(resolve(root, file), 'utf8');
      } catch {
        continue;
      }
      for (const guard of guards) violations.push(...evaluateGuardFile(guard, file, content));
    }
    return violations;
  }

  /**
   * BASE governance policy reader. Reads parsed policy from a real revision
   * via `git show`; never touches the working tree. A missing file at BASE is
   * an explicit bootstrap; a revision that cannot be read or parsed fails
   * closed.
   */
  function readFileAt(rev, relativePath) {
    let present = true;
    try {
      git(['cat-file', '-e', `${rev}:${relativePath}`]);
    } catch {
      present = false;
    }
    if (!present) return { relativePath, present: false };
    try {
      return { relativePath, present: true, text: git(['show', `${rev}:${relativePath}`]) };
    } catch (error) {
      return { relativePath, present: true, error: error instanceof Error ? error.message : String(error) };
    }
  }

  function parseFileAt(file, rev, fallback) {
    if (!file.present) return { value: fallback, bootstrapped: true };
    if (file.error) throw new Error(`cannot read ${file.relativePath} at ${rev}: ${file.error}`);
    try {
      return { value: JSON.parse(file.text), bootstrapped: false };
    } catch (error) {
      throw new Error(`cannot parse ${file.relativePath} at ${rev}: ${error.message}`);
    }
  }

  /**
   * BASE -> HEAD governance comparison for a real revision range: parsed
   * policy delta plus the governance trust surface. In explicit-files mode
   * both are skipped (advisory planning only); the gate never treats that
   * mode as a trusted commit PASS.
   */
  function evaluateBaseGovernance(config, options, changes) {
    if (options.files.length > 0) {
      return {
        policyDelta: {
          status: 'PASS',
          basePolicy: null,
          headPolicy: null,
          changes: [{ kind: 'POLICY_DELTA_SKIPPED', blocking: false, detail: 'explicit-files planning has no base revision; the policy delta runs on real base..head ranges' }],
          blockingChanges: [],
        },
        trustSurface: {
          status: 'PASS',
          changes: [{ kind: 'TRUST_SURFACE_SKIPPED', blocking: false, detail: 'explicit-files planning has no base revision; the trust surface runs on real base..head ranges' }],
          blockingChanges: [],
          trustRoot: null,
        },
      };
    }
    const base = options.base;
    const blockingBase = (detail) => ({
      policyDelta: {
        status: 'GOVERNANCE_POLICY_WEAKENING',
        basePolicy: null,
        headPolicy: null,
        changes: [],
        blockingChanges: [{ kind: 'BASE_POLICY_UNREADABLE', blocking: true, detail }],
      },
      trustSurface: {
        status: 'GOVERNANCE_REVIEW_REQUIRED',
        changes: [],
        blockingChanges: [{ kind: 'BASE_POLICY_UNREADABLE', blocking: true, detail }],
        trustRoot: null,
      },
    });
    try {
      git(['rev-parse', '--verify', `${base}^{commit}`]);
    } catch {
      return blockingBase(`base revision ${base} cannot be resolved; BASE governance policy is unreadable`);
    }
    const files = Object.fromEntries(
      Object.entries(POLICY_FILES).map(([name, relativePath]) => [name, readFileAt(base, relativePath)]),
    );
    files.packageJson = readFileAt(base, PACKAGE_JSON);
    try {
      const baseDocs = {};
      const bootstrapped = [];
      for (const [name, file] of Object.entries(files)) {
        if (name === 'packageJson') continue;
        const parsed = parseFileAt(file, base, EMPTY_BASE_POLICY[name]);
        if (parsed.bootstrapped) bootstrapped.push(file.relativePath);
        baseDocs[name] = parsed.value;
      }
      const basePackageJson = parseFileAt(files.packageJson, base, {}).value;
      let headPackageJson;
      try {
        headPackageJson = JSON.parse(readFileSync(resolve(root, PACKAGE_JSON), 'utf8'));
      } catch (error) {
        return blockingBase(`HEAD package.json is unreadable: ${error instanceof Error ? error.message : String(error)}`);
      }

      const delta = evaluatePolicyDelta({
        baseFeatures: baseDocs.features,
        headFeatures: config.features,
        baseCatalog: baseDocs.catalog,
        headCatalog: config.catalog,
        baseGuards: baseDocs.guards,
        headGuards: config.guards,
      }, { packageScripts: config.packageScripts });
      for (const relativePath of bootstrapped) {
        delta.changes.unshift({
          kind: 'BASE_POLICY_BOOTSTRAP',
          blocking: false,
          detail: `${relativePath} did not exist at ${base}; treated as empty base policy`,
        });
      }
      const trustSurface = evaluateGovernanceTrustSurface({
        changes,
        baseFeatures: baseDocs.features,
        headFeatures: config.features,
        basePackageJson,
        headPackageJson,
      });
      return {
        policyDelta: {
          ...delta,
          basePolicy: { rev: base, files: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, file.present])) },
          headPolicy: { rev: options.head },
        },
        trustSurface,
      };
    } catch (error) {
      return blockingBase(error instanceof Error ? error.message : String(error));
    }
  }

  function buildPlan(config, options) {
    const changes = changedEntries(options);
    const files = changedPathsOf(changes);
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
    const { policyDelta, trustSurface } = evaluateBaseGovernance(config, options, changes);
    return {
      base: options.files.length > 0 ? '<explicit-files>' : options.base,
      head: options.head,
      changedFiles: files,
      changes,
      policyDelta,
      trustSurface,
      architecture: { status: architectureViolations.length === 0 ? 'PASS' : 'FAIL', violations: architectureViolations },
      unmappedProductionFiles,
      features: affected,
      status: resolvePlanStatus({
        trustSurfaceBlocked: trustSurface.status !== 'PASS',
        policyWeakening: policyDelta.status !== 'PASS',
        architectureViolations,
        unmappedProductionFiles,
        hasGaps,
        budgetExceeded,
      }),
    };
  }

  return {
    git,
    repoFiles,
    changedEntries,
    changedFiles,
    evaluateArchitecture,
    buildPlan,
  };
}
