import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentContext } from '../incident-context.js';
import { createIncidentSimilarityService, incidentSimilarityScore } from '../incident-similarity.js';
import { buildInvestigationContext } from '../investigation-context.js';
import { createInvestigationHypothesisService } from '../investigation-hypothesis.js';
import { createInvestigationLoopService } from '../investigation-loop.js';
import { createInvestigationQualityService } from '../investigation-quality.js';
import { createInvestigationRelationService } from '../investigation-relation.js';
import { createMemoryGovernanceService } from '../memory-governance.js';
import { createFakeReasoner } from '../reasoner.js';
import { createReasoningEvaluationService } from '../reasoning-evaluation.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

function seedIncident(
  store = createEventStore(':memory:'),
  overrides: Partial<IncidentRow> & { fingerprint?: string; id?: string } = {},
) {
  const incident = store.createIncident({
    service: overrides.service ?? 'data-asset-service',
    node_id: overrides.node_id ?? 'test-svc-02',
    type: overrides.type ?? 'application.slow_sql',
    state: 'OPEN',
    fingerprint: overrides.fingerprint ?? 'fp-graph-1',
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'warning',
  } satisfies Omit<IncidentRow, 'id'>);
  const evidence: EvidenceRecord = {
    id: 'evd-graph-1',
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

async function completedReport(overrides: Partial<IncidentRow> & { fingerprint?: string } = {}) {
  const seeded = seedIncident(createEventStore(':memory:'), overrides);
  const loop = createInvestigationLoopService(seeded.store);
  const { session } = loop.start(seeded.incident.id);
  await loop.submit(session.id);
  const report = loop.complete(session.id, {
    hypothesis: 'database side investigation required',
    supportingEvidenceIds: ['evd-graph-1'],
    contradictingEvidenceIds: [],
    confidence: 0.8,
    recommendation: 'inspect SQL and indexes',
  });
  return { ...seeded, session, report };
}

describe('investigation knowledge graph', () => {
  it('creates Hypothesis -> Evidence relations when a hypothesis is proposed', async () => {
    const { store, report } = await completedReport();
    const hypotheses = store.listInvestigationHypotheses(report.id);
    assert.equal(hypotheses.length, 1);
    const relations = store.listInvestigationRelations({
      fromType: 'HYPOTHESIS',
      fromId: hypotheses[0]!.id,
    });
    assert.equal(relations.length, 1);
    assert.equal(relations[0]?.relationType, 'SUPPORTED_BY');
    assert.equal(relations[0]?.toType, 'EVIDENCE');
    assert.equal(relations[0]?.toId, 'evd-graph-1');
    store.close();
  });

  it('creates Memory -> ReasoningResult relations when a candidate is created', async () => {
    const { store, incident, report } = await completedReport();
    const result = store.listReasoningResults(incident.id)[0]!;
    createInvestigationQualityService(store).evaluate(report.id);
    createReasoningEvaluationService(store).evaluate({
      reasoningResultId: result.id,
      score: 0.9,
      feedback: 'Confirmed',
    });
    const candidates = store.listMemoryCandidates(result.id);
    assert.equal(candidates.length, 1);
    const relations = store.listInvestigationRelations({
      fromType: 'MEMORY_CANDIDATE',
      fromId: candidates[0]!.id,
    });
    assert.equal(relations.length, 1);
    assert.equal(relations[0]?.relationType, 'DERIVED_FROM');
    assert.equal(relations[0]?.toType, 'REASONING_RESULT');
    assert.equal(relations[0]?.toId, result.id);
    store.close();
  });

  it('finds similar incidents by service, type, and fingerprint dimensions', () => {
    const { store, incident } = seedIncident(createEventStore(':memory:'), {
      fingerprint: '["application","test-svc-02","data-asset-service","application.slow_sql","deadbeef"]',
    });
    const other = store.createIncident({
      service: 'data-asset-service',
      node_id: 'test-svc-02',
      type: 'application.slow_sql',
      state: 'OPEN',
      fingerprint: '["application","test-svc-02","data-asset-service","application.slow_sql","deadbeef"]',
      first_seen: '2026-08-19T12:00:00.000Z',
      last_seen: '2026-08-19T12:00:00.000Z',
      event_count: 1,
      severity: 'warning',
    });
    const unrelated = store.createIncident({
      service: 'other-service',
      node_id: 'test-svc-02',
      type: 'application.slow_sql',
      state: 'OPEN',
      fingerprint: 'fp-other',
      first_seen: '2026-08-19T13:00:00.000Z',
      last_seen: '2026-08-19T13:00:00.000Z',
      event_count: 1,
      severity: 'warning',
    });
    const found = createIncidentSimilarityService(store).findSimilar(incident);
    const ids = found.map((item) => item.incident.id);
    assert.ok(ids.includes(other.id));
    assert.ok(!ids.includes(unrelated.id));
    const score = incidentSimilarityScore(incident, other);
    assert.ok(score.score > 0);
    assert.deepEqual(score.sharedDimensions, ['deadbeef']);
    const similar = store.listInvestigationRelations({
      fromType: 'INCIDENT',
      fromId: incident.id,
      relationType: 'SIMILAR_TO',
    });
    assert.equal(similar.length, 1);
    assert.equal(similar[0]?.toId, other.id);
    store.close();
  });

  it('does not mutate the original Incident when building historical context', async () => {
    const { store, incident, evidence, report } = await completedReport();
    const beforeIncident = structuredClone(store.getIncident(incident.id)!);
    const beforeEvidence = structuredClone(store.listEvidence(incident.id));
    const context = buildInvestigationContext(incident, [evidence], store);
    assert.equal(context.historicalKnowledge.similarIncidents.length, 0);
    assert.deepEqual(store.getIncident(incident.id), beforeIncident);
    assert.deepEqual(store.listEvidence(incident.id), beforeEvidence);
    assert.ok(Object.isFrozen(context));
    assert.ok(Array.isArray(context.historicalKnowledge.similarIncidents));
    store.close();
  });

  it('does not block reasoning when the graph query fails', async () => {
    const { store, incident, evidence } = seedIncident();
    // Simulate a graph query failure: similarity lookup throws.
    const broken = {
      ...store,
      listIncidents(): never {
        throw new Error('graph query down');
      },
    };
    const context = buildInvestigationContext(incident, [evidence], broken as unknown as typeof store);
    assert.equal(context.incident.id, incident.id);
    assert.ok(context.evidence.length >= 1);
    assert.deepEqual(context.historicalKnowledge.similarIncidents, []);
    assert.deepEqual(context.historicalKnowledge.previousResolutions, []);
    assert.equal(context.historicalKnowledgeStatus, 'unavailable');
    assert.equal(store.getIncident(incident.id)?.id, incident.id);
    store.close();
  });

  it('queries relations by from/to and type', () => {
    const store = createEventStore(':memory:');
    const relations = createInvestigationRelationService(store);
    relations.create({
      fromType: 'HYPOTHESIS',
      fromId: 'ihyp-q',
      toType: 'EVIDENCE',
      toId: 'evd-q',
      relationType: 'SUPPORTED_BY',
    });
    relations.create({
      fromType: 'HYPOTHESIS',
      fromId: 'ihyp-q',
      toType: 'EVIDENCE',
      toId: 'evd-c',
      relationType: 'CONTRADICTED_BY',
    });
    const supporting = relations.list({ fromId: 'ihyp-q', relationType: 'SUPPORTED_BY' });
    assert.equal(supporting.length, 1);
    assert.equal(supporting[0]?.toId, 'evd-q');
    assert.equal(relations.list({ toId: 'evd-c' }).length, 1);
    store.close();
  });

  it('preserves provenance when relations are created', async () => {
    const { store, incident, evidence, report } = await completedReport();
    const beforeIncident = structuredClone(store.getIncident(incident.id)!);
    const beforeEvidence = structuredClone(store.listEvidence(incident.id));
    const beforeHypothesis = structuredClone(store.listInvestigationHypotheses(report.id)[0]!);
    const again = createInvestigationRelationService(store).create({
      fromType: 'HYPOTHESIS',
      fromId: beforeHypothesis.id,
      toType: 'EVIDENCE',
      toId: evidence.id,
      relationType: 'SUPPORTED_BY',
    });
    assert.equal(again.fromId, beforeHypothesis.id);
    assert.deepEqual(store.getIncident(incident.id), beforeIncident);
    assert.deepEqual(store.listEvidence(incident.id), beforeEvidence);
    assert.deepEqual(store.listInvestigationHypotheses(report.id)[0], beforeHypothesis);
    store.close();
  });

  it('creates RESOLVED_BY / SIMILAR_TO relations explicitly', () => {
    const store = createEventStore(':memory:');
    const relations = createInvestigationRelationService(store);
    const a = relations.create({
      fromType: 'INCIDENT',
      fromId: 'inc-a',
      toType: 'INCIDENT',
      toId: 'inc-b',
      relationType: 'SIMILAR_TO',
    });
    const b = relations.create({
      fromType: 'INCIDENT',
      fromId: 'inc-a',
      toType: 'HYPOTHESIS',
      toId: 'ihyp-x',
      relationType: 'RESOLVED_BY',
    });
    assert.equal(a.relationType, 'SIMILAR_TO');
    assert.equal(b.relationType, 'RESOLVED_BY');
    assert.equal(store.listInvestigationRelations({ fromId: 'inc-a' }).length, 2);
    store.close();
  });
});
