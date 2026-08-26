import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentContext } from '../incident-context.js';
import { buildInvestigationContext } from '../investigation-context.js';
import { createKnowledgeRetriever } from '../investigation-knowledge.js';
import { createMemoryFeedbackService } from '../memory-feedback.js';
import { createMemoryGovernanceService } from '../memory-governance.js';
import { createFakeReasoner } from '../reasoner.js';
import { createReasoningEvaluationService } from '../reasoning-evaluation.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

const BOUNDS = { maxEvidenceItems: 8, maxContextBytes: 8192, maxLogLines: 20 };

const SHARED_FP = '["application","test-svc-02","data-asset-service","application.slow_sql","deadbeef"]';

function seedIncident(
  store = createEventStore(':memory:'),
  overrides: Partial<IncidentRow> = {},
) {
  const incident = store.createIncident({
    service: overrides.service ?? 'data-asset-service',
    node_id: overrides.node_id ?? 'test-svc-02',
    type: overrides.type ?? 'application.slow_sql',
    state: 'OPEN',
    fingerprint: overrides.fingerprint ?? SHARED_FP,
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
  return { store, incident, evidence };
}

function seedApprovedMemory(
  store = createEventStore(':memory:'),
  fingerprint = SHARED_FP,
) {
  const { incident, evidence } = seedIncident(store, { fingerprint });
  const reasoned = createFakeReasoner().reason(incident, [evidence]);
  store.insertReasoningResult({
    ...reasoned,
    status: 'complete',
    missingEvidence: [],
    reasoningJobId: `rj-${incident.id}`,
    evidenceIds: [evidence.id],
    evidenceSnapshotHash: `hash-${incident.id}`,
  });
  const { candidate } = createReasoningEvaluationService(store).evaluate({
    reasoningResultId: reasoned.id,
    score: 0.9,
    feedback: 'Confirmed by DBA',
  });
  assert.ok(candidate);
  const entry = createMemoryGovernanceService(store).approve(candidate.id);
  return { store, incident, evidence, entry };
}

describe('operational knowledge retrieval', () => {
  it('retrieves similar incidents into historical knowledge', () => {
    const first = seedIncident();
    const second = seedIncident(first.store, {
      fingerprint: SHARED_FP,
    });
    const context = buildIncidentContext(second.incident, [second.evidence], BOUNDS);
    const knowledge = createKnowledgeRetriever(first.store).retrieve(context);
    const ids = knowledge.similarIncidents.map((item) => item.incident.id);
    assert.ok(ids.includes(first.incident.id));
    assert.ok(!ids.includes(second.incident.id));
    assert.ok((knowledge.similarIncidents[0]?.score ?? 0) > 0);
    first.store.close();
  });

  it('filters low quality memory from retrieved knowledge', () => {
    const good = seedApprovedMemory();
    const bad = seedApprovedMemory(good.store, '["application","test-svc-02","data-asset-service","application.slow_sql","cafe"]');
    createMemoryFeedbackService(good.store).record({
      memoryEntryId: bad.entry.id,
      incidentId: bad.incident.id,
      outcome: 'FAILED',
      effectivenessScore: 0.1,
    });
    const query = seedIncident(good.store);
    const context = buildIncidentContext(query.incident, [query.evidence], BOUNDS);
    const knowledge = createKnowledgeRetriever(good.store).retrieve(context);
    const ids = knowledge.relatedMemories.map((item) => item.memory.id);
    assert.ok(ids.includes(good.entry.id));
    assert.ok(!ids.includes(bad.entry.id));
    good.store.close();
  });

  it('records provenance on every retrieved item', () => {
    const historical = seedApprovedMemory();
    const query = seedIncident(historical.store);
    const context = buildIncidentContext(query.incident, [query.evidence], BOUNDS);
    const knowledge = createKnowledgeRetriever(historical.store).retrieve(context);
    assert.ok(knowledge.similarIncidents.length > 0);
    for (const item of knowledge.similarIncidents) {
      assert.equal(item.provenance.sourceIncidentId, item.incident.id);
      assert.equal(item.provenance.sourceRelationType, 'SIMILAR_TO');
      assert.ok(item.confidence >= 0 && item.confidence <= 1);
    }
    for (const item of knowledge.relatedMemories) {
      assert.equal(item.provenance.sourceMemoryEntryId, item.memory.id);
      assert.ok(item.provenance.sourceIncidentId);
      assert.equal(item.confidence, item.memory.confidence);
    }
    historical.store.close();
  });

  it('does not block investigation when retrieval fails', () => {
    const { store, incident, evidence } = seedIncident();
    const broken = {
      ...store,
      listIncidents(): never {
        throw new Error('retrieval down');
      },
      listActiveMemoryEntries(): never {
        throw new Error('retrieval down');
      },
    };
    const context = buildInvestigationContext(
      incident,
      [evidence],
      broken as unknown as typeof store,
    );
    assert.equal(context.incident.id, incident.id);
    assert.deepEqual(context.historicalKnowledge.similarIncidents, []);
    assert.deepEqual(context.historicalKnowledge.relatedMemories, []);
    assert.ok(Object.isFrozen(context.historicalKnowledge));
    store.close();
  });

  it('keeps investigation context immutable', () => {
    const first = seedIncident();
    const query = seedIncident(first.store);
    const context = buildInvestigationContext(query.incident, [query.evidence], first.store);
    assert.ok(context.historicalKnowledge.similarIncidents.length > 0);
    assert.ok(Object.isFrozen(context));
    assert.ok(Object.isFrozen(context.historicalKnowledge));
    assert.ok(Object.isFrozen(context.historicalKnowledge.similarIncidents));
    assert.throws(() => {
      (context as { incident: { id: string } }).incident.id = 'mutated';
    });
    assert.throws(() => {
      (context.historicalKnowledge.similarIncidents as unknown[]).push({});
    });
    first.store.close();
  });
});
