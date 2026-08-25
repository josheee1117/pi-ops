import type { EvidenceRecord, EventStore } from './store.js';

export type EvidenceCategory = 'primary_signal' | 'supporting_signal' | 'weak_signal';

export interface EvidenceProfile {
  evidenceId: string;
  category: EvidenceCategory;
  reliabilityScore: number;
  diagnosticWeight: number;
}

export interface EvidenceRelevanceScore {
  evidenceId: string;
  hypothesisId: string;
  relationship: 'supporting' | 'contradicting' | 'none';
  reliabilityScore: number;
  diagnosticWeight: number;
  relevanceScore: number;
}

const PRIMARY_KINDS = new Set(['docker.inspect', 'http.probe', 'docker.stats']);
const SUPPORTING_KINDS = new Set(['host.memory', 'host.load', 'host.disk']);

export function classifyEvidence(evidence: EvidenceRecord): EvidenceProfile {
  const failed = evidence.status === 'failed';
  let category: EvidenceCategory = 'weak_signal';
  if (!failed && PRIMARY_KINDS.has(evidence.kind)) category = 'primary_signal';
  else if (!failed && SUPPORTING_KINDS.has(evidence.kind)) category = 'supporting_signal';
  else category = 'weak_signal';

  const reliabilityScore = failed
    ? 0.2
    : category === 'primary_signal' ? 0.95
      : category === 'supporting_signal' ? 0.75
        : 0.4;
  const diagnosticWeight = failed
    ? 0.2
    : category === 'primary_signal' ? 1
      : category === 'supporting_signal' ? 0.6
        : 0.25;
  return {
    evidenceId: evidence.id,
    category,
    reliabilityScore,
    diagnosticWeight,
  };
}

export function evidenceWeight(profile: EvidenceProfile): number {
  return profile.reliabilityScore * profile.diagnosticWeight;
}

export function createEvidenceIntelligenceService(store: EventStore) {
  return {
    profile(evidenceId: string): EvidenceProfile {
      const evidence = requireEvidence(store, evidenceId);
      const existing = store.getEvidenceProfile(evidenceId);
      if (existing) return existing;
      const profile = classifyEvidence(evidence);
      store.insertEvidenceProfile(profile);
      return profile;
    },

    relevance(hypothesisId: string, evidenceId: string): EvidenceRelevanceScore {
      const hypothesis = store.getInvestigationHypothesis(hypothesisId);
      if (!hypothesis) throw new Error(`InvestigationHypothesis ${hypothesisId} does not exist`);
      const profile = this.profile(evidenceId);
      const supporting = hypothesis.supportingEvidenceIds.includes(evidenceId);
      const contradicting = hypothesis.contradictingEvidenceIds.includes(evidenceId);
      const relationship = supporting ? 'supporting' : contradicting ? 'contradicting' : 'none';
      const relevanceScore = relationship === 'none' ? 0 : evidenceWeight(profile);
      return {
        evidenceId,
        hypothesisId,
        relationship,
        reliabilityScore: profile.reliabilityScore,
        diagnosticWeight: profile.diagnosticWeight,
        relevanceScore,
      };
    },
  };
}

function requireEvidence(store: EventStore, evidenceId: string): EvidenceRecord {
  const evidence = store.getEvidence(evidenceId);
  if (!evidence) throw new Error(`Evidence ${evidenceId} does not exist`);
  return evidence;
}
