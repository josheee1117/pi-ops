/**
 * Test Governance v2.1 deterministic authorization classifier.
 *
 * HEAD is untrusted data. BASE decides whether a change can pass directly,
 * requires machine semantic review, or needs a rare human break-glass.
 */

export const DECISIONS = ['PASS', 'LOW_PASS', 'HUMAN_REQUIRED', 'REJECT', 'INTERNAL_ERROR'];
export const AUTH_ROUTES = ['NONE', 'MACHINE_REVIEW', 'BREAK_GLASS'];

const LEVEL_RANK = { A: 3, B: 2, C: 1 };
const EVIDENCE_LEVELS = ['A', 'B', 'C'];
const FEATURE_DOC_KEYS = new Set(['schemaVersion', 'trustRootVersion', 'governedRoots', 'unmappedIgnore', 'features']);
const FEATURE_KEYS = new Set(['id', 'paths', 'impacts', 'riskClass', 'riskScore', 'maintenanceBudget', 'invariants']);
const INVARIANT_KEYS = new Set(['id', 'statement', 'requiredEvidence']);
const GUARD_DOC_KEYS = new Set(['schemaVersion', 'guards']);
const GUARD_KEYS = new Set(['id', 'description', 'kind', 'scope', 'patterns']);
const POLICY_FILES = {
  features: 'tools/test-governance/config/features.json',
  catalog: 'tools/test-governance/config/catalog.json',
  guards: 'tools/test-governance/config/architecture-guards.json',
};

// K0: code that directly controls BASE authorization. Changes require a human
// acknowledgement that changing the referee is intentional.
const TRUST_ROOT_FILES = new Set([
  '.github/workflows/governance-trust-anchor.yml',
  'tools/test-governance/trust-anchor/check.mjs',
  'tools/test-governance/trust-anchor/classify.mjs',
  'tools/test-governance/trust-anchor/final-decision.mjs',
  'tools/test-governance/trust-anchor/machine-review.mjs',
]);

function globToRegExp(pattern) {
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
  return globToRegExp(pattern).test(String(file).replaceAll('\\', '/'));
}

export function isTrustRootPath(file) {
  return TRUST_ROOT_FILES.has(String(file).replaceAll('\\', '/'));
}

// K1: governance implementation that matters semantically but does not get to
// decide its own authorization. These changes are reviewed by the read-only
// machine reviewer, not by the GitHub Environment.
export function isMachineReviewPath(file) {
  const path = String(file).replaceAll('\\', '/');
  if (isTrustRootPath(path)) return false;
  if (path === '.github/workflows/test-governance.yml') return true;
  if (matchesPath(path, 'tools/test-governance/src/**')) return true;
  if (matchesPath(path, 'tools/test-governance/trust-anchor/**')) return true;
  return false;
}

// Legacy/conservative helper retained for existing tests and diagnostics.
export function isKernelPath(file) {
  return isTrustRootPath(file) || isMachineReviewPath(file);
}

