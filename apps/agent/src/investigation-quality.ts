import {
  createEvidenceIntelligenceService,
  evidenceWeight,
  type EvidenceProfile,
} from './evidence-intelligence.js';
import type { InvestigationHypothesis } from './investigation-hypothesis.js';
import type { EventStore } from './store.js';

export interface InvestigationQualityEvaluation {
  id: string;
  investigationReportId: string;
  reasoningResultId?: string;
  evidenceCoverageScore: number;
  contradictionRatio: number;
  confidenceConsistencyScore: number;
  qualityScore: number;
  createdAt: string;
}

export function computeInvestigationQuality(input: {
  incidentEvidenceCount?: number;
  supportingCount?: number;
  contradictingCount?: number;
  incidentEvidenceWeight?: number;
  supportingWeight?: number;
  contradictingWeight?: number;
  confidence: number;
}): Omit<InvestigationQualityEvaluation, 'id' | 'investigationReportId' | 'reasoningResultId' | 'createdAt'> {
  const supportingWeight = input.supportingWeight ?? input.supportingCount ?? 0;
  const contradictingWeight = input.contradictingWeight ?? input.contradictingCount ?? 0;
  const incidentEvidenceWeight = input.incidentEvidenceWeight ?? input.incidentEvidenceCount ?? 0;
  const denominator = incidentEvidenceWeight > 0 ? incidentEvidenceWeight : 1;
  const evidenceCoverageScore = clamp(supportingWeight / denominator);
  const cited = supportingWeight + contradictingWeight;
  const contradictionRatio = cited === 0 ? 0 : contradictingWeight / cited;
  const expectedConfidence = evidenceCoverageScore * (1 - contradictionRatio);
  const confidenceConsistencyScore = clamp(1 - Math.abs(input.confidence - expectedConfidence));
  const qualityScore = (
    evidenceCoverageScore
    + (1 - contradictionRatio)
    + confidenceConsistencyScore
  ) / 3;
  return {
    evidenceCoverageScore,
    contradictionRatio,
    confidenceConsistencyScore,
    qualityScore,
  };
}

export function createInvestigationQualityService(
  store: EventStore,
  options: { now?: () => string } = {},
) {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    evaluate(investigationReportId: string): InvestigationQualityEvaluation {
      const existing = store.getInvestigationQualityEvaluationByReportId(investigationReportId);
      if (existing) return existing;
      const report = store.getInvestigationReport(investigationReportId);
      if (!report) throw new Error(`InvestigationReport ${investigationReportId} does not exist`);
      const session = store.getInvestigationSession(report.sessionId);
      if (!session) throw new Error(`InvestigationSession ${report.sessionId} does not exist`);
      const incidentEvidence = store.listEvidence(session.incidentId);
      const intelligence = createEvidenceIntelligenceService(store);
      const profiles = new Map<string, EvidenceProfile>();
      let incidentEvidenceWeight = 0;
      for (const item of incidentEvidence) {
        const profile = intelligence.profile(item.id);
        profiles.set(item.id, profile);
        incidentEvidenceWeight += evidenceWeight(profile);
      }
      const hypotheses = store.listInvestigationHypotheses(report.id);
      const snapshot = summarizeHypotheses(hypotheses, report, profiles);
      const scores = computeInvestigationQuality({
        incidentEvidenceWeight,
        supportingWeight: snapshot.supportingWeight,
        contradictingWeight: snapshot.contradictingWeight,
        confidence: snapshot.confidence,
      });
      const result = store.listReasoningResults(session.incidentId)
        .find((item) => item.investigationReportId === report.id);
      const evaluation: InvestigationQualityEvaluation = {
        id: `iqe-${report.id}`,
        investigationReportId: report.id,
        ...(result ? { reasoningResultId: result.id } : {}),
        ...scores,
        createdAt: now(),
      };
      store.insertInvestigationQualityEvaluation(evaluation);
      if (result) {
        store.patchReasoningResultInvestigationRefs(result.id, {
          hypothesisIds: hypotheses.map((item) => item.id),
          investigationQualityEvaluationId: evaluation.id,
        });
      }
      return evaluation;
    },
  };
}

function summarizeHypotheses(
  hypotheses: InvestigationHypothesis[],
  report: { supportingEvidenceIds: string[]; contradictingEvidenceIds: string[]; confidence: number },
  profiles: Map<string, EvidenceProfile>,
): { supportingWeight: number; contradictingWeight: number; confidence: number } {
  const active = hypotheses.filter((item) => item.status !== 'REJECTED');
  const supportingIds = active.length === 0
    ? report.supportingEvidenceIds
    : [...new Set(active.flatMap((item) => item.supportingEvidenceIds))];
  const contradictingIds = active.length === 0
    ? report.contradictingEvidenceIds
    : [...new Set(active.flatMap((item) => item.contradictingEvidenceIds))];
  const confidence = active.length === 0
    ? report.confidence
    : active.reduce((sum, item) => sum + item.confidence, 0) / active.length;
  return {
    supportingWeight: weightIds(supportingIds, profiles),
    contradictingWeight: weightIds(contradictingIds, profiles),
    confidence,
  };
}

function weightIds(ids: string[], profiles: Map<string, EvidenceProfile>): number {
  let total = 0;
  for (const id of ids) {
    const profile = profiles.get(id);
    if (profile) total += evidenceWeight(profile);
  }
  return total;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
