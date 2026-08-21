import type { EventStore } from './store.js';

export function reasoningJobIdFor(incidentId: string): string {
  return `rj-${incidentId}`;
}

export function createReasoningService(store: EventStore) {
  return {
    enqueue(
      incidentId: string,
      now = new Date().toISOString(),
      reasonerType = 'fake',
      reasonerVersion = '1',
    ): void {
      store.createReasoningJob({
        id: reasoningJobIdFor(incidentId),
        incidentId,
        reasonerType,
        reasonerVersion,
        createdAt: now,
      });
    },
  };
}
