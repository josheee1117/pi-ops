import { randomUUID } from 'node:crypto';
import type { EventStore } from './store.js';

export type MemoryFeedbackOutcome = 'SUCCESS' | 'FAILED' | 'UNKNOWN';

export interface MemoryFeedback {
  id: string;
  memoryEntryId: string;
  incidentId: string;
  reasoningResultId?: string;
  outcome: MemoryFeedbackOutcome;
  effectivenessScore: number;
  createdAt: string;
}

export interface RecordMemoryFeedbackInput {
  memoryEntryId: string;
  incidentId: string;
  reasoningResultId?: string;
  outcome: MemoryFeedbackOutcome;
  effectivenessScore: number;
}

const OUTCOMES = new Set<MemoryFeedbackOutcome>(['SUCCESS', 'FAILED', 'UNKNOWN']);

export function createMemoryFeedbackService(
  store: EventStore,
  options: { now?: () => string } = {},
) {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    record(input: RecordMemoryFeedbackInput): MemoryFeedback {
      const memoryEntryId = input.memoryEntryId.trim();
      if (!store.getMemoryEntry(memoryEntryId)) {
        throw new Error(`MemoryEntry ${memoryEntryId} does not exist`);
      }
      const incidentId = input.incidentId.trim();
      if (!incidentId || !store.getIncident(incidentId)) {
        throw new Error(`Incident ${incidentId} does not exist`);
      }
      if (!OUTCOMES.has(input.outcome)) {
        throw new Error('feedback outcome must be SUCCESS, FAILED, or UNKNOWN');
      }
      if (
        typeof input.effectivenessScore !== 'number'
        || !Number.isFinite(input.effectivenessScore)
        || input.effectivenessScore < 0
        || input.effectivenessScore > 1
      ) {
        throw new Error('effectivenessScore must be a number in [0, 1]');
      }

      const reasoningResultId = input.reasoningResultId?.trim();
      if (reasoningResultId) {
        const result = store.getReasoningResult(reasoningResultId);
        if (!result) {
          throw new Error(`ReasoningResult ${reasoningResultId} does not exist`);
        }
        if (result.incidentId !== incidentId) {
          throw new Error('reasoningResultId must belong to incidentId');
        }
      }

      const feedback: MemoryFeedback = {
        id: `mfb-${randomUUID()}`,
        memoryEntryId,
        incidentId,
        ...(reasoningResultId ? { reasoningResultId } : {}),
        outcome: input.outcome,
        effectivenessScore: input.effectivenessScore,
        createdAt: now(),
      };
      store.insertMemoryFeedback(feedback);
      return feedback;
    },
  };
}
