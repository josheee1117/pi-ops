import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpsEvent } from '@pi-ops/protocol';
import type { AgentConfig } from '../config.js';
import { createEventStore } from '../store.js';
import { createIncidentEngine } from '../incident.js';
import { createInvestigationLoopService } from '../investigation-loop.js';
import { createInvestigationReconciler } from '../investigation-reconciler.js';
import { createReasoningJobWorker } from '../reasoning-worker.js';
import { createFakeReasoner, createReasonerRegistry } from '../reasoner.js';
import type { PiRuntimeClient } from '../pi-runtime-client.js';

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    port: 0,
    ingestToken: 'ingest-token',
    operatorToken: 'operator-token',
    investigationRetryMaxAttempts: 3,
    investigationRetryBackoffMs: 0,
    investigationStaleTimeoutMs: 60_000,
    externalRuntimeEnabled: true,
    sqlitePath: ':memory:',
    nodeId: 'central',
    maxBodySize: 1024 * 1024,
    aggregationWindowMs: 5 * 60 * 1000,
    nodeAgents: new Map(),
    evidenceTimeoutMs: 1000,
    evidenceMaxResponseBytes: 1024 * 1024,
    evidenceLogsMaxLines: 200,
    evidenceJobPollIntervalMs: 1000,
    evidenceJobMaxAttempts: 3,
    evidenceJobBatchSize: 10,
    eventReplayBatchSize: 100,
    reasoningJobPollIntervalMs: 1000,
    reasoningJobMaxAttempts: 3,
    reasoningTimeoutMs: 5000,
    reasoningJobBatchSize: 10,
    reasonerType: 'fake',
    piProvider: '',
    piModel: '',
    reasoningMaxRetries: 2,
    reasoningMaxContextBytes: 32_768,
    reasoningMaxEvidenceItems: 12,
    reasoningMaxLogLines: 50,
    reasoningMaxOutputBytes: 8192,
    piRuntimeUrl: 'http://pi-runtime.test',
    piRuntimeToken: 'runtime-token',
    piRuntimeCallbackUrl: 'http://pi-ops.test/v1/investigation-results',
    ...overrides,
  };
}

function failureEvent(id = 'evt-recon-1'): OpsEvent {
  return {
    schemaVersion: 1,
    id,
    time: '2026-08-20T12:00:00.000Z',
    source: 'health',
    nodeId: 'local-dev',
    service: 'pi-ops-drill',
    type: 'health.failure',
    severity: 'error',
    message: 'health failed',
    attributes: { detector: 'http.health', url: 'http://pi-ops-drill:8088/health' },
  };
}

function ingest(
  store: ReturnType<typeof createEventStore>,
  engine: ReturnType<typeof createIncidentEngine>,
  event: OpsEvent,
) {
  return store.processBatch(
    {
      producer: { id: 'node-agent', type: 'node-agent', version: '1' },
      events: [event],
    },
    event.time,
    (item) => engine.processEvent(item, item.time),
  );
}

function mockRuntime(submitImpl?: PiRuntimeClient['submitInvestigation']): PiRuntimeClient {
  return {
    async submit() {},
    async poll() { return undefined; },
    async submitInvestigation(session, context) {
      if (submitImpl) return submitImpl(session, context);
      return { runtimeTaskId: `rt-${session.runtimeRequestId}` };
    },
  };
}

function makeReconciler(
  store: ReturnType<typeof createEventStore>,
  loop: ReturnType<typeof createInvestigationLoopService>,
  extra: Partial<Parameters<typeof createInvestigationReconciler>[0]> = {},
) {
  return createInvestigationReconciler({
    store,
    loop,
    enabled: true,
    maxAttempts: 3,
    backoffMs: 0,
    staleTimeoutMs: 60_000,
    pollIntervalMs: 60_000,
    ...extra,
  });
}

function complete(loop: ReturnType<typeof createInvestigationLoopService>, sessionId: string, hypothesis = 'finding') {
  return loop.complete(sessionId, {
    hypothesis,
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    confidence: 0.5,
    recommendation: 'inspect current evidence',
  });
}

