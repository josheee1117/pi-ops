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

export interface ReasoningStrategy {
  readonly name: ReasoningStrategyName;
  execute(input: ReasoningStrategyInput): ReasoningResult | Promise<ReasoningResult>;
}

export interface ReasoningStrategyRegistry {
  get(name: ReasoningStrategyName): ReasoningStrategy | undefined;
}

export function strategyNameFor(reasonerType: string): ReasoningStrategyName {
  if (reasonerType === 'fake') return 'deterministic';
  if (reasonerType === 'delegated_analysis') return 'delegated_analysis';
  return 'single_reasoner';
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
    execute({ reasoner, incident, evidence }): ReasoningResult | Promise<ReasoningResult> {
      return reasoner.reason(incident, evidence);
    },
  };
}

export function createSingleReasonerStrategy(): ReasoningStrategy {
  return {
    name: 'single_reasoner',
    execute({ reasoner, incident, evidence }): ReasoningResult | Promise<ReasoningResult> {
      return reasoner.reason(incident, evidence);
    },
  };
}

export function createDelegatedAnalysisStrategy(): ReasoningStrategy {
  return {
    name: 'delegated_analysis',
    execute(): never {
      throw new Error('delegated_analysis is owned by Pi Runtime and is not implemented in Pi-Ops');
    },
  };
}
