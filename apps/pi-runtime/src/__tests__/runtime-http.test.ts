import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INVESTIGATION_RUNTIME_SCHEMA_VERSION } from '@pi-ops/protocol';
import { createPiRuntimeApp } from '../app.js';
import type { PiRuntimeConfig } from '../config.js';

const CONFIG: PiRuntimeConfig = {
  port: 0,
  token: 'runtime-token',
  timeoutMs: 2000,
  maxBodySize: 64 * 1024,
  maxContextBytes: 16_384,
  piProvider: '',
  piModel: '',
};

function context() {
  return {
    schemaVersion: 1,
    incident: { id: 'inc-1', type: 'application.slow_sql', service: 'data-asset-service' },
    evidence: [{ id: 'evd-now', kind: 'host.load' }],
    historicalKnowledgeStatus: 'available',
  };
}

describe('pi-runtime HTTP', () => {
  it('returns health and readiness', async () => {
    const { app } = createPiRuntimeApp(CONFIG);
    const health = await app.request('/health');
    const ready = await app.request('/ready');
    assert.equal(health.status, 200);
    assert.equal(ready.status, 200);
  });

  it('starts one runtime task for a duplicate submit', async () => {
    const callbacks: unknown[] = [];
    const { app, drain, tasks } = createPiRuntimeApp(CONFIG, {
      fetch: async () => {
        callbacks.push(1);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    const body = {
      schemaVersion: INVESTIGATION_RUNTIME_SCHEMA_VERSION,
      runtimeRequestId: 'rreq-1',
      sessionId: 'isess-1',
      incidentId: 'inc-1',
      context: context(),
      callbackUrl: 'http://pi-ops-agent/v1/investigation-results',
    };
    const first = await app.request('/v1/investigations', {
      method: 'POST',
      headers: { authorization: 'Bearer runtime-token', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const second = await app.request('/v1/investigations', {
      method: 'POST',
      headers: { authorization: 'Bearer runtime-token', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const a = await first.json() as { runtimeTaskId: string; duplicate: boolean };
    const b = await second.json() as { runtimeTaskId: string; duplicate: boolean };
    assert.equal(a.runtimeTaskId, b.runtimeTaskId);
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    await drain();
    assert.equal(tasks.getByRequestId('rreq-1')?.runtimeTaskId, a.runtimeTaskId);
    assert.equal(callbacks.length, 1);
  });
});
