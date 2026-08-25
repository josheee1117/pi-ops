import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyEvidence,
  createEvidenceIntelligenceService,
  evidenceWeight,
} from '../evidence-intelligence.js';
import { createInvestigationLoopService } from '../investigation-loop.js';
import { createInvestigationQualityService } from '../investigation-quality.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

function seedMixedEvidence() {
  const store = createEventStore(':memory:');
  const incident = store.createIncident({
    service: 'data-asset-service',
    node_id: 'test-svc-02',
    type: 'application.slow_sql',
    state: 'OPEN',
    fingerprint: 'fp-evd-intel',
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'warning',
  } satisfies Omit<IncidentRow, 'id'>);
  const inspect: EvidenceRecord = {
    id: 'evd-inspect',
    incidentId: incident.id,
    nodeId: 'test-svc-02',
    source: 'docker',
    kind: 'docker.inspect',
    collectedAt: '2026-08-20T12:00:01.000Z',
    data: { State: { Status: 'running' } },
    status: 'succeeded',
  };
  const logs: EvidenceRecord = {
    id: 'evd-logs',
    incidentId: incident.id,
    nodeId: 'test-svc-02',
    source: 'docker',
    kind: 'docker.logs',
    collectedAt: '2026-08-20T12:00:02.000Z',
    data: { lines: ['noise'] },
    status: 'succeeded',
  };
  store.insertEvidence(inspect);
  store.insertEvidence(logs);
  return { store, incident, inspect, logs };
}

async function reportCiting(evidenceId: string) {
  const seeded = seedMixedEvidence();
  const loop = createInvestigationLoopService(seeded.store);
  const { session } = loop.start(seeded.incident.id);
  await loop.submit(session.id);
  const report = loop.complete(session.id, {
    hypothesis: 'container misconfiguration',
    supportingEvidenceIds: [evidenceId],
    contradictingEvidenceIds: [],
    confidence: 0.8,
    recommendation: 'inspect container state',
  });
  return { ...seeded, session, report };
}

describe('evidence intelligence', () => {
  it('increases investigation quality when high-value evidence supports the hypothesis', async () => {
    const primary = await reportCiting('evd-inspect');
    const weak = await reportCiting('evd-logs');
    const primaryScore = createInvestigationQualityService(primary.store).evaluate(primary.report.id);
    const weakScore = createInvestigationQualityService(weak.store).evaluate(weak.report.id);
    assert.ok(primaryScore.qualityScore > weakScore.qualityScore);
    assert.ok(primaryScore.evidenceCoverageScore > weakScore.evidenceCoverageScore);
    primary.store.close();
    weak.store.close();
  });

  it('gives weak evidence a lower contribution than primary evidence', async () => {
    const { store, inspect, logs } = seedMixedEvidence();
    const intelligence = createEvidenceIntelligenceService(store);
    const primary = intelligence.profile(inspect.id);
    const weak = intelligence.profile(logs.id);
    assert.equal(primary.category, 'primary_signal');
    assert.equal(weak.category, 'weak_signal');
    assert.ok(evidenceWeight(weak) < evidenceWeight(primary));
    assert.ok(classifyEvidence(logs).diagnosticWeight < classifyEvidence(inspect).diagnosticWeight);
    store.close();
  });

  it('rejects profiling an unknown evidence id', () => {
    const store = createEventStore(':memory:');
    assert.throws(
      () => createEvidenceIntelligenceService(store).profile('evd-missing'),
      /Evidence/,
    );
    store.close();
  });

  it('records hypothesis evidence contribution without mutating Incident or Evidence', async () => {
    const { store, incident, inspect, report } = await reportCiting('evd-inspect');
    const beforeIncident = structuredClone(store.getIncident(incident.id)!);
    const beforeEvidence = structuredClone(store.listEvidence(incident.id));
    const hypothesis = store.listInvestigationHypotheses(report.id)[0]!;
    assert.deepEqual(hypothesis.supportingEvidenceIds, [inspect.id]);
    assert.equal(hypothesis.contradictingEvidenceIds.length, 0);
    assert.ok(hypothesis.supportingContribution > 0);
    assert.equal(hypothesis.contradictingContribution, 0);
    const relevance = createEvidenceIntelligenceService(store).relevance(hypothesis.id, inspect.id);
    assert.equal(relevance.relationship, 'supporting');
    assert.equal(relevance.relevanceScore, hypothesis.supportingContribution);
    assert.deepEqual(store.getIncident(incident.id), beforeIncident);
    assert.deepEqual(store.listEvidence(incident.id), beforeEvidence);
    store.close();
  });
});
