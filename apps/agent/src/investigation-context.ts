import { buildIncidentContext, type IncidentContext, type IncidentContextBounds } from './incident-context.js';
import { createIncidentSimilarityService, type SimilarIncident } from './incident-similarity.js';
import type { InvestigationHypothesis } from './investigation-hypothesis.js';
import type { MemoryIntelligence } from './memory-quality.js';
import { createMemoryRetriever, type MemoryRetriever } from './memory-retriever.js';
import type { EvidenceRecord, EventStore, IncidentRow } from './store.js';

export const INVESTIGATION_SCHEMA_VERSION = 1;

export interface SimilarHypothesis {
  id: string;
  incidentId: string;
  statement: string;
  confidence: number;
  status: InvestigationHypothesis['status'];
}

export interface InvestigationContext {
  schemaVersion: number;
  incident: IncidentContext['incident'];
  evidence: readonly IncidentContext['evidence'][number][];
  relatedMemories: readonly MemoryIntelligence[];
  previousResolutions: readonly string[];
  conflictingMemories: readonly MemoryIntelligence[];
  relatedIncidents: readonly SimilarIncident[];
  historicalResolutions: readonly string[];
  similarHypotheses: readonly SimilarHypothesis[];
}

const DEFAULT_BOUNDS: IncidentContextBounds = {
  maxEvidenceItems: 8,
  maxContextBytes: 8192,
  maxLogLines: 20,
};

export function buildInvestigationContext(
  incident: IncidentRow,
  evidence: EvidenceRecord[],
  store: EventStore,
  options: {
    retriever?: MemoryRetriever;
    bounds?: IncidentContextBounds;
  } = {},
): InvestigationContext {
  const bounds = options.bounds ?? DEFAULT_BOUNDS;
  const incidentContext = buildIncidentContext(incident, evidence, bounds);
  const retrieval = (options.retriever ?? createMemoryRetriever(store)).retrieve(incidentContext);
  const previousResolutions = uniqueResolutions([
    ...retrieval.memories,
    ...retrieval.conflictingMemories,
  ]);
  const history = historicalContext(incident, store);
  return deepFreeze({
    schemaVersion: INVESTIGATION_SCHEMA_VERSION,
    incident: incidentContext.incident,
    evidence: incidentContext.evidence,
    relatedMemories: retrieval.memories,
    previousResolutions,
    conflictingMemories: retrieval.conflictingMemories,
    ...history,
  });
}

function uniqueResolutions(memories: MemoryIntelligence[]): string[] {
  const seen = new Set<string>();
  const resolutions: string[] = [];
  for (const memory of memories) {
    const resolution = memory.resolution.trim();
    if (!resolution || seen.has(resolution)) continue;
    seen.add(resolution);
    resolutions.push(resolution);
  }
  return resolutions;
}

function historicalContext(incident: IncidentRow, store: EventStore): {
  relatedIncidents: SimilarIncident[];
  historicalResolutions: string[];
  similarHypotheses: SimilarHypothesis[];
} {
  try {
    const similar = createIncidentSimilarityService(store).findSimilar(incident);
    const relatedIds = new Set(similar.map((item) => item.incident.id));
    const incidentByReport = new Map<string, string>();
    const sessionIncident = new Map(
      store.listAllInvestigationSessions().map((session) => [session.id, session.incidentId] as const),
    );
    for (const report of store.listAllInvestigationReports()) {
      const incidentId = sessionIncident.get(report.sessionId);
      if (incidentId && relatedIds.has(incidentId)) {
        incidentByReport.set(report.id, incidentId);
      }
    }
    const historical = new Set<string>();
    const hypotheses: SimilarHypothesis[] = [];
    for (const hypothesis of store.listAllInvestigationHypotheses()) {
      const incidentId = incidentByReport.get(hypothesis.investigationReportId);
      if (!incidentId) continue;
      hypotheses.push({
        id: hypothesis.id,
        incidentId,
        statement: hypothesis.statement,
        confidence: hypothesis.confidence,
        status: hypothesis.status,
      });
      if (hypothesis.status === 'SUPPORTED' && hypothesis.statement.trim()) {
        historical.add(hypothesis.statement);
      }
    }
    return {
      relatedIncidents: similar,
      historicalResolutions: [...historical].slice(0, 10),
      similarHypotheses: hypotheses.slice(0, 10),
    };
  } catch {
    return { relatedIncidents: [], historicalResolutions: [], similarHypotheses: [] };
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}
