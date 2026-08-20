import type { AgentConfig } from './config.js';
import type { EvidenceOrchestrator } from './evidence-orchestrator.js';
import type { EventStore } from './store.js';

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
): EvidenceJobWorker {
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeRun: Promise<void> | undefined;
  let wakeQueued = false;

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
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const current = store.getEvidenceJob(job.id);
        const failed = (current?.attempts ?? job.attempts + 1) >= config.evidenceJobMaxAttempts;
        store.markEvidenceJobRetry(job.id, message, failed);
      }
    }
  }

  async function runOnce(): Promise<void> {
    if (activeRun) return activeRun;
    activeRun = drain().finally(() => {
      activeRun = undefined;
    });
    return activeRun;
  }

  function wake(): void {
    if (wakeQueued) return;
    wakeQueued = true;
    queueMicrotask(() => {
      wakeQueued = false;
      void runOnce().catch((err) => {
        console.error(`[agent] evidence worker error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  return {
    start(): void {
      const reset = store.resetRunningEvidenceJobs();
      if (reset > 0) {
        console.log(`[agent] reset ${reset} interrupted evidence job(s)`);
      }
      wake();
      timer = setInterval(wake, config.evidenceJobPollIntervalMs);
    },

    async stop(): Promise<void> {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (activeRun) await activeRun;
    },

    wake,
    runOnce,
  };
}
