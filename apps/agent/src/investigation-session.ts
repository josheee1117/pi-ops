import { createHash } from 'node:crypto';
import type { InvestigationContext } from './investigation-context.js';

export type InvestigationSessionStatus =
  | 'CREATED'
  | 'SUBMITTED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED';

export interface InvestigationSession {
  id: string;
  incidentId: string;
  contextSnapshotHash: string;
  delegationTaskId: string;
  status: InvestigationSessionStatus;
  createdAt: string;
  completedAt?: string;
}

export function hashInvestigationContext(context: InvestigationContext): string {
  return createHash('sha256').update(JSON.stringify(context)).digest('hex');
}
