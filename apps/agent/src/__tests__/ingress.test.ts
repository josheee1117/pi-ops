import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Hono } from 'hono';
import { createApp } from '../app.js';
import { createEventStore, type EventStore } from '../store.js';
import type { AgentConfig } from '../config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Omit<AgentConfig, 'sqlitePath'> = {
  port: 0,
  ingestToken: 'test-token',
  nodeId: 'test-node',
  maxBodySize: 1024 * 1024,
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

function setupInMemory(): { app: Hono; store: EventStore } {
  const config = makeTestConfig(':memory:');
  const store = createEventStore(':memory:');
  const app = createApp(config, store);
  return { app, store };
}

function setupFileDb(): { app: Hono; store: EventStore; dbPath: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pi-ops-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const config = makeTestConfig(dbPath);
  const store = createEventStore(dbPath);
  const app = createApp(config, store);
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
    // Still reports accepted (the event is valid, INSERT OR IGNORE handles dup)
    assert.equal(body.accepted, 1);
    assert.equal(store.count(), 1); // no new row
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

    // Insert an event
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
          message: 'Survived restart',
          attributes: { persisted: true },
        },
      ],
    };
    store1.insertBatch(batch, '2026-08-20T12:00:00.000Z');
    assert.equal(store1.count(), 1);
    store1.close();

    // Simulate restart: open a new store on the same file
    const store2 = createEventStore(dbPath);
    assert.equal(store2.count(), 1);
    store2.close();

    // Cleanup
    rmSync(dbPath, { recursive: true, force: true });
  });
});