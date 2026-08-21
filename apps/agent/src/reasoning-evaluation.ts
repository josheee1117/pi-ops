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
  feedback: string;
  createdAt: string;
}

export interface MemoryCandidate {
  id: string;
  sourceReasoningResultId: string;
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
  score: number;
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
      if (typeof input.score !== 'number' || !Number.isFinite(input.score) || input.score < 0 || input.score > 1) {
        throw new Error('evaluation score must be a number in [0, 1]');
      }
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
        score: input.score,
        feedback,
        createdAt: now(),
      };
      store.insertReasoningEvaluation(evaluation);

      const incident = store.getIncident(result.incidentId);
      const evidence = store.listEvidence(result.incidentId);
      const candidate = shouldCreateCandidate(result, evaluation, scoreThreshold) && incident
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
  return result.status === 'complete' && evaluation.score >= scoreThreshold;
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
