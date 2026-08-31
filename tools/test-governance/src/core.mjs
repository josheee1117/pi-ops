import ts from 'typescript';

const LEVELS = ['A', 'B', 'C'];
export const EXECUTION_CLASSES = ['UNIT', 'COMPONENT', 'INTEGRATION', 'MULTI_PROCESS', 'SMOKE', 'LIVE_PROVIDER'];
export const RUNTIME_CLASSES = ['fast', 'integration', 'smoke', 'live'];
export const PLAN_STATUS_PRECEDENCE = [
  'GOVERNANCE_REVIEW_REQUIRED',
  'GOVERNANCE_POLICY_WEAKENING',
  'ARCHITECTURE_VIOLATION',
  'UNMAPPED_PRODUCTION_CHANGE',
  'NEEDS_EVIDENCE',
  'BUDGET_EXCEEDED',
  'READY',
];
export const ACTION_COSTS = {
  REUSE: 0,
  STRENGTHEN: 1,
  CREATE: 4,
};

export function globToRegExp(pattern) {
  const target = pattern.replaceAll('\\', '/');
  if (!target.includes('*')) return new RegExp(`^${target.replace(/[.+^${}()|[\]\\]/g, '\\$&')}$`);
  const escaped = target.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  if (target.endsWith('/**')) {
    const prefix = escaped.slice(0, -3).replace(/\*\*/g, '::DOUBLE_STAR::').replace(/\*/g, '[^/]*').replace(/::DOUBLE_STAR::/g, '.*');
    return new RegExp(`^${prefix}(?:/.*)?$`);
  }
  const body = escaped.replace(/\*\*/g, '::DOUBLE_STAR::').replace(/\*/g, '[^/]*').replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${body}$`);
}

export function matchesPath(file, pattern) {
  return globToRegExp(pattern).test(file.replaceAll('\\', '/'));
}

export function isIgnoredPath(file, ignorePatterns = []) {
  return ignorePatterns.some((pattern) => matchesPath(file, pattern));
}

export function isGovernedProductionFile(file, settings = {}) {
  const normalized = file.replaceAll('\\', '/');
  if (isIgnoredPath(normalized, settings.unmappedIgnore ?? [])) return false;
  return (settings.governedRoots ?? []).some((pattern) => matchesPath(normalized, pattern));
}

export function findUnmappedProductionFiles(changedFiles, features, settings = {}) {
  return changedFiles.filter((file) => {
    if (!isGovernedProductionFile(file, settings)) return false;
    return !features.some((feature) => (feature.paths ?? []).some((pattern) => matchesPath(file, pattern)));
  });
}

export function resolveAffectedFeatures(changedFiles, features) {
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  const ordered = [];
  const seen = new Map();

  function add(feature, matchedFiles, reason) {
    const existing = seen.get(feature.id);
    if (existing) {
      for (const file of matchedFiles) {
        if (!existing.matchedFiles.includes(file)) existing.matchedFiles.push(file);
      }
      if (reason === 'DIRECT') {
        existing.reason = 'DIRECT';
      } else if (existing.reason !== 'DIRECT') {
        const labels = new Set(
          existing.reason.replace(/^IMPACTED_BY /, '').split(',').filter(Boolean),
        );
        for (const item of reason.replace(/^IMPACTED_BY /, '').split(',')) {
          if (item) labels.add(item);
        }
        existing.reason = `IMPACTED_BY ${[...labels].sort().join(',')}`;
      }
      return;
    }
    const record = { feature, matchedFiles: [...matchedFiles], reason };
    seen.set(feature.id, record);
    ordered.push(record);
  }

  for (const feature of features) {
    const matchedFiles = changedFiles.filter((file) =>
      (feature.paths ?? []).some((pattern) => matchesPath(file, pattern)));
    if (matchedFiles.length > 0) add(feature, matchedFiles, 'DIRECT');
  }

  const queue = ordered.filter((item) => item.reason === 'DIRECT').map((item) => item.feature.id);
  const queued = new Set(queue);
  while (queue.length > 0) {
    const id = queue.shift();
    const feature = byId.get(id);
    for (const impactId of feature?.impacts ?? []) {
      const impacted = byId.get(impactId);
      if (!impacted) continue;
      const isNew = !seen.has(impactId);
      add(impacted, [], `IMPACTED_BY ${id}`);
      if (isNew && !queued.has(impactId)) {
        queued.add(impactId);
        queue.push(impactId);
      }
    }
  }
  return ordered;
}

/**
 * AST-backed discovery of executable test declarations.
 *
 * Only a CallExpression whose callee is exactly the identifier `it` or `test`
 * and whose first argument is a static string (StringLiteral or
 * NoSubstitutionTemplateLiteral) is an executable declaration. Regex
 * literals, member calls (obj.it), suffixed identifiers (submit), comments,
 * ordinary strings, and substituted templates cannot fabricate a test name.
 */
export function extractTestNames(source, fileName = 'catalog-target.ts') {
  const scriptKind = fileName.endsWith('.mjs') || fileName.endsWith('.js')
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, String(source ?? ''), ts.ScriptTarget.Latest, true, scriptKind);
  const names = [];

  function staticName(argument) {
    if (!argument) return null;
    if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return argument.text;
    return null;
  }

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (callee === 'it' || callee === 'test') {
        const name = staticName(node.arguments[0]);
        if (name !== null) names.push(name);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return names;
}

const CANONICAL_BASH = /^bash[ \t]+([A-Za-z0-9._\-/]+)$/;
const CANONICAL_PNPM = /^pnpm(?:[ \t]+run)?[ \t]+([A-Za-z0-9:_-]+)$/;

function isSafeRelativeTarget(target) {
  return !target.startsWith('/') && !target.split('/').includes('..');
}

function normalizeWhitespace(text) {
  return String(text ?? '').trim().replace(/[ \t]+/g, ' ');
}

/**
 * Canonicalize a Catalog command into an argv form the Runner can execute
 * without a shell.
 *
 * Supported grammar is intentionally tiny:
 *   bash <relative-file>
 *   pnpm <script>          (script text must itself be `bash <declared file>`)
 *   pnpm run <script>
 *
 * Compound shell strings (`||`, `&&`, `|`, `;`, redirects, `echo <path>`)
 * never canonicalize, so a Catalog Proof cannot become valid merely because
 * the artifact path appears somewhere in a shell string.
 *
 * Returns { canonical } or { error }.
 */
export function canonicalizeCommand(command, options = {}) {
  const normalized = normalizeWhitespace(command);
  if (!normalized) return { error: 'command is empty' };

  const bash = normalized.match(CANONICAL_BASH);
  if (bash) {
    const target = bash[1];
    if (!isSafeRelativeTarget(target)) return { error: `UNVERIFIED_COMMAND: bash target must be repository-relative: ${target}` };
    if (typeof options.fileExists === 'function' && !options.fileExists(target)) {
      return { error: `command file missing: ${target}` };
    }
    if (options.declaredFile && options.declaredFile !== target) {
      return { error: `CATALOG_COMMAND_TARGET_MISMATCH: bash target ${target} does not match declared artifact ${options.declaredFile}` };
    }
    return {
      canonical: {
        executable: 'bash',
        args: [target],
        target,
        display: `bash ${target}`,
      },
    };
  }

  const pnpm = normalized.match(CANONICAL_PNPM);
  if (pnpm) {
    const scriptName = pnpm[1];
    const scriptText = options.packageScripts?.[scriptName];
    if (typeof scriptText !== 'string') return { error: `missing package script: ${scriptName}` };
    const declaredFile = options.declaredFile;
    if (!declaredFile) {
      return { error: `CATALOG_COMMAND_TARGET_MISMATCH: script ${scriptName} has no declared artifact to bind` };
    }
    if (normalizeWhitespace(scriptText) !== `bash ${declaredFile}`) {
      return { error: `CATALOG_COMMAND_TARGET_MISMATCH: script ${scriptName} must be exactly "bash ${declaredFile}" but is "${normalizeWhitespace(scriptText)}"` };
    }
    if (typeof options.fileExists === 'function' && !options.fileExists(declaredFile)) {
      return { error: `command file missing: ${declaredFile}` };
    }
    return {
      canonical: {
        executable: 'pnpm',
        args: ['run', scriptName],
        target: declaredFile,
        display: `pnpm run ${scriptName}`,
      },
    };
  }

  return { error: `UNVERIFIED_COMMAND: ${normalized}` };
}

export function validateKnownCommand(command, options = {}) {
  return canonicalizeCommand(command, options).error ?? null;
}

export function catalogEntryKind(entry) {
  const hasTestName = Boolean(entry?.location?.testName);
  const hasCommand = Boolean(entry?.command);
  if (hasTestName && hasCommand) return 'AMBIGUOUS';
  if (hasTestName) return 'TEST';
  if (hasCommand) return 'COMMAND';
  return 'NONE';
}

/**
 * Deterministic Proof Source identity. Two Catalog aliases that resolve to
 * the same real test (or the same canonical command target) for the same
 * invariant and level are one Proof Source and must count once.
 */
export function proofSourceId(entry, proof, options = {}) {
  const kind = catalogEntryKind(entry);
  if (kind === 'TEST') {
    return ['TEST', entry.location.file, entry.location.testName, proof.invariantId, proof.level].join('\u0000');
  }
  if (kind === 'COMMAND') {
    const canonical = canonicalizeCommand(entry.command, {
      packageScripts: options.packageScripts,
      declaredFile: entry.location?.file,
    }).canonical;
    const target = canonical?.target ?? normalizeWhitespace(entry.command);
    return ['COMMAND', target, entry.location?.file ?? '', proof.invariantId, proof.level].join('\u0000');
  }
  return ['UNEXECUTABLE', entry?.id ?? '', proof.invariantId, proof.level].join('\u0000');
}

/**
 * Parse `git diff --name-status --find-renames` output into structured
 * changes. Deletions and both sides of a rename stay visible, so a removed
 * production file can never silently leave governance.
 */
export function parseNameStatus(output) {
  const changes = [];
  for (const line of String(output ?? '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0]?.trim();
    if (!code) continue;
    const status = code[0];
    if ((status === 'R' || status === 'C') && parts.length >= 3) {
      changes.push({ status, oldPath: parts[1], newPath: parts[2] });
      continue;
    }
    if (parts.length >= 2) changes.push({ status, path: parts[1] });
  }
  return changes;
}

export function changedPathsOf(changes) {
  const paths = [];
  for (const change of changes) {
    for (const candidate of [change.path, change.oldPath, change.newPath]) {
      if (candidate && !paths.includes(candidate)) paths.push(candidate);
    }
  }
  return paths;
}

export function validateGovernanceConfig(featureDoc, catalogDoc, guardDoc, options = {}) {
  const errors = [];
  if (featureDoc?.schemaVersion !== 1) errors.push('features.schemaVersion must be 1');
  if (featureDoc?.trustRootVersion !== undefined && featureDoc.trustRootVersion !== 1) {
    errors.push('features.trustRootVersion must be 1');
  }
  if (catalogDoc?.schemaVersion !== 1) errors.push('catalog.schemaVersion must be 1');
  if (guardDoc?.schemaVersion !== 1) errors.push('architecture-guards.schemaVersion must be 1');
  const governedRoots = featureDoc?.governedRoots;
  if (!Array.isArray(governedRoots) || governedRoots.length === 0) {
    errors.push('features.governedRoots must be a non-empty array (unmapped production detection would be silently disabled)');
  }
  if (featureDoc?.unmappedIgnore !== undefined && !Array.isArray(featureDoc.unmappedIgnore)) {
    errors.push('features.unmappedIgnore must be an array');
  }

  const featureIds = new Set();
  const invariantOwners = new Map();
  for (const feature of featureDoc?.features ?? []) {
    if (!feature.id) {
      errors.push('feature id is required');
      continue;
    }
    if (featureIds.has(feature.id)) errors.push(`duplicate feature id: ${feature.id}`);
    featureIds.add(feature.id);
    if (!Array.isArray(feature.paths) || feature.paths.length === 0) {
      errors.push(`${feature.id}: at least one code path is required`);
    }
    if (feature.impacts !== undefined && !Array.isArray(feature.impacts)) {
      errors.push(`${feature.id}: impacts must be an array`);
    }
    const localIds = new Set();
    for (const invariant of feature.invariants ?? []) {
      if (!invariant.id) {
        errors.push(`${feature.id}: invariant id is required`);
        continue;
      }
      if (localIds.has(invariant.id)) errors.push(`${feature.id}: duplicate invariant ${invariant.id}`);
      localIds.add(invariant.id);
      if (invariantOwners.has(invariant.id)) errors.push(`invariant id must be globally unique: ${invariant.id}`);
      invariantOwners.set(invariant.id, feature.id);
      for (const [level, count] of Object.entries(invariant.requiredEvidence ?? {})) {
        if (!LEVELS.includes(level)) errors.push(`${invariant.id}: unknown evidence level ${level}`);
        if (!Number.isInteger(count) || count < 0) {
          errors.push(`${invariant.id}: evidence count for ${level} must be a non-negative integer`);
        }
      }
    }
  }
  for (const feature of featureDoc?.features ?? []) {
    for (const impact of feature.impacts ?? []) {
      if (!featureIds.has(impact)) errors.push(`${feature.id}: invalid impact Feature ${impact}`);
    }
  }

  const entryIds = new Set();
  const proofSources = new Map();
  for (const entry of catalogDoc?.entries ?? []) {
    if (!entry.id) {
      errors.push('catalog entry id is required');
      continue;
    }
    if (entryIds.has(entry.id)) errors.push(`duplicate catalog entry id: ${entry.id}`);
    entryIds.add(entry.id);
    if (!featureIds.has(entry.featureId)) errors.push(`${entry.id}: unknown feature ${entry.featureId}`);
    const status = entry.status ?? 'ACTIVE';
    if (!['ACTIVE', 'PINNED', 'QUARANTINED', 'DOMINATED', 'RETIRED'].includes(status)) {
      errors.push(`${entry.id}: unknown status ${status}`);
    }
    if (!EXECUTION_CLASSES.includes(entry.executionClass)) {
      errors.push(`${entry.id}: executionClass is required and must be one of ${EXECUTION_CLASSES.join('/')} (got ${entry.executionClass ?? 'none'})`);
    }
    if (entry.runtimeClass && !RUNTIME_CLASSES.includes(entry.runtimeClass)) {
      errors.push(`${entry.id}: unknown runtimeClass ${entry.runtimeClass}`);
    }
    if (entry.location?.file && typeof entry.location.file !== 'string') {
      errors.push(`${entry.id}: location.file must be a string`);
    }
    const kind = catalogEntryKind(entry);
    if (kind === 'AMBIGUOUS') {
      errors.push(`${entry.id}: CATALOG_AMBIGUOUS_EXECUTION_SHAPE (location.testName and command are mutually exclusive)`);
    } else if (kind === 'NONE') {
      errors.push(`${entry.id}: entry must declare exactly one executable shape (location.testName or command)`);
    }
    if (!entry.location?.file) {
      errors.push(`${entry.id}: location.file is required for every executable entry`);
    }
    for (const proof of entry.proofs ?? []) {
      if (invariantOwners.get(proof.invariantId) !== entry.featureId) {
        errors.push(`${entry.id}: proof ${proof.invariantId} does not belong to ${entry.featureId}`);
      }
      if (!LEVELS.includes(proof.level)) errors.push(`${entry.id}: unknown proof level ${proof.level}`);
      if (kind !== 'TEST' && kind !== 'COMMAND') continue;
      const sourceId = proofSourceId(entry, proof, { packageScripts: options.packageScripts });
      const owner = proofSources.get(sourceId);
      if (owner) {
        errors.push(`${entry.id}: CATALOG_DUPLICATE_PROOF_SOURCE shares ${proof.invariantId}:${proof.level} with ${owner}`);
      } else {
        proofSources.set(sourceId, entry.id);
      }
    }
  }

  const guardIds = new Set();
  for (const guard of guardDoc?.guards ?? []) {
    if (!guard.id) {
      errors.push('architecture guard id is required');
      continue;
    }
    if (guardIds.has(guard.id)) errors.push(`duplicate architecture guard id: ${guard.id}`);
    guardIds.add(guard.id);
    if (!['forbiddenImport', 'forbiddenText', 'requiredText'].includes(guard.kind)) {
      errors.push(`${guard.id}: unsupported guard kind ${guard.kind}`);
    }
    if (!Array.isArray(guard.scope) || guard.scope.length === 0) errors.push(`${guard.id}: scope is required`);
    if (!Array.isArray(guard.patterns) || guard.patterns.length === 0) errors.push(`${guard.id}: patterns are required`);
  }
  return errors;
}

export function validateCatalogArtifacts(catalogDoc, options = {}) {
  const errors = [];
  for (const entry of catalogDoc?.entries ?? []) {
    const file = entry.location?.file;
    if (file && typeof options.fileExists === 'function' && !options.fileExists(file)) {
      errors.push(`${entry.id}: catalog location.file does not exist: ${file}`);
    }
    if (entry.location?.testName) {
      const source = typeof options.readFile === 'function' ? options.readFile(file) : '';
      const names = extractTestNames(source ?? '', file ?? 'catalog-target.ts');
      const matches = names.filter((name) => name === entry.location.testName).length;
      if (matches === 0) {
        errors.push(`${entry.id}: CATALOG_GHOST_TEST ${entry.location.testName}`);
      } else if (matches > 1) {
        errors.push(`${entry.id}: CATALOG_AMBIGUOUS_TEST ${entry.location.testName}`);
      }
    }
    if (entry.command) {
      const { error } = canonicalizeCommand(entry.command, {
        packageScripts: options.packageScripts,
        fileExists: options.fileExists,
        declaredFile: entry.location?.file,
      });
      if (error) errors.push(`${entry.id}: ${error}`);
    }
  }
  return errors;
}

function key(invariantId, level) {
  return `${invariantId}:${level}`;
}

function requiredSlots(feature) {
  const slots = new Map();
  for (const invariant of feature.invariants ?? []) {
    for (const level of LEVELS) {
      const count = invariant.requiredEvidence?.[level] ?? 0;
      if (count > 0) slots.set(key(invariant.id, level), count);
    }
  }
  return slots;
}

function contribution(entry, remaining) {
  let total = 0;
  const seen = new Set();
  for (const proof of entry.proofs ?? []) {
    const proofKey = key(proof.invariantId, proof.level);
    if ((remaining.get(proofKey) ?? 0) > 0 && !seen.has(proofKey)) {
      total += 1;
      seen.add(proofKey);
    }
  }
  return total;
}

function consume(entry, remaining) {
  const covered = [];
  const seen = new Set();
  for (const proof of entry.proofs ?? []) {
    const proofKey = key(proof.invariantId, proof.level);
    const count = remaining.get(proofKey) ?? 0;
    if (count > 0 && !seen.has(proofKey)) {
      remaining.set(proofKey, count - 1);
      covered.push({ invariantId: proof.invariantId, level: proof.level });
      seen.add(proofKey);
    }
  }
  return covered;
}

export function evaluateMaintenanceBudget({ budget, actions = [] }) {
  let plannedDelta = 0;
  for (const action of actions) {
    const type = action.type ?? action;
    if (type === 'REUSE') plannedDelta += ACTION_COSTS.REUSE;
    else if (type === 'STRENGTHEN') plannedDelta += Number(action.cost ?? ACTION_COSTS.STRENGTHEN);
    else if (type === 'CREATE') plannedDelta += Number(action.cost ?? ACTION_COSTS.CREATE);
  }
  const numericBudget = Number(budget ?? 0);
  const remaining = numericBudget - plannedDelta;
  return {
    maintenanceBudget: numericBudget,
    plannedMaintenanceDelta: plannedDelta,
    remainingBudget: remaining,
    budgetStatus: remaining < 0 ? 'BUDGET_EXCEEDED' : 'WITHIN_BUDGET',
  };
}

export function buildFeaturePlan(feature, catalogEntries, options = {}) {
  const candidates = catalogEntries.filter((entry) =>
    entry.featureId === feature.id && (entry.status === 'ACTIVE' || entry.status === 'PINNED'));
  const remaining = requiredSlots(feature);
  const selected = [];
  const unused = new Set(candidates.map((entry) => entry.id));

  while ([...remaining.values()].some((value) => value > 0)) {
    let best;
    let bestScore = -1;
    for (const entry of candidates) {
      if (!unused.has(entry.id)) continue;
      const amount = contribution(entry, remaining);
      if (amount === 0) continue;
      const cost = Math.max(0.25, Number(entry.maintenanceCost ?? 1));
      const score = amount / cost + (entry.status === 'PINNED' ? 0.01 : 0);
      if (!best || score > bestScore || (score === bestScore && entry.id.localeCompare(best.id) < 0)) {
        best = entry;
        bestScore = score;
      }
    }
    if (!best) break;
    unused.delete(best.id);
    selected.push({ ...best, covers: consume(best, remaining) });
  }

  const gaps = [];
  for (const [proofKey, count] of remaining) {
    if (count <= 0) continue;
    const split = proofKey.lastIndexOf(':');
    gaps.push({ invariantId: proofKey.slice(0, split), level: proofKey.slice(split + 1), missing: count });
  }
  const budget = evaluateMaintenanceBudget({
    budget: feature.maintenanceBudget ?? 0,
    actions: options.actions ?? selected.map(() => ({ type: 'REUSE' })),
  });
  return {
    featureId: feature.id,
    selected,
    gaps,
    catalogMaintenanceCost: selected.reduce((sum, entry) => sum + Number(entry.maintenanceCost ?? 0), 0),
    ...budget,
    status: gaps.length === 0 ? 'CATALOG_COVERED' : 'NEEDS_EVIDENCE',
  };
}

export function collectMachineGaps(features, catalogEntries) {
  return features.flatMap((feature) => {
    const plan = buildFeaturePlan(feature, catalogEntries);
    return plan.gaps.map((gap) => ({
      featureId: feature.id,
      invariantId: gap.invariantId,
      level: gap.level,
      missing: gap.missing,
    }));
  });
}

export function resolvePlanStatus({ trustSurfaceBlocked = false, policyWeakening = false, architectureViolations = [], unmappedProductionFiles = [], hasGaps = false, budgetExceeded = false }) {
  if (trustSurfaceBlocked) return 'GOVERNANCE_REVIEW_REQUIRED';
  if (policyWeakening) return 'GOVERNANCE_POLICY_WEAKENING';
  if (architectureViolations.length > 0) return 'ARCHITECTURE_VIOLATION';
  if (unmappedProductionFiles.length > 0) return 'UNMAPPED_PRODUCTION_CHANGE';
  if (hasGaps) return 'NEEDS_EVIDENCE';
  if (budgetExceeded) return 'BUDGET_EXCEEDED';
  return 'READY';
}

export function parseImportSpecifiers(content) {
  const specs = new Set();
  const expressions = [
    /\b(?:import|export)\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const regex of expressions) {
    let match;
    while ((match = regex.exec(content)) !== null) specs.add(match[1]);
  }
  return [...specs];
}

export function evaluateGuardFile(guard, file, content) {
  if (!guard.scope.some((pattern) => matchesPath(file, pattern))) return [];
  const violations = [];
  if (guard.kind === 'forbiddenImport') {
    const imports = parseImportSpecifiers(content);
    for (const pattern of guard.patterns) {
      for (const specifier of imports) {
        if (specifier.includes(pattern)) violations.push({ guardId: guard.id, file, detail: `forbidden import "${specifier}" matched "${pattern}"` });
      }
    }
  } else if (guard.kind === 'forbiddenText') {
    for (const pattern of guard.patterns) {
      if (content.includes(pattern)) violations.push({ guardId: guard.id, file, detail: `forbidden text matched "${pattern}"` });
    }
  } else if (guard.kind === 'requiredText') {
    for (const pattern of guard.patterns) {
      if (!content.includes(pattern)) violations.push({ guardId: guard.id, file, detail: `required text missing "${pattern}"` });
    }
  }
  return violations;
}

export function summarizeRequirements(feature) {
  return (feature.invariants ?? []).map((invariant) => ({
    id: invariant.id,
    statement: invariant.statement,
    required: LEVELS
      .filter((level) => (invariant.requiredEvidence?.[level] ?? 0) > 0)
      .map((level) => `${level}${invariant.requiredEvidence[level]}`)
      .join(' '),
  }));
}
