import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Hono } from 'hono';
import { createApp } from '../app.js';
import { createEventStore, type EventStore } from '../store.js';
import { createIncidentEngine, type IncidentEngine } from '../incident.js';
import { createEvidenceOrchestrator, type FetchLike } from '../evidence-orchestrator.js';
import { createEvidenceJobWorker, type EvidenceJobWorker } from '../evidence-worker.js';
import type { AgentConfig } from '../config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Omit<AgentConfig, 'sqlitePath'> = {
  port: 0,
  ingestToken: 'test-token',
  nodeId: 'test-node',
  maxBodySize: 1024 * 1024,
  aggregationWindowMs: 5 * 60 * 1000,
  nodeAgents: new Map(),
  evidenceTimeoutMs: 5000,
  evidenceMaxResponseBytes: 1024 * 1024,
  evidenceLogsMaxLines: 200,
  evidenceJobPollIntervalMs: 1000,
  evidenceJobMaxAttempts: 3,
  evidenceJobBatchSize: 10,
};

function makeTestConfig(sqlitePath: string): AgentConfig {
  return { ...DEFAULT_CONFIG, sqlitePath };
}

function makeValidEvent(id = 'evt-0001'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    time: '2026-08-20T12:00:00.000Z',
    source: 'docker',
    nodeId: 'test-svc-02',
    service: 'dataease',
    type: 'container.die',
    severity: 'error',
    message: 'Container dataease exited',
    attributes: { exitCode: 137 },
  };
}

