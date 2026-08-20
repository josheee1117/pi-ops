import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpsEvent } from '@pi-ops/protocol';
import type { AgentConfig } from '../config.js';
import {
  createEvidenceOrchestrator,
  type EvidenceOrchestrator,
  type FetchLike,
} from '../evidence-orchestrator.js';
import { createEvidenceJobWorker } from '../evidence-worker.js';
import { createIncidentEngine } from '../incident.js';
import { createEventStore } from '../store.js';

function makeConfig(
  sqlitePath = ':memory:',
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  return {
    port: 0,
    ingestToken: 'ingest-token',
    sqlitePath,
    nodeId: 'central',
    maxBodySize: 1024 * 1024,
    aggregationWindowMs: 5 * 60 * 1000,
    nodeAgents: new Map(),
    evidenceTimeoutMs: 1000,
    evidenceMaxResponseBytes: 1024 * 1024,
    evidenceLogsMaxLines: 200,
    evidenceJobPollIntervalMs: 60_000,
    evidenceJobMaxAttempts: 3,
    evidenceJobBatchSize: 10,
    eventReplayBatchSize: 100,
    ...overrides,
  };
}

function makeEvent(): OpsEvent {
  return {
    schemaVersion: 1,
    id: 'evt-job-1',
    time: '2026-08-20T12:00:00.000Z',
    source: 'docker',
    nodeId: 'test-svc-02',
    service: 'dataease',
    type: 'container.die',
    severity: 'error',
    message: 'Container died',
    attributes: { containerName: 'dataease' },
  };
}

