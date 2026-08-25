import type { IncidentContext } from './incident-context.js';
import {
  createIncidentSimilarityService,
  type SimilarIncident,
} from './incident-similarity.js';
import type { InvestigationHypothesis } from './investigation-hypothesis.js';
import type { InvestigationRelation } from './investigation-relation.js';
import {
  deriveMemoryQuality,
  successRatio,
  withMemoryQuality,
  type MemoryIntelligence,
} from './memory-quality.js';
import { createMemoryRetriever } from './memory-retriever.js';
import type { EventStore, IncidentRow } from './store.js';

export const KNOWLEDGE_RETRIEVAL_LIMIT = 5;
export const LOW_QUALITY_EFFECTIVENESS = 0.5;

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
  rankScore: number;
  provenance: KnowledgeProvenance;
}

export interface RetrievedMemory {
  memory: MemoryIntelligence;
  rankScore: number;
  provenance: KnowledgeProvenance;
}

export interface KnowledgeContext {
  similarIncidents: readonly RetrievedSimilarIncident[];
  historicalHypotheses: readonly RetrievedHypothesis[];
  previousResolutions: readonly RetrievedResolution[];
  relatedMemories: readonly RetrievedMemory[];
}

export const EMPTY_KNOWLEDGE_CONTEXT: KnowledgeContext = {
  similarIncidents: [],
  historicalHypotheses: [],
  previousResolutions: [],
  relatedMemories: [],
};

export function isLowQualityMemory(memory: MemoryIntelligence): boolean {
  if (memory.failedCount > 0 && memory.successCount === 0) return true;
  return memory.usageCount > 0 && memory.effectivenessScore < LOW_QUALITY_EFFECTIVENESS;
}