function makeValidBatch(eventCount = 1): Record<string, unknown> {
  const events = Array.from({ length: eventCount }, (_, i) =>
    makeValidEvent(`evt-${String(i).padStart(4, '0')}`),
  );
  return {
    producer: { id: 'node-agent-01', type: 'node-agent', version: '0.1.0' },
    events,
  };
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer test-token`, 'Content-Type': 'application/json' };
}

function setupInMemory(): { app: Hono; store: EventStore; engine: IncidentEngine } {
  const config = makeTestConfig(':memory:');
  const store = createEventStore(':memory:');
  const engine = createIncidentEngine(store, { aggregationWindowMs: config.aggregationWindowMs });
  const app = createApp(config, store, engine);
  return { app, store, engine };
}

function setupFileDb(): { app: Hono; store: EventStore; dbPath: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pi-ops-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const config = makeTestConfig(dbPath);
  const store = createEventStore(dbPath);
  const engine = createIncidentEngine(store, { aggregationWindowMs: config.aggregationWindowMs });
  const app = createApp(config, store, engine);
  return { app, store, dbPath };
}

// ── POST /v1/events ─────────────────────────────────────────────────────────

describe('POST /v1/events', () => {
  it('accepts and persists a valid event', async () => {
    const { app, store } = setupInMemory();
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(makeValidBatch(1)),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.accepted, 1);
    assert.equal(body.rejected, 0);
    assert.equal(store.count(), 1);
    assert.ok(store.getEventProcessedAt('evt-0000'));
  });

  it('accepts a batch of multiple events', async () => {
    const { app, store } = setupInMemory();
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(makeValidBatch(5)),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.accepted, 5);
    assert.equal(store.count(), 5);
  });

  it('rolls back Event, Incident, link, and job when Incident processing fails', async () => {
    const config = makeTestConfig(':memory:');
    const store = createEventStore(':memory:');
    const realEngine = createIncidentEngine(store, {
      aggregationWindowMs: config.aggregationWindowMs,
    });
    const failingEngine: IncidentEngine = {
      processEvent(event, timestamp) {
        realEngine.processEvent(event, timestamp);
        throw new Error('simulated Incident processing failure');
      },
    };
    const app = createApp(config, store, failingEngine);

    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(makeValidBatch(1)),
    });

    assert.equal(res.status, 500);
    assert.equal(store.count(), 0);
    assert.equal(store.incidentCount(), 0);
    assert.equal(store.listPendingEvidenceJobs(10).length, 0);

    // The same Event remains retryable because the failed transaction left no
    // immutable Event row or Incident side effects behind.
    const recoveredApp = createApp(config, store, realEngine);
    const retry = await recoveredApp.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(makeValidBatch(1)),
    });
    assert.equal(retry.status, 200);
    assert.equal(store.count(), 1);
    assert.equal(store.incidentCount(), 1);
    assert.equal(store.listPendingEvidenceJobs(10).length, 1);
    store.close();
  });

  it('idempotent: duplicate event id is silently accepted', async () => {
    const { app, store } = setupInMemory();
    // First insert
    await app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(makeValidBatch(1)),
    });
    assert.equal(store.count(), 1);
    // Duplicate insert
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(makeValidBatch(1)),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.accepted, 1);
    assert.equal(store.count(), 1); // no new row
  });

  it('does not invoke Incident processing again for a duplicate Event', async () => {
    const config = makeTestConfig(':memory:');
    const store = createEventStore(':memory:');
    const realEngine = createIncidentEngine(store, {
      aggregationWindowMs: config.aggregationWindowMs,
    });
    let processCalls = 0;
    const countingEngine: IncidentEngine = {
      processEvent(event, timestamp) {
        processCalls++;
        return realEngine.processEvent(event, timestamp);
      },
    };
    const app = createApp(config, store, countingEngine);
    const request = () => app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(makeValidBatch(1)),
    });

    assert.equal((await request()).status, 200);
    assert.equal((await request()).status, 200);
    assert.equal(processCalls, 1);
    assert.equal(store.count(), 1);
    assert.equal(store.incidentCount(), 1);
    store.close();
  });

  it('rejects a duplicate id with conflicting payload', async () => {
    const config = makeTestConfig(':memory:');
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, {
      aggregationWindowMs: config.aggregationWindowMs,
    });
    const app = createApp(config, store, engine);
    const firstBatch = makeValidBatch(1);
    const conflictingBatch = makeValidBatch(1);
    Object.assign((conflictingBatch.events as Record<string, unknown>[])[0]!, {
      type: 'container.oom',
      message: 'Conflicting payload for immutable id',
    });

    const first = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(firstBatch),
    });
    const retry = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(conflictingBatch),
    });

    assert.equal(first.status, 200);
    assert.equal(retry.status, 409);
    const conflict = await retry.json();
    assert.equal(conflict.eventId, 'evt-0000');
    assert.equal(store.count(), 1);
    assert.equal(store.incidentCount(), 1);
    assert.ok(store.findActiveIncident(
      'docker:test-svc-02:dataease:container.die',
      '2026-08-20T12:00:00.000Z',
      config.aggregationWindowMs,
    ));
    assert.equal(store.findActiveIncident(
      'docker:test-svc-02:dataease:container.oom',
      '2026-08-20T12:00:00.000Z',
      config.aggregationWindowMs,
    ), undefined);
    assert.equal(store.listPendingEvidenceJobs(10).length, 1);
    store.close();
  });

  it('rolls back an entire mixed batch when one duplicate id conflicts', async () => {
    const config = makeTestConfig(':memory:');
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, {
      aggregationWindowMs: config.aggregationWindowMs,
    });
    const app = createApp(config, store, engine);
    assert.equal((await app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(makeValidBatch(1)),
    })).status, 200);

    const mixedBatch = {
      producer: { id: 'node-agent-01', type: 'node-agent', version: '0.1.0' },
      events: [
        makeValidEvent('evt-new-in-conflicting-batch'),
        {
          ...makeValidEvent('evt-0000'),
          type: 'container.oom',
          message: 'Conflicting duplicate',
        },
      ],
    };
    const conflict = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(mixedBatch),
    });

    assert.equal(conflict.status, 409);
    assert.equal(store.getEvent('evt-new-in-conflicting-batch'), undefined);
    assert.equal(store.count(), 1);
    assert.equal(store.incidentCount(), 1);
    assert.equal(store.listPendingEvidenceJobs(10).length, 1);
    const incident = store.findActiveIncident(
      'docker:test-svc-02:dataease:container.die',
      '2026-08-20T12:00:00.000Z',
      config.aggregationWindowMs,
    );
    assert.equal(incident?.event_count, 1);
    store.close();
  });

  it('does not let a retried unmatched recovery affect a later Incident', async () => {
    const config = makeTestConfig(':memory:');
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, {
      aggregationWindowMs: config.aggregationWindowMs,
    });
    const app = createApp(config, store, engine);
    const producer = { id: 'node-agent-01', type: 'node-agent', version: '0.1.0' };
    const recovery = {
      ...makeValidEvent('evt-unmatched-recovery'),
      time: '2026-08-20T12:05:00.000Z',
      source: 'health',
      type: 'health.recovered',
      severity: 'info',
      message: 'Health recovered',
    };
    const failure = {
      ...makeValidEvent('evt-later-failure'),
      time: '2026-08-20T12:00:00.000Z',
      source: 'health',
      type: 'health.failure',
      severity: 'error',
      message: 'Health check failed',
    };
    const post = (event: Record<string, unknown>) => app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ producer, events: [event] }),
    });

    assert.equal((await post(recovery)).status, 200);
    assert.equal(store.incidentCount(), 0);
    assert.equal((await post(failure)).status, 200);
    assert.equal((await post(recovery)).status, 200);

    const incident = store.findActiveIncident(
      'health:test-svc-02:dataease:health.failure',
      '2026-08-20T12:00:00.000Z',
      config.aggregationWindowMs,
    );
    assert.ok(incident);
    assert.equal(incident.state, 'OPEN');
    assert.equal(incident.event_count, 1);
    assert.equal(store.count(), 2);
    store.close();
  });

  it('starts evidence collection once for a new Incident without blocking ingestion', async () => {
    const config = makeTestConfig(':memory:');
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, {
      aggregationWindowMs: config.aggregationWindowMs,
    });
    let calls = 0;
    const worker: EvidenceJobWorker = {
      start() {},
      async stop() {},
      wake() { calls++; },
      async runOnce() {},
    };
    const app = createApp(config, store, engine, worker);

    const first = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(makeValidBatch(1)),
    });
    assert.equal(first.status, 200);
    assert.equal(calls, 1);
    assert.equal(store.listPendingEvidenceJobs(10).length, 1);

    // Transport retry does not create another Incident or evidence run.
    const retry = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(makeValidBatch(1)),
    });
    assert.equal(retry.status, 200);
    assert.equal(calls, 1);
    store.close();
  });

  it('runs the integrated ingress → Incident → durable job → Evidence flow', async () => {
    const config = {
      ...makeTestConfig(':memory:'),
      nodeAgents: new Map([
        ['test-svc-02', {
          nodeId: 'test-svc-02',
          url: 'http://node-agent.test',
          token: 'node-token',
        }],
      ]),
    };
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, {
      aggregationWindowMs: config.aggregationWindowMs,
    });
    let id = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)) as { type: string; incidentId: string };
      id++;
      return new Response(JSON.stringify({
        id: `node-evidence-${id}`,
        incidentId: query.incidentId,
        nodeId: 'test-svc-02',
        source: 'docker',
        kind: query.type,
        collectedAt: '2026-08-20T12:00:01.000Z',
        data: { collected: true },
      }), { status: 200 });
    }) as FetchLike;
    const orchestrator = createEvidenceOrchestrator(config, store, fetchImpl);
    const worker = createEvidenceJobWorker(config, store, orchestrator);
    const app = createApp(config, store, engine, worker);

    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(makeValidBatch(1)),
    });
    assert.equal(res.status, 200);
    await worker.runOnce();

    const incident = store.findActiveIncident(
      'docker:test-svc-02:dataease:container.die',
      '2026-08-20T12:00:00.000Z',
      config.aggregationWindowMs,
    );
    assert.ok(incident);
    assert.equal(store.listEvidence(incident.id).length, 2);
    assert.equal(store.getEvidenceJob(`job-${incident.id}`)?.state, 'COMPLETED');
    await worker.stop();
    store.close();
  });

  it('rejects request without auth token', async () => {
    const { app } = setupInMemory();
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeValidBatch(1)),
    });
    assert.equal(res.status, 401);
  });

  it('rejects request with wrong token', async () => {
    const { app } = setupInMemory();
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(makeValidBatch(1)),
    });
    assert.equal(res.status, 401);
  });

  it('rejects invalid JSON body', async () => {
    const { app } = setupInMemory();
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: 'not json',
    });
    assert.equal(res.status, 400);
  });

  it('rejects a declared oversized event body', async () => {
    const config = { ...makeTestConfig(':memory:'), maxBodySize: 32 };
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, {
      aggregationWindowMs: config.aggregationWindowMs,
    });
    const app = createApp(config, store, engine);
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Length': '4096' },
      body: JSON.stringify(makeValidBatch(1)),
    });
    assert.equal(res.status, 413);
    assert.equal(store.count(), 0);
    store.close();
  });

  it('rejects an oversized chunked event body without Content-Length', async () => {
    const config = { ...makeTestConfig(':memory:'), maxBodySize: 32 };
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, {
      aggregationWindowMs: config.aggregationWindowMs,
    });
    const app = createApp(config, store, engine);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"padding":"'));
        controller.enqueue(encoder.encode('x'.repeat(256)));
        controller.enqueue(encoder.encode('"}'));
        controller.close();
      },
    });
    const request = new Request('http://localhost/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const res = await app.fetch(request);
    assert.equal(res.status, 413);
    assert.equal(store.count(), 0);
    store.close();
  });

  it('rejects an event with missing required fields', async () => {
    const { app, store } = setupInMemory();
    const batch = makeValidBatch(1);
    delete (batch.events as Record<string, unknown>[])[0]!['id'];
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(batch),
    });
    assert.equal(res.status, 400);
    assert.equal(store.count(), 0);
  });

  it('rejects batch with empty events array', async () => {
    const { app } = setupInMemory();
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ producer: { id: 'x', type: 'node-agent', version: '1' }, events: [] }),
    });
    assert.equal(res.status, 400);
  });

  it('does not crash on invalid event — reports 400', async () => {
    const { app, store } = setupInMemory();
    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ not: 'a batch' }),
    });
    assert.equal(res.status, 400);
    assert.equal(store.count(), 0);
  });
});

// ── GET /health ──────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns ok with nodeId', async () => {
    const { app } = setupInMemory();
    const res = await app.request('/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.nodeId, 'test-node');
  });
});

// ── Persistence across restarts ──────────────────────────────────────────────

describe('persistence', () => {
  it('event survives database close and reopen', () => {
    const { store: store1, dbPath } = setupFileDb();

    const batch = {
      producer: { id: 'p1', type: 'node-agent' as const, version: '0.1.0' },
      events: [
        {
          schemaVersion: 1 as const,
          id: 'evt-survivor',
          time: '2026-08-20T12:00:00.000Z',
          source: 'docker' as const,
          nodeId: 'test-svc-02',
          service: 'dataease',
          type: 'container.die',
          severity: 'error' as const,
          fingerprint: 'producer-audit-fingerprint',
          traceId: 'trace-survivor',
          message: 'Survived restart',
          attributes: { persisted: true },
        },
      ],
    };
    store1.insertBatch(batch, '2026-08-20T12:00:05.000Z');
    assert.equal(store1.count(), 1);
    store1.close();

    // Simulate restart: open a new store on the same file.
    const store2 = createEventStore(dbPath);
    assert.equal(store2.count(), 1);
    const persisted = store2.getEvent('evt-survivor');
    assert.ok(persisted);
    assert.equal(persisted.schema_version, 1);
    assert.equal(persisted.event_time, '2026-08-20T12:00:00.000Z');
    assert.equal(persisted.receive_time, '2026-08-20T12:00:05.000Z');
    assert.equal(persisted.fingerprint, 'producer-audit-fingerprint');
    assert.equal(persisted.trace_id, 'trace-survivor');
    assert.equal(persisted.attributes, JSON.stringify({ persisted: true }));
    store2.close();

    rmSync(dbPath, { recursive: true, force: true });
  });

  it('preserves each canonical event time when events aggregate into one Incident', () => {
    const { store: store1, dbPath } = setupFileDb();
    const engine = createIncidentEngine(store1, { aggregationWindowMs: 5 * 60 * 1000 });
    const first = {
      schemaVersion: 1 as const,
      id: 'evt-aggregate-first',
      time: '2026-08-20T12:00:00.000Z',
      source: 'docker' as const,
      nodeId: 'test-svc-02',
      service: 'dataease',
      type: 'container.die',
      severity: 'error' as const,
      message: 'First failure',
      attributes: { sequence: 1 },
    };
    const second = {
      ...first,
      id: 'evt-aggregate-second',
      time: '2026-08-20T12:01:00.000Z',
      message: 'Second failure',
      attributes: { sequence: 2 },
    };
    const batch = {
      producer: { id: 'p1', type: 'node-agent' as const, version: '0.1.0' },
      events: [first, second],
    };

    store1.processBatch(batch, '2026-08-20T12:10:00.000Z', (event) => {
      engine.processEvent(event, event.time);
    });
    assert.equal(store1.incidentCount(), 1);
    store1.close();

    const store2 = createEventStore(dbPath);
    assert.equal(store2.incidentCount(), 1);
    assert.equal(store2.getEvent(first.id)?.event_time, first.time);
    assert.equal(store2.getEvent(second.id)?.event_time, second.time);
    assert.equal(store2.getEvent(first.id)?.receive_time, '2026-08-20T12:10:00.000Z');
    assert.equal(store2.getEvent(second.id)?.receive_time, '2026-08-20T12:10:00.000Z');
    assert.equal(store2.getEvent(first.id)?.schema_version, 1);
    assert.equal(store2.getEvent(second.id)?.schema_version, 1);
    store2.close();

    rmSync(dbPath, { recursive: true, force: true });
  });

  it('migrates legacy Event rows with a deterministic event-time backfill', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-ops-legacy-test-'));
    const dbPath = join(tmpDir, 'legacy.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        receive_time TEXT NOT NULL,
        producer_id TEXT NOT NULL,
        producer_type TEXT NOT NULL,
        producer_version TEXT NOT NULL,
        source TEXT NOT NULL,
        node_id TEXT NOT NULL,
        service TEXT NOT NULL,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        fingerprint TEXT,
        trace_id TEXT,
        message TEXT NOT NULL,
        attributes TEXT NOT NULL DEFAULT '{}'
      );
      INSERT INTO events (
        id, receive_time, producer_id, producer_type, producer_version,
        source, node_id, service, type, severity, message, attributes
      ) VALUES (
        'evt-legacy', '2026-08-20T11:59:00.000Z', 'legacy-agent', 'node-agent', '0.0.1',
        'docker', 'test-svc-02', 'dataease', 'container.die', 'error', 'Legacy event', '{}'
      );
    `);
    legacy.close();

    const migrated = createEventStore(dbPath);
    const event = migrated.getEvent('evt-legacy');
    assert.ok(event);
    assert.equal(event.schema_version, 1);
    assert.equal(event.event_time, event.receive_time);
    assert.equal(event.event_time, '2026-08-20T11:59:00.000Z');
    assert.equal(migrated.getEventProcessedAt('evt-legacy'), undefined);

    const replayBatch = {
      producer: { id: 'legacy-agent', type: 'node-agent' as const, version: '0.0.1' },
      events: [{
        schemaVersion: 1 as const,
        id: 'evt-legacy',
        time: '2026-08-20T11:59:00.000Z',
        source: 'docker' as const,
        nodeId: 'test-svc-02',
        service: 'dataease',
        type: 'container.die',
        severity: 'error' as const,
        message: 'Legacy event',
        attributes: {},
      }],
    };
    const engine = createIncidentEngine(migrated, { aggregationWindowMs: 5 * 60 * 1000 });
    const replay = () => migrated.processBatch(
      replayBatch,
      '2026-08-20T12:30:00.000Z',
      (replayed) => engine.processEvent(replayed, replayed.time),
    );

    assert.deepEqual(replay(), { inserted: 0, processed: 1 });
    assert.deepEqual(replay(), { inserted: 0, processed: 0 });
    assert.equal(migrated.incidentCount(), 1);
    assert.equal(migrated.getEventProcessedAt('evt-legacy'), '2026-08-20T12:30:00.000Z');
    assert.deepEqual(migrated.getEvent('evt-legacy'), event);
    migrated.close();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('evidence survives database close and reopen', () => {
    const { store: store1, dbPath } = setupFileDb();
    store1.insertEvidence({
      id: 'evd-survivor',
      incidentId: 'inc-survivor',
      nodeId: 'test-svc-02',
      source: 'docker',
      kind: 'docker.inspect',
      collectedAt: '2026-08-20T12:01:00.000Z',
      data: { persisted: true },
      status: 'succeeded',
    });
    store1.close();

    const store2 = createEventStore(dbPath);
    const evidence = store2.listEvidence('inc-survivor');
    assert.equal(evidence.length, 1);
    assert.deepEqual(evidence[0]?.data, { persisted: true });
    assert.equal(evidence[0]?.status, 'succeeded');
    store2.close();

    rmSync(dbPath, { recursive: true, force: true });
  });
});