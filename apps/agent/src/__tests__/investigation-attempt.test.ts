import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInvestigationLoopService } from '../investigation-loop.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

function seedIncident(store = createEventStore(':memory:')) {
  const incident = store.createIncident({
    service: 'data-asset-service',
    node_id: 'test-svc-02',
    type: 'application.slow_sql',
    state: 'OPEN',
    fingerprint: 'fp-attempt',
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'warning',
  } satisfies Omit<IncidentRow, 'id'>);
  store.insertEvidence({
    id: 'evd-attempt-1',
    incidentId: incident.id,
    nodeId: 'test-svc-02',
    source: 'host',
    kind: 'host.load',
    collectedAt: '2026-08-20T12:00:01.000Z',
    data: { load1: 0.2 },
    status: 'succeeded',
  } satisfies EvidenceRecord);
  return { store, incident };
}

const report = {
  hypothesis: 'SQL contention on the current incident',
  supportingEvidenceIds: ['evd-attempt-1'],
  contradictingEvidenceIds: [],
  confidence: 0.7,
  recommendation: 'inspect indexes',
};

describe('investigation attempt lifecycle', () => {
  it('reuses an open session for the same Incident and context', () => {
    const { store, incident } = seedIncident();
    const loop = createInvestigationLoopService(store);
    const first = loop.start(incident.id);
    const second = loop.start(incident.id);
    assert.equal(second.session.id, first.session.id);
    assert.equal(second.session.runtimeRequestId, first.session.runtimeRequestId);
    store.close();
  });

  it('creates an independent attempt after COMPLETED', async () => {
    const { store, incident } = seedIncident();
    const loop = createInvestigationLoopService(store);
    const first = loop.start(incident.id);
    await loop.submit(first.session.id);
    loop.complete(first.session.id, report);
    const firstPlan = store.getInvestigationPlan(store.getDelegationTask(first.session.delegationTaskId)!.investigationPlanId)!;
    const firstJob = store.getReasoningJob(firstPlan.reasoningJobId)!;
    assert.equal(firstJob.status, 'COMPLETED');
    const second = loop.start(incident.id);
    assert.notEqual(second.session.id, first.session.id);
    assert.notEqual(second.session.runtimeRequestId, first.session.runtimeRequestId);
    assert.notEqual(second.session.delegationTaskId, first.session.delegationTaskId);
    const firstTask = store.getDelegationTask(first.session.delegationTaskId)!;
    const secondTask = store.getDelegationTask(second.session.delegationTaskId)!;
    assert.notEqual(firstTask.investigationPlanId, secondTask.investigationPlanId);
    const secondPlan = store.getInvestigationPlan(secondTask.investigationPlanId)!;
    assert.notEqual(secondPlan.reasoningJobId, firstPlan.reasoningJobId);
    assert.equal(store.getReasoningJob(firstPlan.reasoningJobId)?.status, 'COMPLETED');
    await loop.submit(second.session.id);
    loop.complete(second.session.id, report);
    const result1 = store.getReasoningResultByJobId(firstPlan.reasoningJobId);
    const result2 = store.getReasoningResultByJobId(secondPlan.reasoningJobId);
    assert.ok(result1);
    assert.ok(result2);
    assert.notEqual(result1.id, result2.id);
    store.close();
  });

  it('allows a new attempt after FAILED', async () => {
    const { store, incident } = seedIncident();
    const loop = createInvestigationLoopService(store);
    const first = loop.start(incident.id);
    await loop.submit(first.session.id);
    loop.fail(first.session.id, 'runtime failed');
    const firstPlan = store.getInvestigationPlan(store.getDelegationTask(first.session.delegationTaskId)!.investigationPlanId)!;
    const firstStatus = store.getReasoningJob(firstPlan.reasoningJobId)?.status;
    const second = loop.start(incident.id);
    assert.notEqual(second.session.id, first.session.id);
    assert.equal(store.getReasoningJob(firstPlan.reasoningJobId)?.status, firstStatus);
    await loop.submit(second.session.id);
    const reportRow = loop.complete(second.session.id, report);
    assert.equal(reportRow.sessionId, second.session.id);
    store.close();
  });
});
