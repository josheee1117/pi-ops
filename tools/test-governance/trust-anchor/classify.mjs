/**
 * v2.0.1 deterministic authorization classifier.
 * LOW_PASS only when the entire normalized policy residual is empty
 * after consuming approved monotonic transformations.
 * No LLM. No engine imports (Trust Anchor cannot depend on typescript).
 */

export const DECISIONS = ['PASS', 'LOW_PASS', 'HUMAN_REQUIRED', 'REJECT', 'INTERNAL_ERROR'];

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
  return globToRegExp(pattern).test(file.replaceAll('\\', '/'));
}

export function isKernelPath(file) {
  const path = file.replaceAll('\\', '/');
  if (path === '.github/workflows/governance-trust-anchor.yml') return true;
  if (path === '.github/workflows/test-governance.yml') return true;
  if (matchesPath(path, 'tools/test-governance/trust-anchor/**')) return true;
  if (matchesPath(path, 'tools/test-governance/src/**')) return true;
  return false;
}

function uniqueSorted(values) {
  return [...new Set(values.filter((item) => item != null && item !== ''))].sort((a, b) => String(a).localeCompare(String(b)));
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
  const extra = [...unknownKeys(baseRequired ?? {}, new Set(EVIDENCE_LEVELS)), ...unknownKeys(headRequired ?? {}, new Set(EVIDENCE_LEVELS))];
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

function diffStringList(baseList, headList, path, addedCode, removedClass, removedCode) {
  const { added, removed } = listDelta(baseList, headList);
  const atoms = [];
  for (const item of added) atoms.push(atom('HUMAN', addedCode, `${path}:${item}`));
  for (const item of removed) atoms.push(atom(removedClass, removedCode, `${path}:${item}`));
  return atoms;
}

function diffInvariant(base, head, path) {
  const atoms = [...diffUnknown(base, head, INVARIANT_KEYS, path)];
  if ((base.statement ?? '') !== (head.statement ?? '')) {
    atoms.push(atom('HUMAN', 'INVARIANT_STATEMENT_CHANGED', `${path}.statement`));
  }
  const relation = evidenceSlotRelation(base.requiredEvidence, head.requiredEvidence);
  if (relation === 'strengthen') atoms.push(atom('LOW', 'EVIDENCE_FLOOR_RAISED', `${path}.requiredEvidence`));
  else if (relation === 'weaken') atoms.push(atom('REJECT', 'EVIDENCE_FLOOR_LOWERED', `${path}.requiredEvidence`));
  else if (relation === 'unknown') atoms.push(unclassified(`${path}.requiredEvidence`));
  return atoms;
}

function diffFeature(base, head, path) {
  const atoms = [...diffUnknown(base, head, FEATURE_KEYS, path)];
  atoms.push(...diffStringList(base.paths, head.paths, `${path}.paths`, 'FEATURE_PATH_ADDED', 'REJECT', 'FEATURE_PATH_REMOVED'));
  atoms.push(...diffStringList(base.impacts, head.impacts, `${path}.impacts`, 'FEATURE_IMPACT_ADDED', 'REJECT', 'FEATURE_IMPACT_REMOVED'));
  for (const field of ['riskClass', 'riskScore', 'maintenanceBudget']) {
    if (!sameJson(base[field], head[field])) atoms.push(atom('HUMAN', `FEATURE_${field.toUpperCase()}_CHANGED`, `${path}.${field}`));
  }
  const baseInv = new Map((base.invariants ?? []).filter((item) => item?.id).map((item) => [item.id, item]));
  const headInv = new Map((head.invariants ?? []).filter((item) => item?.id).map((item) => [item.id, item]));
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
  if (!sameJson(base.schemaVersion, head.schemaVersion)) {
    atoms.push(atom('HUMAN', 'SCHEMA_VERSION_CHANGED', 'features.schemaVersion'));
  }
  if ((base.trustRootVersion ?? null) !== (head.trustRootVersion ?? null)) {
    if (base.trustRootVersion != null && head.trustRootVersion == null) {
      atoms.push(atom('REJECT', 'TRUST_ROOT_REMOVED', 'features.trustRootVersion'));
    } else {
      atoms.push(atom('HUMAN', 'TRUST_ROOT_CHANGED', 'features.trustRootVersion'));
    }
  }
  const roots = listDelta(base.governedRoots, head.governedRoots);
  for (const root of roots.added) atoms.push(atom('LOW', 'GOVERNED_ROOT_ADDED', `features.governedRoots:${root}`));
  for (const root of roots.removed) atoms.push(atom('REJECT', 'GOVERNED_ROOT_REMOVED', `features.governedRoots:${root}`));
  const ignore = listDelta(base.unmappedIgnore, head.unmappedIgnore);
  for (const pattern of ignore.added) atoms.push(atom('REJECT', 'UNMAPPED_IGNORE_EXPANDED', `features.unmappedIgnore:${pattern}`));
  for (const pattern of ignore.removed) atoms.push(atom('HUMAN', 'UNMAPPED_IGNORE_REDUCED', `features.unmappedIgnore:${pattern}`));

  const baseFeatures = new Map((base.features ?? []).filter((item) => item?.id).map((item) => [item.id, item]));
  const headFeatures = new Map((head.features ?? []).filter((item) => item?.id).map((item) => [item.id, item]));
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
  if (base.kind !== head.kind) {
    atoms.push(atom('HUMAN', 'GUARD_KIND_CHANGED', `${path}.kind`));
  }
  if ((base.description ?? '') !== (head.description ?? '')) {
    atoms.push(atom('HUMAN', 'GUARD_DESCRIPTION_CHANGED', `${path}.description`));
  }
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
  if (!sameJson(base.schemaVersion, head.schemaVersion)) {
    atoms.push(atom('HUMAN', 'SCHEMA_VERSION_CHANGED', 'guards.schemaVersion'));
  }
  const baseGuards = new Map((base.guards ?? []).filter((item) => item?.id).map((item) => [item.id, item]));
  const headGuards = new Map((head.guards ?? []).filter((item) => item?.id).map((item) => [item.id, item]));
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
  return finding.catalogEntryId
    || finding.catalogEntryIds?.[0]
    || finding.file
    || 'catalog';
}

function classifyProofFindings(trust) {
  const atoms = [];
  for (const finding of trust.proofIntegrity?.newProofs ?? []) {
    atoms.push(atom('HUMAN', 'NEW_PROOF', `catalog.${proofPath(finding)}`));
  }
  for (const finding of trust.proofIntegrity?.changedSources ?? []) {
    atoms.push(atom('REJECT', 'PROOF_SOURCE_CHANGED', finding.file || `catalog.${proofPath(finding)}`));
  }
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
    if (changeType === 'STATUS_CHANGED') {
      atoms.push(atom('HUMAN', 'PROOF_STATUS_CHANGED', path));
      continue;
    }
    atoms.push(atom('HUMAN', 'PROOF_DEFINITION_CHANGED', path));
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
  if (atoms.some((item) => item.path === prefix || String(item.path).startsWith(`${prefix}.`) || String(item.path).startsWith(`${prefix}:`))) {
    return [];
  }
  return [unclassified(file)];
}

export function classifyAuthorization(input) {
  const changedFiles = uniqueSorted(input.changedFiles ?? []);
  const kernelChanges = uniqueSorted(changedFiles.filter(isKernelPath));
  try {
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
    if (fileTouched(changedFiles, POLICY_FILES.catalog) && proofAtoms.length === 0) {
      proofAtoms.push(unclassified(POLICY_FILES.catalog));
    }
    const entryAtoms = classifyEntrypoints(trust);
    const atoms = [...policyAtoms, ...proofAtoms, ...entryAtoms];

    const lows = atoms.filter((item) => item.classification === 'LOW');
    const weakenings = atoms.filter((item) => item.classification === 'REJECT');
    const humans = atoms.filter((item) => item.classification === 'HUMAN');
    const residualChanges = humans.map((item) => ({ code: item.code, path: item.path }))
      .sort((a, b) => String(a.path).localeCompare(String(b.path)) || String(a.code).localeCompare(String(b.code)));
    const reasonCodes = uniqueSorted(atoms.map((item) => item.code).concat(kernelChanges.length > 0 ? ['KERNEL_CHANGED'] : []));
    const strengthenings = uniqueSorted(lows.map((item) => `${item.code}:${item.path}`));
    const weakeningNotes = uniqueSorted(weakenings.map((item) => `${item.code}:${item.path}`));
    const labels = [];
    if (kernelChanges.length > 0) labels.push('KERNEL_CHANGED');
    if (lows.length > 0) labels.push('SAFE_STRENGTHENING');
    if (weakenings.some((item) => String(item.code).startsWith('PROOF') || item.code.startsWith('PINNED'))) labels.push('PROOF_WEAKENING');
    if (weakenings.some((item) => String(item.code).startsWith('GUARD'))) labels.push('ARCHITECTURE_GUARD_WEAKENING');
    if (weakenings.some((item) => !String(item.code).startsWith('PROOF') && !String(item.code).startsWith('PINNED') && !String(item.code).startsWith('GUARD'))) {
      labels.push('POLICY_WEAKENING');
    }
    if (humans.some((item) => item.code === 'NEW_PROOF')) labels.push('NEW_PROOF');
    if (humans.some((item) => item.code === 'UNCLASSIFIED_POLICY_CHANGE')) labels.push('UNCLASSIFIED_POLICY_CHANGE');
    else if (humans.length > 0) labels.push('UNKNOWN');

    const affectedInvariants = uniqueSorted(atoms
      .map((item) => /invariants\.([^.:]+)/.exec(item.path)?.[1])
      .filter(Boolean));
    const affectedProofs = uniqueSorted(atoms
      .filter((item) => String(item.path).startsWith('catalog.'))
      .map((item) => item.path.slice('catalog.'.length)));

    const packFields = {
      changedFiles,
      kernelChanges,
      strengthenings,
      weakenings: weakeningNotes,
      residualChanges,
      affectedInvariants,
      affectedProofs,
      reasonCodes,
      labels: uniqueSorted(labels),
      baseSha: input.baseSha,
      headSha: input.headSha,
    };

    if (weakenings.length > 0) {
      return pack({
        ...packFields,
        decision: 'REJECT',
        risk: 'HIGH',
        labels: uniqueSorted([...labels, kernelChanges.length > 0 ? 'KERNEL_WEAKENING' : null]),
      });
    }

    if (kernelChanges.length > 0) {
      return pack({
        ...packFields,
        decision: 'HUMAN_REQUIRED',
        risk: 'HIGH',
        labels: uniqueSorted(['KERNEL_CHANGED', ...labels]),
        reasonCodes: uniqueSorted(['KERNEL_CHANGED', ...reasonCodes]),
      });
    }

    if (humans.length > 0) {
      return pack({
        ...packFields,
        decision: 'HUMAN_REQUIRED',
        risk: 'HIGH',
        labels: uniqueSorted(labels.length > 0 ? labels : ['UNCLASSIFIED_POLICY_CHANGE']),
        reasonCodes: uniqueSorted(reasonCodes.length > 0 ? reasonCodes : ['UNCLASSIFIED_POLICY_CHANGE']),
      });
    }

    if (lows.length > 0 && residualChanges.length === 0) {
      return pack({
        ...packFields,
        decision: 'LOW_PASS',
        risk: 'LOW',
        labels: uniqueSorted(['SAFE_STRENGTHENING', ...labels]),
      });
    }

    return pack({
      ...packFields,
      decision: 'PASS',
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
      risk: 'HIGH',
      labels: ['UNKNOWN'],
      changedFiles,
      kernelChanges,
      strengthenings: [],
      weakenings: [],
      residualChanges: [],
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
    schemaVersion: 1,
    baseSha: fields.baseSha ?? null,
    headSha: fields.headSha ?? null,
    decision: fields.decision,
    risk: fields.risk,
    labels: uniqueSorted(fields.labels),
    changedFiles: uniqueSorted(fields.changedFiles),
    kernelChanges: uniqueSorted(fields.kernelChanges),
    strengthenings: uniqueSorted(fields.strengthenings),
    weakenings: uniqueSorted(fields.weakenings),
    residualChanges: (fields.residualChanges ?? []).map((item) => ({ code: item.code, path: item.path })),
    affectedInvariants: uniqueSorted(fields.affectedInvariants),
    affectedProofs: uniqueSorted(fields.affectedProofs),
    reasonCodes: uniqueSorted(fields.reasonCodes),
  };
  if (fields.error) result.error = fields.error;
  return result;
}