export function createInvestigationKnowledgeRetriever(
  store: EventStore,
  options: { limit?: number } = {},
) {
  const limit = options.limit ?? KNOWLEDGE_RETRIEVAL_LIMIT;
  const similarity = createIncidentSimilarityService(store, { limit });
  const memories = createMemoryRetriever(store, { limit });

  return {
    retrieve(context: IncidentContext): KnowledgeContext {
      const incident = store.getIncident(context.incident.id);
      if (!incident) return EMPTY_KNOWLEDGE_CONTEXT;
      const similar = similarity.findSimilar(incident);
      const similarById = new Map(similar.map((item) => [item.incident.id, item]));
      const similarIds = new Set(similarById.keys());

      const rankedSimilar = similar
        .map((item) => rankSimilarIncident(store, item))
        .sort(byRankThenId)
        .slice(0, limit);

      const hypotheses = collectHypotheses(store, similarIds, similarById)
        .sort(byRankThenId)
        .slice(0, limit);

      const resolutions = collectResolutions(store, similarIds, similarById, hypotheses)
        .sort(byRankThenId)
        .slice(0, limit);

      const relatedMemories = memories.retrieve(context).memories
        .map((memory) => withProvenanceMemory(store, memory))
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

function rankSimilarIncident(store: EventStore, item: SimilarIncident): RetrievedSimilarIncident {
  const feedbackBoost = resolutionSuccess(store, item.incident.id);
  const relation = store.listInvestigationRelations({
    fromType: 'INCIDENT',
    fromId: item.incident.id,
    toType: 'INCIDENT',
    relationType: 'SIMILAR_TO',
  })[0] ?? store.listInvestigationRelations({
    fromType: 'INCIDENT',
    toId: item.incident.id,
    toType: 'INCIDENT',
    relationType: 'SIMILAR_TO',
  })[0];
  return {
    incident: item.incident,
    score: item.score,
    sharedDimensions: item.sharedDimensions,
    rankScore: item.score + 0.2 * feedbackBoost,
    provenance: {
      sourceIncidentId: item.incident.id,
      ...(relation ? {
        sourceRelationId: relation.id,
        sourceRelationType: relation.relationType,
      } : { sourceRelationType: 'SIMILAR_TO' as const }),
    },
  };
}

function collectHypotheses(
  store: EventStore,
  similarIds: Set<string>,
  similarById: Map<string, SimilarIncident>,
): RetrievedHypothesis[] {
  const sessionIncident = new Map(
    store.listAllInvestigationSessions().map((session) => [session.id, session.incidentId] as const),
  );
  const reportIncident = new Map<string, string>();
  for (const report of store.listAllInvestigationReports()) {
    const incidentId = sessionIncident.get(report.sessionId);
    if (incidentId && similarIds.has(incidentId)) reportIncident.set(report.id, incidentId);
  }
  const items: RetrievedHypothesis[] = [];
  for (const hypothesis of store.listAllInvestigationHypotheses()) {
    const incidentId = reportIncident.get(hypothesis.investigationReportId);
    if (!incidentId) continue;
    const similarity = similarById.get(incidentId)?.score ?? 0;
    items.push({
      id: hypothesis.id,
      incidentId,
      statement: hypothesis.statement,
      confidence: hypothesis.confidence,
      status: hypothesis.status,
      rankScore: similarity * 0.6 + hypothesis.confidence * 0.4,
      provenance: {
        sourceIncidentId: incidentId,
        sourceRelationType: 'SIMILAR_TO',
      },
    });
  }
  return items;
}

function collectResolutions(
  store: EventStore,
  similarIds: Set<string>,
  similarById: Map<string, SimilarIncident>,
  hypotheses: RetrievedHypothesis[],
): RetrievedResolution[] {
  const seen = new Set<string>();
  const items: RetrievedResolution[] = [];
  for (const hypothesis of hypotheses) {
    if (hypothesis.status !== 'SUPPORTED') continue;
    const text = hypothesis.statement.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    items.push({
      text,
      rankScore: hypothesis.rankScore,
      provenance: hypothesis.provenance,
    });
  }
  for (const entry of store.listActiveMemoryEntries()) {
    const origin = originIncident(store, entry.id);
    if (!origin || !similarIds.has(origin.incidentId)) continue;
    const text = entry.resolution.trim();
    if (!text || seen.has(text)) continue;
    const feedbacks = store.listMemoryFeedbacks(entry.id);
    const quality = deriveMemoryQuality(feedbacks, entry.confidence);
    if (isLowQualityMemory(withMemoryQuality(entry, quality))) continue;
    seen.add(text);
    const similarity = similarById.get(origin.incidentId)?.score ?? 0;
    items.push({
      text,
      rankScore: similarity * 0.5 + quality.effectivenessScore * 0.5,
      provenance: {
        sourceIncidentId: origin.incidentId,
        sourceMemoryEntryId: entry.id,
        sourceRelationType: 'DERIVED_FROM',
      },
    });
  }
  return items;
}

function withProvenanceMemory(store: EventStore, memory: MemoryIntelligence): RetrievedMemory {
  const origin = originIncident(store, memory.id);
  const derived = store.listInvestigationRelations({
    fromType: 'MEMORY_CANDIDATE',
    fromId: memory.sourceMemoryCandidateId,
    relationType: 'DERIVED_FROM',
  })[0];
  return {
    memory,
    rankScore: memory.effectivenessScore + 0.1 * successRatio(memory),
    provenance: {
      sourceMemoryEntryId: memory.id,
      ...(origin ? { sourceIncidentId: origin.incidentId } : {}),
      ...(derived ? {
        sourceRelationId: derived.id,
        sourceRelationType: derived.relationType,
      } : {}),
    },
  };
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

function resolutionSuccess(store: EventStore, incidentId: string): number {
  let success = 0;
  let failed = 0;
  for (const entry of store.listActiveMemoryEntries()) {
    const origin = originIncident(store, entry.id);
    if (origin?.incidentId !== incidentId) continue;
    for (const feedback of store.listMemoryFeedbacks(entry.id)) {
      if (feedback.outcome === 'SUCCESS') success += 1;
      if (feedback.outcome === 'FAILED') failed += 1;
    }
  }
  const decided = success + failed;
  return decided === 0 ? 0.5 : success / decided;
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
