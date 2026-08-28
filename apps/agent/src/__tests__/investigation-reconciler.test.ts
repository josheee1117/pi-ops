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
    ...overrides,
  };
}

function failureEvent(): OpsEvent {
  return {
    schemaVersion: 1,
    id: 'evt-recon-1',
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
    assert.equal(store.listAllInvestigationSessions().length, 0);
    assert.equal(store.getReasoningJob(`rj-${created.id}`), undefined);
    const loop = createInvestigationLoopService(store, { runtime: mockRuntime() });
    const reconciler = createInvestigationReconciler({
      store,
      loop,
      enabled: true,
      maxAttempts: 3,
      backoffMs: 0,
      pollIntervalMs: 60_000,
    });
    await reconciler.reconcile();
    const sessions = store.listAllInvestigationSessions().filter((item) => item.incidentId === created.id);
    assert.equal(sessions.length, 1);
    assert.ok(sessions[0]?.status === 'SUBMITTED' || sessions[0]?.status === 'CREATED');
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
    const reconciler = createInvestigationReconciler({
      store,
      loop,
      enabled: true,
      maxAttempts: 3,
      backoffMs: 0,
      pollIntervalMs: 60_000,
    });
    await reconciler.reconcile();
    await reconciler.reconcile();
    await reconciler.reconcile();
    assert.equal(store.listAllInvestigationSessions().filter((item) => item.incidentId === created.id).length, 1);
    store.close();
  });

  it('does not redispatch a COMPLETED matching snapshot', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, {
      aggregationWindowMs: 300_000,
      scheduleLocalReasoning: false,
    });
    ingest(store, engine, failureEvent());
    const created = store.listIncidents()[0]!;
    store.markEvidenceJobCompleted(`job-${created.id}`);
    const loop = createInvestigationLoopService(store, { runtime: mockRuntime() });
    const { session } = loop.start(created.id);
    await loop.submit(session.id);
    loop.complete(session.id, {
      hypothesis: 'drill health failed',
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      confidence: 0.4,
      recommendation: 'restore the drill endpoint',
    });
    const reconciler = createInvestigationReconciler({
      store,
      loop,
      enabled: true,
      maxAttempts: 3,
      backoffMs: 0,
      pollIntervalMs: 60_000,
    });
    await reconciler.reconcile();
    assert.equal(store.listAllInvestigationSessions().filter((item) => item.incidentId === created.id).length, 1);
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
    const reconciler = createInvestigationReconciler({
      store,
      loop,
      enabled: true,
      maxAttempts: 3,
      backoffMs: 0,
      pollIntervalMs: 60_000,
    });
    await reconciler.reconcile();
    assert.equal(store.listAllInvestigationSessions()[0]?.status, 'FAILED');
    down = false;
    await reconciler.reconcile();
    const sessions = store.listAllInvestigationSessions().filter((item) => item.incidentId === created.id);
    assert.equal(sessions.length, 2);
    assert.ok(sessions.some((item) => item.status === 'SUBMITTED'));
    store.close();
  });

  it('repairs the crash gap after reopening SQLite', async () => {
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
    store1.close();

    const store2 = createEventStore(dbPath);
    const loop = createInvestigationLoopService(store2, { runtime: mockRuntime() });
    const reconciler = createInvestigationReconciler({
      store: store2,
      loop,
      enabled: true,
      maxAttempts: 3,
      backoffMs: 0,
      pollIntervalMs: 60_000,
    });
    await reconciler.reconcile();
    assert.equal(store2.listAllInvestigationSessions().length, 1);
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
    const reconciler = createInvestigationReconciler({
      store,
      loop,
      enabled: true,
      maxAttempts: 3,
      backoffMs: 0,
      pollIntervalMs: 60_000,
    });
    await reconciler.reconcile();
    const session = store.listAllInvestigationSessions()[0]!;
    loop.complete(session.id, {
      hypothesis: 'authoritative runtime finding',
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      confidence: 0.5,
      recommendation: 'inspect current evidence',
    });
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
    assert.equal(results[0]?.reasoningSummary, 'authoritative runtime finding');
    store.close();
  });
});
