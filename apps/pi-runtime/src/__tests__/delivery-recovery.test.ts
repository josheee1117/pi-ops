import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INVESTIGATION_RUNTIME_SCHEMA_VERSION } from '@pi-ops/protocol';
import { createPiRuntimeApp } from '../app.js';
import type { PiRuntimeConfig } from '../config.js';
import { createFakeRuntimeModel } from '../model.js';

function config(overrides: Partial<PiRuntimeConfig> = {}): PiRuntimeConfig {
  return {
    port: 0,
    token: 'runtime-token',
    maxBodySize: 64 * 1024,
    maxContextBytes: 16_384,
    sqlitePath: ':memory:',
    callbackBaseUrl: 'http://pi-ops-agent/v1/investigation-results',
    callbackTimeoutMs: 2000,
    executionTimeoutMs: 5000,
    deliveryBackoffMs: 20,
    maxDeliveryAttempts: 5,
    piProvider: '',
    piModel: '',
    ...overrides,
  };
}

describe('callback crash recovery', () => {
  it('retries DELIVERING work after restart without rerunning the model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-runtime-'));
    const sqlitePath = join(dir, 'runtime.sqlite');
    const model = createFakeRuntimeModel();
    let callbacks = 0;
    const first = createPiRuntimeApp(config({ sqlitePath }), {
      model,
      fetch: async () => {
        callbacks += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    await first.app.request('/v1/investigations', {
      method: 'POST',
      headers: { authorization: 'Bearer runtime-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: INVESTIGATION_RUNTIME_SCHEMA_VERSION,
        runtimeRequestId: 'rreq-delivering',
        sessionId: 'isess-1',
        incidentId: 'inc-1',
        context: {
          schemaVersion: 1,
          incident: { id: 'inc-1', type: 'application.slow_sql', service: 'svc' },
          evidence: [{ id: 'evd-now', kind: 'host.load' }],
        },
        callbackUrl: 'http://pi-ops-agent/v1/investigation-results',
      }),
    });
    await first.drain();
    const invocations = model.invocations;
    first.tasks.update('rreq-delivering', { deliveryStatus: 'delivering' });
    first.close();

    const recoveredModel = createFakeRuntimeModel();
    const recovered = createPiRuntimeApp(config({ sqlitePath }), {
      model: recoveredModel,
      fetch: async () => {
        callbacks += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    await recovered.drain();
    assert.equal(recovered.tasks.getByRequestId('rreq-delivering')?.deliveryStatus, 'delivered');
    assert.equal(recoveredModel.invocations, 0);
    assert.equal(model.invocations, invocations);
    assert.ok(callbacks >= 2);
    recovered.close();
  });
});
