import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryFeedbackService } from '../memory-feedback.js';
import { createMemoryGovernanceService } from '../memory-governance.js';
import { createFakeReasoner } from '../reasoner.js';
import { createReasoningEvaluationService } from '../reasoning-evaluation.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

function persistApprovedMemory() {
  const store = createEventStore(':memory:');
  const incident = store.createIncident({
    service: 'data-asset-service',
    node_id: 'test-svc-02',
    type: 'application.slow_sql',
    state: 'OPEN',
    fingerprint: 'fp-feedback',
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'warning',
  } satisfies Omit<IncidentRow, 'id'>);
  const evidence: EvidenceRecord = {
    id: 'evd-feedback-1',
    incidentId: incident.id,
    nodeId: 'test-svc-02',
    source: 'host',
    kind: 'host.load',
    collectedAt: '2026-08-20T12:00:01.000Z',
    data: { load1: 0.2, cpus: 8 },
    status: 'succeeded',
  };
  store.insertEvidence(evidence);
  const reasoned = createFakeReasoner().reason(incident, [evidence]);
  const result = {
    ...reasoned,
    status: 'complete' as const,
    missingEvidence: [],
    reasoningJobId: `rj-${incident.id}`,
    reasonerType: 'fake',
    reasonerVersion: '1',
    evidenceIds: [evidence.id],
    evidenceSnapshotHash: 'hash-feedback-1',
    usedMemoryEntryIds: [] as string[],
  };
  store.insertReasoningResult(result);
  const { candidate } = createReasoningEvaluationService(store, {
    now: () => '2026-08-21T04:00:00.000Z',
  }).evaluate({
    reasoningResultId: result.id,
    score: 0.9,
    feedback: 'Confirmed by DBA',
  });
  assert.ok(candidate);
  const entry = createMemoryGovernanceService(store, {
    now: () => '2026-08-21T04:30:00.000Z',
  }).approve(candidate.id);
  return { store, incident, result, entry };
}

describe('MemoryFeedbackService', () => {
  it('records feedback for a memory entry applied to an incident', () => {
    const { store, incident, result, entry } = persistApprovedMemory();
    const feedback = createMemoryFeedbackService(store, {
      now: () => '2026-08-21T05:00:00.000Z',
    }).record({
      memoryEntryId: entry.id,
      incidentId: incident.id,
      reasoningResultId: result.id,
      outcome: 'UNKNOWN',
      effectivenessScore: 0.5,
    });
    assert.equal(feedback.memoryEntryId, entry.id);
    assert.equal(feedback.incidentId, incident.id);
    assert.equal(feedback.reasoningResultId, result.id);
    assert.equal(feedback.outcome, 'UNKNOWN');
    assert.equal(feedback.effectivenessScore, 0.5);
    assert.equal(feedback.createdAt, '2026-08-21T05:00:00.000Z');
    assert.deepEqual(store.listMemoryFeedbacks(entry.id), [feedback]);
    store.close();
  });

  it('does not change MemoryEntry content when feedback is recorded', () => {
    const { store, incident, result, entry } = persistApprovedMemory();
    const before = structuredClone(store.getMemoryEntry(entry.id)!);
    createMemoryFeedbackService(store).record({
      memoryEntryId: entry.id,
      incidentId: incident.id,
      reasoningResultId: result.id,
      outcome: 'SUCCESS',
      effectivenessScore: 0.95,
    });
    assert.deepEqual(store.getMemoryEntry(entry.id), before);
    store.close();
  });

  it('stores SUCCESS feedback', () => {
    const { store, incident, result, entry } = persistApprovedMemory();
    const feedback = createMemoryFeedbackService(store).record({
      memoryEntryId: entry.id,
      incidentId: incident.id,
      reasoningResultId: result.id,
      outcome: 'SUCCESS',
      effectivenessScore: 0.9,
    });
    assert.equal(feedback.outcome, 'SUCCESS');
    assert.equal(store.listMemoryFeedbacks(entry.id)[0]?.outcome, 'SUCCESS');
    store.close();
  });

  it('stores FAILED feedback', () => {
    const { store, incident, result, entry } = persistApprovedMemory();
    const feedback = createMemoryFeedbackService(store).record({
      memoryEntryId: entry.id,
      incidentId: incident.id,
      reasoningResultId: result.id,
      outcome: 'FAILED',
      effectivenessScore: 0.1,
    });
    assert.equal(feedback.outcome, 'FAILED');
    assert.equal(store.listMemoryFeedbacks(entry.id)[0]?.outcome, 'FAILED');
    store.close();
  });

  it('rejects feedback for an unknown memory entry', () => {
    const { store, incident, result } = persistApprovedMemory();
    assert.throws(
      () => createMemoryFeedbackService(store).record({
        memoryEntryId: 'mentry-missing',
        incidentId: incident.id,
        reasoningResultId: result.id,
        outcome: 'SUCCESS',
        effectivenessScore: 0.8,
      }),
      /MemoryEntry/,
    );
    assert.equal(store.listMemoryFeedbacks('mentry-missing').length, 0);
    store.close();
  });
});
