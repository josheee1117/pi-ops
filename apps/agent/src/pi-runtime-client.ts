import type { InvestigationContext } from './investigation-context.js';
import type { InvestigationReportInput } from './investigation-report.js';
import type { InvestigationSession } from './investigation-session.js';

/** Submission acknowledgement from the external Pi Runtime. */
export interface PiRuntimeSubmitAck {
  runtimeTaskId?: string;
}

export interface InvestigationReportCallback {
  schemaVersion: number;
  runtimeRequestId: string;
  runtimeTaskId: string;
  sessionId: string;
  report: InvestigationReportInput;
}

export interface PiRuntimeClient {
  submitInvestigation(
    session: InvestigationSession,
    context: InvestigationContext,
  ): Promise<PiRuntimeSubmitAck | void>;
}

export function createNoopPiRuntimeClient(): PiRuntimeClient {
  return {
    async submitInvestigation(
      session: InvestigationSession,
      _context: InvestigationContext,
    ): Promise<PiRuntimeSubmitAck | void> {
      return { runtimeTaskId: `rt-${session.runtimeRequestId}` };
    },
  };
}
