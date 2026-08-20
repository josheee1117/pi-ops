import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import type { NodeAgentConfig } from '../config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<NodeAgentConfig> = {}): NodeAgentConfig {
  return {
    port: 0,
    nodeToken: 'test-token',
    nodeId: 'test-node',
    allowedContainers: new Set(['dataease']),
    dockerSocketPath: '/var/run/docker.sock',
    logsMaxLines: 200,
    logsMaxBytes: 1024 * 1024,
    probeMaxTimeoutMs: 30000,
    maxResponseBytes: 1024 * 1024,
    agentUrl: 'http://localhost:8080',
    ingestToken: 'test-token',
    eventQueueSize: 1000,
    eventSendTimeoutMs: 5000,
    eventMaxRetries: 3,
    eventFlushIntervalMs: 1000,
    ...overrides,
  };
}

function authHeaders(): Record<string, string> {
  return { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
}

// ── GET /health ──────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns ok with nodeId and allowedContainers', async () => {
    const app = createApp(makeConfig());
    const res = await app.request('/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.nodeId, 'test-node');
    assert.deepEqual(body.allowedContainers, ['dataease']);
  });
});

// ── POST /v1/evidence/query ─────────────────────────────────────────────────

describe('POST /v1/evidence/query', () => {
  it('rejects without auth token', async () => {
    const app = createApp(makeConfig());
    const res = await app.request('/v1/evidence/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'host.memory', incidentId: 'inc-1' }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects with wrong token', async () => {
    const app = createApp(makeConfig());
    const res = await app.request('/v1/evidence/query', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'host.memory', incidentId: 'inc-1' }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects invalid JSON body', async () => {
    const app = createApp(makeConfig());
    const res = await app.request('/v1/evidence/query', {
      method: 'POST',
      headers: authHeaders(),
      body: 'not json',
    });
    assert.equal(res.status, 400);
  });

  it('rejects unknown query type', async () => {
    const app = createApp(makeConfig());
    const res = await app.request('/v1/evidence/query', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ type: 'docker.exec', incidentId: 'inc-1' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'validation failed');
  });

  it('rejects missing incidentId', async () => {
    const app = createApp(makeConfig());
    const res = await app.request('/v1/evidence/query', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ type: 'host.memory' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects unlisted container', async () => {
    const app = createApp(makeConfig());
    const res = await app.request('/v1/evidence/query', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        type: 'docker.inspect',
        incidentId: 'inc-1',
        container: 'unknown-container',
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.details.some((d: { message: string }) => d.message.includes('allowlist')));
  });

  it('accepts host.memory query (no Docker needed)', async () => {
    const app = createApp(makeConfig());
    const res = await app.request('/v1/evidence/query', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ type: 'host.memory', incidentId: 'inc-1' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.incidentId, 'inc-1');
    assert.equal(body.nodeId, 'test-node');
    assert.equal(body.source, 'host');
    assert.equal(body.kind, 'host.memory');
    assert.ok(typeof body.data.total === 'number');
    assert.ok(typeof body.data.free === 'number');
    assert.ok(typeof body.data.usagePercent === 'string');
  });
});