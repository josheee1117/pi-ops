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
  eventReplayBatchSize: 100,
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

interface LegacyEventInput {
  id: string;
  receiveTime: string;
  type: string;
  severity: string;
  message: string;
}

function setupLegacyEventsDb(events: LegacyEventInput[]): { dbPath: string; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pi-ops-legacy-events-'));
  const dbPath = join(tmpDir, 'legacy.db');
  const db = new Database(dbPath);
  db.exec(`
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
  `);
  const insert = db.prepare(`
    INSERT INTO events (
      id, receive_time, producer_id, producer_type, producer_version,
      source, node_id, service, type, severity, message, attributes
    ) VALUES (
      @id, @receive_time, 'legacy-agent', 'node-agent', '0.0.1',
      'health', 'test-svc-02', 'dataease', @type, @severity, @message, '{}'
    );
  `);
  for (const event of events) {
    insert.run({
      id: event.id,
      receive_time: event.receiveTime,
      type: event.type,
      severity: event.severity,
      message: event.message,
    });
  }
  db.close();
  return { dbPath, tmpDir };
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
    let wakes = 0;
    const worker: EvidenceJobWorker = {
      start() {},
      async stop() {},
      wake() { wakes++; },
      async runOnce() {},
    };
    const app = createApp(config, store, failingEngine, worker);

    const res = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(makeValidBatch(1)),
    });

    assert.equal(res.status, 500);
    assert.equal(store.count(), 0);
    assert.equal(store.incidentCount(), 0);
    assert.equal(store.listPendingEvidenceJobs(10).length, 0);
    assert.equal(wakes, 0);

    // The same Event remains retryable because the failed transaction left no
    // immutable Event row or Incident side effects behind.
    const recoveredApp = createApp(config, store, realEngine, worker);
    const retry = await recoveredApp.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(makeValidBatch(1)),
    });
    assert.equal(retry.status, 200);
    assert.equal(store.count(), 1);
    assert.equal(store.incidentCount(), 1);
    assert.equal(store.listPendingEvidenceJobs(10).length, 1);
    assert.equal(wakes, 1);
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

  it('accepts an exact Event retry after producer envelope version changes', async () => {
    const { app, store } = setupInMemory();
    const firstBatch = makeValidBatch(1);
    const retriedBatch = makeValidBatch(1);
    (retriedBatch.producer as Record<string, unknown>)['version'] = '0.2.0';

    const first = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(firstBatch),
    });
    const retry = await app.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(retriedBatch),
    });

    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    assert.equal(store.count(), 1);
    assert.equal(store.incidentCount(), 1);
    assert.equal(store.listPendingEvidenceJobs(10).length, 1);
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
      JSON.stringify(['docker', 'test-svc-02', 'dataease', 'container.die']),
      '2026-08-20T12:00:00.000Z',
      config.aggregationWindowMs,
    ));
    assert.equal(store.findActiveIncident(
      JSON.stringify(['docker', 'test-svc-02', 'dataease', 'container.oom']),
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
      JSON.stringify(['docker', 'test-svc-02', 'dataease', 'container.die']),
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
      JSON.stringify(['health', 'test-svc-02', 'dataease', 'health.failure']),
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
      JSON.stringify(['docker', 'test-svc-02', 'dataease', 'container.die']),
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

  it('rejects conflicting duplicate payload after database reopen', async () => {
    const { app: app1, store: store1, dbPath } = setupFileDb();
    assert.equal((await app1.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(makeValidBatch(1)),
    })).status, 200);
    store1.close();

    const config = makeTestConfig(dbPath);
    const store2 = createEventStore(dbPath);
    const engine2 = createIncidentEngine(store2, {
      aggregationWindowMs: config.aggregationWindowMs,
    });
    const app2 = createApp(config, store2, engine2);
    const conflict = makeValidBatch(1);
    Object.assign((conflict.events as Record<string, unknown>[])[0]!, {
      type: 'container.oom',
      message: 'Conflicting payload after restart',
    });

    const response = await app2.request('/v1/events', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(conflict),
    });

    assert.equal(response.status, 409);
    assert.equal(store2.count(), 1);
    assert.equal(store2.incidentCount(), 1);
    assert.equal(store2.listPendingEvidenceJobs(10).length, 1);
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

    store1.processBatch(
      batch,
      '2026-08-20T12:10:00.000Z',
      (event) => engine.processEvent(event, event.time),
    );
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

  it('migrates legacy Incident fingerprints before new aggregation', () => {
    const { store: store1, dbPath } = setupFileDb();
    const engine1 = createIncidentEngine(store1, { aggregationWindowMs: 5 * 60 * 1000 });
    const first = {
      schemaVersion: 1 as const,
      id: 'evt-legacy-fingerprint-1',
      time: '2026-08-20T12:00:00.000Z',
      source: 'docker' as const,
      nodeId: 'test-svc-02',
      service: 'dataease',
      type: 'container.die',
      severity: 'error' as const,
      message: 'First legacy fingerprint event',
      attributes: {},
    };
    const producer = { id: 'p1', type: 'node-agent' as const, version: '0.1.0' };
    store1.processBatch(
      { producer, events: [first] },
      '2026-08-20T12:00:01.000Z',
      (event) => engine1.processEvent(event, event.time),
    );
    const incidentId = store1.findIncidentByEventId(first.id)?.id;
    assert.ok(incidentId);
    store1.close();

    const legacy = new Database(dbPath);
    legacy.prepare('UPDATE incidents SET fingerprint = ? WHERE id = ?').run(
      'docker:test-svc-02:dataease:container.die',
      incidentId,
    );
    legacy.close();

    const store2 = createEventStore(dbPath);
    const expectedFingerprint = JSON.stringify([
      'docker',
      'test-svc-02',
      'dataease',
      'container.die',
    ]);
    assert.equal(store2.getIncident(incidentId)?.fingerprint, expectedFingerprint);
    const engine2 = createIncidentEngine(store2, { aggregationWindowMs: 5 * 60 * 1000 });
    const second = {
      ...first,
      id: 'evt-legacy-fingerprint-2',
      time: '2026-08-20T12:01:00.000Z',
      message: 'Second legacy fingerprint event',
    };
    store2.processBatch(
      { producer, events: [second] },
      '2026-08-20T12:01:01.000Z',
      (event) => engine2.processEvent(event, event.time),
    );

    assert.equal(store2.incidentCount(), 1);
    assert.equal(store2.getIncident(incidentId)?.event_count, 2);
    assert.equal(store2.findIncidentByEventId(second.id)?.id, incidentId);
    store2.close();
    rmSync(dbPath, { recursive: true, force: true });
  });

  it('rolls back migration when one Incident links heterogeneous Event identities', () => {
    const { store, dbPath } = setupFileDb();
    const engine = createIncidentEngine(store, { aggregationWindowMs: 5 * 60 * 1000 });
    const producer = { id: 'p1', type: 'node-agent' as const, version: '0.1.0' };
    const first = {
      schemaVersion: 1 as const,
      id: 'evt-mixed-identity-a',
      time: '2026-08-20T12:00:00.000Z',
      source: 'docker' as const,
      nodeId: 'node-a',
      service: 'service-a',
      type: 'container.die',
      severity: 'error' as const,
      message: 'Identity A',
      attributes: {},
    };
    const second = {
      ...first,
      id: 'evt-mixed-identity-b',
      nodeId: 'node-b',
      service: 'service-b',
      message: 'Identity B',
    };
    store.processBatch(
      { producer, events: [first, second] },
      '2026-08-20T12:00:01.000Z',
      (event) => engine.processEvent(event, event.time),
    );
    const firstIncident = store.findIncidentByEventId(first.id)?.id;
    const secondIncident = store.findIncidentByEventId(second.id)?.id;
    assert.ok(firstIncident);
    assert.ok(secondIncident);
    store.close();

    const corrupt = new Database(dbPath);
    corrupt.prepare('UPDATE incidents SET fingerprint = ? WHERE id = ?').run(
      'legacy-shared-fingerprint',
      firstIncident,
    );
    corrupt.prepare('UPDATE incident_events SET incident_id = ? WHERE event_id = ?').run(
      firstIncident,
      second.id,
    );
    corrupt.prepare('DELETE FROM evidence_jobs WHERE incident_id = ?').run(secondIncident);
    corrupt.prepare('DELETE FROM incidents WHERE id = ?').run(secondIncident);
    corrupt.close();

    assert.throws(
      () => createEventStore(dbPath),
      /links Events with multiple central identities/,
    );
    const verifyRollback = new Database(dbPath, { readonly: true });
    const row = verifyRollback.prepare(
      'SELECT fingerprint FROM incidents WHERE id = ?',
    ).get(firstIncident) as { fingerprint: string };
    assert.equal(row.fingerprint, 'legacy-shared-fingerprint');
    verifyRollback.close();
    rmSync(dbPath, { recursive: true, force: true });
  });

  it('fails migration for an active Incident without an immutable Event link', () => {
    const { store, dbPath } = setupFileDb();
    store.createIncident({
      service: 'dataease',
      node_id: 'test-svc-02',
      type: 'container.die',
      state: 'OPEN',
      fingerprint: 'legacy-unlinked',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'error',
    });
    store.close();

    assert.throws(
      () => createEventStore(dbPath),
      /has no linked immutable Event/,
    );
    rmSync(dbPath, { recursive: true, force: true });
  });

  it('migrates legacy Event rows with a deterministic event-time backfill', () => {
    const { dbPath, tmpDir } = setupLegacyEventsDb([{
      id: 'evt-legacy',
      receiveTime: '2026-08-20T11:59:00.000Z',
      type: 'health.failure',
      severity: 'error',
      message: 'Legacy event',
    }]);

    const migrated = createEventStore(dbPath);
    const event = migrated.getEvent('evt-legacy');
    assert.ok(event);
    assert.equal(event.schema_version, 1);
    assert.equal(event.event_time, event.receive_time);
    assert.equal(event.event_time, '2026-08-20T11:59:00.000Z');
    assert.equal(migrated.getEventProcessedAt('evt-legacy'), undefined);

    const engine = createIncidentEngine(migrated, { aggregationWindowMs: 5 * 60 * 1000 });
    const replay = () => migrated.replayPendingEvents(
      (replayed) => engine.processEvent(replayed, replayed.time),
      '2026-08-20T12:30:00.000Z',
      100,
    );

    assert.equal(replay(), 1);
    assert.equal(replay(), 0);
    assert.equal(migrated.incidentCount(), 1);
    assert.equal(migrated.listPendingEvidenceJobs(10).length, 1);
    assert.equal(migrated.getEventProcessedAt('evt-legacy'), '2026-08-20T12:30:00.000Z');
    assert.deepEqual(migrated.getEvent('evt-legacy'), event);
    migrated.close();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replays a legacy failure then recovery into one recovered Incident', () => {
    const { dbPath, tmpDir } = setupLegacyEventsDb([
      {
        id: 'evt-legacy-failure',
        receiveTime: '2026-08-20T12:00:00.000Z',
        type: 'health.failure',
        severity: 'error',
        message: 'Legacy health failure',
      },
      {
        id: 'evt-legacy-recovery',
        receiveTime: '2026-08-20T12:10:00.000Z',
        type: 'health.recovered',
        severity: 'info',
        message: 'Legacy health recovery',
      },
    ]);
    const store = createEventStore(dbPath);
    const engine = createIncidentEngine(store, { aggregationWindowMs: 5 * 60 * 1000 });

    assert.equal(store.replayPendingEvents(
      (event) => engine.processEvent(event, event.time),
      '2026-08-20T12:30:00.000Z',
      1,
    ), 1);
    assert.equal(store.findIncidentByEventId('evt-legacy-failure')?.state, 'OPEN');
    assert.equal(store.getEventProcessedAt('evt-legacy-recovery'), undefined);
    store.close();

    // Simulate a process restart between committed replay batches.
    const resumedStore = createEventStore(dbPath);
    const resumedEngine = createIncidentEngine(resumedStore, {
      aggregationWindowMs: 5 * 60 * 1000,
    });
    const replayBatch = () => resumedStore.replayPendingEvents(
      (event) => resumedEngine.processEvent(event, event.time),
      '2026-08-20T12:31:00.000Z',
      1,
    );
    assert.equal(replayBatch(), 1);
    assert.equal(replayBatch(), 0);
    assert.equal(resumedStore.incidentCount(), 1);
    const incident = resumedStore.findIncidentByEventId('evt-legacy-failure');
    assert.ok(incident);
    assert.equal(incident.state, 'RECOVERED');
    assert.equal(incident.event_count, 2);
    assert.equal(resumedStore.findIncidentByEventId('evt-legacy-recovery')?.id, incident.id);
    assert.ok(resumedStore.getEventProcessedAt('evt-legacy-failure'));
    assert.ok(resumedStore.getEventProcessedAt('evt-legacy-recovery'));
    assert.equal(resumedStore.listPendingEvidenceJobs(10).length, 1);
    resumedStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replays offset datetimes in chronological rather than lexical order', () => {
    const { dbPath, tmpDir } = setupLegacyEventsDb([
      {
        id: 'evt-offset-failure',
        receiveTime: '2026-08-20T12:00:00.000+02:00',
        type: 'health.failure',
        severity: 'error',
        message: 'Offset health failure',
      },
      {
        id: 'evt-offset-recovery',
        receiveTime: '2026-08-20T10:30:00.000Z',
        type: 'health.recovered',
        severity: 'info',
        message: 'UTC health recovery',
      },
    ]);
    const store = createEventStore(dbPath);
    const engine = createIncidentEngine(store, { aggregationWindowMs: 5 * 60 * 1000 });

    assert.equal(store.replayPendingEvents(
      (event) => engine.processEvent(event, event.time),
      '2026-08-20T12:30:00.000Z',
      100,
    ), 2);

    const incident = store.findIncidentByEventId('evt-offset-failure');
    assert.ok(incident);
    assert.equal(incident.state, 'RECOVERED');
    assert.equal(store.findIncidentByEventId('evt-offset-recovery')?.id, incident.id);
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replays a legacy recovery before failure without closing the later Incident', () => {
    const { dbPath, tmpDir } = setupLegacyEventsDb([
      {
        id: 'evt-legacy-early-recovery',
        receiveTime: '2026-08-20T12:00:00.000Z',
        type: 'health.recovered',
        severity: 'info',
        message: 'Early legacy recovery',
      },
      {
        id: 'evt-legacy-later-failure',
        receiveTime: '2026-08-20T12:10:00.000Z',
        type: 'health.failure',
        severity: 'error',
        message: 'Later legacy failure',
      },
    ]);
    const store = createEventStore(dbPath);
    const engine = createIncidentEngine(store, { aggregationWindowMs: 5 * 60 * 1000 });

    const replayed = store.replayPendingEvents(
      (event) => engine.processEvent(event, event.time),
      '2026-08-20T12:30:00.000Z',
      100,
    );

    assert.equal(replayed, 2);
    assert.equal(store.incidentCount(), 1);
    const incident = store.findIncidentByEventId('evt-legacy-later-failure');
    assert.ok(incident);
    assert.equal(incident.state, 'OPEN');
    assert.equal(incident.event_count, 1);
    assert.equal(store.findIncidentByEventId('evt-legacy-early-recovery'), undefined);
    assert.ok(store.getEventProcessedAt('evt-legacy-early-recovery'));
    assert.ok(store.getEventProcessedAt('evt-legacy-later-failure'));
    assert.equal(store.listPendingEvidenceJobs(10).length, 1);
    store.close();
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