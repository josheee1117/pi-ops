import type { IncidentContext } from './incident-context.js';
import {
  createIncidentSimilarityService,
  type SimilarIncident,
} from './incident-similarity.js';
import type { InvestigationHypothesis } from './investigation-hypothesis.js';
import type { InvestigationRelation } from './investigation-relation.js';
import {
  deriveMemoryQuality,
  withMemoryQuality,
  type MemoryIntelligence,
} from './memory-quality.js';
import { createMemoryRetriever } from './memory-retriever.js';
import type { EventStore, IncidentRow } from './store.js';

export const KNOWLEDGE_RETRIEVAL_LIMIT = 5;
export const LOW_QUALITY_EFFECTIVENESS = 0.5;

export const KNOWLEDGE_RANK_WEIGHTS = {
  similarity: 0.4,
  effectiveness: 0.3,
  quality: 0.3,
} as const;

export interface KnowledgeProvenance {
  sourceRelationId?: string;
  sourceRelationType?: InvestigationRelation['relationType'];
  sourceIncidentId?: string;
  sourceMemoryEntryId?: string;
}

export interface RetrievedSimilarIncident {
  incident: IncidentRow;
  score: number;
  sharedDimensions: string[];
  confidence: number;
  rankScore: number;
  provenance: KnowledgeProvenance;
}

export interface RetrievedHypothesis {
  id: string;
  incidentId: string;
  statement: string;
  confidence: number;
  status: InvestigationHypothesis['status'];
  rankScore: number;
  provenance: KnowledgeProvenance;
}

export interface RetrievedResolution {
  text: string;
  confidence: number;
  rankScore: number;
  provenance: KnowledgeProvenance;
}

export interface RetrievedMemory {
  memory: MemoryIntelligence;
  confidence: number;
  rankScore: number;
  provenance: KnowledgeProvenance;
}

export interface OperationalKnowledgeContext {
  similarIncidents: readonly RetrievedSimilarIncident[];
  historicalHypotheses: readonly RetrievedHypothesis[];
  previousResolutions: readonly RetrievedResolution[];
  relatedMemories: readonly RetrievedMemory[];
}

export type KnowledgeContext = OperationalKnowledgeContext;

export const EMPTY_OPERATIONAL_KNOWLEDGE_CONTEXT: OperationalKnowledgeContext = {
  similarIncidents: [],
  historicalHypotheses: [],
  previousResolutions: [],
  relatedMemories: [],
};

export const EMPTY_KNOWLEDGE_CONTEXT = EMPTY_OPERATIONAL_KNOWLEDGE_CONTEXT;

export interface KnowledgeRetriever {
  retrieve(context: IncidentContext): OperationalKnowledgeContext;
}

export function isLowQualityMemory(memory: MemoryIntelligence): boolean {
  if (memory.failedCount > 0 && memory.successCount === 0) return true;
  return memory.usageCount > 0 && memory.effectivenessScore < LOW_QUALITY_EFFECTIVENESS;
}

export function createKnowledgeRetriever(
  store: EventStore,
  options: { limit?: number } = {},
): KnowledgeRetriever {
  const limit = options.limit ?? KNOWLEDGE_RETRIEVAL_LIMIT;
  const similarity = createIncidentSimilarityService(store, { limit });
  const memories = createMemoryRetriever(store, { limit });

  return {
    retrieve(context: IncidentContext): OperationalKnowledgeContext {
      const incident = store.getIncident(context.incident.id);
      if (!incident) return EMPTY_OPERATIONAL_KNOWLEDGE_CONTEXT;
      const similar = similarity.findSimilar(incident);
      const index = buildRetrievalIndex(store, incident.id, similar, memories.retrieve(context).memories);

      const rankedSimilar = similar
        .map((item) => rankSimilarIncident(index, item))
        .sort(byRankThenId)
        .slice(0, limit);

      const hypotheses = collectHypotheses(index)
        .sort(byRankThenId)
        .slice(0, limit);

      const resolutions = collectResolutions(index)
        .sort(byRankThenId)
        .slice(0, limit);

      const relatedMemories = index.retrievedMemories
        .map((memory) => withProvenanceMemory(index, memory))
        .filter((item) => !isLowQualityMemory(item.memory))
        .sort(byRankThenId)
        .slice(0, limit);

      return {
        similarIncidents: rankedSimilar,
        historicalHypotheses: hypotheses,
        previousResolutions: resolutions,
        relatedMemories,
      };
    },
  };
}

