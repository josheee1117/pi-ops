const LEVELS = ['A', 'B', 'C'];

export function matchesPath(file, pattern) {
  const normalized = file.replaceAll('\\', '/');
  const target = pattern.replaceAll('\\', '/');
  if (target.endsWith('/**')) {
    const prefix = target.slice(0, -3);
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  }
  if (!target.includes('*')) return normalized === target;
  const escaped = target.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = escaped
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${regex}$`).test(normalized);
}

export function resolveAffectedFeatures(changedFiles, features) {
  return features
    .map((feature) => ({
      feature,
      matchedFiles: changedFiles.filter((file) =>
        feature.paths.some((pattern) => matchesPath(file, pattern))),
    }))
    .filter(({ matchedFiles }) => matchedFiles.length > 0);
}

export function validateGovernanceConfig(featureDoc, catalogDoc, guardDoc) {
  const errors = [];
  if (featureDoc?.schemaVersion !== 1) errors.push('features.schemaVersion must be 1');
  if (catalogDoc?.schemaVersion !== 1) errors.push('catalog.schemaVersion must be 1');
  if (guardDoc?.schemaVersion !== 1) errors.push('architecture-guards.schemaVersion must be 1');

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

export function buildFeaturePlan(feature, catalogEntries) {
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
  return {
    featureId: feature.id,
    selected,
    gaps,
    catalogMaintenanceCost: selected.reduce((sum, entry) => sum + Number(entry.maintenanceCost ?? 0), 0),
    status: gaps.length === 0 ? 'CATALOG_COVERED' : 'NEEDS_EVIDENCE'
  };
}

export function parseImportSpecifiers(content) {
  const specs = new Set();
  const expressions = [
    /\b(?:import|export)\s+(?:[^'\"]*?\sfrom\s*)?['\"]([^'\"]+)['\"]/g,
    /\bimport\(\s*['\"]([^'\"]+)['\"]\s*\)/g,
    /\brequire\(\s*['\"]([^'\"]+)['\"]\s*\)/g
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
        if (specifier.includes(pattern)) violations.push({ guardId: guard.id, file, detail: `forbidden import \"${specifier}\" matched \"${pattern}\"` });
      }
    }
  } else if (guard.kind === 'forbiddenText') {
    for (const pattern of guard.patterns) {
      if (content.includes(pattern)) violations.push({ guardId: guard.id, file, detail: `forbidden text matched \"${pattern}\"` });
    }
  } else if (guard.kind === 'requiredText') {
    for (const pattern of guard.patterns) {
      if (!content.includes(pattern)) violations.push({ guardId: guard.id, file, detail: `required text missing \"${pattern}\"` });
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
      .join(' ')
  }));
}
