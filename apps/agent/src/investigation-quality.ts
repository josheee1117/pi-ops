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
  incidentEvidenceCount: number;
  supportingCount: number;
  contradictingCount: number;
  confidence: number;
}): Omit<InvestigationQualityEvaluation, 'id' | 'investigationReportId' | 'reasoningResultId' | 'createdAt'> {
  const evidenceCoverageScore = clamp(
    input.supportingCount / Math.max(input.incidentEvidenceCount, 1),
  );
  const cited = input.supportingCount + input.contradictingCount;
  const contradictionRatio = cited === 0 ? 0 : input.contradictingCount / cited;
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
      const hypotheses = store.listInvestigationHypotheses(report.id);
      const snapshot = summarizeHypotheses(hypotheses, report);
      const scores = computeInvestigationQuality({
        incidentEvidenceCount: incidentEvidence.length,
        supportingCount: snapshot.supportingCount,
        contradictingCount: snapshot.contradictingCount,
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
): { supportingCount: number; contradictingCount: number; confidence: number } {
  const active = hypotheses.filter((item) => item.status !== 'REJECTED');
  if (active.length === 0) {
    return {
      supportingCount: report.supportingEvidenceIds.length,
      contradictingCount: report.contradictingEvidenceIds.length,
      confidence: report.confidence,
    };
  }
  const supporting = new Set(active.flatMap((item) => item.supportingEvidenceIds));
  const contradicting = new Set(active.flatMap((item) => item.contradictingEvidenceIds));
  const confidence = active.reduce((sum, item) => sum + item.confidence, 0) / active.length;
  return {
    supportingCount: supporting.size,
    contradictingCount: contradicting.size,
    confidence,
  };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