interface RetrievalIndex {
  queryIncidentId: string;
  similarById: Map<string, SimilarIncident>;
  similarIds: Set<string>;
  incidentIdByReportId: Map<string, string>;
  qualityByReportId: Map<string, number>;
  qualityByIncidentId: Map<string, number>;
  effectivenessByIncidentId: Map<string, number>;
  originByMemoryId: Map<string, string>;
  pairRelationByHistoricalId: Map<string, InvestigationRelation>;
  derivedByCandidateId: Map<string, InvestigationRelation>;
  hypotheses: InvestigationHypothesis[];
  resolvedBy: InvestigationRelation[];
  retrievedMemories: MemoryIntelligence[];
  memoryById: Map<string, MemoryIntelligence>;
}

function buildRetrievalIndex(
  store: EventStore,
  queryIncidentId: string,
  similar: SimilarIncident[],
  retrievedMemories: MemoryIntelligence[],
): RetrievalIndex {
  const similarById = new Map(similar.map((item) => [item.incident.id, item]));
  const similarIds = new Set(similarById.keys());

  const sessions = store.listAllInvestigationSessions();
  const reports = store.listAllInvestigationReports();
  const hypotheses = store.listAllInvestigationHypotheses();
  const activeMemories = store.listActiveMemoryEntries();

  const incidentIdBySessionId = new Map(sessions.map((session) => [session.id, session.incidentId] as const));
  const incidentIdByReportId = new Map<string, string>();
  for (const report of reports) {
    const incidentId = incidentIdBySessionId.get(report.sessionId);
    if (incidentId) incidentIdByReportId.set(report.id, incidentId);
  }

  const qualityByReportId = new Map<string, number>();
  const qualityByIncidentId = new Map<string, number>();
  for (const report of reports) {
    const evaluation = store.getInvestigationQualityEvaluationByReportId(report.id);
    if (!evaluation) continue;
    qualityByReportId.set(report.id, evaluation.qualityScore);
    const incidentId = incidentIdByReportId.get(report.id);
    if (!incidentId) continue;
    const previous = qualityByIncidentId.get(incidentId);
    if (previous === undefined || evaluation.qualityScore > previous) {
      qualityByIncidentId.set(incidentId, evaluation.qualityScore);
    }
  }

  const originByMemoryId = new Map<string, string>();
  const memoryById = new Map<string, MemoryIntelligence>();
  const effectivenessAcc = new Map<string, { effectiveness: number; uses: number; success: number; failed: number }>();
  for (const entry of activeMemories) {
    const origin = originIncident(store, entry.id);
    if (origin) originByMemoryId.set(entry.id, origin.incidentId);
    const feedbacks = store.listMemoryFeedbacks(entry.id);
    const quality = deriveMemoryQuality(feedbacks, entry.confidence);
    const memory = withMemoryQuality(entry, quality);
    memoryById.set(entry.id, memory);
    if (!origin) continue;
    const acc = effectivenessAcc.get(origin.incidentId) ?? {
      effectiveness: 0,
      uses: 0,
      success: 0,
      failed: 0,
    };
    acc.effectiveness += quality.effectivenessScore;
    acc.uses += 1;
    acc.success += quality.successCount;
    acc.failed += quality.failedCount;
    effectivenessAcc.set(origin.incidentId, acc);
  }

  const effectivenessByIncidentId = new Map<string, number>();
  for (const [incidentId, acc] of effectivenessAcc) {
    const decided = acc.success + acc.failed;
    const ratio = decided === 0 ? 0.5 : acc.success / decided;
    effectivenessByIncidentId.set(incidentId, 0.5 * (acc.effectiveness / acc.uses) + 0.5 * ratio);
  }

  const pairRelationByHistoricalId = new Map<string, InvestigationRelation>();
  for (const relation of store.listInvestigationRelations({
    fromType: 'INCIDENT',
    fromId: queryIncidentId,
    toType: 'INCIDENT',
    relationType: 'SIMILAR_TO',
  })) {
    pairRelationByHistoricalId.set(relation.toId, relation);
  }
  for (const relation of store.listInvestigationRelations({
    fromType: 'INCIDENT',
    toId: queryIncidentId,
    toType: 'INCIDENT',
    relationType: 'SIMILAR_TO',
  })) {
    if (!pairRelationByHistoricalId.has(relation.fromId)) {
      pairRelationByHistoricalId.set(relation.fromId, relation);
    }
  }

  const derivedByCandidateId = new Map<string, InvestigationRelation>();
  for (const relation of store.listInvestigationRelations({
    fromType: 'MEMORY_CANDIDATE',
    relationType: 'DERIVED_FROM',
  })) {
    derivedByCandidateId.set(relation.fromId, relation);
  }

  return {
    queryIncidentId,
    similarById,
    similarIds,
    incidentIdByReportId,
    qualityByReportId,
    qualityByIncidentId,
    effectivenessByIncidentId,
    originByMemoryId,
    pairRelationByHistoricalId,
    derivedByCandidateId,
    hypotheses,
    resolvedBy: store.listInvestigationRelations({
      fromType: 'INCIDENT',
      toType: 'HYPOTHESIS',
      relationType: 'RESOLVED_BY',
    }),
    retrievedMemories,
    memoryById,
  };
}

