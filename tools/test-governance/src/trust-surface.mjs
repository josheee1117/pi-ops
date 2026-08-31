import { changedPathsOf, matchesPath } from './core.mjs';

/**
 * Governance Trust Surface: the code and entrypoints that enforce governance
 * policy are themselves review-gated. A commit that changes them can never
 * approve itself through the automatic Gate; it requires the repository's
 * explicit architecture review.
 *
 * Bootstrap (one-time, structural): if BASE has no trustRootVersion and HEAD
 * introduces TRUST_ROOT_VERSION, trust-surface changes in that commit are
 * surfaced but non-blocking (TRUST_ROOT_BOOTSTRAP). Every later commit has
 * trustRootVersion in BASE, so any trust-surface change blocks.
 */
export const TRUST_ROOT_VERSION = 1;

const ENGINE_GLOB = 'tools/test-governance/src/**';
const WORKFLOW_PATH = '.github/workflows/test-governance.yml';
const PACKAGE_JSON_PATH = 'package.json';

const PROTECTED_SCRIPTS = [
  'test:gate',
  'test:plan',
  'test:run',
  'test:arch',
  'test:governance',
  'test:governance:self',
];

// Root package.json fields that keep Test Governance runnable.
const PROTECTED_FIELDS = [
  'packageManager',
  'engines.node',
  'dependencies.typescript',
  'devDependencies.typescript',
];

function fieldValue(packageJson, dotted) {
  return dotted.split('.').reduce((value, key) => value?.[key], packageJson);
}

function comparePackageJson(basePackageJson, headPackageJson, record, blocking) {
  const base = basePackageJson ?? {};
  const head = headPackageJson ?? {};

  for (const script of PROTECTED_SCRIPTS) {
    const before = base.scripts?.[script];
    const after = head.scripts?.[script];
    if (before === after) continue;
    const transition = before === undefined ? 'added' : after === undefined ? 'removed' : 'changed';
    record(blocking, 'GOVERNANCE_ENTRYPOINT_CHANGE_REQUIRES_REVIEW',
      `package.json scripts["${script}"] ${transition}: ${before ?? 'absent'} -> ${after ?? 'absent'}`);
  }
  for (const field of PROTECTED_FIELDS) {
    const before = fieldValue(base, field);
    const after = fieldValue(head, field);
    if (before !== after) {
      record(blocking, 'GOVERNANCE_ENTRYPOINT_CHANGE_REQUIRES_REVIEW',
        `package.json ${field} changed: ${JSON.stringify(before ?? null)} -> ${JSON.stringify(after ?? null)}`);
    }
  }

  // Unprotected script changes are surfaced but never block.
  const baseScripts = base.scripts ?? {};
  const headScripts = head.scripts ?? {};
  for (const key of new Set([...Object.keys(baseScripts), ...Object.keys(headScripts)])) {
    if (PROTECTED_SCRIPTS.includes(key)) continue;
    if (baseScripts[key] !== headScripts[key]) {
      record(false, 'PACKAGE_SCRIPT_CHANGED', `package.json scripts["${key}"] changed (unprotected, surfaced only)`);
    }
  }
}

export function evaluateGovernanceTrustSurface({
  changes,
  baseFeatures,
  headFeatures,
  basePackageJson,
  headPackageJson,
}) {
  const changesList = [];
  const record = (blocking, kind, detail) => {
    changesList.push({ kind, blocking, detail });
  };

  const baseVersion = baseFeatures?.trustRootVersion;
  const headVersion = headFeatures?.trustRootVersion;
  const bootstrap = baseVersion === undefined && headVersion === TRUST_ROOT_VERSION;

  if (baseVersion !== headVersion) {
    if (bootstrap) {
      record(false, 'TRUST_ROOT_BOOTSTRAP',
        `trustRootVersion ${TRUST_ROOT_VERSION} introduced at HEAD; trust-surface protection is authoritative from this commit onward`);
    } else if (headVersion === undefined) {
      record(true, 'TRUST_ROOT_VERSION_REMOVED',
        `trustRootVersion ${baseVersion} -> absent`);
    } else {
      record(true, 'TRUST_ROOT_VERSION_CHANGED',
        `trustRootVersion ${baseVersion ?? 'absent'} -> ${headVersion}`);
    }
  }

  const paths = changedPathsOf(changes ?? []);
  for (const file of paths.filter((path) => matchesPath(path, ENGINE_GLOB))) {
    record(!bootstrap, 'GOVERNANCE_ENGINE_CHANGE_REQUIRES_REVIEW', `governance engine file changed: ${file}`);
  }
  if (paths.includes(WORKFLOW_PATH)) {
    record(!bootstrap, 'GOVERNANCE_WORKFLOW_CHANGE_REQUIRES_REVIEW', `governance workflow changed: ${WORKFLOW_PATH}`);
  }
  if (paths.includes(PACKAGE_JSON_PATH)) {
    comparePackageJson(basePackageJson, headPackageJson, record, !bootstrap);
  }

  const blockingChanges = changesList.filter((change) => change.blocking);
  return {
    status: blockingChanges.length > 0 ? 'GOVERNANCE_REVIEW_REQUIRED' : 'PASS',
    changes: changesList,
    blockingChanges,
    trustRoot: { base: baseVersion ?? null, head: headVersion ?? null, bootstrap },
  };
}
