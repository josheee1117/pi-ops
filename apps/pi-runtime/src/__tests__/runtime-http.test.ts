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

function context() {
  return {
    schemaVersion: 1,
    incident: { id: 'inc-1', type: 'application.slow_sql', service: 'data-asset-service' },
    evidence: [{ id: 'evd-now', kind: 'host.load' }],
    historicalKnowledgeStatus: 'available' as const,
  };
}

function submitBody(runtimeRequestId = 'rreq-1') {
  return {
    schemaVersion: INVESTIGATION_RUNTIME_SCHEMA_VERSION,
    runtimeRequestId,
    sessionId: 'isess-1',
    incidentId: 'inc-1',
    context: context(),
    callbackUrl: 'http://pi-ops-agent/v1/investigation-results',
  };
}

async function post(app: ReturnType<typeof createPiRuntimeApp>['app'], body: unknown) {
  return app.request('/v1/investigations', {
    method: 'POST',
    headers: { authorization: 'Bearer runtime-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('pi-runtime HTTP', () => {
  it('returns health and readiness', async () => {
    const runtime = createPiRuntimeApp(config());
    const health = await runtime.app.request('/health');
    const ready = await runtime.app.request('/ready');
    assert.equal(health.status, 200);
    assert.equal(ready.status, 200);
    runtime.close();
  });

  it('starts one runtime task for a duplicate submit', async () => {
    const callbacks: unknown[] = [];
    const model = createFakeRuntimeModel();
    const runtime = createPiRuntimeApp(config(), {
      model,
      fetch: async () => {
        callbacks.push(1);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    const first = await post(runtime.app, submitBody());
    const second = await post(runtime.app, submitBody());
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const a = await first.json() as { runtimeTaskId: string; duplicate: boolean };
    const b = await second.json() as { runtimeTaskId: string; duplicate: boolean };
    assert.equal(a.runtimeTaskId, b.runtimeTaskId);
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    await runtime.drain();
    assert.equal(runtime.tasks.getByRequestId('rreq-1')?.runtimeTaskId, a.runtimeTaskId);
    assert.equal(callbacks.length, 1);
    assert.equal(model.networkCalls, 0);
    runtime.close();
  });

  it('retries a failed callback until delivery succeeds', async () => {
    let attempts = 0;
    const runtime = createPiRuntimeApp(config({ deliveryBackoffMs: 15 }), {
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) return new Response('unavailable', { status: 500 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    assert.equal((await post(runtime.app, submitBody())).status, 200);
    await runtime.drain();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await runtime.drain();
    assert.equal(attempts, 2);
    assert.equal(runtime.tasks.getByRequestId('rreq-1')?.deliveryStatus, 'delivered');
    runtime.close();
  });

  it('resumes pending delivery after restart without rerunning the model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-runtime-'));
    const sqlitePath = join(dir, 'runtime.sqlite');
    const model = createFakeRuntimeModel();
    let attempts = 0;
    const failing = createPiRuntimeApp(config({ sqlitePath, maxDeliveryAttempts: 5, deliveryBackoffMs: 60_000 }), {
      model,
      fetch: async () => {
        attempts += 1;
        return new Response('unavailable', { status: 503 });
      },
    });
    assert.equal((await post(failing.app, submitBody('rreq-restart'))).status, 200);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const current = failing.tasks.getByRequestId('rreq-restart');
      if (current?.executionStatus === 'completed' && (current.deliveryAttempts >= 1 || current.deliveryStatus === 'pending')) break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const invocations = model.invocations;
    assert.equal(failing.tasks.getByRequestId('rreq-restart')?.executionStatus, 'completed');
    assert.ok(failing.tasks.getByRequestId('rreq-restart')?.result);
    failing.close();

    const recoveredModel = createFakeRuntimeModel();
    const recovered = createPiRuntimeApp(config({ sqlitePath, deliveryBackoffMs: 10 }), {
      model: recoveredModel,
      fetch: async () => {
        attempts += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    await recovered.drain();
    assert.equal(recovered.tasks.getByRequestId('rreq-restart')?.deliveryStatus, 'delivered');
    assert.equal(recoveredModel.invocations, 0);
    assert.equal(model.invocations, invocations);
    recovered.close();
  });

  it('does not rerun execution on duplicate submit after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-runtime-'));
    const sqlitePath = join(dir, 'runtime.sqlite');
    const first = createPiRuntimeApp(config({ sqlitePath }), {
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    await post(first.app, submitBody('rreq-dup'));
    await first.drain();
    first.close();
    const model = createFakeRuntimeModel();
    const second = createPiRuntimeApp(config({ sqlitePath }), {
      model,
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    const duplicate = await post(second.app, submitBody('rreq-dup'));
    const body = await duplicate.json() as { duplicate: boolean };
    assert.equal(body.duplicate, true);
    await second.drain();
    assert.equal(model.invocations, 0);
    second.close();
  });

  it('persists runtime metadata on the task', async () => {
    const runtime = createPiRuntimeApp(config(), {
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    await post(runtime.app, submitBody('rreq-meta'));
    await runtime.drain();
    const task = runtime.tasks.getByRequestId('rreq-meta');
    assert.equal(task?.metadata?.provider, 'fake');
    assert.equal(task?.metadata?.model, 'deterministic');
    assert.ok((task?.metadata?.selectedSpecialists.length ?? 0) > 0);
    assert.ok((task?.metadata?.inputTokens ?? 0) >= 0);
    runtime.close();
  });

  it('rejects an arbitrary callback destination', async () => {
    const runtime = createPiRuntimeApp(config());
    const response = await post(runtime.app, {
      ...submitBody(),
      callbackUrl: 'http://evil.example/steal',
    });
    assert.equal(response.status, 400);
    runtime.close();
  });
});