function rankScore(similarity: number, effectiveness: number, quality: number): number {
  return KNOWLEDGE_RANK_WEIGHTS.similarity * similarity
    + KNOWLEDGE_RANK_WEIGHTS.effectiveness * effectiveness
    + KNOWLEDGE_RANK_WEIGHTS.quality * quality;
}

function rankSimilarIncident(index: RetrievalIndex, item: SimilarIncident): RetrievedSimilarIncident {
  const quality = index.qualityByIncidentId.get(item.incident.id);
  const effectiveness = index.effectivenessByIncidentId.get(item.incident.id) ?? 0.5;
  const relation = index.pairRelationByHistoricalId.get(item.incident.id);
  return {
    incident: item.incident,
    score: item.score,
    sharedDimensions: item.sharedDimensions,
    confidence: quality !== undefined ? quality : item.score,
    rankScore: rankScore(item.score, effectiveness, quality ?? 0),
    provenance: {
      sourceIncidentId: item.incident.id,
      ...(relation ? {
        sourceRelationId: relation.id,
        sourceRelationType: relation.relationType,
      } : { sourceRelationType: 'SIMILAR_TO' as const }),
    },
  };
}

function collectHypotheses(index: RetrievalIndex): RetrievedHypothesis[] {
  const items: RetrievedHypothesis[] = [];
  for (const hypothesis of index.hypotheses) {
    const incidentId = index.incidentIdByReportId.get(hypothesis.investigationReportId);
    if (!incidentId || !index.similarIds.has(incidentId)) continue;
    const similarity = index.similarById.get(incidentId)?.score ?? 0;
    const quality = qualityForHypothesis(index, hypothesis);
    items.push({
      id: hypothesis.id,
      incidentId,
      statement: hypothesis.statement,
      confidence: hypothesis.confidence,
      status: hypothesis.status,
      rankScore: rankScore(similarity, index.effectivenessByIncidentId.get(incidentId) ?? 0.5, quality),
      provenance: {
        sourceIncidentId: incidentId,
        sourceRelationType: 'SIMILAR_TO',
      },
    });
  }
  return items;
}

