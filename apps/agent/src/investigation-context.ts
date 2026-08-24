import { buildIncidentContext, type IncidentContext, type IncidentContextBounds } from './incident-context.js';
import type { MemoryIntelligence } from './memory-quality.js';
import { createMemoryRetriever, type MemoryRetriever } from './memory-retriever.js';
import type { EvidenceRecord, EventStore, IncidentRow } from './store.js';

export interface InvestigationContext {
  incident: IncidentContext['incident'];
  evidence: readonly IncidentContext['evidence'][number][];
  relatedMemories: readonly MemoryIntelligence[];
  previousResolutions: readonly string[];
  conflictingMemories: readonly MemoryIntelligence[];
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
  return deepFreeze({
    incident: incidentContext.incident,
    evidence: incidentContext.evidence,
    relatedMemories: retrieval.memories,
    previousResolutions,
    conflictingMemories: retrieval.conflictingMemories,
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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}
