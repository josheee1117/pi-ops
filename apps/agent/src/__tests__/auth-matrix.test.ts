import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import type { AgentConfig } from '../config.js';
import { createEventStore } from '../store.js';
import { createIncidentEngine } from '../incident.js';
import { createInvestigationLoopService } from '../investigation-loop.js';
import { createInvestigationEvidenceService } from '../investigation-evidence.js';
import { createEvidenceOrchestrator } from '../evidence-orchestrator.js';

function config(): AgentConfig {
  return {
    port: 0,
    ingestToken: 'ingest-token',
    operatorToken: 'operator-token',
    investigationRetryMaxAttempts: 3,
    investigationRetryBackoffMs: 0,
    investigationStaleTimeoutMs: 60_000,
    externalRuntimeEnabled: false,
    sqlitePath: ':memory:',
    nodeId: 'central',
    maxBodySize: 1024 * 1024,
    aggregationWindowMs: 5 * 60 * 1000,
    nodeAgents: new Map([
      ['test-svc-02', { nodeId: 'test-svc-02', url: 'http://node-agent.test', token: 'node-token' }],
    ]),
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
    piRuntimeToken: 'runtime-token',
  };
}

function setup() {
  const cfg = config();
  const store = createEventStore(':memory:');
  const engine = createIncidentEngine(store, { aggregationWindowMs: cfg.aggregationWindowMs });
  const orchestrator = createEvidenceOrchestrator(cfg, store);
  const app = createApp(
    cfg,
    store,
    engine,
    undefined,
    createInvestigationLoopService(store),
    createInvestigationEvidenceService(store, cfg, orchestrator),
  );
  return { app, store, close: () => store.close() };
}

describe('token domain separation', () => {
  it('allows ingest only on /v1/events and rejects ops and runtime routes', async () => {
    const { app, close } = setup();
    const ingest = { Authorization: 'Bearer ingest-token', 'Content-Type': 'application/json' };
    const events = await app.request('/v1/events', {
      method: 'POST',
      headers: ingest,
      body: JSON.stringify({
        producer: { id: 'n', type: 'node-agent', version: '1' },
        events: [{
          schemaVersion: 1,
          id: 'evt-auth-1',
          time: '2026-08-20T12:00:00.000Z',
          source: 'docker',
          nodeId: 'test-svc-02',
          service: 'pi-ops-drill',
          type: 'container.die',
          severity: 'error',
          message: 'died',
          attributes: {},
        }],
      }),
    });
    assert.equal(events.status, 200);
    assert.equal((await app.request('/v1/ops/incidents', { headers: ingest })).status, 401);
    assert.equal((await app.request('/v1/ops/incidents/inc-x/evidence?view=raw', { headers: ingest })).status, 401);
    assert.equal((await app.request('/v1/investigation-results', { method: 'POST', headers: ingest, body: '{}' })).status, 401);
    assert.equal((await app.request('/v1/investigation-evidence', { method: 'POST', headers: ingest, body: '{}' })).status, 401);
    close();
  });

  it('allows operator on /v1/ops and rejects ingest and runtime routes', async () => {
    const { app, store, close } = setup();
    const operator = { Authorization: 'Bearer operator-token' };
    const ingest = {
      Authorization: 'Bearer ingest-token',
      'Content-Type': 'application/json',
    };
    await app.request('/v1/events', {
      method: 'POST',
      headers: ingest,
      body: JSON.stringify({
        producer: { id: 'n', type: 'node-agent', version: '1' },
        events: [{
          schemaVersion: 1,
          id: 'evt-auth-2',
          time: '2026-08-20T12:00:00.000Z',
          source: 'docker',
          nodeId: 'test-svc-02',
          service: 'pi-ops-drill',
          type: 'container.die',
          severity: 'error',
          message: 'died',
          attributes: {},
        }],
      }),
    });
    const incident = store.listIncidents()[0]!;
    assert.equal((await app.request('/v1/ops/incidents', { headers: operator })).status, 200);
    assert.equal((await app.request(`/v1/ops/incidents/${incident.id}`, { headers: operator })).status, 200);
    assert.equal((await app.request(`/v1/ops/incidents/${incident.id}/evidence?view=raw`, { headers: operator })).status, 200);
    assert.equal((await app.request('/v1/events', { method: 'POST', headers: { ...operator, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await app.request('/v1/investigation-results', { method: 'POST', headers: { ...operator, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    close();
  });

  it('allows runtime token only on runtime callback routes', async () => {
    const { app, close } = setup();
    const runtime = { Authorization: 'Bearer runtime-token', 'Content-Type': 'application/json' };
    assert.equal((await app.request('/v1/ops/incidents', { headers: runtime })).status, 401);
    assert.equal((await app.request('/v1/ops/incidents/inc-x/evidence?view=raw', { headers: runtime })).status, 401);
    assert.equal((await app.request('/v1/events', { method: 'POST', headers: runtime, body: '{}' })).status, 401);
    const results = await app.request('/v1/investigation-results', { method: 'POST', headers: runtime, body: '{}' });
    const evidence = await app.request('/v1/investigation-evidence', { method: 'POST', headers: runtime, body: '{}' });
    assert.notEqual(results.status, 401);
    assert.notEqual(evidence.status, 401);
    close();
  });
});
