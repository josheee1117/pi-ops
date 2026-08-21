import type { IncidentContext } from './incident-context.js';
import type { MemoryEntry } from './memory-governance.js';
import type { EventStore } from './store.js';

export const MEMORY_RETRIEVAL_LIMIT = 3;

export interface MemoryRetriever {
  retrieve(context: IncidentContext): MemoryEntry[];
}

export function createMemoryRetriever(
  store: EventStore,
  options: { limit?: number } = {},
): MemoryRetriever {
  const limit = options.limit ?? MEMORY_RETRIEVAL_LIMIT;
  return {
    retrieve(context: IncidentContext): MemoryEntry[] {
      const queryTokens = contextTokens(context);
      const scored: Array<{ entry: MemoryEntry; overlap: number }> = [];
      for (const entry of store.listActiveMemoryEntries()) {
        if (entry.status !== 'ACTIVE') continue;
        const origin = originFor(store, entry);
        if (!origin) continue;
        if (origin.incidentType !== context.incident.type) continue;
        if (origin.service !== context.incident.service) continue;
        const overlap = tokenOverlap(queryTokens, memoryTokens(entry));
        if (overlap === 0) continue;
        scored.push({ entry, overlap });
      }
      scored.sort((left, right) =>
        right.overlap - left.overlap
        || right.entry.confidence - left.entry.confidence
        || left.entry.id.localeCompare(right.entry.id),
      );
      return scored.slice(0, Math.max(1, limit)).map((item) => item.entry);
    },
  };
}

function originFor(store: EventStore, entry: MemoryEntry): { incidentType: string; service: string } | undefined {
  const candidate = store.getMemoryCandidate(entry.sourceMemoryCandidateId);
  if (!candidate || candidate.status !== 'APPROVED') return undefined;
  const result = store.getReasoningResult(candidate.sourceReasoningResultId);
  if (!result) return undefined;
  const incident = store.getIncident(result.incidentId);
  if (!incident) return undefined;
  return { incidentType: candidate.incidentType, service: incident.service };
}

function contextTokens(context: IncidentContext): Set<string> {
  const parts = [context.incident.type, context.incident.service, ...context.evidence.map((item) => item.kind)];
  return tokenize(parts.join(' '));
}

function memoryTokens(entry: MemoryEntry): Set<string> {
  return tokenize(`${entry.pattern} ${entry.evidenceSummary} ${entry.conclusion}`);
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter((token) => token.length >= 2));
}

function tokenOverlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) {
    if (right.has(token)) count += 1;
  }
  return count;
}