describe('durable evidence jobs', () => {
  it('atomically creates a pending job with a new Incident', () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const result = engine.processEvent(makeEvent(), makeEvent().time);
    assert.ok(result.incidentId);

    const job = store.getEvidenceJob(`job-${result.incidentId}`);
    assert.ok(job);
    assert.equal(job.state, 'PENDING');
    assert.equal(job.incidentId, result.incidentId);
    assert.equal(job.triggeringEvent.id, 'evt-job-1');
    assert.equal(store.incidentCount(), 1);
    store.close();
  });

  it('processes a pending job and marks it completed', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const result = engine.processEvent(makeEvent(), makeEvent().time);
    assert.ok(result.incidentId);
    let calls = 0;
    let collectionId: string | undefined;
    const orchestrator: EvidenceOrchestrator = {
      async collectForIncident(incident, _event, id) {
        calls++;
        collectionId = id;
        return {
          incidentId: incident.id,
          requested: 2,
          succeeded: 2,
          failed: 0,
          retryableFailures: 0,
          terminalFailures: 0,
        };
      },
    };
    const worker = createEvidenceJobWorker(makeConfig(), store, orchestrator);
    await worker.runOnce();

    assert.equal(calls, 1);
    assert.equal(collectionId, `job-${result.incidentId}`);
    assert.equal(store.getEvidenceJob(`job-${result.incidentId}`)?.state, 'COMPLETED');
    await worker.stop();
    store.close();
  });

  it('retries HTTP 500 collection and completes without duplicate Evidence', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const incident = engine.processEvent(makeEvent(), makeEvent().time);
    assert.ok(incident.incidentId);
    let calls = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls++;
      if (calls <= 2) return new Response('temporary failure', { status: 500 });
      const query = JSON.parse(String(init?.body)) as { type: string; incidentId: string };
      return new Response(JSON.stringify({
        id: `node-${calls}`,
        incidentId: query.incidentId,
        nodeId: 'test-svc-02',
        source: 'docker',
        kind: query.type,
        collectedAt: '2026-08-20T12:01:00.000Z',
        data: { ok: true },
      }), { status: 200 });
    }) as FetchLike;
    const config = makeConfig(':memory:', {
      nodeAgents: new Map([[
        'test-svc-02',
        { nodeId: 'test-svc-02', url: 'http://node-agent.test', token: 'token' },
      ]]),
    });
    const worker = createEvidenceJobWorker(
      config,
      store,
      createEvidenceOrchestrator(config, store, fetchImpl),
    );
    const jobId = `job-${incident.incidentId}`;

    await worker.runOnce();
    assert.equal(store.getEvidenceJob(jobId)?.state, 'PENDING');
    assert.equal(store.listEvidence(incident.incidentId).length, 2);
    assert.ok(store.listEvidence(incident.incidentId).every((item) => item.status === 'failed'));

    await worker.runOnce();
    assert.equal(store.getEvidenceJob(jobId)?.state, 'COMPLETED');
    assert.equal(store.getEvidenceJob(jobId)?.attempts, 2);
    assert.equal(store.listEvidence(incident.incidentId).length, 2);
    assert.ok(store.listEvidence(incident.incidentId).every((item) => item.status === 'succeeded'));
    assert.equal(calls, 4);
    store.close();
  });

  it('retries timeout collection and completes on the second attempt', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const incident = engine.processEvent(makeEvent(), makeEvent().time);
    assert.ok(incident.incidentId);
    let calls = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls++;
      if (calls <= 2) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      const query = JSON.parse(String(init?.body)) as { type: string; incidentId: string };
      return new Response(JSON.stringify({
        id: `node-${calls}`,
        incidentId: query.incidentId,
        nodeId: 'test-svc-02',
        source: 'docker',
        kind: query.type,
        collectedAt: '2026-08-20T12:01:00.000Z',
        data: { ok: true },
      }), { status: 200 });
    }) as FetchLike;
    const config = makeConfig(':memory:', {
      evidenceTimeoutMs: 5,
      nodeAgents: new Map([[
        'test-svc-02',
        { nodeId: 'test-svc-02', url: 'http://node-agent.test', token: 'token' },
      ]]),
    });
    const worker = createEvidenceJobWorker(
      config,
      store,
      createEvidenceOrchestrator(config, store, fetchImpl),
    );
    const jobId = `job-${incident.incidentId}`;

    await worker.runOnce();
    assert.equal(store.getEvidenceJob(jobId)?.state, 'PENDING');
    await worker.runOnce();
    assert.equal(store.getEvidenceJob(jobId)?.state, 'COMPLETED');
    assert.equal(store.listEvidence(incident.incidentId).length, 2);
    assert.ok(store.listEvidence(incident.incidentId).every((item) => item.status === 'succeeded'));
    store.close();
  });

  it('does not retry terminal HTTP 4xx collection failure', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const incident = engine.processEvent(makeEvent(), makeEvent().time);
    assert.ok(incident.incidentId);
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('not allowed', { status: 403 });
    }) as FetchLike;
    const config = makeConfig(':memory:', {
      nodeAgents: new Map([[
        'test-svc-02',
        { nodeId: 'test-svc-02', url: 'http://node-agent.test', token: 'token' },
      ]]),
    });
    const worker = createEvidenceJobWorker(
      config,
      store,
      createEvidenceOrchestrator(config, store, fetchImpl),
    );
    const jobId = `job-${incident.incidentId}`;

    await worker.runOnce();
    assert.equal(store.getEvidenceJob(jobId)?.state, 'COMPLETED');
    assert.equal(store.getEvidenceJob(jobId)?.attempts, 1);
    await worker.runOnce();
    assert.equal(calls, 2);
    assert.equal(store.listEvidence(incident.incidentId).length, 2);
    assert.ok(store.listEvidence(incident.incidentId).every((item) => item.status === 'failed'));
    store.close();
  });

  it('retries only retryable queries after a mixed terminal/retryable attempt', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const incident = engine.processEvent(makeEvent(), makeEvent().time);
    assert.ok(incident.incidentId);
    let calls = 0;
    let logsCalls = 0;
    const seenTypes: string[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls++;
      const query = JSON.parse(String(init?.body)) as { type: string; incidentId: string };
      seenTypes.push(query.type);
      if (query.type === 'docker.inspect') {
        return new Response('terminal', { status: 403 });
      }
      logsCalls++;
      if (logsCalls === 1) return new Response('retry', { status: 500 });
      return new Response(JSON.stringify({
        id: `node-${calls}`,
        incidentId: query.incidentId,
        nodeId: 'test-svc-02',
        source: 'docker',
        kind: query.type,
        collectedAt: '2026-08-20T12:01:00.000Z',
        data: { ok: true },
      }), { status: 200 });
    }) as FetchLike;
    const config = makeConfig(':memory:', {
      nodeAgents: new Map([[
        'test-svc-02',
        { nodeId: 'test-svc-02', url: 'http://node-agent.test', token: 'token' },
      ]]),
    });
    const worker = createEvidenceJobWorker(
      config,
      store,
      createEvidenceOrchestrator(config, store, fetchImpl),
    );
    const jobId = `job-${incident.incidentId}`;

    await worker.runOnce();
    assert.equal(store.getEvidenceJob(jobId)?.state, 'PENDING');
    await worker.runOnce();

    assert.equal(store.getEvidenceJob(jobId)?.state, 'COMPLETED');
    assert.equal(calls, 3);
    assert.deepEqual(seenTypes, ['docker.inspect', 'docker.logs', 'docker.logs']);
    const evidence = store.listEvidence(incident.incidentId);
    assert.equal(evidence.length, 2);
    assert.equal(evidence.find((item) => item.kind === 'docker.inspect')?.failureClass, 'terminal');
    assert.equal(evidence.find((item) => item.kind === 'docker.logs')?.status, 'succeeded');
    store.close();
  });

  it('retries only the query whose successful Evidence failed to persist', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const incident = engine.processEvent(makeEvent(), makeEvent().time);
    assert.ok(incident.incidentId);
    const config = makeConfig(':memory:', {
      nodeAgents: new Map([[
        'test-svc-02',
        { nodeId: 'test-svc-02', url: 'http://node-agent.test', token: 'token' },
      ]]),
    });
    const callsByType = new Map<string, number>();
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)) as { type: string; incidentId: string };
      callsByType.set(query.type, (callsByType.get(query.type) ?? 0) + 1);
      return new Response(JSON.stringify({
        id: `node-${query.type}`,
        incidentId: query.incidentId,
        nodeId: 'test-svc-02',
        source: 'docker',
        kind: query.type,
        collectedAt: '2026-08-20T12:01:00.000Z',
        data: { ok: true },
      }), { status: 200 });
    }) as FetchLike;
    const originalInsertEvidence = store.insertEvidence;
    let failLogsInsert = true;
    store.insertEvidence = (evidence) => {
      if (failLogsInsert && evidence.kind === 'docker.logs') {
        failLogsInsert = false;
        throw new Error('sqlite write failed');
      }
      originalInsertEvidence(evidence);
    };
    const worker = createEvidenceJobWorker(
      config,
      store,
      createEvidenceOrchestrator(config, store, fetchImpl),
    );
    const jobId = `job-${incident.incidentId}`;

    await worker.runOnce();
    assert.equal(store.getEvidenceJob(jobId)?.state, 'PENDING');
    assert.equal(store.getEvidenceJob(jobId)?.attempts, 1);
    assert.match(store.getEvidenceJob(jobId)?.lastError ?? '', /sqlite write failed/);
    assert.equal(store.listEvidence(incident.incidentId).length, 1);

    await worker.runOnce();
    assert.equal(store.getEvidenceJob(jobId)?.state, 'COMPLETED');
    assert.equal(callsByType.get('docker.inspect'), 1);
    assert.equal(callsByType.get('docker.logs'), 2);
    assert.equal(store.listEvidence(incident.incidentId).length, 2);
    store.insertEvidence = originalInsertEvidence;
    store.close();
  });

  it('resets and resumes a RUNNING job after process restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-ops-evidence-job-'));
    const dbPath = join(directory, 'agent.sqlite');
    const store1 = createEventStore(dbPath);
    const engine = createIncidentEngine(store1, { aggregationWindowMs: 300_000 });
    const event = makeEvent();
    let incidentId: string | null = null;
    store1.processBatch(
      {
        producer: { id: 'node-agent-01', type: 'node-agent', version: '0.1.0' },
        events: [event],
      },
      '2026-08-20T12:00:01.000Z',
      (persisted) => {
        const result = engine.processEvent(persisted, persisted.time);
        incidentId = result.incidentId;
        return result;
      },
    );
    assert.ok(incidentId);
    const result = { incidentId };
    const jobId = `job-${result.incidentId}`;
    assert.equal(store1.markEvidenceJobRunning(jobId), true);
    assert.equal(store1.getEvidenceJob(jobId)?.state, 'RUNNING');
    store1.close();

    const store2 = createEventStore(dbPath);
    let calls = 0;
    const orchestrator: EvidenceOrchestrator = {
      async collectForIncident(incident) {
        calls++;
        return {
          incidentId: incident.id,
          requested: 0,
          succeeded: 0,
          failed: 0,
          retryableFailures: 0,
          terminalFailures: 0,
        };
      },
    };
    const worker = createEvidenceJobWorker(makeConfig(dbPath), store2, orchestrator);
    worker.start();
    await worker.runOnce();
    await worker.stop();

    assert.equal(calls, 1);
    assert.equal(store2.getEvidenceJob(jobId)?.state, 'COMPLETED');
    store2.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('does not create another job for a transport retry', () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const event = makeEvent();
    const first = engine.processEvent(event, event.time);
    const retry = engine.processEvent(event, '2026-08-20T13:00:00.000Z');
    assert.equal(retry.incidentId, first.incidentId);
    assert.equal(store.listPendingEvidenceJobs(10).length, 1);
    store.close();
  });
});
