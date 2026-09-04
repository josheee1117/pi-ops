/**
 * v2.0 deterministic authorization classifier.
 * Pure functions. No LLM. No engine imports (Trust Anchor cannot depend on typescript).
 */

export const DECISIONS = ['PASS', 'LOW_PASS', 'HUMAN_REQUIRED', 'REJECT', 'INTERNAL_ERROR'];
const LEVEL_RANK = { A: 3, B: 2, C: 1 };
const LOW_POLICY_KINDS = new Set([
  'EVIDENCE_FLOOR_RAISED',
  'GOVERNED_ROOT_ADDED',
  'INVARIANT_ADDED',
  'GUARD_SCOPE_EXPANDED',
  'GUARD_PATTERN_ADDED',
]);
const POLICY_CONFIG_FILES = new Set([
  'tools/test-governance/config/features.json',
  'tools/test-governance/config/architecture-guards.json',
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
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
}

function rankOf(required) {
  const req = required ?? {};
  if ((req.A ?? 0) > 0) return 3;
  if ((req.B ?? 0) > 0) return 2;
  if ((req.C ?? 0) > 0) return 1;
  return 0;
}

function levelName(rank) {
  return rank === 3 ? 'A' : rank === 2 ? 'B' : rank === 1 ? 'C' : 'none';
}

function invariantIndex(featuresDoc) {
  const map = new Map();
  for (const feature of featuresDoc?.features ?? []) {
    for (const invariant of feature.invariants ?? []) {
      if (invariant.id) map.set(invariant.id, invariant);
    }
  }
  return map;
}

function analyzeFloors(baseFeatures, headFeatures) {
  const raises = [];
  const lowers = [];
  const baseIndex = invariantIndex(baseFeatures);
  const headIndex = invariantIndex(headFeatures);
  for (const [id, baseInvariant] of baseIndex) {
    const headInvariant = headIndex.get(id);
    if (!headInvariant) continue;
    const beforeRank = rankOf(baseInvariant.requiredEvidence);
    const afterRank = rankOf(headInvariant.requiredEvidence);
    for (const level of ['A', 'B', 'C']) {
      const before = baseInvariant.requiredEvidence?.[level] ?? 0;
      const after = headInvariant.requiredEvidence?.[level] ?? 0;
      if (after > before) {
        raises.push({ invariantId: id, level, before, after });
      } else if (after < before) {
        const absorbedUpgrade = afterRank > beforeRank && (LEVEL_RANK[level] ?? 0) < afterRank;
        if (!absorbedUpgrade) lowers.push({ invariantId: id, level, before, after });
      }
    }
  }
  return { raises, lowers };
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

export function classifyAuthorization(input) {
  const labels = [];
  const reasonCodes = [];
  const strengthenings = [];
  const weakenings = [];
  const kernelChanges = uniqueSorted((input.changedFiles ?? []).filter(isKernelPath));
  const changedFiles = uniqueSorted(input.changedFiles ?? []);
  const affectedInvariants = [];
  const affectedProofs = [];

  const push = (list, item) => {
    if (item && !list.includes(item)) list.push(item);
  };

  try {
    const trust = input.trustResult ?? {};
    const findings = [
      ...(trust.trustSurface?.findings ?? []),
      ...(trust.proofIntegrity?.changedSources ?? []),
      ...(trust.proofIntegrity?.changedDefinitions ?? []),
      ...(trust.proofIntegrity?.newProofs ?? []),
    ];
    const noTrustChange = findings.length === 0 && kernelChanges.length === 0;

    if (kernelChanges.length > 0) {
      labels.push('KERNEL_CHANGED');
      reasonCodes.push('KERNEL_CHANGED');
    }

    for (const finding of trust.proofIntegrity?.newProofs ?? []) {
      labels.push('NEW_PROOF');
      reasonCodes.push('NEW_PROOF');
      for (const id of finding.catalogEntryIds ?? []) push(affectedProofs, id);
      for (const id of finding.invariantIds ?? []) push(affectedInvariants, id);
    }
    for (const finding of trust.proofIntegrity?.changedSources ?? []) {
      labels.push('PROOF_WEAKENING');
      reasonCodes.push('PROOF_SOURCE_CHANGED');
      weakenings.push(finding.kind ?? 'PROOF_SOURCE_CHANGED');
      for (const id of finding.catalogEntryIds ?? []) push(affectedProofs, id);
    }
    for (const finding of trust.proofIntegrity?.changedDefinitions ?? []) {
      for (const id of finding.catalogEntryIds ?? []) push(affectedProofs, id);
      const removed = /REMOVED/.test(finding.kind ?? '');
      const move = / ([ABC]) -> ([ABC])/.exec(finding.detail ?? '');
      const downgrade = move ? (LEVEL_RANK[move[2]] ?? 0) < (LEVEL_RANK[move[1]] ?? 0) : false;
      if (removed || downgrade || (finding.kind ?? '').startsWith('PINNED')) {
        labels.push('PROOF_WEAKENING');
        reasonCodes.push('PROOF_DEFINITION_CHANGED');
        weakenings.push(finding.kind ?? 'PROOF_DEFINITION_CHANGED');
      } else {
        labels.push('UNKNOWN');
        reasonCodes.push('PROOF_DEFINITION_CHANGED');
      }
    }

    const baseFeatures = input.baseFeatures ?? { features: [] };
    const headFeatures = input.headFeatures ?? { features: [] };
    const floors = analyzeFloors(baseFeatures, headFeatures);
    for (const raise of floors.raises) {
      strengthenings.push(`EVIDENCE_FLOOR_RAISED:${raise.invariantId}:${raise.level}`);
      push(affectedInvariants, raise.invariantId);
      labels.push('SAFE_STRENGTHENING');
      reasonCodes.push('EVIDENCE_FLOOR_RAISED');
    }
    for (const lower of floors.lowers) {
      weakenings.push(`EVIDENCE_FLOOR_LOWERED:${lower.invariantId}:${lower.level}`);
      push(affectedInvariants, lower.invariantId);
      labels.push('POLICY_WEAKENING');
      reasonCodes.push('EVIDENCE_FLOOR_LOWERED');
    }

    const roots = listDelta(baseFeatures.governedRoots ?? [], headFeatures.governedRoots ?? []);
    for (const root of roots.added) {
      strengthenings.push(`GOVERNED_ROOT_ADDED:${root}`);
      labels.push('SAFE_STRENGTHENING');
      reasonCodes.push('GOVERNED_ROOT_ADDED');
    }
    for (const root of roots.removed) {
      weakenings.push(`GOVERNED_ROOT_REMOVED:${root}`);
      labels.push('POLICY_WEAKENING');
      reasonCodes.push('GOVERNED_ROOT_REMOVED');
    }

    const baseInv = invariantIndex(baseFeatures);
    const headInv = invariantIndex(headFeatures);
    for (const id of headInv.keys()) {
      if (!baseInv.has(id)) {
        strengthenings.push(`INVARIANT_ADDED:${id}`);
        push(affectedInvariants, id);
        labels.push('SAFE_STRENGTHENING');
        reasonCodes.push('INVARIANT_ADDED');
      }
    }
    for (const [id, baseInvariant] of baseInv) {
      const headInvariant = headInv.get(id);
      if (!headInvariant) {
        weakenings.push(`INVARIANT_REMOVED:${id}`);
        push(affectedInvariants, id);
        labels.push('POLICY_WEAKENING');
        reasonCodes.push('INVARIANT_REMOVED');
        continue;
      }
      if ((baseInvariant.statement ?? '') !== (headInvariant.statement ?? '')) {
        push(affectedInvariants, id);
        labels.push('UNKNOWN');
        reasonCodes.push('INVARIANT_STATEMENT_CHANGED');
      }
    }

    const baseGuards = new Map((input.baseGuards?.guards ?? []).map((guard) => [guard.id, guard]));
    const headGuards = new Map((input.headGuards?.guards ?? []).map((guard) => [guard.id, guard]));
    for (const [id, base] of baseGuards) {
      const head = headGuards.get(id);
      if (!head) {
        weakenings.push(`GUARD_REMOVED:${id}`);
        labels.push('ARCHITECTURE_GUARD_WEAKENING');
        reasonCodes.push('GUARD_REMOVED');
        continue;
      }
      if (base.kind !== head.kind) {
        labels.push('UNKNOWN');
        reasonCodes.push('GUARD_KIND_CHANGED');
        continue;
      }
      const scope = listDelta(base.scope ?? [], head.scope ?? []);
      if (scope.removed.length > 0) {
        weakenings.push(`GUARD_SCOPE_SHRUNK:${id}`);
        labels.push('ARCHITECTURE_GUARD_WEAKENING');
        reasonCodes.push('GUARD_SCOPE_SHRUNK');
      }
      if (scope.added.length > 0) {
        strengthenings.push(`GUARD_SCOPE_EXPANDED:${id}`);
        labels.push('SAFE_STRENGTHENING');
        reasonCodes.push('GUARD_SCOPE_EXPANDED');
      }
      const patterns = listDelta(base.patterns ?? [], head.patterns ?? []);
      if (patterns.removed.length > 0) {
        weakenings.push(`GUARD_PATTERN_REMOVED:${id}`);
        labels.push('ARCHITECTURE_GUARD_WEAKENING');
        reasonCodes.push('GUARD_PATTERN_REMOVED');
      }
      if (patterns.added.length > 0) {
        strengthenings.push(`GUARD_PATTERN_ADDED:${id}`);
        labels.push('SAFE_STRENGTHENING');
        reasonCodes.push('GUARD_PATTERN_ADDED');
      }
    }
    for (const id of headGuards.keys()) {
      if (!baseGuards.has(id)) {
        labels.push('UNKNOWN');
        reasonCodes.push('GUARD_ADDED');
      }
    }

    const ignore = listDelta(baseFeatures.unmappedIgnore ?? [], headFeatures.unmappedIgnore ?? []);
    if (ignore.added.length > 0) {
      weakenings.push('UNMAPPED_IGNORE_EXPANDED');
      labels.push('POLICY_WEAKENING');
      reasonCodes.push('UNMAPPED_IGNORE_EXPANDED');
    }
    if (ignore.removed.length > 0) {
      labels.push('UNKNOWN');
      reasonCodes.push('UNMAPPED_IGNORE_REDUCED');
    }

    const entrypointFindings = (trust.trustSurface?.findings ?? []).filter((item) => item.kind === 'GOVERNANCE_ENTRYPOINT_CHANGED');
    for (const finding of entrypointFindings) {
      const removed = /removed/.test(finding.detail ?? '');
      if (removed) {
        weakenings.push(finding.detail);
        labels.push('POLICY_WEAKENING');
        reasonCodes.push('GOVERNANCE_ENTRYPOINT_REMOVED');
      } else {
        labels.push('KERNEL_CHANGED');
        reasonCodes.push('GOVERNANCE_ENTRYPOINT_CHANGED');
      }
    }

    const uniqueLabels = uniqueSorted(labels);
    const uniqueReasons = uniqueSorted(reasonCodes);
    const uniqueStrengthenings = uniqueSorted(strengthenings);
    const uniqueWeakenings = uniqueSorted(weakenings);

    if (noTrustChange && uniqueWeakenings.length === 0 && uniqueReasons.length === 0) {
      return pack({
        decision: 'PASS',
        risk: 'NONE',
        labels: [],
        changedFiles,
        kernelChanges,
        strengthenings: [],
        weakenings: [],
        affectedInvariants: uniqueSorted(affectedInvariants),
        affectedProofs: uniqueSorted(affectedProofs),
        reasonCodes: [],
        baseSha: input.baseSha,
        headSha: input.headSha,
      });
    }

    if (uniqueWeakenings.length > 0 || uniqueLabels.includes('PROOF_WEAKENING') || uniqueLabels.includes('ARCHITECTURE_GUARD_WEAKENING') || uniqueLabels.includes('POLICY_WEAKENING')) {
      const kernelWeakening = kernelChanges.length > 0;
      return pack({
        decision: 'REJECT',
        risk: 'HIGH',
        labels: uniqueSorted([...uniqueLabels, kernelWeakening ? 'KERNEL_WEAKENING' : null]),
        changedFiles,
        kernelChanges,
        strengthenings: uniqueStrengthenings,
        weakenings: uniqueWeakenings,
        affectedInvariants: uniqueSorted(affectedInvariants),
        affectedProofs: uniqueSorted(affectedProofs),
        reasonCodes: uniqueReasons,
        baseSha: input.baseSha,
        headSha: input.headSha,
      });
    }

    const extraFiles = changedFiles.filter((file) => !POLICY_CONFIG_FILES.has(file) && file !== 'tools/test-governance/config/catalog.json');
    const catalogTouched = changedFiles.includes('tools/test-governance/config/catalog.json');
    const onlyLowReasons = uniqueReasons.every((code) => LOW_POLICY_KINDS.has(code));
    const lowCandidate = onlyLowReasons
      && uniqueReasons.length > 0
      && kernelChanges.length === 0
      && !uniqueLabels.includes('NEW_PROOF')
      && !uniqueLabels.includes('UNKNOWN')
      && extraFiles.length === 0
      && !catalogTouched;

    if (lowCandidate) {
      return pack({
        decision: 'LOW_PASS',
        risk: 'LOW',
        labels: uniqueSorted(['SAFE_STRENGTHENING', ...uniqueLabels]),
        changedFiles,
        kernelChanges,
        strengthenings: uniqueStrengthenings,
        weakenings: [],
        affectedInvariants: uniqueSorted(affectedInvariants),
        affectedProofs: uniqueSorted(affectedProofs),
        reasonCodes: uniqueReasons,
        baseSha: input.baseSha,
        headSha: input.headSha,
      });
    }

    if (uniqueLabels.includes('UNKNOWN') && uniqueReasons.length > 0 && kernelChanges.length === 0 && uniqueWeakenings.length === 0 && uniqueLabels.includes('NEW_PROOF') === false) {
      return pack({
        decision: 'HUMAN_REQUIRED',
        risk: 'HIGH',
        labels: uniqueSorted([...uniqueLabels, 'UNKNOWN']),
        changedFiles,
        kernelChanges,
        strengthenings: uniqueStrengthenings,
        weakenings: uniqueWeakenings,
        affectedInvariants: uniqueSorted(affectedInvariants),
        affectedProofs: uniqueSorted(affectedProofs),
        reasonCodes: uniqueReasons,
        baseSha: input.baseSha,
        headSha: input.headSha,
      });
    }

    return pack({
      decision: 'HUMAN_REQUIRED',
      risk: 'HIGH',
      labels: uniqueLabels.length > 0 ? uniqueLabels : ['KERNEL_CHANGED'],
      changedFiles,
      kernelChanges,
      strengthenings: uniqueStrengthenings,
      weakenings: uniqueWeakenings,
      affectedInvariants: uniqueSorted(affectedInvariants),
      affectedProofs: uniqueSorted(affectedProofs),
      reasonCodes: uniqueReasons.length > 0 ? uniqueReasons : ['KERNEL_CHANGED'],
      baseSha: input.baseSha,
      headSha: input.headSha,
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
    affectedInvariants: uniqueSorted(fields.affectedInvariants),
    affectedProofs: uniqueSorted(fields.affectedProofs),
    reasonCodes: uniqueSorted(fields.reasonCodes),
  };
  if (fields.error) result.error = fields.error;
  return result;
}
