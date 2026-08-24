import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDelegatedResultIngestionService } from '../delegated-result-ingestion.js';
import type { DelegatedReasoningResult } from '../pi-runtime-client.js';
import { buildInvestigationPlan } from '../reasoning-strategy.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

function waitingJob(store = createEventStore(':memory:')) {
  const incident = store.createIncident({
    service: 'data-asset-service',
    node_id: 'test-svc-02',
    type: 'application.slow_sql',
    state: 'OPEN',
    fingerprint: 'fp-ingest',
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'warning',
  } satisfies Omit<IncidentRow, 'id'>);
  const evidence: EvidenceRecord = {
    id: 'evd-ingest-1',
    incidentId: incident.id,
    nodeId: 'test-svc-02',
    source: 'host',
    kind: 'host.load',
    collectedAt: '2026-08-20T12:00:01.000Z',
    data: { load1: 0.2, cpus: 8 },
    status: 'succeeded',
  };
  store.insertEvidence(evidence);
  const jobId = `rj-${incident.id}`;
  store.createReasoningJob({
    id: jobId,
    incidentId: incident.id,
    reasonerType: 'delegated_analysis',
    reasonerVersion: '1',
    createdAt: incident.last_seen,
  });
  const plan = buildInvestigationPlan(jobId, incident, 'delegated_analysis', incident.last_seen);
  store.insertInvestigationPlan(plan);
  store.markReasoningJobWaitingDelegation(jobId);
  return { store, incident, evidence, jobId, plan };
}

function payload(overrides: Partial<DelegatedReasoningResult> = {}): DelegatedReasoningResult {
  return {
    investigationPlanId: 'iplan-missing',
    reasoningSummary: 'database side investigation required',
    confidence: 0.72,
    evidenceIds: ['evd-ingest-1'],
    ...overrides,
  };
}

describe('DelegatedResultIngestionService', () => {
  it('completes a WAITING job from a valid delegated result', () => {
    const { store, incident, jobId, plan } = waitingJob();
    const result = createDelegatedResultIngestionService(store, {
      now: () => '2026-08-21T04:00:00.000Z',
    }).ingest(payload({ investigationPlanId: plan.id }));
    assert.equal(store.getReasoningJob(jobId)?.status, 'COMPLETED');
    assert.equal(result.investigationPlanId, plan.id);
    assert.equal(result.strategy, 'delegated_analysis');
    assert.equal(result.strategyVersion, '1');
    assert.equal(result.reasoningJobId, jobId);
    assert.equal(result.incidentId, incident.id);
    assert.equal(result.confidence, 0.72);
    assert.deepEqual(result.hypotheses, ['database side investigation required']);
    store.close();
  });

  it('rejects invalid confidence without writing a result', () => {
    const { store, jobId, plan } = waitingJob();
    assert.throws(
      () => createDelegatedResultIngestionService(store).ingest(
        payload({ investigationPlanId: plan.id, confidence: 1.4 }),
      ),
      /confidence/,
    );
    assert.equal(store.getReasoningJob(jobId)?.status, 'WAITING_DELEGATION');
    assert.equal(store.listReasoningResults(store.getReasoningJob(jobId)!.incidentId).length, 0);
    store.close();
  });

  it('rejects an unknown InvestigationPlan', () => {
    const { store, jobId } = waitingJob();
    assert.throws(
      () => createDelegatedResultIngestionService(store).ingest(
        payload({ investigationPlanId: 'iplan-unknown' }),
      ),
      /does not exist/,
    );
    assert.equal(store.getReasoningJob(jobId)?.status, 'WAITING_DELEGATION');
    store.close();
  });

  it('returns the existing ReasoningResult on duplicate ingest', () => {
    const { store, plan } = waitingJob();
    const service = createDelegatedResultIngestionService(store);
    const first = service.ingest(payload({ investigationPlanId: plan.id }));
    const second = service.ingest(payload({
      investigationPlanId: plan.id,
      reasoningSummary: 'should not replace',
      confidence: 0.1,
    }));
    assert.equal(second.id, first.id);
    assert.equal(second.reasoningSummary, first.reasoningSummary);
    assert.equal(store.listReasoningResults(first.incidentId).length, 1);
    store.close();
  });

  it('does not mutate Incident or Evidence on ingest', () => {
    const { store, incident, evidence, plan } = waitingJob();
    const beforeIncident = structuredClone(store.getIncident(incident.id)!);
    const beforeEvidence = structuredClone(store.listEvidence(incident.id));
    createDelegatedResultIngestionService(store).ingest(payload({ investigationPlanId: plan.id }));
    assert.deepEqual(store.getIncident(incident.id), beforeIncident);
    assert.deepEqual(store.listEvidence(incident.id), beforeEvidence);
    assert.equal(store.listEvidence(incident.id)[0]?.id, evidence.id);
    store.close();
  });
});
