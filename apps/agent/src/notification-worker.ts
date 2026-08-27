import type { AgentConfig } from './config.js';
import { isRetryableNotificationError, type Notifier } from './notifier.js';
import type { EventStore } from './store.js';

export interface NotificationJobWorker {
  start(): void;
  stop(): Promise<void>;
  wake(): void;
  runOnce(): Promise<void>;
}

export function createNotificationJobWorker(
  config: AgentConfig,
  store: EventStore,
  notifier: Notifier,
): NotificationJobWorker {
  const pollIntervalMs = config.notificationJobPollIntervalMs ?? 1000;
  const maxAttempts = config.notificationJobMaxAttempts ?? 5;
  const batchSize = config.notificationJobBatchSize ?? 20;
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeRun: Promise<void> | undefined;
  let wakeQueued = false;

  async function drain(): Promise<void> {
    const jobs = store.listPendingNotificationJobs(batchSize);
    for (const job of jobs) {
      if (!store.markNotificationJobRunning(job.id)) continue;
      try {
        await notifier.send(job.payload);
        store.markNotificationJobDelivered(job.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const current = store.getNotificationJob(job.id);
        const attempts = current?.attempts ?? job.attempts + 1;
        const retryable = isRetryableNotificationError(error);
        const failed = !retryable || attempts >= maxAttempts;
        store.markNotificationJobRetry(job.id, message, failed);
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
        console.error(`[agent] notification worker error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  return {
    start(): void {
      const reset = store.resetRunningNotificationJobs();
      if (reset > 0) {
        console.log(`[agent] reset ${reset} interrupted notification job(s)`);
      }
      wake();
      timer = setInterval(wake, pollIntervalMs);
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
