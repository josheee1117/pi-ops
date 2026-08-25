import { randomUUID } from 'node:crypto';
import { isCpuHigh } from './reasoner.js';
import type { ReasoningResult } from './reasoner.js';
import type { EvidenceRecord, EventStore, IncidentRow } from './store.js';

export const MEMORY_CANDIDATE_SCORE_THRESHOLD = 0.8;
export const MAX_EVALUATION_FEEDBACK_CHARS = 2000;

export type MemoryCandidateStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ReasoningEvaluation {
  id: string;
  reasoningResultId: string;
  evaluatorType: string;
  score: number;
  confidenceScore: number;
  evidenceCoverageScore: number;
  feedback: string;
  createdAt: string;
}

export interface MemoryCandidate {
  id: string;
  sourceReasoningResultId: string;
  sourceEvaluationId: string;
  incidentType: string;
  pattern: string;
  evidenceSummary: string;
  conclusion: string;
  resolution: string;
  confidence: number;
  status: MemoryCandidateStatus;
  createdAt: string;
}

export interface EvaluateInput {
  reasoningResultId: string;
  score?: number;
  confidenceScore?: number;
  evidenceCoverageScore?: number;
  feedback: string;
  evaluatorType?: string;
}

export interface EvaluateResult {
  evaluation: ReasoningEvaluation;
  candidate: MemoryCandidate | undefined;
}

export function createReasoningEvaluationService(
  store: EventStore,
  options: {
    scoreThreshold?: number;
    now?: () => string;
  } = {},
) {
  const scoreThreshold = options.scoreThreshold ?? MEMORY_CANDIDATE_SCORE_THRESHOLD;
  const now = options.now ?? (() => new Date().toISOString());

  return {
    evaluate(input: EvaluateInput): EvaluateResult {
      const scores = normalizeQualityScores(input);
      const feedback = input.feedback.trim();
      if (!feedback) throw new Error('evaluation feedback is required');
      if (feedback.length > MAX_EVALUATION_FEEDBACK_CHARS) {
        throw new Error(`evaluation feedback exceeds ${MAX_EVALUATION_FEEDBACK_CHARS} characters`);
      }
      const evaluatorType = (input.evaluatorType ?? 'human').trim();
      if (!evaluatorType) throw new Error('evaluator type is required');

      const result = store.getReasoningResult(input.reasoningResultId);
      if (!result) throw new Error(`ReasoningResult ${input.reasoningResultId} does not exist`);

      const evaluation: ReasoningEvaluation = {
        id: `eval-${randomUUID()}`,
        reasoningResultId: result.id,
        evaluatorType,
        score: scores.score,
        confidenceScore: scores.confidenceScore,
        evidenceCoverageScore: scores.evidenceCoverageScore,
        feedback,
        createdAt: now(),
      };
      store.insertReasoningEvaluation(evaluation);

      const incident = store.getIncident(result.incidentId);
      const evidence = store.listEvidence(result.incidentId);
      const report = result.investigationSessionId
        ? store.getInvestigationReportBySessionId(result.investigationSessionId)
        : undefined;
      const quality = report
        ? store.getInvestigationQualityEvaluationByReportId(report.id)
        : undefined;
      const candidate = shouldCreateCandidate(result, evaluation, scoreThreshold)
        && incident
        && (!result.investigationSessionId || Boolean(report))
        && (!result.investigationSessionId || (quality !== undefined && quality.qualityScore >= scoreThreshold))
        ? buildMemoryCandidate(result, evaluation, incident, evidence)
        : undefined;
      if (candidate) store.insertMemoryCandidate(candidate);
      return { evaluation, candidate };
    },
  };
}

export function shouldCreateCandidate(
  result: ReasoningResult,
  evaluation: ReasoningEvaluation,
  scoreThreshold = MEMORY_CANDIDATE_SCORE_THRESHOLD,
): boolean {
  return result.status === 'complete'
    && evaluation.confidenceScore >= scoreThreshold
    && evaluation.evidenceCoverageScore >= scoreThreshold;
}

function requireUnitScore(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number in [0, 1]`);
  }
  return value;
}

function normalizeQualityScores(input: EvaluateInput): {
  score: number;
  confidenceScore: number;
  evidenceCoverageScore: number;
} {
  if (input.confidenceScore !== undefined || input.evidenceCoverageScore !== undefined) {
    const confidenceScore = requireUnitScore('confidenceScore', input.confidenceScore);
    const evidenceCoverageScore = requireUnitScore('evidenceCoverageScore', input.evidenceCoverageScore);
    return {
      score: Math.min(confidenceScore, evidenceCoverageScore),
      confidenceScore,
      evidenceCoverageScore,
    };
  }
  const score = requireUnitScore('score', input.score);
  return { score, confidenceScore: score, evidenceCoverageScore: score };
}

export function buildMemoryCandidate(
  result: ReasoningResult,
  evaluation: ReasoningEvaluation,
  incident: IncidentRow,
  evidence: EvidenceRecord[],
): MemoryCandidate {
  const derived = deriveKnowledge(incident, evidence, result, evaluation);
  return {
    id: `mem-${evaluation.id}`,
    sourceReasoningResultId: result.id,
    sourceEvaluationId: evaluation.id,
    incidentType: incident.type,
    pattern: derived.pattern,
    evidenceSummary: derived.evidenceSummary,
    conclusion: derived.conclusion,
    resolution: derived.resolution,
    confidence: Math.min(result.confidence, evaluation.score),
    status: 'PENDING',
    createdAt: evaluation.createdAt,
  };
}

function deriveKnowledge(
  incident: IncidentRow,
  evidence: EvidenceRecord[],
  result: ReasoningResult,
  evaluation: ReasoningEvaluation,
): {
  pattern: string;
  evidenceSummary: string;
  conclusion: string;
  resolution: string;
} {
  const kinds = [...new Set(evidence.map((item) => item.kind))].sort();
  const evidenceSummary = evidence.length === 0
    ? 'no evidence'
    : evidence
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => `${item.kind}:${item.status}`)
      .join(', ');

  if (incident.type === 'application.slow_sql' && !isCpuHigh(evidence)) {
    return {
      pattern: 'slow_sql + database timeout',
      evidenceSummary,
      conclusion: 'database related',
      resolution: 'check SQL/index',
    };
  }
  if (incident.type === 'application.slow_sql' && isCpuHigh(evidence)) {
    return {
      pattern: 'slow_sql + cpu high',
      evidenceSummary,
      conclusion: result.hypotheses[0] ?? 'application resource saturation',
      resolution: result.recommendedActions?.[0] ?? 'inspect host and container CPU',
    };
  }
  if (incident.type === 'jvm.gc_pressure') {
    return {
      pattern: ['gc_pressure', ...kinds].join(' + '),
      evidenceSummary,
      conclusion: result.hypotheses[0] ?? 'JVM memory pressure',
      resolution: result.recommendedActions?.[0] ?? 'inspect JVM heap and host memory',
    };
  }
  return {
    pattern: [incident.type, ...kinds].join(' + '),
    evidenceSummary,
    conclusion: result.hypotheses[0] ?? evaluation.feedback,
    resolution: result.recommendedActions?.[0] ?? 'review bounded evidence with a human',
  };
}
