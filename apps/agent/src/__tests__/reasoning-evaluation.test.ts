import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFakeReasoner,
  HYPOTHESIS_DATABASE_INVESTIGATION,
} from '../reasoner.js';
import {
  createReasoningEvaluationService,
  MEMORY_CANDIDATE_SCORE_THRESHOLD,
} from '../reasoning-evaluation.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

function incidentRow(overrides: Partial<IncidentRow> = {}): Omit<IncidentRow, 'id'> {
  return {
    service: 'data-asset-service',
    node_id: 'test-svc-02',
    type: 'application.slow_sql',
    state: 'OPEN',
    fingerprint: 'fp-eval',
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'warning',
    ...overrides,
  };
}

function evidenceFor(incidentId: string, overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: 'evd-eval-1',
    incidentId,
    nodeId: 'test-svc-02',
    source: 'host',
    kind: 'host.load',
    collectedAt: '2026-08-20T12:00:01.000Z',
    data: { load1: 0.2, cpus: 8 },
    status: 'succeeded',
    ...overrides,
  };
}

function persistCompleteResult(store = createEventStore(':memory:')) {
  const incident = store.createIncident(incidentRow());
  const evidence = [evidenceFor(incident.id)];
  store.insertEvidence(evidence[0]!);
  store.createReasoningJob({
    id: `rj-${incident.id}`,
    incidentId: incident.id,
    reasonerType: 'fake',
    reasonerVersion: '1',
    createdAt: incident.last_seen,
  });
  const reasoned = createFakeReasoner().reason(incident, evidence);
  const result = {
    ...reasoned,
    status: 'complete' as const,
    missingEvidence: [],
    reasoningJobId: `rj-${incident.id}`,
    reasonerType: 'fake',
    reasonerVersion: '1',
    evidenceIds: evidence.map((item) => item.id),
    evidenceSnapshotHash: 'hash-eval-1',
  };
  store.insertReasoningResult(result);
  return { store, incident, evidence, result };
}

describe('ReasoningEvaluationService', () => {
  it('creates an evaluation for a ReasoningResult', () => {
    const { store, result } = persistCompleteResult();
    const service = createReasoningEvaluationService(store, {
      now: () => '2026-08-21T01:00:00.000Z',
    });
    const { evaluation } = service.evaluate({
      reasoningResultId: result.id,
      score: 0.9,
      feedback: 'Confirmed by DBA',
    });
    assert.equal(evaluation.reasoningResultId, result.id);
    assert.equal(evaluation.score, 0.9);
    assert.equal(evaluation.feedback, 'Confirmed by DBA');
    assert.equal(evaluation.evaluatorType, 'human');
    assert.equal(store.listReasoningEvaluations(result.id).length, 1);
    store.close();
  });

  it('keeps multiple evaluations for one ReasoningResult', () => {
    const { store, result } = persistCompleteResult();
    const service = createReasoningEvaluationService(store);
    service.evaluate({ reasoningResultId: result.id, score: 0.4, feedback: 'uncertain' });
    service.evaluate({ reasoningResultId: result.id, score: 0.95, feedback: 'Confirmed by DBA' });
    const listed = store.listReasoningEvaluations(result.id);
    assert.equal(listed.length, 2);
    assert.notEqual(listed[0]?.id, listed[1]?.id);
    assert.equal(listed[0]?.score, 0.4);
    assert.equal(listed[1]?.score, 0.95);
    store.close();
  });

  it('does not create a MemoryCandidate for a low score', () => {
    const { store, result } = persistCompleteResult();
    const service = createReasoningEvaluationService(store);
    const { candidate } = service.evaluate({
      reasoningResultId: result.id,
      score: MEMORY_CANDIDATE_SCORE_THRESHOLD - 0.3,
      feedback: 'not useful',
    });
    assert.equal(candidate, undefined);
    assert.equal(store.listMemoryCandidates(result.id).length, 0);
    store.close();
  });

  it('creates a MemoryCandidate for a high score on complete reasoning', () => {
    const { store, result } = persistCompleteResult();
    const service = createReasoningEvaluationService(store);
    const { candidate } = service.evaluate({
      reasoningResultId: result.id,
      score: 0.9,
      feedback: 'Confirmed index issue',
    });
    assert.ok(candidate);
    assert.equal(candidate.status, 'PENDING');
    assert.equal(candidate.incidentType, 'application.slow_sql');
    assert.equal(candidate.pattern, 'slow_sql + database timeout');
    assert.equal(candidate.conclusion, 'database related');
    assert.equal(candidate.resolution, 'check SQL/index');
    assert.equal(store.listMemoryCandidates(result.id).length, 1);
    store.close();
  });

  it('keeps an auditable provenance chain on the MemoryCandidate', () => {
    const { store, incident, evidence, result } = persistCompleteResult();
    const service = createReasoningEvaluationService(store);
    const { candidate } = service.evaluate({
      reasoningResultId: result.id,
      score: 0.9,
      feedback: 'Confirmed by DBA',
    });
    assert.ok(candidate);
    const storedResult = store.getReasoningResult(candidate.sourceReasoningResultId);
    assert.ok(storedResult);
    assert.equal(storedResult.incidentId, incident.id);
    const job = store.getReasoningJob(storedResult.reasoningJobId!);
    assert.equal(job?.incidentId, incident.id);
    assert.deepEqual(store.getIncident(storedResult.incidentId)?.id, incident.id);
    assert.deepEqual(storedResult.evidenceIds, evidence.map((item) => item.id));
    assert.equal(storedResult.evidenceSnapshotHash, 'hash-eval-1');
    store.close();
  });

  it('does not mutate Incident, Evidence, or ReasoningResult', () => {
    const { store, incident, result } = persistCompleteResult();
    const beforeIncident = structuredClone(store.getIncident(incident.id)!);
    const beforeEvidence = structuredClone(store.listEvidence(incident.id));
    const beforeResult = structuredClone(store.getReasoningResult(result.id)!);
    createReasoningEvaluationService(store).evaluate({
      reasoningResultId: result.id,
      score: 0.9,
      feedback: 'Confirmed by DBA',
    });
    assert.deepEqual(store.getIncident(incident.id), beforeIncident);
    assert.deepEqual(store.listEvidence(incident.id), beforeEvidence);
    assert.deepEqual(store.getReasoningResult(result.id), beforeResult);
    store.close();
  });

  it('does not change FakeReasoner output after memory exists', () => {
    const { store, incident, evidence, result } = persistCompleteResult();
    const reasoner = createFakeReasoner();
    const before = reasoner.reason(incident, evidence);
    createReasoningEvaluationService(store).evaluate({
      reasoningResultId: result.id,
      score: 0.9,
      feedback: 'Confirmed by DBA',
    });
    const after = reasoner.reason(incident, evidence);
    assert.deepEqual(after, before);
    assert.deepEqual(after.hypotheses, [HYPOTHESIS_DATABASE_INVESTIGATION]);
    store.close();
  });
});
