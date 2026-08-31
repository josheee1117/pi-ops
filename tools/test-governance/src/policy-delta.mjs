import { canonicalizeCommand, catalogEntryKind } from './core.mjs';

/**
 * Policy Delta Guard: deterministic semantic comparison of governance policy
 * at BASE vs HEAD. A commit must never be able to weaken the rules that judge
 * it in the same change (removed guards, lowered Evidence floors, deleted
 * PINNED regressions, shrunk governed scope, regraded Proofs).
 *
 * Pure function: both policy versions are parsed structures, never diff text.
 * Weakening fails closed (GOVERNANCE_POLICY_WEAKENING); strengthening passes.
 */
const FLOOR_LEVELS = ['A', 'B', 'C'];

function sourceKeyOf(entry, packageScripts) {
  const kind = catalogEntryKind(entry);
  if (kind === 'TEST') return `test:${entry.location.file}#${entry.location.testName}`;
  if (kind === 'COMMAND') {
    const { canonical } = canonicalizeCommand(entry.command, {
      packageScripts,
      declaredFile: entry.location?.file,
    });
    return `command:${canonical?.target ?? String(entry.command ?? '').trim()}`;
  }
  return `unexecutable:${entry?.id ?? ''}`;
}

function proofKeyOf(entry, proof, packageScripts) {
  return `${proof.invariantId}\u0000${proof.level}\u0000${sourceKeyOf(entry, packageScripts)}`;
}

function listRemovedAndAdded(baseItems, headItems) {
  const headSet = new Set(headItems);
  const baseSet = new Set(baseItems);
  return {
    removed: baseItems.filter((item) => !headSet.has(item)),
    added: headItems.filter((item) => !baseSet.has(item)),
  };
}

export function evaluatePolicyDelta({
  baseFeatures,
  headFeatures,
  baseCatalog,
  headCatalog,
  baseGuards,
  headGuards,
}, options = {}) {
  const changes = [];
  const record = (blocking, kind, detail) => changes.push({ kind, blocking, detail });

  compareGuards(baseGuards, headGuards, record);
  compareGovernedRoots(baseFeatures, headFeatures, record);
  compareUnmappedIgnore(baseFeatures, headFeatures, record);
  compareFeatures(baseFeatures, headFeatures, record);
  compareCatalog(baseCatalog, headCatalog, { record, packageScripts: options.packageScripts });

  const blockingChanges = changes.filter((change) => change.blocking);
  return {
    status: blockingChanges.length > 0 ? 'GOVERNANCE_POLICY_WEAKENING' : 'PASS',
    changes,
    blockingChanges,
  };
}

function compareGuards(baseGuards, headGuards, record) {
  const baseGuardsValue = baseGuards?.guards ?? [];
  const headGuardsValue = headGuards?.guards ?? [];
  const headById = new Map(headGuardsValue.map((guard) => [guard.id, guard]));

  for (const base of baseGuardsValue) {
    const head = headById.get(base.id);
    if (!head) {
      record(true, 'GUARD_REMOVED', `removed architecture guard ${base.id}`);
      continue;
    }
    if (base.kind !== head.kind) {
      // Kind changes are never auto-classified as stronger/weaker: e.g.
      // forbiddenText -> forbiddenImport can lose protection for patterns
      // that are not import specifiers.
      record(true, 'POLICY_REVIEW_REQUIRED', `architecture guard ${base.id} kind ${base.kind} -> ${head.kind}`);
    }
    const { removed: scopeRemoved, added: scopeAdded } = listRemovedAndAdded(base.scope ?? [], head.scope ?? []);
    if (scopeRemoved.length > 0) {
      record(true, 'GUARD_SCOPE_SHRUNK', `shrunk scope of architecture guard ${base.id}: removed ${scopeRemoved.join(', ')}`);
    }
    for (const pattern of scopeAdded) {
      record(false, 'GUARD_SCOPE_EXPANDED', `expanded scope of architecture guard ${base.id}: added ${pattern}`);
    }
    const { removed: patternRemoved, added: patternAdded } = listRemovedAndAdded(base.patterns ?? [], head.patterns ?? []);
    if (patternRemoved.length > 0) {
      record(true, 'GUARD_PATTERN_REMOVED', `removed pattern from architecture guard ${base.id}: ${patternRemoved.join(', ')}`);
    }
    for (const pattern of patternAdded) {
      record(false, 'GUARD_PATTERN_ADDED', `added pattern to architecture guard ${base.id}: ${pattern}`);
    }
  }
  const baseIds = new Set(baseGuardsValue.map((guard) => guard.id));
  for (const head of headGuardsValue) {
    if (!baseIds.has(head.id)) record(false, 'GUARD_ADDED', `added architecture guard ${head.id}`);
  }
}

