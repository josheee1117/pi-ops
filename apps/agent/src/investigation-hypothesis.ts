import type { InvestigationReport } from './investigation-report.js';
import type { EventStore } from './store.js';

export type InvestigationHypothesisStatus = 'PROPOSED' | 'SUPPORTED' | 'REJECTED';

export interface InvestigationHypothesis {
  id: string;
  investigationReportId: string;
  statement: string;
  confidence: number;
  status: InvestigationHypothesisStatus;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  createdAt: string;
}

export interface ProposeHypothesisInput {
  investigationReportId: string;
  statement: string;
  confidence: number;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}

export function createInvestigationHypothesisService(
  store: EventStore,
  options: { now?: () => string } = {},
) {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    propose(input: ProposeHypothesisInput): InvestigationHypothesis {
      const report = requireReport(store, input.investigationReportId);
      const statement = input.statement.trim();
      if (!statement) throw new Error('hypothesis statement is required');
      if (
        typeof input.confidence !== 'number'
        || !Number.isFinite(input.confidence)
        || input.confidence < 0
        || input.confidence > 1
      ) {
        throw new Error('confidence must be a number in [0, 1]');
      }
      validateEvidenceOwnership(store, report, [
        ...input.supportingEvidenceIds,
        ...input.contradictingEvidenceIds,
      ]);
      const hypothesis: InvestigationHypothesis = {
        id: `ihyp-${report.id}-${store.listInvestigationHypotheses(report.id).length}`,
        investigationReportId: report.id,
        statement,
        confidence: input.confidence,
        status: 'PROPOSED',
        supportingEvidenceIds: [...input.supportingEvidenceIds],
        contradictingEvidenceIds: [...input.contradictingEvidenceIds],
        createdAt: now(),
      };
      store.insertInvestigationHypothesis(hypothesis);
      return hypothesis;
    },

    proposeFromReport(report: InvestigationReport): InvestigationHypothesis {
      const existing = store.listInvestigationHypotheses(report.id)[0];
      if (existing) return existing;
      return this.propose({
        investigationReportId: report.id,
        statement: report.hypothesis,
        confidence: report.confidence,
        supportingEvidenceIds: report.supportingEvidenceIds,
        contradictingEvidenceIds: report.contradictingEvidenceIds,
      });
    },

    support(id: string): InvestigationHypothesis {
      return setStatus(store, id, 'SUPPORTED');
    },

    reject(id: string): InvestigationHypothesis {
      return setStatus(store, id, 'REJECTED');
    },
  };
}

function setStatus(
  store: EventStore,
  id: string,
  status: InvestigationHypothesisStatus,
): InvestigationHypothesis {
  const hypothesis = store.getInvestigationHypothesis(id);
  if (!hypothesis) throw new Error(`InvestigationHypothesis ${id} does not exist`);
  if (hypothesis.status === status) return hypothesis;
  store.updateInvestigationHypothesisStatus(id, status);
  return store.getInvestigationHypothesis(id)!;
}

function requireReport(store: EventStore, reportId: string): InvestigationReport {
  const report = store.getInvestigationReport(reportId);
  if (!report) throw new Error(`InvestigationReport ${reportId} does not exist`);
  return report;
}

export function validateEvidenceOwnership(
  store: EventStore,
  report: InvestigationReport,
  evidenceIds: string[],
): void {
  const session = store.getInvestigationSession(report.sessionId);
  if (!session) throw new Error(`InvestigationSession ${report.sessionId} does not exist`);
  const known = new Set(store.listEvidence(session.incidentId).map((item) => item.id));
  for (const evidenceId of new Set(evidenceIds)) {
    if (!known.has(evidenceId)) {
      throw new Error(`evidence id ${evidenceId} does not belong to the Incident`);
    }
  }
}
