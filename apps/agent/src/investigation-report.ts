import type { InvestigationDiagnosis } from '@pi-ops/protocol';

export interface InvestigationReport {
  id: string;
  sessionId: string;
  schemaVersion: number;
  hypothesis: string;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  confidence: number;
  recommendation: string;
  diagnosis?: InvestigationDiagnosis;
  createdAt: string;
}

export interface InvestigationReportInput {
  schemaVersion?: number;
  hypothesis: string;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  confidence: number;
  recommendation: string;
  diagnosis?: InvestigationDiagnosis;
}
