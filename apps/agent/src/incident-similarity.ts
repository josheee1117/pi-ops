import { createInvestigationRelationService } from './investigation-relation.js';
import type { IncidentRow, EventStore } from './store.js';

export interface SimilarIncident {
  incident: IncidentRow;
  score: number;
  sharedDimensions: string[];
}

/**
 * No embeddings yet. Similarity is structural:
 * same service + same type + matching node / overlapping fingerprint dimensions.
 */
export function fingerprintBase(fingerprint: string): string[] {
  try {
    const parsed = JSON.parse(fingerprint) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.slice(0, 4).map((item) => String(item));
    }
  } catch {
    // fall through
  }
  return [];
}

export function fingerprintDimensions(fingerprint: string): string[] {
  try {
    const parsed = JSON.parse(fingerprint) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.slice(4).map((item) => String(item)).filter((item) => item.length > 0);
    }
  } catch {
    // fall through
  }
  return [];
}

export function incidentSimilarityScore(
  left: IncidentRow,
  right: IncidentRow,
): { score: number; sharedDimensions: string[] } {
  if (left.id === right.id) return { score: 0, sharedDimensions: [] };
  if (left.service !== right.service || left.type !== right.type) {
    return { score: 0, sharedDimensions: [] };
  }
  const leftBase = fingerprintBase(left.fingerprint);
  const rightBase = fingerprintBase(right.fingerprint);
  const nodeMatch = leftBase[1] !== undefined && leftBase[1] === rightBase[1];
  const sharedDimensions = fingerprintDimensions(left.fingerprint).filter((dim) =>
    fingerprintDimensions(right.fingerprint).includes(dim),
  );
  let score = 0.4; // same service + type
  if (nodeMatch) score += 0.3;
  if (sharedDimensions.length > 0) score += 0.3;
  return { score, sharedDimensions };
}

export function createIncidentSimilarityService(
  store: EventStore,
  options: { limit?: number } = {},
) {
  const limit = options.limit ?? 5;
  const relations = createInvestigationRelationService(store);

  return {
    findSimilar(incident: IncidentRow): SimilarIncident[] {
      const scored: Array<{ incident: IncidentRow; score: number; sharedDimensions: string[] }> = [];
      for (const candidate of store.listIncidents()) {
        const match = incidentSimilarityScore(incident, candidate);
        if (match.score > 0) scored.push({ incident: candidate, ...match });
      }
      scored.sort(
        (left, right) => right.score - left.score
          || left.incident.id.localeCompare(right.incident.id),
      );
      const similar = scored.slice(0, limit).map((item) => ({
        incident: item.incident,
        score: item.score,
        sharedDimensions: item.sharedDimensions,
      }));
      for (const item of similar) {
        relations.create({
          fromType: 'INCIDENT',
          fromId: incident.id,
          toType: 'INCIDENT',
          toId: item.incident.id,
          relationType: 'SIMILAR_TO',
        });
      }
      return similar;
    },
  };
}
