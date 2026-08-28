import { buildInvestigationContext } from './investigation-context.js';
import { hashInvestigationContext } from './investigation-session.js';
import type { createInvestigationLoopService } from './investigation-loop.js';
import type { EventStore } from './store.js';

export interface InvestigationReconciler {
  reconcile(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createInvestigationReconciler(options: {
  store: EventStore;
  loop: ReturnType<typeof createInvestigationLoopService>;
  enabled: boolean;
  maxAttempts: number;
  backoffMs: number;
  pollIntervalMs: number;
  now?: () => string;
}): InvestigationReconciler {
  const now = options.now ?? (() => new Date().toISOString());
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;

  async function reconcile(): Promise<void> {
    if (!options.enabled) return;
    if (active) return active;
    active = run().finally(() => {
      active = undefined;
    });
    return active;
  }

  async function run(): Promise<void> {
    for (const incident of options.store.listIncidents()) {
      const job = options.store.getEvidenceJob(`job-${incident.id}`);
      if (!job || job.state !== 'COMPLETED') continue;
      const context = buildInvestigationContext(incident, options.store.listEvidence(incident.id), options.store);
      const hash = hashInvestigationContext(context);
      const matching = options.store.listAllInvestigationSessions().filter((session) => (
        session.incidentId === incident.id
        && session.contextSnapshotHash === hash
      ));
      if (matching.some((session) => session.status === 'COMPLETED')) continue;
      const activeSession = matching.find((session) => (
        session.status === 'CREATED' || session.status === 'SUBMITTED' || session.status === 'RUNNING'
      ));
      if (activeSession) {
        if (activeSession.status === 'CREATED') {
          await options.loop.submit(activeSession.id);
        }
        continue;
      }
      const failed = matching.filter((session) => session.status === 'FAILED');
      if (failed.length >= options.maxAttempts) continue;
      if (failed.length > 0) {
        const latest = [...failed].sort((left, right) => (
          Date.parse(right.completedAt ?? right.createdAt) - Date.parse(left.completedAt ?? left.createdAt)
        ))[0]!;
        const elapsed = Date.parse(now()) - Date.parse(latest.completedAt ?? latest.createdAt);
        if (!Number.isFinite(elapsed) || elapsed < options.backoffMs * failed.length) continue;
      }
      const { session } = options.loop.start(incident.id);
      if (session.status === 'CREATED') {
        await options.loop.submit(session.id);
      }
    }
  }

  return {
    reconcile,
    start(): void {
      void reconcile();
      timer = setInterval(() => {
        void reconcile();
      }, options.pollIntervalMs);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
