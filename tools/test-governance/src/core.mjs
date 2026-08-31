const LEVELS = ['A', 'B', 'C'];
export const PLAN_STATUS_PRECEDENCE = [
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
 * Lexical scanner for executable test declarations.
 * Counts only it('name') / it("name") / test('name') / test("name") whose
 * first argument is a string literal appearing as real code. Comments,
 * string literals, and template literals never contribute declarations,
 * so a test name that exists only inside a comment/string/template is a ghost.
 */
export function extractTestNames(source) {
  const names = [];
  const n = source.length;
  let i = 0;
  let codeTail = '';

  function recordCode(text) {
    codeTail = (codeTail + text).slice(-64);
  }

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i = Math.min(n, i + 2);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      let content = '';
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          content += source[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (c === quote) break;
        content += c;
        i += 1;
      }
      i = Math.min(n, i + 1);
      if (/(?:^|[^A-Za-z0-9_$.])(?:it|test)\s*\(\s*$/.test(codeTail)) {
        names.push(content);
      }
      recordCode('""');
      continue;
    }
    recordCode(ch);
    i += 1;
  }
  return names;
}

export function validateKnownCommand(command, options = {}) {
  const trimmed = String(command ?? '').trim();
  if (!trimmed) return 'command is empty';
  const pnpm = trimmed.match(/^pnpm(?:\s+run)?\s+([A-Za-z0-9:_-]+)$/);
  if (pnpm) {
    const scriptName = pnpm[1];
    const scriptText = options.packageScripts?.[scriptName];
    if (typeof scriptText !== 'string') {
      return `missing package script: ${scriptName}`;
    }
    if (options.declaredFile && !scriptText.includes(options.declaredFile)) {
      return `CATALOG_COMMAND_TARGET_MISMATCH: script ${scriptName} does not reference declared artifact ${options.declaredFile}`;
    }
    return null;
  }
  const bash = trimmed.match(/^bash\s+(\S+)$/);
  if (bash) {
    if (typeof options.fileExists === 'function' && !options.fileExists(bash[1])) {
      return `command file missing: ${bash[1]}`;
    }
    if (options.declaredFile && options.declaredFile !== bash[1]) {
      return `CATALOG_COMMAND_TARGET_MISMATCH: bash target ${bash[1]} does not match declared artifact ${options.declaredFile}`;
    }
    return null;
  }
  return `UNVERIFIED_COMMAND: ${trimmed}`;
}

export function validateGovernanceConfig(featureDoc, catalogDoc, guardDoc) {
  const errors = [];
  if (featureDoc?.schemaVersion !== 1) errors.push('features.schemaVersion must be 1');
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
    if (entry.executionClass && !['UNIT', 'COMPONENT', 'INTEGRATION', 'MULTI_PROCESS', 'SMOKE', 'LIVE_PROVIDER'].includes(entry.executionClass)) {
      errors.push(`${entry.id}: unknown executionClass ${entry.executionClass}`);
    }
    if (entry.runtimeClass && !['fast', 'integration', 'smoke', 'live'].includes(entry.runtimeClass)) {
      errors.push(`${entry.id}: unknown runtimeClass ${entry.runtimeClass}`);
    }
    if (entry.location?.file && typeof entry.location.file !== 'string') {
      errors.push(`${entry.id}: location.file must be a string`);
    }
    if (entry.location?.testName && !entry.location?.file) {
      errors.push(`${entry.id}: location.file is required when location.testName is set`);
    }
    for (const proof of entry.proofs ?? []) {
      if (invariantOwners.get(proof.invariantId) !== entry.featureId) {
        errors.push(`${entry.id}: proof ${proof.invariantId} does not belong to ${entry.featureId}`);
      }
      if (!LEVELS.includes(proof.level)) errors.push(`${entry.id}: unknown proof level ${proof.level}`);
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
      const names = extractTestNames(source ?? '');
      if (!names.includes(entry.location.testName)) {
        errors.push(`${entry.id}: CATALOG_GHOST_TEST ${entry.location.testName}`);
      }
    }
    if (entry.command) {
      const commandError = validateKnownCommand(entry.command, {
        packageScripts: options.packageScripts,
        fileExists: options.fileExists,
        declaredFile: entry.location?.file,
      });
      if (commandError) errors.push(`${entry.id}: ${commandError}`);
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

export function resolvePlanStatus({ architectureViolations = [], unmappedProductionFiles = [], hasGaps = false, budgetExceeded = false }) {
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