function compareGovernedRoots(baseFeatures, headFeatures, record) {
  const baseRoots = baseFeatures?.governedRoots ?? [];
  const headRoots = headFeatures?.governedRoots ?? [];
  const { removed, added } = listRemovedAndAdded(baseRoots, headRoots);
  for (const root of removed) record(true, 'GOVERNED_ROOT_REMOVED', `removed governed root ${root}`);
  for (const root of added) record(false, 'GOVERNED_ROOT_ADDED', `added governed root ${root}`);
}

/**
 * unmappedIgnore is an exemption surface: every added ignore pattern removes
 * production files from UNMAPPED_PRODUCTION_CHANGE detection and weakens
 * governance. Exact-set comparison only; no glob containment reasoning.
 */
function compareUnmappedIgnore(baseFeatures, headFeatures, record) {
  const baseIgnore = baseFeatures?.unmappedIgnore ?? [];
  const headIgnore = headFeatures?.unmappedIgnore ?? [];
  const { removed, added } = listRemovedAndAdded(baseIgnore, headIgnore);
  for (const pattern of removed) record(false, 'UNMAPPED_IGNORE_REDUCED', `removed unmappedIgnore pattern ${pattern}`);
  for (const pattern of added) record(true, 'UNMAPPED_IGNORE_EXPANDED', `added unmappedIgnore pattern ${pattern}`);
}

function compareFeatures(baseFeatures, headFeatures, record) {
  const baseList = baseFeatures?.features ?? [];
  const headList = headFeatures?.features ?? [];
  const headById = new Map(headList.map((feature) => [feature.id, feature]));

  for (const base of baseList) {
    const head = headById.get(base.id);
    if (!head) {
      record(true, 'FEATURE_REMOVED', `removed Feature ${base.id}`);
      continue;
    }
    const { removed: pathsRemoved, added: pathsAdded } = listRemovedAndAdded(base.paths ?? [], head.paths ?? []);
    for (const path of pathsRemoved) record(true, 'FEATURE_PATH_REMOVED', `${base.id}: removed Feature path ${path}`);
    for (const path of pathsAdded) record(false, 'FEATURE_PATH_ADDED', `${base.id}: added Feature path ${path}`);

    const { removed: impactsRemoved, added: impactsAdded } = listRemovedAndAdded(base.impacts ?? [], head.impacts ?? []);
    for (const impact of impactsRemoved) record(true, 'IMPACT_EDGE_REMOVED', `${base.id}: removed impact edge ${impact}`);
    for (const impact of impactsAdded) record(false, 'IMPACT_EDGE_ADDED', `${base.id}: added impact edge ${impact}`);

    compareInvariants(base, head, record);
  }
  const baseIds = new Set(baseList.map((feature) => feature.id));
  for (const head of headList) {
    if (!baseIds.has(head.id)) record(false, 'FEATURE_ADDED', `added Feature ${head.id}`);
  }
}

function compareInvariants(base, head, record) {
  const baseInvariants = new Map((base.invariants ?? []).map((invariant) => [invariant.id, invariant]));
  const headInvariants = new Map((head.invariants ?? []).map((invariant) => [invariant.id, invariant]));

  for (const [id, baseInvariant] of baseInvariants) {
    const headInvariant = headInvariants.get(id);
    if (!headInvariant) {
      record(true, 'INVARIANT_REMOVED', `${base.id}: removed invariant ${id}`);
      continue;
    }
    for (const level of FLOOR_LEVELS) {
      const before = baseInvariant.requiredEvidence?.[level] ?? 0;
      const after = headInvariant.requiredEvidence?.[level] ?? 0;
      if (before > after) {
        record(true, 'EVIDENCE_FLOOR_LOWERED', `lowered evidence floor ${id} ${level}:${before} -> ${level}:${after}`);
      } else if (before < after) {
        record(false, 'EVIDENCE_FLOOR_RAISED', `raised evidence floor ${id} ${level}:${before} -> ${level}:${after}`);
      }
    }
    if ((baseInvariant.statement ?? '') !== (headInvariant.statement ?? '')) {
      // Any statement change on an existing invariant id requires review:
      // the machine cannot distinguish wording clarification from semantic
      // weakening, so both block automatic PASS.
      record(true, 'POLICY_REVIEW_REQUIRED', `invariant ${id} statement changed: "${baseInvariant.statement}" -> "${headInvariant.statement}"`);
    }
  }
  for (const id of headInvariants.keys()) {
    if (!baseInvariants.has(id)) record(false, 'INVARIANT_ADDED', `${head.id}: added invariant ${id}`);
  }
}

