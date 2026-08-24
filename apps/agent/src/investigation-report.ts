export interface InvestigationReport {
  id: string;
  sessionId: string;
  hypothesis: string;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  confidence: number;
  recommendation: string;
  createdAt: string;
}

export interface InvestigationReportInput {
  hypothesis: string;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  confidence: number;
  recommendation: string;
}
