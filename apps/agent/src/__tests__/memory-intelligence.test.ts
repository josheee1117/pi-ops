import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentContext } from '../incident-context.js';
import { buildInvestigationContext } from '../investigation-context.js';
import { createMemoryFeedbackService } from '../memory-feedback.js';
import { createMemoryGovernanceService } from '../memory-governance.js';
import { createMemoryRetriever } from '../memory-retriever.js';
import { createFakeReasoner } from '../reasoner.js';
import { createReasoningEvaluationService } from '../reasoning-evaluation.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

const BOUNDS = { maxEvidenceItems: 8, maxContextBytes: 8192, maxLogLines: 20 };

function seedApproved(
  store = createEventStore(':memory:'),
  overrides: {
    fingerprint?: string;
    conclusion?: string;
    pattern?: string;
    resolution?: string;
  } = {},
) {
  const incident = store.createIncident({
    service: 'data-asset-service',
    node_id: 'test-svc-02',
    type: 'application.slow_sql',
    state: 'OPEN',
    fingerprint: overrides.fingerprint ?? `fp-intel-${store.listActiveMemoryEntries().length}`,
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'warning',
  } satisfies Omit<IncidentRow, 'id'>);
  const evidence: EvidenceRecord = {
    id: `evd-${incident.id}`,
    incidentId: incident.id,
    nodeId: 'test-svc-02',
    source: 'host',
    kind: 'host.load',
    collectedAt: '2026-08-20T12:00:01.000Z',
    data: { load1: 0.2, cpus: 8 },
    status: 'succeeded',
  };
  store.insertEvidence(evidence);
  const evidenceList = [evidence];
  const reasoned = createFakeReasoner().reason(incident, evidenceList);
  store.insertReasoningResult({
    ...reasoned,
    status: 'complete',
    missingEvidence: [],
    reasoningJobId: `rj-${incident.id}`,
    evidenceIds: [evidence.id],
    evidenceSnapshotHash: `hash-${incident.id}`,
  });
  const { evaluation, candidate } = createReasoningEvaluationService(store).evaluate({
    reasoningResultId: reasoned.id,
    score: 0.9,
    feedback: 'Confirmed by DBA',
  });
  assert.ok(candidate);
  if (overrides.conclusion || overrides.pattern || overrides.resolution) {
    store.insertMemoryCandidate({
      ...candidate,
      id: `${candidate.id}-custom`,
      pattern: overrides.pattern ?? candidate.pattern,
      conclusion: overrides.conclusion ?? candidate.conclusion,
      resolution: overrides.resolution ?? candidate.resolution,
      status: 'PENDING',
    });
    const entry = createMemoryGovernanceService(store).approve(`${candidate.id}-custom`);
    return { store, incident, evidence: evidenceList, resultId: reasoned.id, evaluation, entry };
  }
  const entry = createMemoryGovernanceService(store).approve(candidate.id);
  return { store, incident, evidence: evidenceList, resultId: reasoned.id, evaluation, entry };
}

describe('memory intelligence', () => {
  it('changes ranking after feedback', () => {
    const first = seedApproved();
    const second = seedApproved(first.store, { fingerprint: 'fp-intel-2' });
    const retriever = createMemoryRetriever(first.store);
    const context = buildIncidentContext(first.incident, first.evidence, BOUNDS);
    const before = retriever.retrieve(context).memories.map((item) => item.id);
    assert.deepEqual(before, [first.entry.id, second.entry.id].sort((left, right) => left.localeCompare(right)));
    const lower = before[1]!;
    createMemoryFeedbackService(first.store).record({
      memoryEntryId: lower,
      incidentId: first.incident.id,
      reasoningResultId: first.resultId,
      outcome: 'SUCCESS',
      effectivenessScore: 0.99,
    });
    const after = retriever.retrieve(context).memories.map((item) => item.id);
    assert.equal(after[0], lower);
    assert.notDeepEqual(after, before);
    first.store.close();
  });

  it('decreases priority of a failed memory', () => {
    const first = seedApproved();
    const second = seedApproved(first.store, { fingerprint: 'fp-intel-fail' });
    const retriever = createMemoryRetriever(first.store);
    const context = buildIncidentContext(first.incident, first.evidence, BOUNDS);
    createMemoryFeedbackService(first.store).record({
      memoryEntryId: first.entry.id,
      incidentId: first.incident.id,
      reasoningResultId: first.resultId,
      outcome: 'FAILED',
      effectivenessScore: 0.05,
    });
    const ranked = retriever.retrieve(context).memories;
    assert.equal(ranked[0]?.id, second.entry.id);
    assert.equal(ranked[1]?.id, first.entry.id);
    assert.ok((ranked[1]?.effectivenessScore ?? 1) < (ranked[0]?.effectivenessScore ?? 0));
    first.store.close();
  });

  it('detects conflicting memories without merging them', () => {
    const redis = seedApproved(createEventStore(':memory:'), {
      fingerprint: 'fp-redis',
      pattern: 'slow_sql + redis timeout',
      conclusion: 'Redis issue',
      resolution: 'check redis latency',
    });
    const jvm = seedApproved(redis.store, {
      fingerprint: 'fp-jvm',
      pattern: 'slow_sql + jvm pause',
      conclusion: 'JVM issue',
      resolution: 'check JVM GC',
    });
    const retrieval = createMemoryRetriever(redis.store).retrieve(
      buildIncidentContext(redis.incident, redis.evidence, BOUNDS),
    );
    const conclusions = retrieval.conflictingMemories.map((item) => item.conclusion).sort();
    assert.deepEqual(conclusions, ['JVM issue', 'Redis issue']);
    assert.equal(retrieval.memories.length, 2);
    assert.notEqual(retrieval.memories[0]?.conclusion, retrieval.memories[1]?.conclusion);
    redis.store.close();
  });

  it('builds an immutable InvestigationContext', () => {
    const { store, incident, evidence, entry } = seedApproved();
    const context = buildInvestigationContext(incident, evidence, store);
    assert.equal(context.incident.id, incident.id);
    assert.ok(context.relatedMemories.some((item) => item.id === entry.id));
    assert.ok(Object.isFrozen(context));
    assert.ok(Object.isFrozen(context.relatedMemories));
    assert.throws(() => {
      (context as { incident: { id: string } }).incident.id = 'mutated';
    });
    assert.throws(() => {
      (context.relatedMemories as MemoryIntelligenceMutable).push(context.relatedMemories[0]!);
    });
    store.close();
  });

  it('does not change stored MemoryEntry content when ranking or building context', () => {
    const seeded = seedApproved();
    const before = structuredClone(seeded.store.getMemoryEntry(seeded.entry.id)!);
    createMemoryFeedbackService(seeded.store).record({
      memoryEntryId: seeded.entry.id,
      incidentId: seeded.incident.id,
      reasoningResultId: seeded.resultId,
      outcome: 'SUCCESS',
      effectivenessScore: 0.97,
    });
    createMemoryRetriever(seeded.store).retrieve(
      buildIncidentContext(seeded.incident, seeded.evidence, BOUNDS),
    );
    buildInvestigationContext(seeded.incident, seeded.evidence, seeded.store);
    assert.deepEqual(seeded.store.getMemoryEntry(seeded.entry.id), before);
    assert.equal(seeded.store.listMemoryFeedbacks(seeded.entry.id).length, 1);
    seeded.store.close();
  });
});

type MemoryIntelligenceMutable = Array<ReturnType<typeof buildInvestigationContext>['relatedMemories'][number]>;
