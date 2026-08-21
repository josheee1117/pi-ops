import type { MemoryCandidate } from './reasoning-evaluation.js';
import type { EventStore } from './store.js';

export type MemoryEntryStatus = 'ACTIVE' | 'DISABLED';

export interface MemoryEntry {
  id: string;
  sourceMemoryCandidateId: string;
  sourceEvaluationId: string;
  pattern: string;
  evidenceSummary: string;
  conclusion: string;
  resolution: string;
  confidence: number;
  status: MemoryEntryStatus;
  createdAt: string;
  approvedAt: string;
}

export function createMemoryGovernanceService(
  store: EventStore,
  options: { now?: () => string } = {},
) {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    approve(candidateId: string): MemoryEntry {
      const candidate = requireCandidate(store, candidateId);
      if (candidate.status === 'REJECTED') {
        throw new Error(`MemoryCandidate ${candidateId} is rejected`);
      }
      const existing = store.getMemoryEntryByCandidateId(candidate.id);
      if (existing) return existing;
      store.updateMemoryCandidateStatus(candidate.id, 'APPROVED');
      const approvedAt = now();
      const entry: MemoryEntry = {
        id: `mentry-${candidate.id}`,
        sourceMemoryCandidateId: candidate.id,
        sourceEvaluationId: candidate.sourceEvaluationId,
        pattern: candidate.pattern,
        evidenceSummary: candidate.evidenceSummary,
        conclusion: candidate.conclusion,
        resolution: candidate.resolution,
        confidence: candidate.confidence,
        status: 'ACTIVE',
        createdAt: candidate.createdAt,
        approvedAt,
      };
      store.insertMemoryEntry(entry);
      return entry;
    },

    reject(candidateId: string): MemoryCandidate {
      const candidate = requireCandidate(store, candidateId);
      if (store.getMemoryEntryByCandidateId(candidate.id)) {
        throw new Error(`MemoryCandidate ${candidateId} already has a MemoryEntry`);
      }
      store.updateMemoryCandidateStatus(candidate.id, 'REJECTED');
      return store.getMemoryCandidate(candidate.id)!;
    },

    disable(entryId: string): MemoryEntry {
      const entry = store.getMemoryEntry(entryId);
      if (!entry) throw new Error(`MemoryEntry ${entryId} does not exist`);
      store.updateMemoryEntryStatus(entry.id, 'DISABLED');
      return store.getMemoryEntry(entry.id)!;
    },
  };
}

function requireCandidate(store: EventStore, candidateId: string): MemoryCandidate {
  const candidate = store.getMemoryCandidate(candidateId);
  if (!candidate) throw new Error(`MemoryCandidate ${candidateId} does not exist`);
  return candidate;
}
