import { createHash } from 'node:crypto';
import type { AgentConfig } from './config.js';
import { buildIncidentContext } from './incident-context.js';
import type { MemoryRetriever } from './memory-retriever.js';
import { createNoopPiRuntimeClient, type PiRuntimeClient } from './pi-runtime-client.js';
import type { ReasonerRegistry, ReasoningResult } from './reasoner.js';
import {
  buildInvestigationPlan,
  createDefaultReasoningStrategies,
  strategyNameFor,
  type ReasoningStrategyRegistry,
} from './reasoning-strategy.js';
import type { EvidenceRecord, EventStore, IncidentRow, ReasoningJob } from './store.js';

export interface ReasoningWorkerMetrics {
  created: number;
  completed: number;
  failed: number;
  lastDurationMs: number | null;
}

export interface ReasoningJobWorker {
  start(): void;
  stop(): Promise<void>;
  wake(): void;
  runOnce(): Promise<void>;
  metrics(): ReasoningWorkerMetrics;
}

export function hashEvidenceSnapshot(evidence: EvidenceRecord[]): string {
  const snapshot = [...evidence]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      collectedAt: item.collectedAt,
      status: item.status,
      data: item.data ?? null,
      error: item.error ?? null,
    }));
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export function createReasoningJobWorker(
  config: AgentConfig,
  store: EventStore,
  registry: ReasonerRegistry,
  strategies: ReasoningStrategyRegistry = createDefaultReasoningStrategies(),
  retriever?: MemoryRetriever,
  runtime: PiRuntimeClient = createNoopPiRuntimeClient(),
): ReasoningJobWorker {
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeRun: Promise<void> | undefined;
  let wakeQueued = false;
  const stats: ReasoningWorkerMetrics = {
    created: 0,
    completed: 0,
    failed: 0,
    lastDurationMs: null,
  };

  async function executeJob(job: ReasoningJob): Promise<void> {
    const started = Date.now();
    stats.created += 1;
    try {
      const incident = store.getIncident(job.incidentId);
      if (!incident) throw new Error(`Incident ${job.incidentId} no longer exists`);
      const strategyName = strategyNameFor(job.reasonerType);
      const strategy = strategies.get(strategyName);
      if (!strategy) throw new Error(`unknown reasoning strategy ${strategyName}`);
      const evidence = store.listEvidence(job.incidentId);
      const existing = store.getReasoningResultByJobId(job.id);
      if (existing) {
        store.markReasoningJobCompleted(job.id);
        stats.completed += 1;
        stats.lastDurationMs = Date.now() - started;
        return;
      }
      if (strategy.name === 'delegated_analysis') {
        const plan = buildInvestigationPlan(job.id, incident, strategy.name);
        if (!store.getInvestigationPlan(plan.id)) store.insertInvestigationPlan(plan);
        try {
          await runtime.submit(plan);
        } catch {
          // Plan is the durable handoff. Submit is best-effort for the no-op contract.
        }
        store.markReasoningJobWaitingDelegation(job.id);
        stats.lastDurationMs = Date.now() - started;
        return;
      }
      const reasoner = registry.get(job.reasonerType);
      if (!reasoner) throw new Error(`unknown reasoner type ${job.reasonerType}`);
      const usedMemoryEntryIds = retrieveMemoryIds(retriever, incident, evidence, config);
      const decision = await withTimeout(
        () => strategy.execute({ incident, evidence, reasoner }),
        config.reasoningTimeoutMs,
      );
      const result: ReasoningResult = {
        ...decision,
        id: decision.id,
        incidentId: incident.id,
        createdAt: decision.createdAt,
        reasoningJobId: job.id,
        reasonerType: reasoner.type,
        reasonerVersion: reasoner.version,
        evidenceIds: evidence.map((item) => item.id),
        evidenceSnapshotHash: hashEvidenceSnapshot(evidence),
        strategy: strategy.name,
        strategyVersion: strategy.version,
        ...(usedMemoryEntryIds.length > 0 ? { usedMemoryEntryIds } : {}),
      };
      store.insertReasoningResult(result);
      store.markReasoningJobCompleted(job.id);
      stats.completed += 1;
      stats.lastDurationMs = Date.now() - started;
      console.log(`[agent] reasoning job ${job.id} completed durationMs=${stats.lastDurationMs}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.markReasoningJobFailed(job.id, message);
      stats.failed += 1;
      stats.lastDurationMs = Date.now() - started;
      console.error(`[agent] reasoning job ${job.id} failed durationMs=${stats.lastDurationMs}`);
    }
  }

  async function drain(): Promise<void> {
    const jobs = store.listPendingReasoningJobs(config.reasoningJobBatchSize);
    for (const job of jobs) {
      if (!store.markReasoningJobRunning(job.id)) continue;
      await executeJob(job);
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
        console.error(`[agent] reasoning worker error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  return {
    start(): void {
      const reset = store.resetRunningReasoningJobs();
      if (reset > 0) {
        console.log(`[agent] reset ${reset} interrupted reasoning job(s)`);
      }
      wake();
      timer = setInterval(wake, config.reasoningJobPollIntervalMs);
    },
    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (activeRun) await activeRun;
    },
    wake,
    runOnce,
    metrics(): ReasoningWorkerMetrics {
      return { ...stats };
    },
  };
}

function retrieveMemoryIds(
  retriever: MemoryRetriever | undefined,
  incident: IncidentRow,
  evidence: EvidenceRecord[],
  config: AgentConfig,
): string[] {
  if (!retriever) return [];
  try {
    const context = buildIncidentContext(incident, evidence, {
      maxEvidenceItems: config.reasoningMaxEvidenceItems,
      maxContextBytes: config.reasoningMaxContextBytes,
      maxLogLines: config.reasoningMaxLogLines,
    });
    return retriever.retrieve(context).map((entry) => entry.id);
  } catch {
    return [];
  }
}

function withTimeout<T>(work: () => T | Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('reasoning timeout')), ms);
    Promise.resolve()
      .then(work)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
  });
}
