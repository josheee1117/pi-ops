import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInvestigationLoopService } from '../investigation-loop.js';
import { createReasoningEvaluationService } from '../reasoning-evaluation.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

function seedIncident(store = createEventStore(':memory:')) {
  const incident = store.createIncident({
    service: 'data-asset-service',
    node_id: 'test-svc-02',
    type: 'application.slow_sql',
    state: 'OPEN',
    fingerprint: 'fp-inv-loop',
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'warning',
  } satisfies Omit<IncidentRow, 'id'>);
  const evidence: EvidenceRecord = {
    id: 'evd-inv-1',
    incidentId: incident.id,
    nodeId: 'test-svc-02',
    source: 'host',
    kind: 'host.load',
    collectedAt: '2026-08-20T12:00:01.000Z',
    data: { load1: 0.2, cpus: 8 },
    status: 'succeeded',
  };
  store.insertEvidence(evidence);
  return { store, incident, evidence };
}

function reportInput(overrides: Partial<Parameters<ReturnType<typeof createInvestigationLoopService>['complete']>[1]> = {}) {
  return {
    hypothesis: 'database side investigation required',
    supportingEvidenceIds: ['evd-inv-1'],
    contradictingEvidenceIds: [],
    confidence: 0.74,
    recommendation: 'inspect SQL and indexes',
    ...overrides,
  };
}

describe('InvestigationLoopService', () => {
  it('walks the session lifecycle CREATED → SUBMITTED → RUNNING → COMPLETED', async () => {
    const { store, incident } = seedIncident();
    const loop = createInvestigationLoopService(store, {
      now: () => '2026-08-21T06:00:00.000Z',
    });
    const started = loop.start(incident.id);
    assert.equal(started.session.status, 'CREATED');
    assert.equal(started.session.incidentId, incident.id);
    assert.ok(started.session.delegationTaskId);
    const submitted = await loop.submit(started.session.id);
    assert.equal(submitted.status, 'SUBMITTED');
    assert.equal(store.getDelegationTask(submitted.delegationTaskId)?.status, 'SUBMITTED');
    const running = loop.markRunning(started.session.id);
    assert.equal(running.status, 'RUNNING');
    const report = loop.complete(started.session.id, reportInput());
    const completed = store.getInvestigationSession(started.session.id)!;
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.completedAt, '2026-08-21T06:00:00.000Z');
    assert.equal(report.sessionId, started.session.id);
    assert.equal(report.hypothesis, 'database side investigation required');
    assert.equal(store.getInvestigationReportBySessionId(started.session.id)?.id, report.id);
    store.close();
  });

  it('keeps the InvestigationContext snapshot immutable', async () => {
    const { store, incident } = seedIncident();
    const loop = createInvestigationLoopService(store);
    const { session, context } = loop.start(incident.id);
    const stored = store.getInvestigationContextSnapshot(session.contextSnapshotHash)!;
    assert.equal(stored.incident.id, context.incident.id);
    assert.ok(Object.isFrozen(stored));
    assert.throws(() => {
      (stored as { incident: { id: string } }).incident.id = 'mutated';
    });
    const again = loop.start(incident.id);
    assert.equal(again.session.contextSnapshotHash, session.contextSnapshotHash);
    assert.deepEqual(
      store.getInvestigationContextSnapshot(again.session.contextSnapshotHash),
      stored,
    );
    store.close();
  });

  it('rejects an invalid report without writing it', async () => {
    const { store, incident } = seedIncident();
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(incident.id);
    await loop.submit(session.id);
    assert.throws(
      () => loop.complete(session.id, reportInput({ confidence: 1.4 })),
      /confidence/,
    );
    assert.equal(store.getInvestigationSession(session.id)?.status, 'SUBMITTED');
    assert.equal(store.getInvestigationReportBySessionId(session.id), undefined);
    assert.equal(store.listReasoningResults(incident.id).length, 0);
    store.close();
  });

  it('rejects evidence ids that do not belong to the Incident', async () => {
    const { store, incident } = seedIncident();
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(incident.id);
    await loop.submit(session.id);
    assert.throws(
      () => loop.complete(session.id, reportInput({
        supportingEvidenceIds: ['evd-other'],
      })),
      /does not belong/,
    );
    assert.equal(store.getInvestigationReportBySessionId(session.id), undefined);
    store.close();
  });

  it('does not modify Incident or Evidence when the runtime fails', async () => {
    const { store, incident, evidence } = seedIncident();
    const beforeIncident = structuredClone(store.getIncident(incident.id)!);
    const beforeEvidence = structuredClone(store.listEvidence(incident.id));
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(incident.id);
    await loop.submit(session.id);
    const failed = loop.fail(session.id, 'runtime crashed');
    assert.equal(failed.status, 'FAILED');
    assert.deepEqual(store.getIncident(incident.id), beforeIncident);
    assert.deepEqual(store.listEvidence(incident.id), beforeEvidence);
    assert.equal(store.listEvidence(incident.id)[0]?.id, evidence.id);
    assert.equal(store.getInvestigationReportBySessionId(session.id), undefined);
    store.close();
  });

  it('requires InvestigationReport and Evaluation before a MemoryCandidate', async () => {
    const { store, incident } = seedIncident();
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(incident.id);
    await loop.submit(session.id);
    const report = loop.complete(session.id, reportInput());
    assert.equal(store.listMemoryCandidates().length, 0);
    const result = store.listReasoningResults(incident.id)[0]!;
    assert.equal(result.investigationReportId, report.id);
    const { candidate, evaluation } = createReasoningEvaluationService(store).evaluate({
      reasoningResultId: result.id,
      score: 0.9,
      feedback: 'Confirmed after runtime report',
    });
    assert.ok(evaluation);
    assert.ok(candidate);
    assert.equal(candidate.sourceReasoningResultId, result.id);
    store.close();
  });
});