function collectResolutions(index: RetrievalIndex): RetrievedResolution[] {
  const seen = new Set<string>();
  const items: RetrievedResolution[] = [];

  for (const relation of index.resolvedBy) {
    if (!index.similarIds.has(relation.fromId)) continue;
    const hypothesis = index.hypotheses.find((item) => item.id === relation.toId);
    if (!hypothesis) continue;
    const similarity = index.similarById.get(relation.fromId)?.score ?? 0;
    pushResolution(items, seen, {
      text: hypothesis.statement,
      confidence: hypothesis.confidence,
      rankScore: rankScore(
        similarity,
        index.effectivenessByIncidentId.get(relation.fromId) ?? 0.5,
        qualityForHypothesis(index, hypothesis),
      ),
      provenance: {
        sourceIncidentId: relation.fromId,
        sourceRelationId: relation.id,
        sourceRelationType: relation.relationType,
      },
    });
  }

  for (const memory of index.memoryById.values()) {
    const originId = index.originByMemoryId.get(memory.id);
    if (!originId || !index.similarIds.has(originId)) continue;
    if (isLowQualityMemory(memory)) continue;
    const similarity = index.similarById.get(originId)?.score ?? 0;
    pushResolution(items, seen, {
      text: memory.resolution,
      confidence: memory.confidence,
      rankScore: rankScore(
        similarity,
        memory.effectivenessScore,
        index.qualityByIncidentId.get(originId) ?? 0,
      ),
      provenance: {
        sourceIncidentId: originId,
        sourceMemoryEntryId: memory.id,
        sourceRelationType: 'DERIVED_FROM',
      },
    });
  }
  return items;
}

function pushResolution(
  items: RetrievedResolution[],
  seen: Set<string>,
  item: RetrievedResolution,
): void {
  const text = item.text.trim();
  if (!text || seen.has(text)) return;
  seen.add(text);
  items.push({ ...item, text });
}

function withProvenanceMemory(index: RetrievalIndex, memory: MemoryIntelligence): RetrievedMemory {
  const originId = index.originByMemoryId.get(memory.id);
  const derived = index.derivedByCandidateId.get(memory.sourceMemoryCandidateId);
  const similarity = originId ? index.similarById.get(originId)?.score ?? 0 : 0;
  const quality = originId ? index.qualityByIncidentId.get(originId) ?? 0 : 0;
  return {
    memory,
    confidence: memory.confidence,
    rankScore: rankScore(similarity, memory.effectivenessScore, quality),
    provenance: {
      sourceMemoryEntryId: memory.id,
      ...(originId ? { sourceIncidentId: originId } : {}),
      ...(derived ? {
        sourceRelationId: derived.id,
        sourceRelationType: derived.relationType,
      } : {}),
    },
  };
}

function qualityForHypothesis(index: RetrievalIndex, hypothesis: InvestigationHypothesis): number {
  if (index.qualityByReportId.has(hypothesis.investigationReportId)) {
    return index.qualityByReportId.get(hypothesis.investigationReportId)!;
  }
  return evidenceQuality(hypothesis);
}

function originIncident(store: EventStore, memoryEntryId: string): { incidentId: string } | undefined {
  const entry = store.getMemoryEntry(memoryEntryId);
  if (!entry) return undefined;
  const candidate = store.getMemoryCandidate(entry.sourceMemoryCandidateId);
  if (!candidate) return undefined;
  const result = store.getReasoningResult(candidate.sourceReasoningResultId);
  if (!result) return undefined;
  return { incidentId: result.incidentId };
}

function evidenceQuality(hypothesis: InvestigationHypothesis): number {
  const cited = hypothesis.supportingContribution + hypothesis.contradictingContribution;
  if (cited <= 0) return 0;
  return hypothesis.supportingContribution / cited;
}

function byRankThenId<T extends { rankScore: number } & ({ incident?: { id: string }; id?: string; text?: string; memory?: { id: string } })>(
  left: T,
  right: T,
): number {
  const rank = right.rankScore - left.rankScore;
  if (rank !== 0) return rank;
  return knowledgeKey(left).localeCompare(knowledgeKey(right));
}

function knowledgeKey(item: {
  incident?: { id: string };
  id?: string;
  text?: string;
  memory?: { id: string };
}): string {
  return item.incident?.id ?? item.memory?.id ?? item.id ?? item.text ?? '';
}
