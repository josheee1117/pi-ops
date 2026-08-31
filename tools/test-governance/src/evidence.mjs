/**
 * Realized Evidence.
 *
 * Catalog entries are POTENTIAL evidence ("this test can prove invariant X").
 * A proof becomes REALIZED only when its backing run actually executed and
 * PASSED in the current gate run. Only PASSED realizes proofs; FAILED,
 * SKIPPED, NOT_RUN, and UNEXECUTABLE realize nothing.
 */

const LEVELS = ['A', 'B', 'C'];

export function realizeEvidence({ features, executionResults }) {
  const statusByEntry = new Map();
  for (const result of executionResults) {
    for (const [entryId, status] of Object.entries(result.entryStatuses ?? {})) {
      statusByEntry.set(entryId, { status, runId: result.runId, gate: result.gate });
    }
  }

  const featureEvidence = (features ?? []).map((item) => {
    const invariants = (item.feature.invariants ?? []).map((invariant) => {
      const required = { A: 0, B: 0, C: 0, ...(invariant.requiredEvidence ?? {}) };
      const potential = { A: 0, B: 0, C: 0 };
      const realized = { A: 0, B: 0, C: 0 };
      const realizers = [];
      let liveProviderBlocked = false;
      for (const entry of item.plan.selected ?? []) {
        for (const proof of entry.proofs ?? []) {
          if (proof.invariantId !== invariant.id) continue;
          potential[proof.level] += 1;
          const execution = statusByEntry.get(entry.id);
          if (execution?.status === 'PASSED') {
            realized[proof.level] += 1;
            realizers.push({ catalogEntryId: entry.id, runId: execution.runId, level: proof.level });
          } else if (execution?.status === 'NOT_RUN' && execution.gate === 4) {
            liveProviderBlocked = true;
          }
        }
      }
      const satisfied = LEVELS.every((level) => realized[level] >= required[level]);
      return {
        invariantId: invariant.id,
        required,
        potential,
        realized,
        realizers,
        satisfied,
        liveProviderBlocked: !satisfied && liveProviderBlocked,
      };
    });
    return {
      featureId: item.feature.id,
      reason: item.reason ?? 'DIRECT',
      invariants,
      status: invariants.every((invariant) => invariant.satisfied)
        ? 'SATISFIED'
        : 'EXECUTION_EVIDENCE_MISSING',
    };
  });

  return {
    features: featureEvidence,
    allSatisfied: featureEvidence.every((feature) => feature.status === 'SATISFIED'),
  };
}

export function resolveGateStatus({ policyStatus, executionResults, evidence }) {
  if (policyStatus !== 'READY') return 'POLICY_BLOCKED';
  const failedRun = (executionResults ?? []).some((result) => result.status === 'FAILED' || result.status === 'UNEXECUTABLE');
  if (failedRun) return 'EXECUTION_FAILED';
  if (!evidence?.allSatisfied) {
    const unsatisfied = (evidence?.features ?? []).flatMap((feature) => feature.invariants)
      .filter((invariant) => !invariant.satisfied);
    if (unsatisfied.length > 0 && unsatisfied.every((invariant) => invariant.liveProviderBlocked)) {
      return 'LIVE_PROVIDER_REQUIRED';
    }
    return 'EVIDENCE_NOT_REALIZED';
  }
  return 'PASS';
}
