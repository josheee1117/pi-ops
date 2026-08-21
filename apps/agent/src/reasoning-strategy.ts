import type { Reasoner, ReasoningResult } from './reasoner.js';
import type { EvidenceRecord, IncidentRow } from './store.js';

/**
 * How a ReasoningJob chooses to obtain a ReasoningResult.
 * Pi-Ops executes and tracks the job; it does not orchestrate agents.
 */
export type ReasoningStrategyName = 'deterministic' | 'single_reasoner' | 'delegated_analysis';

export interface ReasoningStrategyInput {
  incident: IncidentRow;
  evidence: EvidenceRecord[];
  reasoner: Reasoner;
}

export const REASONING_STRATEGY_VERSION = '1';

export interface InvestigationPlan {
  id: string;
  reasoningJobId: string;
  strategy: ReasoningStrategyName;
  objectives: string[];
  requestedCapabilities: string[];
  createdAt: string;
}

export interface ReasoningStrategy {
  readonly name: ReasoningStrategyName;
  readonly version: string;
  execute(input: ReasoningStrategyInput): ReasoningResult | Promise<ReasoningResult>;
}

export interface ReasoningStrategyRegistry {
  get(name: ReasoningStrategyName): ReasoningStrategy | undefined;
}

export function strategyNameFor(reasonerType: string): ReasoningStrategyName {
  if (reasonerType === 'fake') return 'deterministic';
  if (reasonerType === 'pi') return 'single_reasoner';
  if (reasonerType === 'delegated_analysis') return 'delegated_analysis';
  throw new Error(`unknown reasoning strategy for reasoner type ${reasonerType}`);
}

export function buildInvestigationPlan(
  jobId: string,
  incident: IncidentRow,
  strategy: ReasoningStrategyName,
  createdAt = new Date().toISOString(),
): InvestigationPlan {
  return {
    id: `iplan-${jobId}`,
    reasoningJobId: jobId,
    strategy,
    objectives: [`diagnose ${incident.type}`, 'use collected evidence only'],
    requestedCapabilities: strategy === 'delegated_analysis'
      ? ['pi.runtime.delegated_analysis']
      : [],
    createdAt,
  };
}

export function createReasoningStrategyRegistry(
  strategies: ReasoningStrategy[],
): ReasoningStrategyRegistry {
  const byName = new Map(strategies.map((strategy) => [strategy.name, strategy]));
  return {
    get(name: ReasoningStrategyName): ReasoningStrategy | undefined {
      return byName.get(name);
    },
  };
}

export function createDefaultReasoningStrategies(): ReasoningStrategyRegistry {
  return createReasoningStrategyRegistry([
    createDeterministicStrategy(),
    createSingleReasonerStrategy(),
    createDelegatedAnalysisStrategy(),
  ]);
}

export function createDeterministicStrategy(): ReasoningStrategy {
  return {
    name: 'deterministic',
    version: REASONING_STRATEGY_VERSION,
    execute({ reasoner, incident, evidence }): ReasoningResult | Promise<ReasoningResult> {
      return reasoner.reason(incident, evidence);
    },
  };
}

export function createSingleReasonerStrategy(): ReasoningStrategy {
  return {
    name: 'single_reasoner',
    version: REASONING_STRATEGY_VERSION,
    execute({ reasoner, incident, evidence }): ReasoningResult | Promise<ReasoningResult> {
      return reasoner.reason(incident, evidence);
    },
  };
}

export function createDelegatedAnalysisStrategy(): ReasoningStrategy {
  return {
    name: 'delegated_analysis',
    version: REASONING_STRATEGY_VERSION,
    execute(): never {
      throw new Error('delegated_analysis is owned by Pi Runtime and is not implemented in Pi-Ops');
    },
  };
}
