import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryGovernanceService } from '../memory-governance.js';
import {
  createFakeReasoner,
  HYPOTHESIS_DATABASE_INVESTIGATION,
} from '../reasoner.js';
import { createReasoningEvaluationService } from '../reasoning-evaluation.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

function persistCandidate() {
  const store = createEventStore(':memory:');
  const incident = store.createIncident({
    service: 'data-asset-service',
    node_id: 'test-svc-02',
    type: 'application.slow_sql',
    state: 'OPEN',
    fingerprint: 'fp-gov',
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'warning',
  } satisfies Omit<IncidentRow, 'id'>);
  const evidence: EvidenceRecord[] = [{
    id: 'evd-gov-1',
    incidentId: incident.id,
    nodeId: 'test-svc-02',
    source: 'host',
    kind: 'host.load',
    collectedAt: '2026-08-20T12:00:01.000Z',
    data: { load1: 0.2, cpus: 8 },
    status: 'succeeded',
  }];
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
    evidenceIds: [evidence[0]!.id],
    evidenceSnapshotHash: 'hash-gov-1',
  };
  store.insertReasoningResult(result);
  const { evaluation, candidate } = createReasoningEvaluationService(store, {
    now: () => '2026-08-21T02:00:00.000Z',
  }).evaluate({
    reasoningResultId: result.id,
    score: 0.9,
    feedback: 'Confirmed by DBA',
  });
  assert.ok(candidate);
  return { store, incident, evidence, result, evaluation, candidate };
}

describe('MemoryGovernanceService', () => {
  it('creates a MemoryEntry when a candidate is approved', () => {
    const { store, candidate } = persistCandidate();
    const governance = createMemoryGovernanceService(store, {
      now: () => '2026-08-21T03:00:00.000Z',
    });
    const entry = governance.approve(candidate.id);
    assert.equal(entry.sourceMemoryCandidateId, candidate.id);
    assert.equal(entry.status, 'ACTIVE');
    assert.equal(entry.approvedAt, '2026-08-21T03:00:00.000Z');
    assert.equal(store.getMemoryCandidate(candidate.id)?.status, 'APPROVED');
    assert.equal(store.getMemoryCandidate(candidate.id)?.pattern, candidate.pattern);
    assert.equal(store.listActiveMemoryEntries().length, 1);
    store.close();
  });

  it('does not create a MemoryEntry for a rejected candidate', () => {
    const { store, candidate } = persistCandidate();
    const rejected = createMemoryGovernanceService(store).reject(candidate.id);
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(store.getMemoryEntryByCandidateId(candidate.id), undefined);
    assert.equal(store.listActiveMemoryEntries().length, 0);
    assert.throws(
      () => createMemoryGovernanceService(store).approve(candidate.id),
      /rejected/,
    );
    store.close();
  });

  it('preserves the provenance chain on MemoryEntry', () => {
    const { store, incident, evidence, result, evaluation, candidate } = persistCandidate();
    const entry = createMemoryGovernanceService(store).approve(candidate.id);
    const storedCandidate = store.getMemoryCandidate(entry.sourceMemoryCandidateId)!;
    const storedEvaluation = store.getReasoningEvaluation(entry.sourceEvaluationId)!;
    const storedResult = store.getReasoningResult(storedCandidate.sourceReasoningResultId)!;
    const job = store.getReasoningJob(storedResult.reasoningJobId!)!;
    assert.equal(storedCandidate.sourceEvaluationId, evaluation.id);
    assert.equal(storedEvaluation.id, evaluation.id);
    assert.equal(storedEvaluation.reasoningResultId, result.id);
    assert.equal(storedResult.id, result.id);
    assert.equal(job.incidentId, incident.id);
    assert.equal(store.getIncident(job.incidentId)?.id, incident.id);
    assert.deepEqual(storedResult.evidenceIds, evidence.map((item) => item.id));
    assert.equal(storedResult.evidenceSnapshotHash, 'hash-gov-1');
    store.close();
  });

  it('does not treat DISABLED memory as active', () => {
    const { store, candidate } = persistCandidate();
    const governance = createMemoryGovernanceService(store);
    const entry = governance.approve(candidate.id);
    const disabled = governance.disable(entry.id);
    assert.equal(disabled.status, 'DISABLED');
    assert.equal(store.listActiveMemoryEntries().length, 0);
    assert.equal(store.getMemoryEntry(entry.id)?.status, 'DISABLED');
    store.close();
  });

  it('does not change FakeReasoner output after approval', () => {
    const { store, incident, evidence, candidate } = persistCandidate();
    const reasoner = createFakeReasoner();
    const before = reasoner.reason(incident, evidence);
    createMemoryGovernanceService(store).approve(candidate.id);
    const after = reasoner.reason(incident, evidence);
    assert.deepEqual(after, before);
    assert.deepEqual(after.hypotheses, [HYPOTHESIS_DATABASE_INVESTIGATION]);
    store.close();
  });

  it('does not mutate Incident, Evidence, or ReasoningResult on approve/reject', () => {
    const { store, incident, result, candidate } = persistCandidate();
    const beforeIncident = structuredClone(store.getIncident(incident.id)!);
    const beforeEvidence = structuredClone(store.listEvidence(incident.id));
    const beforeResult = structuredClone(store.getReasoningResult(result.id)!);
    const beforeKnowledge = {
      pattern: candidate.pattern,
      evidenceSummary: candidate.evidenceSummary,
      conclusion: candidate.conclusion,
      resolution: candidate.resolution,
    };
    createMemoryGovernanceService(store).approve(candidate.id);
    assert.deepEqual(store.getIncident(incident.id), beforeIncident);
    assert.deepEqual(store.listEvidence(incident.id), beforeEvidence);
    assert.deepEqual(store.getReasoningResult(result.id), beforeResult);
    const after = store.getMemoryCandidate(candidate.id)!;
    assert.equal(after.pattern, beforeKnowledge.pattern);
    assert.equal(after.evidenceSummary, beforeKnowledge.evidenceSummary);
    assert.equal(after.conclusion, beforeKnowledge.conclusion);
    assert.equal(after.resolution, beforeKnowledge.resolution);
    store.close();
  });
});
