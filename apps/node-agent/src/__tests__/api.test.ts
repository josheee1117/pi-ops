import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { makeNodeAgentConfig as makeConfig } from './test-config.js';

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

  it('rejects a declared oversized request body', async () => {
    const app = createApp(makeConfig({ maxRequestBytes: 32 }));
    const res = await app.request('/v1/evidence/query', {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Length': '1024',
      },
      body: JSON.stringify({ type: 'host.memory', incidentId: 'inc-1' }),
    });
    assert.equal(res.status, 413);
  });

  it('rejects an oversized chunked body without Content-Length', async () => {
    const app = createApp(makeConfig({ maxRequestBytes: 32 }));
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"padding":"'));
        controller.enqueue(encoder.encode('x'.repeat(128)));
        controller.enqueue(encoder.encode('"}'));
        controller.close();
      },
    });
    const request = new Request('http://localhost/v1/evidence/query', {
      method: 'POST',
      headers: authHeaders(),
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const res = await app.fetch(request);
    assert.equal(res.status, 413);
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