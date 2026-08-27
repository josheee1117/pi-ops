import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import type { AgentConfig } from '../config.js';
import { createIncidentEngine } from '../incident.js';
import { createInvestigationEvidenceService } from '../investigation-evidence.js';
import { createInvestigationLoopService } from '../investigation-loop.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';
import type { EvidenceOrchestrator } from '../evidence-orchestrator.js';

const CONFIG: AgentConfig = {
  port: 0,
  ingestToken: 'ingest-token',
  sqlitePath: ':memory:',
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

function seed() {
  const store = createEventStore(':memory:');
  const incident = store.createIncident({
    service: 'data-asset-service',
    node_id: 'test-svc-02',
    type: 'application.slow_sql',
    state: 'OPEN',
    fingerprint: 'fp-evd-req',
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'warning',
  } satisfies Omit<IncidentRow, 'id'>);
  store.insertEvidence({
    id: 'evd-now',
    incidentId: incident.id,
    nodeId: 'test-svc-02',
    source: 'host',
    kind: 'host.load',
    collectedAt: '2026-08-20T12:00:01.000Z',
    data: { load1: 0.2 },
    status: 'succeeded',
  } satisfies EvidenceRecord);
  return { store, incident };
}

describe('typed investigation evidence requests', () => {
  it('reuses existing Evidence and rejects forbidden capabilities', async () => {
    const { store, incident } = seed();
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(incident.id);
    await loop.submit(session.id);
    const task = store.getDelegationTask(session.delegationTaskId)!;
    store.markDelegationTaskSubmitted(task.id, new Date().toISOString(), 'rtask-1');
    const submitted = store.getDelegationTask(session.delegationTaskId)!;
    const orchestrator: EvidenceOrchestrator = {
      async collectForIncident() {
        return { incidentId: incident.id, requested: 0, succeeded: 0, failed: 0, retryableFailures: 0, terminalFailures: 0 };
      },
      async collectQueriesForIncident() {
        return { incidentId: incident.id, requested: 0, succeeded: 0, failed: 0, retryableFailures: 0, terminalFailures: 0 };
      },
    };
    const evidence = createInvestigationEvidenceService(store, CONFIG, orchestrator);
    const engine = createIncidentEngine(store, { aggregationWindowMs: CONFIG.aggregationWindowMs });
    const app = createApp(CONFIG, store, engine, undefined, loop, evidence);
    const ok = await app.request('/v1/investigation-evidence', {
      method: 'POST',
      headers: { authorization: 'Bearer runtime-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        runtimeRequestId: session.runtimeRequestId,
        runtimeTaskId: submitted.runtimeTaskId,
        sessionId: session.id,
        requests: [{ requestId: 'r1', type: 'host.load' }],
      }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json() as { results: Array<{ status: string; evidenceId: string }> };
    assert.equal(body.results[0]?.status, 'collected');
    assert.equal(body.results[0]?.evidenceId, 'evd-now');

    const forbidden = await app.request('/v1/investigation-evidence', {
      method: 'POST',
      headers: { authorization: 'Bearer runtime-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        runtimeRequestId: session.runtimeRequestId,
        runtimeTaskId: submitted.runtimeTaskId,
        sessionId: session.id,
        requests: [{ requestId: 'r2', type: 'bash' }],
      }),
    });
    assert.equal(forbidden.status, 400);

    const ingest = await app.request('/v1/investigation-evidence', {
      method: 'POST',
      headers: { authorization: 'Bearer ingest-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        runtimeRequestId: session.runtimeRequestId,
        runtimeTaskId: submitted.runtimeTaskId,
        sessionId: session.id,
        requests: [{ requestId: 'r3', type: 'host.load' }],
      }),
    });
    assert.equal(ingest.status, 401);
    store.close();
  });
});
