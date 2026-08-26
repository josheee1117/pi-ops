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

const SIMILARITY_WEIGHT = 0.4;
const EFFECTIVENESS_WEIGHT = 0.3;
const QUALITY_WEIGHT = 0.3;

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
        .map((memory) => withProvenanceMemory(store, memory, similarById))
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

export const createInvestigationKnowledgeRetriever = createKnowledgeRetriever;

function rankScore(similarity: number, effectiveness: number, quality: number): number {
  return SIMILARITY_WEIGHT * similarity
    + EFFECTIVENESS_WEIGHT * effectiveness
    + QUALITY_WEIGHT * quality;
}

function rankSimilarIncident(store: EventStore, item: SimilarIncident): RetrievedSimilarIncident {
  const effectiveness = memoryEffectiveness(store, item.incident.id);
  const quality = investigationQualityForIncident(store, item.incident.id);
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
    confidence: quality > 0 ? quality : item.score,
    rankScore: rankScore(item.score, effectiveness, quality),
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
    const quality = investigationQualityForReport(store, hypothesis.investigationReportId)
      || evidenceQuality(hypothesis);
    items.push({
      id: hypothesis.id,
      incidentId,
      statement: hypothesis.statement,
      confidence: hypothesis.confidence,
      status: hypothesis.status,
      rankScore: rankScore(similarity, memoryEffectiveness(store, incidentId), quality),
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

  for (const relation of store.listInvestigationRelations({
    fromType: 'INCIDENT',
    toType: 'HYPOTHESIS',
    relationType: 'RESOLVED_BY',
  })) {
    if (!similarIds.has(relation.fromId)) continue;
    const hypothesis = store.getInvestigationHypothesis(relation.toId);
    if (!hypothesis) continue;
    const similarity = similarById.get(relation.fromId)?.score ?? 0;
    const quality = investigationQualityForReport(store, hypothesis.investigationReportId)
      || evidenceQuality(hypothesis);
    pushResolution(items, seen, {
      text: hypothesis.statement,
      confidence: hypothesis.confidence,
      rankScore: rankScore(similarity, memoryEffectiveness(store, relation.fromId), quality),
      provenance: {
        sourceIncidentId: relation.fromId,
        sourceRelationId: relation.id,
        sourceRelationType: relation.relationType,
      },
    });
  }

  for (const hypothesis of hypotheses) {
    if (hypothesis.status !== 'SUPPORTED') continue;
    pushResolution(items, seen, {
      text: hypothesis.statement,
      confidence: hypothesis.confidence,
      rankScore: hypothesis.rankScore,
      provenance: hypothesis.provenance,
    });
  }

  for (const entry of store.listActiveMemoryEntries()) {
    const origin = originIncident(store, entry.id);
    if (!origin || !similarIds.has(origin.incidentId)) continue;
    const feedbacks = store.listMemoryFeedbacks(entry.id);
    const quality = deriveMemoryQuality(feedbacks, entry.confidence);
    const memory = withMemoryQuality(entry, quality);
    if (isLowQualityMemory(memory)) continue;
    const similarity = similarById.get(origin.incidentId)?.score ?? 0;
    pushResolution(items, seen, {
      text: entry.resolution,
      confidence: entry.confidence,
      rankScore: rankScore(similarity, memory.effectivenessScore, investigationQualityForIncident(store, origin.incidentId)),
      provenance: {
        sourceIncidentId: origin.incidentId,
        sourceMemoryEntryId: entry.id,
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

function withProvenanceMemory(
  store: EventStore,
  memory: MemoryIntelligence,
  similarById: Map<string, SimilarIncident>,
): RetrievedMemory {
  const origin = originIncident(store, memory.id);
  const derived = store.listInvestigationRelations({
    fromType: 'MEMORY_CANDIDATE',
    fromId: memory.sourceMemoryCandidateId,
    relationType: 'DERIVED_FROM',
  })[0];
  const similarity = origin ? similarById.get(origin.incidentId)?.score ?? 0.4 : 0.4;
  const quality = origin ? investigationQualityForIncident(store, origin.incidentId) : 0;
  return {
    memory,
    confidence: memory.confidence,
    rankScore: rankScore(similarity, memory.effectivenessScore, quality),
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

function memoryEffectiveness(store: EventStore, incidentId: string): number {
  let success = 0;
  let failed = 0;
  let effectiveness = 0;
  let uses = 0;
  for (const entry of store.listActiveMemoryEntries()) {
    const origin = originIncident(store, entry.id);
    if (origin?.incidentId !== incidentId) continue;
    const feedbacks = store.listMemoryFeedbacks(entry.id);
    const quality = deriveMemoryQuality(feedbacks, entry.confidence);
    effectiveness += quality.effectivenessScore;
    uses += 1;
    success += quality.successCount;
    failed += quality.failedCount;
  }
  if (uses === 0) return 0.5;
  const decided = success + failed;
  const ratio = decided === 0 ? 0.5 : success / decided;
  return 0.5 * (effectiveness / uses) + 0.5 * ratio;
}

function investigationQualityForIncident(store: EventStore, incidentId: string): number {
  const sessionIds = new Set(
    store.listAllInvestigationSessions()
      .filter((session) => session.incidentId === incidentId)
      .map((session) => session.id),
  );
  if (sessionIds.size === 0) return 0;
  let best = 0;
  for (const report of store.listAllInvestigationReports()) {
    if (!sessionIds.has(report.sessionId)) continue;
    const score = investigationQualityForReport(store, report.id);
    if (score > best) best = score;
  }
  return best;
}

function investigationQualityForReport(store: EventStore, reportId: string): number {
  return store.getInvestigationQualityEvaluationByReportId(reportId)?.qualityScore ?? 0;
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
