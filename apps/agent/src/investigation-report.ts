export interface InvestigationReport {
  id: string;
  sessionId: string;
  schemaVersion: number;
  hypothesis: string;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  confidence: number;
  recommendation: string;
  createdAt: string;
}

export interface InvestigationReportInput {
  schemaVersion?: number;
  hypothesis: string;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  confidence: number;
  recommendation: string;
}
