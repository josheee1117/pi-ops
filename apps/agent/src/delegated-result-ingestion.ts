import type { DelegatedReasoningResult } from './pi-runtime-client.js';
import type { ReasoningResult } from './reasoner.js';
import { REASONING_STRATEGY_VERSION } from './reasoning-strategy.js';
import { hashEvidenceSnapshot } from './reasoning-worker.js';
import type { EventStore } from './store.js';

const MAX_SUMMARY_CHARS = 2000;

export function createDelegatedResultIngestionService(
  store: EventStore,
  options: { now?: () => string } = {},
) {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    ingest(input: DelegatedReasoningResult): ReasoningResult {
      validatePayload(input);
      const plan = store.getInvestigationPlan(input.investigationPlanId);
      if (!plan) throw new Error(`InvestigationPlan ${input.investigationPlanId} does not exist`);
      const job = store.getReasoningJob(plan.reasoningJobId);
      if (!job) throw new Error(`ReasoningJob ${plan.reasoningJobId} does not exist`);
      if (plan.reasoningJobId !== job.id) {
        throw new Error('InvestigationPlan does not belong to the ReasoningJob');
      }
      const existing = store.getReasoningResultByJobId(job.id);
      if (existing) {
        if (existing.investigationPlanId && existing.investigationPlanId !== plan.id) {
          throw new Error('ReasoningJob already has a result for a different InvestigationPlan');
        }
        if (job.status !== 'COMPLETED') store.markReasoningJobCompleted(job.id);
        return existing;
      }
      if (job.status !== 'WAITING_DELEGATION') {
        throw new Error(`ReasoningJob ${job.id} is not waiting for delegation`);
      }
      const incident = store.getIncident(job.incidentId);
      if (!incident) throw new Error(`Incident ${job.incidentId} does not exist`);
      const evidence = store.listEvidence(incident.id);
      const knownIds = new Set(evidence.map((item) => item.id));
      for (const evidenceId of input.evidenceIds) {
        if (!knownIds.has(evidenceId)) {
          throw new Error(`evidence id ${evidenceId} does not belong to the Incident`);
        }
      }
      const result: ReasoningResult = {
        id: `reason-${job.id}`,
        incidentId: incident.id,
        createdAt: now(),
        hypotheses: [input.reasoningSummary],
        missingEvidence: [],
        confidence: input.confidence,
        status: 'complete',
        reasoningJobId: job.id,
        reasonerType: job.reasonerType,
        reasonerVersion: job.reasonerVersion,
        evidenceIds: [...input.evidenceIds],
        evidenceSnapshotHash: hashEvidenceSnapshot(evidence),
        reasoningSummary: input.reasoningSummary,
        strategy: plan.strategy,
        strategyVersion: REASONING_STRATEGY_VERSION,
        investigationPlanId: plan.id,
        ...(input.memoryIds && input.memoryIds.length > 0
          ? { usedMemoryEntryIds: [...input.memoryIds] }
          : {}),
      };
      store.insertReasoningResult(result);
      store.markReasoningJobCompleted(job.id);
      return store.getReasoningResult(result.id) ?? result;
    },
  };
}

function validatePayload(input: DelegatedReasoningResult): void {
  if (!input.investigationPlanId?.trim()) {
    throw new Error('investigationPlanId is required');
  }
  if (typeof input.reasoningSummary !== 'string' || input.reasoningSummary.trim().length === 0) {
    throw new Error('reasoningSummary must be a non-empty string');
  }
  if (input.reasoningSummary.length > MAX_SUMMARY_CHARS) {
    throw new Error(`reasoningSummary exceeds ${MAX_SUMMARY_CHARS} characters`);
  }
  if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence)
    || input.confidence < 0 || input.confidence > 1) {
    throw new Error('confidence must be a number in [0, 1]');
  }
  if (!Array.isArray(input.evidenceIds)) {
    throw new Error('evidenceIds must be an array');
  }
}
