import type { IncidentContext } from './incident-context.js';
import type { MemoryEntry } from './memory-governance.js';
import {
  deriveMemoryQuality,
  lastUsedAt,
  successRatio,
  withMemoryQuality,
  type MemoryIntelligence,
} from './memory-quality.js';
import type { EventStore } from './store.js';

export const MEMORY_RETRIEVAL_LIMIT = 3;

export interface MemoryRetrieval {
  memories: MemoryIntelligence[];
  conflictingMemories: MemoryIntelligence[];
}

export interface MemoryRetriever {
  retrieve(context: IncidentContext): MemoryRetrieval;
}

export function createMemoryRetriever(
  store: EventStore,
  options: { limit?: number } = {},
): MemoryRetriever {
  const limit = options.limit ?? MEMORY_RETRIEVAL_LIMIT;
  return {
    retrieve(context: IncidentContext): MemoryRetrieval {
      const queryTokens = contextTokens(context);
      const matched: RankedMemory[] = [];
      for (const entry of store.listActiveMemoryEntries()) {
        if (entry.status !== 'ACTIVE') continue;
        const origin = originFor(store, entry);
        if (!origin) continue;
        if (origin.incidentType !== context.incident.type) continue;
        if (origin.service !== context.incident.service) continue;
        const overlap = tokenOverlap(queryTokens, memoryTokens(entry));
        if (overlap === 0) continue;
        const feedbacks = store.listMemoryFeedbacks(entry.id);
        const quality = deriveMemoryQuality(feedbacks, entry.confidence);
        matched.push({
          memory: withMemoryQuality(entry, quality),
          overlap,
          lastUsedAt: lastUsedAt(feedbacks),
        });
      }
      matched.sort(compareRanked);
      const conflictingMemories = detectConflictingMemories(matched.map((item) => item.memory));
      return {
        memories: matched.slice(0, Math.max(1, limit)).map((item) => item.memory),
        conflictingMemories,
      };
    },
  };
}

export function detectConflictingMemories(memories: MemoryIntelligence[]): MemoryIntelligence[] {
  const conclusions = new Set(memories.map((item) => normalizeConclusion(item.conclusion)));
  if (conclusions.size <= 1) return [];
  return [...memories];
}

interface RankedMemory {
  memory: MemoryIntelligence;
  overlap: number;
  lastUsedAt?: string;
}

function compareRanked(left: RankedMemory, right: RankedMemory): number {
  return right.memory.effectivenessScore - left.memory.effectivenessScore
    || successRatio(right.memory) - successRatio(left.memory)
    || compareRecent(right.lastUsedAt, left.lastUsedAt)
    || right.memory.usageCount - left.memory.usageCount
    || right.overlap - left.overlap
    || left.memory.id.localeCompare(right.memory.id);
}

function compareRecent(right?: string, left?: string): number {
  if (right && left) return right > left ? 1 : right < left ? -1 : 0;
  if (right) return 1;
  if (left) return -1;
  return 0;
}

function normalizeConclusion(conclusion: string): string {
  return conclusion.trim().toLowerCase().replace(/\s+/g, ' ');
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
