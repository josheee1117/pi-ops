import type { AgentConfig } from './config.js';
import type { EvidenceOrchestrator } from './evidence-orchestrator.js';
import type { EventStore } from './store.js';
import { createPollingWorker } from './polling-worker.js';

export interface EvidenceJobWorker {
  start(): void;
  stop(): Promise<void>;
  wake(): void;
  runOnce(): Promise<void>;
}

export function createEvidenceJobWorker(
  config: AgentConfig,
  store: EventStore,
  orchestrator: EvidenceOrchestrator,
  options: { onCompleted?: (incidentId: string) => void | Promise<void> } = {},
): EvidenceJobWorker {
  async function drain(): Promise<void> {
    const jobs = store.listPendingEvidenceJobs(config.evidenceJobBatchSize);
    for (const job of jobs) {
      if (!store.markEvidenceJobRunning(job.id)) continue;
      try {
        const incident = store.getIncident(job.incidentId);
        if (!incident) throw new Error(`Incident ${job.incidentId} no longer exists`);
        const summary = await orchestrator.collectForIncident(
          incident,
          job.triggeringEvent,
          job.id,
        );
        if (summary.retryableFailures > 0) {
          const current = store.getEvidenceJob(job.id);
          const failed = (current?.attempts ?? job.attempts + 1) >= config.evidenceJobMaxAttempts;
          store.markEvidenceJobRetry(
            job.id,
            `${summary.retryableFailures} retryable evidence collection failure(s)`,
            failed,
          );
        } else {
          store.markEvidenceJobCompleted(job.id);
          if (options.onCompleted) {
            void Promise.resolve(options.onCompleted(job.incidentId)).catch((error) => {
              console.error(`[agent] investigation start after evidence failed: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const current = store.getEvidenceJob(job.id);
        const failed = (current?.attempts ?? job.attempts + 1) >= config.evidenceJobMaxAttempts;
        store.markEvidenceJobRetry(job.id, message, failed);
      }
    }
  }

  return createPollingWorker({
    name: 'evidence',
    intervalMs: config.evidenceJobPollIntervalMs,
    reset: () => store.resetRunningEvidenceJobs(),
    drain,
  });
}