function compareCatalog(baseCatalog, headCatalog, context) {
  const { record, packageScripts } = context;
  const baseEntries = baseCatalog?.entries ?? [];
  const headEntries = headCatalog?.entries ?? [];
  const headById = new Map(headEntries.map((entry) => [entry.id, entry]));

  for (const base of baseEntries) {
    const head = headById.get(base.id);
    if (!head) {
      if ((base.status ?? 'ACTIVE') === 'PINNED') {
        record(true, 'PINNED_ENTRY_REMOVED', `PINNED catalog proof ${base.id} removed`);
      } else {
        record(false, 'CATALOG_ENTRY_REMOVED', `catalog entry ${base.id} removed (status ${base.status ?? 'ACTIVE'})`);
      }
      continue;
    }
    const baseStatus = base.status ?? 'ACTIVE';
    const headStatus = head.status ?? 'ACTIVE';
    if (baseStatus === 'PINNED' && headStatus !== 'PINNED') {
      record(true, 'PINNED_STATUS_CHANGED', `PINNED catalog proof ${base.id} -> ${headStatus}`);
    }
    if (base.historicalRegression === true && head.historicalRegression !== true) {
      record(true, 'HISTORICAL_REGRESSION_FLIPPED', `${base.id}: historicalRegression true -> ${head.historicalRegression ?? false}`);
    }
    if (baseStatus === 'PINNED' && headStatus === 'PINNED') {
      if (sourceKeyOf(base, packageScripts) !== sourceKeyOf(head, packageScripts)) {
        record(true, 'PINNED_SOURCE_CHANGED', `changed backing executable source of PINNED entry ${base.id}`);
      }
      const headProofKeys = new Set((head.proofs ?? []).map((proof) => proofKeyOf(head, proof, packageScripts)));
      for (const proof of base.proofs ?? []) {
        if (!headProofKeys.has(proofKeyOf(base, proof, packageScripts))) {
          record(true, 'PINNED_PROOF_REMOVED', `removed Proof from PINNED entry ${base.id}: ${proof.invariantId}:${proof.level}`);
        }
      }
    }

    // EVIDENCE_GRADE_CHANGE: an existing Proof Source (same backing test or
    // canonical command) must never silently swap its Evidence level
    // (C -> A, B -> A, ...). Adding an extra level alongside the existing one
    // is a new Proof and stays allowed.
    const baseProofLevels = proofLevelsByInvariant(base, packageScripts);
    const headProofLevels = proofLevelsByInvariant(head, packageScripts);
    for (const [mapKey, baseLevels] of baseProofLevels) {
      const headLevels = headProofLevels.get(mapKey);
      if (!headLevels) continue;
      const lost = [...baseLevels].filter((level) => !headLevels.has(level));
      const gained = [...headLevels].filter((level) => !baseLevels.has(level));
      if (lost.length > 0 && gained.length > 0) {
        const invariantId = mapKey.split('\u0000')[0];
        record(true, 'EVIDENCE_GRADE_CHANGE_REQUIRES_REVIEW', `${base.id}: Proof ${invariantId} level ${lost.join('/')} -> ${gained.join('/')} on unchanged backing source`);
      }
    }

    if (baseStatus !== 'PINNED') {
      const headProofKeys = new Set((head.proofs ?? []).map((proof) => proofKeyOf(head, proof, packageScripts)));
      const baseProofKeys = new Set((base.proofs ?? []).map((proof) => proofKeyOf(base, proof, packageScripts)));
      for (const proof of base.proofs ?? []) {
        if (!headProofKeys.has(proofKeyOf(base, proof, packageScripts))) {
          record(false, 'CATALOG_PROOF_REMOVED', `removed Proof from catalog entry ${base.id}: ${proof.invariantId}:${proof.level}`);
        }
      }
      for (const proof of head.proofs ?? []) {
        if (!baseProofKeys.has(proofKeyOf(head, proof, packageScripts))) {
          record(false, 'CATALOG_PROOF_ADDED', `added Proof to catalog entry ${base.id}: ${proof.invariantId}:${proof.level}`);
        }
      }
    }
  }
  const baseIds = new Set(baseEntries.map((entry) => entry.id));
  for (const head of headEntries) {
    if (!baseIds.has(head.id)) record(false, 'CATALOG_ENTRY_ADDED', `added catalog entry ${head.id}`);
  }
}

function proofLevelsByInvariant(entry, packageScripts) {
  const levels = new Map();
  const sourceKey = sourceKeyOf(entry, packageScripts);
  for (const proof of entry.proofs ?? []) {
    const mapKey = `${proof.invariantId}\u0000${sourceKey}`;
    if (!levels.has(mapKey)) levels.set(mapKey, new Set());
    levels.get(mapKey).add(proof.level);
  }
  return levels;
}
