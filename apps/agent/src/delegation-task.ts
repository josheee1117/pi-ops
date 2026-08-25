import type { InvestigationPlan } from './reasoning-strategy.js';

export type DelegationTaskStatus = 'PENDING' | 'SUBMITTED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface DelegationTask {
  id: string;
  investigationPlanId: string;
  status: DelegationTaskStatus;
  submittedAt?: string;
  completedAt?: string;
  runtimeTaskId?: string;
  runtimeRequestId?: string;
  lastError?: string;
}

export function buildDelegationTask(plan: InvestigationPlan): DelegationTask {
  return {
    id: `dtask-${plan.id}`,
    investigationPlanId: plan.id,
    status: 'PENDING',
  };
}
