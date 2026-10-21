import type { AgentConfig } from './config.js';
import { isRetryableNotificationError, type Notifier } from './notifier.js';
import type { EventStore } from './store.js';
import { createPollingWorker } from './polling-worker.js';

export interface NotificationJobWorker {
  start(): void;
  stop(): Promise<void>;
  wake(): void;
  runOnce(): Promise<void>;
}

export function createNotificationJobWorker(
  config: AgentConfig,
  store: EventStore,
  notifier?: Notifier,
): NotificationJobWorker {
  const pollIntervalMs = config.notificationJobPollIntervalMs ?? 1000;
  const maxAttempts = config.notificationJobMaxAttempts ?? 5;
  const batchSize = config.notificationJobBatchSize ?? 20;

  async function drain(): Promise<void> {
    store.reconcileNotifications();
    if (!notifier) return;
    const jobs = store.listPendingNotificationJobs(batchSize);
    for (const job of jobs) {
      if (!store.markNotificationJobRunning(job.id)) continue;
      try {
        await notifier.send(store.getNotificationJob(job.id)?.payload ?? job.payload);
        if (!store.markNotificationJobDelivered(job.id)) {
          console.warn('[agent] notification transition skipped because state changed');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const current = store.getNotificationJob(job.id);
        const attempts = current?.attempts ?? job.attempts + 1;
        const retryable = isRetryableNotificationError(error);
        const failed = !retryable || attempts >= maxAttempts;
        if (!store.markNotificationJobRetry(job.id, message, failed)) {
          console.warn('[agent] notification transition skipped because state changed');
        }
      }
    }
  }

  return createPollingWorker({
    name: 'notification',
    intervalMs: pollIntervalMs,
    reset: () => notifier ? store.resetRunningNotificationJobs() : 0,
    drain,
  });
}