describe('investigation reconciliation', () => {
  it('creates an InvestigationSession for completed evidence with no session', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, {
      aggregationWindowMs: 300_000,
      scheduleLocalReasoning: false,
    });
    ingest(store, engine, failureEvent());
    const created = store.listIncidents()[0]!;
    store.markEvidenceJobCompleted(`job-${created.id}`);
    const loop = createInvestigationLoopService(store, { runtime: mockRuntime() });
    await makeReconciler(store, loop).reconcile();
    assert.equal(store.listAllInvestigationSessions().filter((item) => item.incidentId === created.id).length, 1);
    store.close();
  });

  it('is idempotent across repeated reconcile calls', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, {
      aggregationWindowMs: 300_000,
      scheduleLocalReasoning: false,
    });
    ingest(store, engine, failureEvent());
    const created = store.listIncidents()[0]!;
    store.markEvidenceJobCompleted(`job-${created.id}`);
    const loop = createInvestigationLoopService(store, { runtime: mockRuntime() });
    const reconciler = makeReconciler(store, loop);
    await reconciler.reconcile();
    await reconciler.reconcile();
    await reconciler.reconcile();
    assert.equal(store.listAllInvestigationSessions().filter((item) => item.incidentId === created.id).length, 1);
    store.close();
  });

  it('does not start a new investigation when dynamic Evidence is added to a COMPLETED generation', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, {
      aggregationWindowMs: 300_000,
      scheduleLocalReasoning: false,
    });
    ingest(store, engine, failureEvent());
    const created = store.listIncidents()[0]!;
    store.markEvidenceJobCompleted(`job-${created.id}`);
    const loop = createInvestigationLoopService(store, { runtime: mockRuntime() });
    const reconciler = makeReconciler(store, loop);
    await reconciler.reconcile();
    const session = store.listAllInvestigationSessions()[0]!;
    store.insertEvidence({
      id: `inv-${session.id}-evidence-host.memory`,
      incidentId: created.id,
      nodeId: 'local-dev',
      source: 'host',
      kind: 'host.memory',
      collectedAt: '2026-08-20T12:05:00.000Z',
      status: 'succeeded',
      data: { usedPercent: 42 },
    });
    complete(loop, session.id);
    await reconciler.reconcile();
    await reconciler.reconcile();
    assert.equal(store.listAllInvestigationSessions().filter((item) => item.incidentId === created.id).length, 1);
    assert.equal(store.listReasoningResults(created.id).length, 1);
    assert.equal(
      store.listNotificationJobs(created.id).filter((job) => job.type === 'INVESTIGATION_COMPLETED').length,
      1,
    );
    store.close();
  });

  it('starts exactly one new investigation after a new deterministic Evidence generation', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, {
      aggregationWindowMs: 300_000,
      scheduleLocalReasoning: false,
    });
    ingest(store, engine, failureEvent());
    const created = store.listIncidents()[0]!;
    store.markEvidenceJobCompleted(`job-${created.id}`);
    const loop = createInvestigationLoopService(store, { runtime: mockRuntime() });
    const reconciler = makeReconciler(store, loop);
    await reconciler.reconcile();
    const first = store.listAllInvestigationSessions()[0]!;
    store.insertEvidence({
      id: `inv-${first.id}-evidence-host.memory`,
      incidentId: created.id,
      nodeId: 'local-dev',
      source: 'host',
      kind: 'host.memory',
      collectedAt: '2026-08-20T12:05:00.000Z',
      status: 'succeeded',
      data: { usedPercent: 42 },
    });
    complete(loop, first.id, 'generation 1');
    store.requeueEvidenceJob(created.id, failureEvent());
    assert.equal(store.getEvidenceJob(`job-${created.id}`)?.generation, 2);
    store.markEvidenceJobCompleted(`job-${created.id}`);
    await reconciler.reconcile();
    await reconciler.reconcile();
    const sessions = store.listAllInvestigationSessions().filter((item) => item.incidentId === created.id);
    assert.equal(sessions.length, 2);
    assert.equal(sessions.filter((item) => item.evidenceGeneration === 2).length, 1);
    store.close();
  });

  it('retries a FAILED attempt after runtime becomes available, bounded', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, {
      aggregationWindowMs: 300_000,
      scheduleLocalReasoning: false,
    });
    ingest(store, engine, failureEvent());
    const created = store.listIncidents()[0]!;
    store.markEvidenceJobCompleted(`job-${created.id}`);
    let down = true;
    const runtime = mockRuntime(async (session) => {
      if (down) throw new Error('runtime unavailable');
      return { runtimeTaskId: `rt-${session.runtimeRequestId}` };
    });
    const loop = createInvestigationLoopService(store, { runtime });
    const reconciler = makeReconciler(store, loop);
    await reconciler.reconcile();
    assert.equal(store.listAllInvestigationSessions()[0]?.status, 'FAILED');
    down = false;
    await reconciler.reconcile();
    const sessions = store.listAllInvestigationSessions().filter((item) => item.incidentId === created.id);
    assert.equal(sessions.length, 2);
    assert.ok(sessions.some((item) => item.status === 'SUBMITTED'));
    store.close();
  });

  it('fails a stale SUBMITTED session and later retries within budget', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, {
      aggregationWindowMs: 300_000,
      scheduleLocalReasoning: false,
    });
    ingest(store, engine, failureEvent());
    const created = store.listIncidents()[0]!;
    store.markEvidenceJobCompleted(`job-${created.id}`);
    let current = '2026-08-20T12:00:00.000Z';
    const now = () => current;
    const loop = createInvestigationLoopService(store, { runtime: mockRuntime(), now });
    const reconciler = makeReconciler(store, loop, { now, staleTimeoutMs: 1000 });
    await reconciler.reconcile();
    assert.equal(store.listAllInvestigationSessions()[0]?.status, 'SUBMITTED');
    current = '2026-08-20T12:00:05.000Z';
    await reconciler.reconcile();
    const afterTimeout = store.listAllInvestigationSessions().filter((item) => item.incidentId === created.id);
    assert.ok(afterTimeout.some((item) => item.status === 'FAILED'));
    assert.ok(afterTimeout.some((item) => item.status === 'SUBMITTED' && item.id !== afterTimeout.find((row) => row.status === 'FAILED')?.id));
    const second = afterTimeout.find((item) => item.status === 'SUBMITTED')!;
    complete(loop, second.id, 'recovered after stale timeout');
    assert.equal(store.getInvestigationSession(second.id)?.status, 'COMPLETED');
    store.close();
  });

  it('fails a stale RUNNING session', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, {
      aggregationWindowMs: 300_000,
      scheduleLocalReasoning: false,
    });
    ingest(store, engine, failureEvent());
    const created = store.listIncidents()[0]!;
    store.markEvidenceJobCompleted(`job-${created.id}`);
    let current = '2026-08-20T12:00:00.000Z';
    const now = () => current;
    const loop = createInvestigationLoopService(store, { runtime: mockRuntime(), now });
    const reconciler = makeReconciler(store, loop, { now, staleTimeoutMs: 1000, maxAttempts: 1 });
    await reconciler.reconcile();
    loop.markRunning(store.listAllInvestigationSessions()[0]!.id);
    assert.equal(store.listAllInvestigationSessions()[0]?.status, 'RUNNING');
    current = '2026-08-20T12:00:05.000Z';
    await reconciler.reconcile();
    assert.ok(store.listAllInvestigationSessions().some((item) => item.status === 'FAILED'));
    store.close();
  });

  it('stops retrying after maxAttempts FAILED sessions for the same generation', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, {
      aggregationWindowMs: 300_000,
      scheduleLocalReasoning: false,
    });
    ingest(store, engine, failureEvent());
    const created = store.listIncidents()[0]!;
    store.markEvidenceJobCompleted(`job-${created.id}`);
    const runtime = mockRuntime(async () => {
      throw new Error('runtime unavailable');
    });
    const loop = createInvestigationLoopService(store, { runtime });
    const reconciler = makeReconciler(store, loop, { maxAttempts: 3 });
    await reconciler.reconcile();
    await reconciler.reconcile();
    await reconciler.reconcile();
    await reconciler.reconcile();
    const sessions = store.listAllInvestigationSessions().filter((item) => item.incidentId === created.id);
    assert.equal(sessions.length, 3);
    assert.ok(sessions.every((item) => item.status === 'FAILED'));
    store.close();
  });

  it('repairs the crash gap after reopening SQLite and does not redispatch COMPLETED generations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-ops-recon-'));
    const dbPath = join(directory, 'agent.sqlite');
    const store1 = createEventStore(dbPath);
    const engine = createIncidentEngine(store1, {
      aggregationWindowMs: 300_000,
      scheduleLocalReasoning: false,
    });
    ingest(store1, engine, failureEvent());
    const created = store1.listIncidents()[0]!;
    store1.markEvidenceJobCompleted(`job-${created.id}`);
    const loop1 = createInvestigationLoopService(store1, { runtime: mockRuntime() });
    await makeReconciler(store1, loop1).reconcile();
    complete(loop1, store1.listAllInvestigationSessions()[0]!.id);
    store1.close();

    const store2 = createEventStore(dbPath);
    const loop2 = createInvestigationLoopService(store2, { runtime: mockRuntime() });
    await makeReconciler(store2, loop2).reconcile();
    assert.equal(store2.listAllInvestigationSessions().length, 1);
    assert.equal(store2.listAllInvestigationSessions()[0]?.status, 'COMPLETED');
    store2.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('keeps one authoritative ReasoningResult from the InvestigationSession', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, {
      aggregationWindowMs: 300_000,
      scheduleLocalReasoning: false,
    });
    ingest(store, engine, failureEvent());
    const created = store.listIncidents()[0]!;
    store.markEvidenceJobCompleted(`job-${created.id}`);
    const loop = createInvestigationLoopService(store, { runtime: mockRuntime() });
    await makeReconciler(store, loop).reconcile();
    const session = store.listAllInvestigationSessions()[0]!;
    complete(loop, session.id, 'authoritative runtime finding');
    const worker = createReasoningJobWorker(
      baseConfig(),
      store,
      createReasonerRegistry([createFakeReasoner()]),
    );
    await worker.runOnce();
    assert.equal(store.getReasoningJob(`rj-${created.id}`), undefined);
    const results = store.listReasoningResults(created.id);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.investigationSessionId, session.id);
    store.close();
  });
});
