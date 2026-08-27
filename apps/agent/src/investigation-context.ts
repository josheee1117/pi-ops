import {
  buildIncidentContext,
  MODEL_SAFE_MAX_LOG_LINES,
  type IncidentContext,
  type IncidentContextBounds,
} from './incident-context.js';
import {
  createKnowledgeRetriever,
  EMPTY_OPERATIONAL_KNOWLEDGE_CONTEXT,
  type OperationalKnowledgeContext,
} from './investigation-knowledge.js';
import type { MemoryIntelligence } from './memory-quality.js';
import { createMemoryRetriever, type MemoryRetriever } from './memory-retriever.js';
import type { EvidenceRecord, EventStore, IncidentRow } from './store.js';

export const INVESTIGATION_SCHEMA_VERSION = 1;

export type HistoricalKnowledgeStatus = 'available' | 'unavailable';

export interface InvestigationContext {
  schemaVersion: number;
  incident: IncidentContext['incident'];
  evidence: readonly IncidentContext['evidence'][number][];
  historicalKnowledge: OperationalKnowledgeContext;
  historicalKnowledgeStatus: HistoricalKnowledgeStatus;
  conflictingMemories: readonly MemoryIntelligence[];
}

const DEFAULT_BOUNDS: IncidentContextBounds = {
  maxEvidenceItems: 8,
  maxContextBytes: 8192,
  maxLogLines: MODEL_SAFE_MAX_LOG_LINES,
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
  let conflictingMemories: MemoryIntelligence[] = [];
  try {
    conflictingMemories = (options.retriever ?? createMemoryRetriever(store))
      .retrieve(incidentContext)
      .conflictingMemories;
  } catch {
    conflictingMemories = [];
  }
  const knowledge = retrieveKnowledge(incidentContext, store);
  return deepFreeze({
    schemaVersion: INVESTIGATION_SCHEMA_VERSION,
    incident: incidentContext.incident,
    evidence: incidentContext.evidence,
    historicalKnowledge: knowledge.context,
    historicalKnowledgeStatus: knowledge.status,
    conflictingMemories,
  });
}

function retrieveKnowledge(
  context: IncidentContext,
  store: EventStore,
): { context: OperationalKnowledgeContext; status: HistoricalKnowledgeStatus } {
  try {
    return {
      context: createKnowledgeRetriever(store).retrieve(context),
      status: 'available',
    };
  } catch {
    return {
      context: EMPTY_OPERATIONAL_KNOWLEDGE_CONTEXT,
      status: 'unavailable',
    };
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
