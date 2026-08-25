import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInvestigationHypothesisService } from '../investigation-hypothesis.js';
import { createInvestigationLoopService } from '../investigation-loop.js';
import {
  computeInvestigationQuality,
  createInvestigationQualityService,
} from '../investigation-quality.js';
import { createReasoningEvaluationService } from '../reasoning-evaluation.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

function seedIncident(store = createEventStore(':memory:'), extraEvidence = 0) {
  const incident = store.createIncident({
    service: 'data-asset-service',
    node_id: 'test-svc-02',
    type: 'application.slow_sql',
    state: 'OPEN',
    fingerprint: 'fp-inv-quality',
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'warning',
  } satisfies Omit<IncidentRow, 'id'>);
  const evidence: EvidenceRecord[] = [{
    id: 'evd-q-1',
    incidentId: incident.id,
    nodeId: 'test-svc-02',
    source: 'host',
    kind: 'host.load',
    collectedAt: '2026-08-20T12:00:01.000Z',
    data: { load1: 0.2, cpus: 8 },
    status: 'succeeded',
  }];
  for (let index = 0; index < extraEvidence; index += 1) {
    evidence.push({
      id: `evd-q-${index + 2}`,
      incidentId: incident.id,
      nodeId: 'test-svc-02',
      source: 'host',
      kind: 'host.memory',
      collectedAt: '2026-08-20T12:00:02.000Z',
      data: { used: index },
      status: 'succeeded',
    });
  }
  for (const item of evidence) store.insertEvidence(item);
  return { store, incident, evidence };
}

async function completedReport(extraEvidence = 0, confidence = 0.74) {
  const seeded = seedIncident(createEventStore(':memory:'), extraEvidence);
  const loop = createInvestigationLoopService(seeded.store);
  const { session } = loop.start(seeded.incident.id);
  await loop.submit(session.id);
  const report = loop.complete(session.id, {
    hypothesis: 'database side investigation required',
    supportingEvidenceIds: ['evd-q-1'],
    contradictingEvidenceIds: [],
    confidence,
    recommendation: 'inspect SQL and indexes',
  });
  return { ...seeded, session, report };
}

describe('investigation quality governance', () => {
  it('walks the hypothesis lifecycle PROPOSED → SUPPORTED / REJECTED', async () => {
    const { store, report } = await completedReport();
    const hypotheses = store.listInvestigationHypotheses(report.id);
    assert.equal(hypotheses.length, 1);
    assert.equal(hypotheses[0]?.status, 'PROPOSED');
    assert.equal(hypotheses[0]?.statement, report.hypothesis);
    const service = createInvestigationHypothesisService(store);
    const supported = service.support(hypotheses[0]!.id);
    assert.equal(supported.status, 'SUPPORTED');
    const extra = service.propose({
      investigationReportId: report.id,
      statement: 'JVM issue',
      confidence: 0.4,
      supportingEvidenceIds: ['evd-q-1'],
      contradictingEvidenceIds: [],
    });
    const rejected = service.reject(extra.id);
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(store.getInvestigationHypothesis(hypotheses[0]!.id)?.status, 'SUPPORTED');
    store.close();
  });

  it('rejects a hypothesis that cites evidence from another Incident', async () => {
    const { store, report } = await completedReport();
    assert.throws(
      () => createInvestigationHypothesisService(store).propose({
        investigationReportId: report.id,
        statement: 'Redis issue',
        confidence: 0.5,
        supportingEvidenceIds: ['evd-other'],
        contradictingEvidenceIds: [],
      }),
      /does not belong/,
    );
    assert.equal(store.listInvestigationHypotheses(report.id).length, 1);
    store.close();
  });

  it('calculates quality scores from coverage, contradiction, and consistency', () => {
    const scores = computeInvestigationQuality({
      incidentEvidenceCount: 4,
      supportingCount: 2,
      contradictingCount: 2,
      confidence: 0.8,
    });
    assert.equal(scores.evidenceCoverageScore, 0.5);
    assert.equal(scores.contradictionRatio, 0.5);
    assert.ok(Math.abs(scores.confidenceConsistencyScore - 0.45) < 1e-9);
    assert.equal(
      scores.qualityScore,
      (scores.evidenceCoverageScore + (1 - scores.contradictionRatio) + scores.confidenceConsistencyScore) / 3,
    );
  });

  it('lowers quality when supporting evidence is weak', async () => {
    const weak = await completedReport(3, 0.95);
    const strong = await completedReport(0, 0.95);
    const weakScore = createInvestigationQualityService(weak.store).evaluate(weak.report.id);
    const strongScore = createInvestigationQualityService(strong.store).evaluate(strong.report.id);
    assert.ok(weakScore.qualityScore < strongScore.qualityScore);
    assert.ok(weakScore.evidenceCoverageScore < strongScore.evidenceCoverageScore);
    assert.deepEqual(weak.store.getIncident(weak.incident.id), weak.incident);
    assert.equal(weak.store.listEvidence(weak.incident.id).length, 4);
    weak.store.close();
    strong.store.close();
  });

  it('requires a quality evaluation before creating a MemoryCandidate', async () => {
    const { store, incident, report } = await completedReport();
    const withoutQuality = createReasoningEvaluationService(store).evaluate({
      reasoningResultId: store.listReasoningResults(incident.id)[0]!.id,
      score: 0.9,
      feedback: 'Looks good',
    });
    assert.equal(withoutQuality.candidate, undefined);
    const quality = createInvestigationQualityService(store).evaluate(report.id);
    assert.ok(quality.qualityScore > 0);
    const result = store.getReasoningResult(store.listReasoningResults(incident.id)[0]!.id)!;
    assert.equal(result.investigationQualityEvaluationId, quality.id);
    assert.ok(result.hypothesisIds?.length);
    const withQuality = createReasoningEvaluationService(store).evaluate({
      reasoningResultId: result.id,
      score: 0.9,
      feedback: 'Confirmed after quality review',
    });
    assert.ok(withQuality.candidate);
    store.close();
  });
});
