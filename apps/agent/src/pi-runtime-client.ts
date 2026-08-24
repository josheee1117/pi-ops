import type { InvestigationContext } from './investigation-context.js';
import type { InvestigationSession } from './investigation-session.js';
import type { InvestigationPlan } from './reasoning-strategy.js';

export interface DelegatedReasoningResult {
  investigationPlanId: string;
  reasoningSummary: string;
  confidence: number;
  evidenceIds: string[];
  memoryIds?: string[];
}

/**
 * Replaceable contract for a future Pi Runtime.
 * Pi-Ops must not implement agents, tools, or HTTP here.
 */
export interface PiRuntimeSubmitAck {
  runtimeTaskId?: string;
}

export interface PiRuntimeClient {
  submit(plan: InvestigationPlan): Promise<PiRuntimeSubmitAck | void>;
  poll(planId: string): Promise<DelegatedReasoningResult | undefined>;
  submitInvestigation(
    session: InvestigationSession,
    context: InvestigationContext,
  ): Promise<PiRuntimeSubmitAck | void>;
}

export function createNoopPiRuntimeClient(): PiRuntimeClient {
  const submitted = new Map<string, InvestigationPlan>();
  return {
    async submit(plan: InvestigationPlan): Promise<PiRuntimeSubmitAck | void> {
      submitted.set(plan.id, plan);
    },
    async poll(_planId: string): Promise<DelegatedReasoningResult | undefined> {
      return undefined;
    },
    async submitInvestigation(
      _session: InvestigationSession,
      _context: InvestigationContext,
    ): Promise<PiRuntimeSubmitAck | void> {
      return undefined;
    },
  };
}
