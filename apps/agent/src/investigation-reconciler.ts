import type { createInvestigationLoopService } from './investigation-loop.js';
import type { EventStore } from './store.js';
import type { InvestigationSession } from './investigation-session.js';

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
  staleTimeoutMs: number;
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
    options.loop.reconcile({ timeoutMs: options.staleTimeoutMs });
    for (const incident of options.store.listIncidents()) {
      const job = options.store.getEvidenceJob(`job-${incident.id}`);
      if (!job || job.state !== 'COMPLETED') continue;
      const generation = job.generation;
      const matching = options.store.listAllInvestigationSessions().filter((session) => (
        session.incidentId === incident.id
        && session.evidenceGeneration === generation
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
      if (failed.length > 0 && !retryReady(failed, now(), options.backoffMs)) continue;
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

function retryReady(failed: InvestigationSession[], nowIso: string, backoffMs: number): boolean {
  const latest = [...failed].sort((left, right) => (
    Date.parse(right.completedAt ?? right.createdAt) - Date.parse(left.completedAt ?? left.createdAt)
  ))[0]!;
  const elapsed = Date.parse(nowIso) - Date.parse(latest.completedAt ?? latest.createdAt);
  return Number.isFinite(elapsed) && elapsed >= backoffMs * failed.length;
}