function uniqueSorted(values) {
  return [...new Set((values ?? []).filter((item) => item != null && item !== ''))]
    .sort((a, b) => String(a).localeCompare(String(b)));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function listDelta(baseItems, headItems) {
  const base = baseItems ?? [];
  const head = headItems ?? [];
  const headSet = new Set(head);
  const baseSet = new Set(base);
  return {
    removed: base.filter((item) => !headSet.has(item)),
    added: head.filter((item) => !baseSet.has(item)),
  };
}

function unknownKeys(obj, known) {
  return Object.keys(obj ?? {}).filter((key) => !known.has(key)).sort();
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function atom(classification, code, path) {
  return { classification, code, path };
}

function shapeProblem(code, path) {
  return { code, path };
}

function validateStringArray(value, path, problems, { required = false } = {}) {
  if (value === undefined && !required) return;
  if (!Array.isArray(value)) {
    problems.push(shapeProblem('INVALID_ARRAY', path));
    return;
  }
  if (value.some((item) => typeof item !== 'string' || item.length === 0)) {
    problems.push(shapeProblem('INVALID_STRING_ARRAY_ITEM', path));
  }
}

function validateEvidence(required, path, problems) {
  if (!isPlainObject(required)) {
    problems.push(shapeProblem('INVALID_REQUIRED_EVIDENCE', path));
    return;
  }
  for (const key of Object.keys(required)) {
    if (!EVIDENCE_LEVELS.includes(key)) problems.push(shapeProblem('UNKNOWN_EVIDENCE_LEVEL', `${path}.${key}`));
  }
  for (const level of EVIDENCE_LEVELS) {
    const value = required[level];
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      problems.push(shapeProblem('INVALID_EVIDENCE_COUNT', `${path}.${level}`));
    }
  }
}

/**
 * Fail-closed structural validation before any lossy Map normalization.
 * Duplicate or missing ids are security-relevant because Map would otherwise
 * overwrite/drop entries.
 */
export function validatePolicyShape({ features, guards }) {
  const problems = [];
  const invariantIds = new Set();

  if (!isPlainObject(features)) {
    problems.push(shapeProblem('INVALID_FEATURE_DOCUMENT', 'features'));
  } else {
    if (!Array.isArray(features.features)) {
      problems.push(shapeProblem('INVALID_FEATURE_LIST', 'features.features'));
    } else {
      const featureIds = new Set();
      for (let i = 0; i < features.features.length; i += 1) {
        const feature = features.features[i];
        const basePath = `features.features[${i}]`;
        if (!isPlainObject(feature)) {
          problems.push(shapeProblem('INVALID_FEATURE', basePath));
          continue;
        }
        if (typeof feature.id !== 'string' || feature.id.length === 0) {
          problems.push(shapeProblem('MISSING_FEATURE_ID', `${basePath}.id`));
        } else if (featureIds.has(feature.id)) {
          problems.push(shapeProblem('DUPLICATE_FEATURE_ID', `${basePath}.id:${feature.id}`));
        } else {
          featureIds.add(feature.id);
        }
        validateStringArray(feature.paths, `${basePath}.paths`, problems, { required: true });
        validateStringArray(feature.impacts, `${basePath}.impacts`, problems);
        if (feature.riskClass !== undefined && typeof feature.riskClass !== 'string') problems.push(shapeProblem('INVALID_RISK_CLASS', `${basePath}.riskClass`));
        if (feature.riskScore !== undefined && typeof feature.riskScore !== 'number') problems.push(shapeProblem('INVALID_RISK_SCORE', `${basePath}.riskScore`));
        if (feature.maintenanceBudget !== undefined && typeof feature.maintenanceBudget !== 'number') problems.push(shapeProblem('INVALID_MAINTENANCE_BUDGET', `${basePath}.maintenanceBudget`));
        if (!Array.isArray(feature.invariants)) {
          problems.push(shapeProblem('INVALID_INVARIANT_LIST', `${basePath}.invariants`));
          continue;
        }
        for (let j = 0; j < feature.invariants.length; j += 1) {
          const invariant = feature.invariants[j];
          const invPath = `${basePath}.invariants[${j}]`;
          if (!isPlainObject(invariant)) {
            problems.push(shapeProblem('INVALID_INVARIANT', invPath));
            continue;
          }
          if (typeof invariant.id !== 'string' || invariant.id.length === 0) {
            problems.push(shapeProblem('MISSING_INVARIANT_ID', `${invPath}.id`));
          } else if (invariantIds.has(invariant.id)) {
            problems.push(shapeProblem('DUPLICATE_INVARIANT_ID', `${invPath}.id:${invariant.id}`));
          } else {
            invariantIds.add(invariant.id);
          }
          if (typeof invariant.statement !== 'string' || invariant.statement.length === 0) {
            problems.push(shapeProblem('INVALID_INVARIANT_STATEMENT', `${invPath}.statement`));
          }
          validateEvidence(invariant.requiredEvidence, `${invPath}.requiredEvidence`, problems);
        }
      }
    }
    validateStringArray(features.governedRoots, 'features.governedRoots', problems);
    validateStringArray(features.unmappedIgnore, 'features.unmappedIgnore', problems);
  }

  if (!isPlainObject(guards)) {
    problems.push(shapeProblem('INVALID_GUARD_DOCUMENT', 'guards'));
  } else if (!Array.isArray(guards.guards)) {
    problems.push(shapeProblem('INVALID_GUARD_LIST', 'guards.guards'));
  } else {
    const guardIds = new Set();
    for (let i = 0; i < guards.guards.length; i += 1) {
      const guard = guards.guards[i];
      const path = `guards.guards[${i}]`;
      if (!isPlainObject(guard)) {
        problems.push(shapeProblem('INVALID_GUARD', path));
        continue;
      }
      if (typeof guard.id !== 'string' || guard.id.length === 0) {
        problems.push(shapeProblem('MISSING_GUARD_ID', `${path}.id`));
      } else if (guardIds.has(guard.id)) {
        problems.push(shapeProblem('DUPLICATE_GUARD_ID', `${path}.id:${guard.id}`));
      } else {
        guardIds.add(guard.id);
      }
      if (typeof guard.kind !== 'string' || guard.kind.length === 0) problems.push(shapeProblem('INVALID_GUARD_KIND', `${path}.kind`));
      validateStringArray(guard.scope, `${path}.scope`, problems, { required: true });
      validateStringArray(guard.patterns, `${path}.patterns`, problems, { required: true });
    }
  }

  return problems.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
}

function expandSlots(required) {
  const slots = [];
  for (const level of EVIDENCE_LEVELS) {
    const count = required?.[level] ?? 0;
    if (!Number.isInteger(count) || count < 0) return { error: true, slots: [] };
    for (let i = 0; i < count; i += 1) slots.push(LEVEL_RANK[level]);
  }
  return { error: false, slots };
}

export function evidenceSlotRelation(baseRequired, headRequired) {
  const extra = [
    ...unknownKeys(baseRequired ?? {}, new Set(EVIDENCE_LEVELS)),
    ...unknownKeys(headRequired ?? {}, new Set(EVIDENCE_LEVELS)),
  ];
  if (extra.length > 0) return 'unknown';
  const base = expandSlots(baseRequired);
  const head = expandSlots(headRequired);
  if (base.error || head.error) return 'unknown';
  const used = new Array(head.slots.length).fill(false);
  for (const need of base.slots) {
    let found = -1;
    for (let i = head.slots.length - 1; i >= 0; i -= 1) {
      if (!used[i] && head.slots[i] >= need) {
        found = i;
        break;
      }
    }
    if (found === -1) return 'weaken';
    used[found] = true;
  }
  if (base.slots.length === head.slots.length && base.slots.every((rank, i) => rank === head.slots[i])) return 'equal';
  return 'strengthen';
}

function unclassified(path, code = 'UNCLASSIFIED_POLICY_CHANGE') {
  return atom('HUMAN', code, path);
}

function diffUnknown(baseObj, headObj, known, path) {
  const atoms = [];
  const keys = uniqueSorted([...unknownKeys(baseObj ?? {}, known), ...unknownKeys(headObj ?? {}, known)]);
  for (const key of keys) {
    if (!sameJson(baseObj?.[key], headObj?.[key])) atoms.push(unclassified(`${path}.${key}`));
  }
  return atoms;
}

function diffStringList(baseList, headList, path, addedClass, addedCode, removedClass, removedCode) {
  const { added, removed } = listDelta(baseList, headList);
  const atoms = [];
  for (const item of added) atoms.push(atom(addedClass, addedCode, `${path}:${item}`));
  for (const item of removed) atoms.push(atom(removedClass, removedCode, `${path}:${item}`));
  return atoms;
}

function diffInvariant(base, head, path) {
  const atoms = [...diffUnknown(base, head, INVARIANT_KEYS, path)];
  if ((base.statement ?? '') !== (head.statement ?? '')) atoms.push(atom('HUMAN', 'INVARIANT_STATEMENT_CHANGED', `${path}.statement`));
  const relation = evidenceSlotRelation(base.requiredEvidence, head.requiredEvidence);
  if (relation === 'strengthen') atoms.push(atom('LOW', 'EVIDENCE_FLOOR_RAISED', `${path}.requiredEvidence`));
  else if (relation === 'weaken') atoms.push(atom('REJECT', 'EVIDENCE_FLOOR_LOWERED', `${path}.requiredEvidence`));
  else if (relation === 'unknown') atoms.push(unclassified(`${path}.requiredEvidence`));
  return atoms;
}

function diffFeature(base, head, path) {
  const atoms = [...diffUnknown(base, head, FEATURE_KEYS, path)];
  // paths/impacts are semantically important; additions are not automatically
  // monotonic because they can alter selection/propagation behavior.
  atoms.push(...diffStringList(base.paths, head.paths, `${path}.paths`, 'HUMAN', 'FEATURE_PATH_ADDED', 'REJECT', 'FEATURE_PATH_REMOVED'));
  atoms.push(...diffStringList(base.impacts, head.impacts, `${path}.impacts`, 'HUMAN', 'FEATURE_IMPACT_ADDED', 'REJECT', 'FEATURE_IMPACT_REMOVED'));
  for (const field of ['riskClass', 'riskScore', 'maintenanceBudget']) {
    if (!sameJson(base[field], head[field])) atoms.push(atom('HUMAN', `FEATURE_${field.toUpperCase()}_CHANGED`, `${path}.${field}`));
  }
  const baseInv = new Map((base.invariants ?? []).map((item) => [item.id, item]));
  const headInv = new Map((head.invariants ?? []).map((item) => [item.id, item]));
  for (const id of uniqueSorted([...baseInv.keys(), ...headInv.keys()])) {
    const before = baseInv.get(id);
    const after = headInv.get(id);
    const invPath = `${path}.invariants.${id}`;
    if (!before) atoms.push(atom('LOW', 'INVARIANT_ADDED', invPath));
    else if (!after) atoms.push(atom('REJECT', 'INVARIANT_REMOVED', invPath));
    else atoms.push(...diffInvariant(before, after, invPath));
  }
  return atoms;
}

function diffFeatures(baseDoc, headDoc) {
  const base = baseDoc ?? {};
  const head = headDoc ?? {};
  const atoms = [...diffUnknown(base, head, FEATURE_DOC_KEYS, 'features')];
  if (!sameJson(base.schemaVersion, head.schemaVersion)) atoms.push(atom('HUMAN', 'SCHEMA_VERSION_CHANGED', 'features.schemaVersion'));
  if ((base.trustRootVersion ?? null) !== (head.trustRootVersion ?? null)) {
    if (base.trustRootVersion != null && head.trustRootVersion == null) atoms.push(atom('REJECT', 'TRUST_ROOT_REMOVED', 'features.trustRootVersion'));
    else atoms.push(atom('HUMAN', 'TRUST_ROOT_CHANGED', 'features.trustRootVersion'));
  }
  const roots = listDelta(base.governedRoots, head.governedRoots);
  for (const root of roots.added) atoms.push(atom('LOW', 'GOVERNED_ROOT_ADDED', `features.governedRoots:${root}`));
  for (const root of roots.removed) atoms.push(atom('REJECT', 'GOVERNED_ROOT_REMOVED', `features.governedRoots:${root}`));
  const ignore = listDelta(base.unmappedIgnore, head.unmappedIgnore);
  for (const pattern of ignore.added) atoms.push(atom('REJECT', 'UNMAPPED_IGNORE_EXPANDED', `features.unmappedIgnore:${pattern}`));
  for (const pattern of ignore.removed) atoms.push(atom('HUMAN', 'UNMAPPED_IGNORE_REDUCED', `features.unmappedIgnore:${pattern}`));

  const baseFeatures = new Map((base.features ?? []).map((item) => [item.id, item]));
  const headFeatures = new Map((head.features ?? []).map((item) => [item.id, item]));
  for (const id of uniqueSorted([...baseFeatures.keys(), ...headFeatures.keys()])) {
    const before = baseFeatures.get(id);
    const after = headFeatures.get(id);
    const path = `features.${id}`;
    if (!before) atoms.push(atom('HUMAN', 'FEATURE_ADDED', path));
    else if (!after) atoms.push(atom('REJECT', 'FEATURE_REMOVED', path));
    else atoms.push(...diffFeature(before, after, path));
  }
  return atoms;
}

function diffGuard(base, head, path) {
  const atoms = [...diffUnknown(base, head, GUARD_KEYS, path)];
  if (base.kind !== head.kind) atoms.push(atom('HUMAN', 'GUARD_KIND_CHANGED', `${path}.kind`));
  if ((base.description ?? '') !== (head.description ?? '')) atoms.push(atom('HUMAN', 'GUARD_DESCRIPTION_CHANGED', `${path}.description`));
  const scope = listDelta(base.scope, head.scope);
  for (const item of scope.added) atoms.push(atom('LOW', 'GUARD_SCOPE_EXPANDED', `${path}.scope:${item}`));
  for (const item of scope.removed) atoms.push(atom('REJECT', 'GUARD_SCOPE_SHRUNK', `${path}.scope:${item}`));
  const patterns = listDelta(base.patterns, head.patterns);
  for (const item of patterns.added) atoms.push(atom('LOW', 'GUARD_PATTERN_ADDED', `${path}.patterns:${item}`));
  for (const item of patterns.removed) atoms.push(atom('REJECT', 'GUARD_PATTERN_REMOVED', `${path}.patterns:${item}`));
  return atoms;
}

function diffGuards(baseDoc, headDoc) {
  const base = baseDoc ?? {};
  const head = headDoc ?? {};
  const atoms = [...diffUnknown(base, head, GUARD_DOC_KEYS, 'guards')];
  if (!sameJson(base.schemaVersion, head.schemaVersion)) atoms.push(atom('HUMAN', 'SCHEMA_VERSION_CHANGED', 'guards.schemaVersion'));
  const baseGuards = new Map((base.guards ?? []).map((item) => [item.id, item]));
  const headGuards = new Map((head.guards ?? []).map((item) => [item.id, item]));
  for (const id of uniqueSorted([...baseGuards.keys(), ...headGuards.keys()])) {
    const before = baseGuards.get(id);
    const after = headGuards.get(id);
    const path = `guards.${id}`;
    if (!before) atoms.push(atom('HUMAN', 'GUARD_ADDED', path));
    else if (!after) atoms.push(atom('REJECT', 'GUARD_REMOVED', path));
    else atoms.push(...diffGuard(before, after, path));
  }
  return atoms;
}

function proofPath(finding) {
  return finding.catalogEntryId || finding.catalogEntryIds?.[0] || finding.file || 'catalog';
}

function classifyProofFindings(trust) {
  const atoms = [];
  for (const finding of trust.proofIntegrity?.newProofs ?? []) atoms.push(atom('HUMAN', 'NEW_PROOF', `catalog.${proofPath(finding)}`));
  for (const finding of trust.proofIntegrity?.changedSources ?? []) atoms.push(atom('REJECT', 'PROOF_SOURCE_CHANGED', finding.file || `catalog.${proofPath(finding)}`));
  for (const finding of trust.proofIntegrity?.changedDefinitions ?? []) {
    const path = `catalog.${proofPath(finding)}`;
    const before = finding.before ?? null;
    const after = finding.after ?? null;
    const changeType = finding.changeType ?? null;
    if (changeType === 'REMOVED' || after == null) {
      atoms.push(atom('REJECT', 'PROOF_REMOVED', path));
      continue;
    }
    if (before?.status === 'PINNED' && after.status !== 'PINNED') {
      atoms.push(atom('REJECT', 'PINNED_STATUS_CHANGED', path));
      continue;
    }
    const beforeRank = LEVEL_RANK[before?.level] ?? 0;
    const afterRank = LEVEL_RANK[after.level] ?? 0;
    if (changeType === 'GRADE_CHANGED' || (before?.level && after.level && before.level !== after.level)) {
      if (afterRank < beforeRank) atoms.push(atom('REJECT', 'PROOF_GRADE_DOWNGRADE', path));
      else atoms.push(atom('HUMAN', 'PROOF_GRADE_CHANGED', path));
      continue;
    }
    if (changeType === 'STATUS_CHANGED') atoms.push(atom('HUMAN', 'PROOF_STATUS_CHANGED', path));
    else atoms.push(atom('HUMAN', 'PROOF_DEFINITION_CHANGED', path));
  }
  return atoms;
}

function classifyEntrypoints(trust) {
  const atoms = [];
  for (const finding of trust.trustSurface?.findings ?? []) {
    if (finding.kind !== 'GOVERNANCE_ENTRYPOINT_CHANGED') continue;
    const path = finding.field || 'package.json';
    if (finding.changeType === 'REMOVED') atoms.push(atom('REJECT', 'GOVERNANCE_ENTRYPOINT_REMOVED', path));
    else atoms.push(atom('HUMAN', 'GOVERNANCE_ENTRYPOINT_CHANGED', path));
  }
  return atoms;
}

function fileTouched(changedFiles, file) {
  return changedFiles.includes(file);
}

function blobWithoutAtoms(changedFiles, atoms, file, prefix) {
  if (!fileTouched(changedFiles, file)) return [];
  if (atoms.some((item) => item.path === prefix || String(item.path).startsWith(`${prefix}.`) || String(item.path).startsWith(`${prefix}:`))) return [];
  return [unclassified(file)];
}

function routeFor({ trustRootChanges, machineReviewChanges, humans }) {
  if (trustRootChanges.length > 0) return 'BREAK_GLASS';
  if (machineReviewChanges.length > 0 || humans.length > 0) return 'MACHINE_REVIEW';
  return 'NONE';
}

export function classifyAuthorization(input) {
  const changedFiles = uniqueSorted(input.changedFiles ?? []);
  const trustRootChanges = uniqueSorted(changedFiles.filter(isTrustRootPath));
  const machineReviewChanges = uniqueSorted(changedFiles.filter(isMachineReviewPath));
  const kernelChanges = uniqueSorted([...trustRootChanges, ...machineReviewChanges]);

  try {
    const baseShapeProblems = validatePolicyShape({ features: input.baseFeatures, guards: input.baseGuards });
    if (baseShapeProblems.length > 0) throw new Error(`BASE_POLICY_SHAPE_INVALID ${JSON.stringify(baseShapeProblems)}`);

    const headShapeProblems = validatePolicyShape({ features: input.headFeatures, guards: input.headGuards });
    if (headShapeProblems.length > 0) {
      return pack({
        decision: 'REJECT',
        route: 'NONE',
        risk: 'HIGH',
        labels: ['INVALID_POLICY_SHAPE', 'POLICY_WEAKENING'],
        changedFiles,
        kernelChanges,
        trustRootChanges,
        machineReviewChanges,
        strengthenings: [],
        weakenings: headShapeProblems.map((item) => `${item.code}:${item.path}`),
        residualChanges: [],
        shapeProblems: headShapeProblems,
        affectedInvariants: [],
        affectedProofs: [],
        reasonCodes: uniqueSorted(headShapeProblems.map((item) => item.code)),
        baseSha: input.baseSha,
        headSha: input.headSha,
      });
    }

    const trust = input.trustResult ?? {};
    const policyAtoms = [
      ...diffFeatures(input.baseFeatures, input.headFeatures),
      ...diffGuards(input.baseGuards, input.headGuards),
    ];
    policyAtoms.push(
      ...blobWithoutAtoms(changedFiles, policyAtoms, POLICY_FILES.features, 'features'),
      ...blobWithoutAtoms(changedFiles, policyAtoms, POLICY_FILES.guards, 'guards'),
    );
    const proofAtoms = classifyProofFindings(trust);
    if (fileTouched(changedFiles, POLICY_FILES.catalog) && proofAtoms.length === 0) proofAtoms.push(unclassified(POLICY_FILES.catalog));
    const entryAtoms = classifyEntrypoints(trust);
    const atoms = [...policyAtoms, ...proofAtoms, ...entryAtoms];

    const lows = atoms.filter((item) => item.classification === 'LOW');
    const weakenings = atoms.filter((item) => item.classification === 'REJECT');
    const humans = atoms.filter((item) => item.classification === 'HUMAN');
    const route = routeFor({ trustRootChanges, machineReviewChanges, humans });
    const residualChanges = humans.map((item) => ({ code: item.code, path: item.path }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
    const reasonCodes = uniqueSorted([
      ...atoms.map((item) => item.code),
      ...(trustRootChanges.length > 0 ? ['TRUST_ROOT_CHANGED'] : []),
      ...(machineReviewChanges.length > 0 ? ['MACHINE_REVIEW_SURFACE_CHANGED'] : []),
    ]);
    const strengthenings = uniqueSorted(lows.map((item) => `${item.code}:${item.path}`));
    const weakeningNotes = uniqueSorted(weakenings.map((item) => `${item.code}:${item.path}`));
    const labels = [];
    if (kernelChanges.length > 0) labels.push('KERNEL_CHANGED');
    if (trustRootChanges.length > 0) labels.push('TRUST_ROOT_CHANGED');
    if (machineReviewChanges.length > 0) labels.push('MACHINE_REVIEW_SURFACE_CHANGED');
    if (lows.length > 0) labels.push('SAFE_STRENGTHENING');
    if (weakenings.some((item) => item.code.startsWith('PROOF') || item.code.startsWith('PINNED'))) labels.push('PROOF_WEAKENING');
    if (weakenings.some((item) => item.code.startsWith('GUARD'))) labels.push('ARCHITECTURE_GUARD_WEAKENING');
    if (weakenings.some((item) => !item.code.startsWith('PROOF') && !item.code.startsWith('PINNED') && !item.code.startsWith('GUARD'))) labels.push('POLICY_WEAKENING');
    if (humans.some((item) => item.code === 'NEW_PROOF')) labels.push('NEW_PROOF');
    if (humans.some((item) => item.code === 'UNCLASSIFIED_POLICY_CHANGE')) labels.push('UNCLASSIFIED_POLICY_CHANGE');
    else if (humans.length > 0) labels.push('UNKNOWN');

    const affectedInvariants = uniqueSorted(atoms.map((item) => /invariants\.([^.:]+)/.exec(item.path)?.[1]).filter(Boolean));
    const affectedProofs = uniqueSorted(atoms.filter((item) => String(item.path).startsWith('catalog.')).map((item) => item.path.slice('catalog.'.length)));

    const common = {
      changedFiles,
      kernelChanges,
      trustRootChanges,
      machineReviewChanges,
      strengthenings,
      weakenings: weakeningNotes,
      residualChanges,
      shapeProblems: [],
      affectedInvariants,
      affectedProofs,
      reasonCodes,
      labels: uniqueSorted(labels),
      baseSha: input.baseSha,
      headSha: input.headSha,
    };

    if (weakenings.length > 0) {
      return pack({ ...common, decision: 'REJECT', route: 'NONE', risk: 'HIGH', labels: uniqueSorted([...labels, trustRootChanges.length > 0 ? 'TRUST_ROOT_WEAKENING' : null]) });
    }

    if (route !== 'NONE') {
      return pack({ ...common, decision: 'HUMAN_REQUIRED', route, risk: 'HIGH' });
    }

    if (lows.length > 0 && residualChanges.length === 0) {
      return pack({ ...common, decision: 'LOW_PASS', route: 'NONE', risk: 'LOW', labels: uniqueSorted(['SAFE_STRENGTHENING', ...labels]) });
    }

    return pack({
      ...common,
      decision: 'PASS',
      route: 'NONE',
      risk: 'NONE',
      labels: [],
      reasonCodes: [],
      strengthenings: [],
      weakenings: [],
      residualChanges: [],
    });
  } catch (error) {
    return pack({
      decision: 'INTERNAL_ERROR',
      route: 'NONE',
      risk: 'HIGH',
      labels: ['UNKNOWN'],
      changedFiles,
      kernelChanges,
      trustRootChanges,
      machineReviewChanges,
      strengthenings: [],
      weakenings: [],
      residualChanges: [],
      shapeProblems: [],
      affectedInvariants: [],
      affectedProofs: [],
      reasonCodes: ['INTERNAL_ERROR'],
      baseSha: input.baseSha,
      headSha: input.headSha,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function pack(fields) {
  const result = {
    schemaVersion: 2,
    baseSha: fields.baseSha ?? null,
    headSha: fields.headSha ?? null,
    decision: fields.decision,
    route: AUTH_ROUTES.includes(fields.route) ? fields.route : 'NONE',
    risk: fields.risk,
    labels: uniqueSorted(fields.labels),
    changedFiles: uniqueSorted(fields.changedFiles),
    kernelChanges: uniqueSorted(fields.kernelChanges),
    trustRootChanges: uniqueSorted(fields.trustRootChanges),
    machineReviewChanges: uniqueSorted(fields.machineReviewChanges),
    strengthenings: uniqueSorted(fields.strengthenings),
    weakenings: uniqueSorted(fields.weakenings),
    residualChanges: (fields.residualChanges ?? []).map((item) => ({ code: item.code, path: item.path })),
    shapeProblems: (fields.shapeProblems ?? []).map((item) => ({ code: item.code, path: item.path })),
    affectedInvariants: uniqueSorted(fields.affectedInvariants),
    affectedProofs: uniqueSorted(fields.affectedProofs),
    reasonCodes: uniqueSorted(fields.reasonCodes),
  };
  if (fields.error) result.error = fields.error;
  return result;
}
