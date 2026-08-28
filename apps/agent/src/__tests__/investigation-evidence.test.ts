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
    operatorToken: 'operator-token',
    investigationRetryMaxAttempts: 3,
    investigationRetryBackoffMs: 0,
    investigationStaleTimeoutMs: 60_000,
    externalRuntimeEnabled: false,
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
  it('scopes reuse to the session and rejects forbidden capabilities', async () => {
    const { store, incident } = seed();
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(incident.id);
    await loop.submit(session.id);
    const task = store.getDelegationTask(session.delegationTaskId)!;
    store.markDelegationTaskSubmitted(task.id, new Date().toISOString(), 'rtask-1');
    const submitted = store.getDelegationTask(session.delegationTaskId)!;
    let collections = 0;
    const orchestrator: EvidenceOrchestrator = {
      async collectForIncident() {
        return { incidentId: incident.id, requested: 0, succeeded: 0, failed: 0, retryableFailures: 0, terminalFailures: 0 };
      },
      async collectQueriesForIncident(target, queries, collectionId) {
        collections += 1;
        for (const query of queries) {
          store.insertEvidence({
            id: `${collectionId}-evidence-${query.type}`,
            incidentId: target.id,
            nodeId: target.node_id,
            source: 'host',
            kind: query.type,
            collectedAt: '2026-08-20T12:00:05.000Z',
            data: { queryType: query.type },
            status: 'succeeded',
          });
        }
        return { incidentId: target.id, requested: queries.length, succeeded: queries.length, failed: 0, retryableFailures: 0, terminalFailures: 0 };
      },
    };
    const evidence = createInvestigationEvidenceService(store, CONFIG, orchestrator);
    const engine = createIncidentEngine(store, { aggregationWindowMs: CONFIG.aggregationWindowMs });
    const app = createApp(CONFIG, store, engine, undefined, loop, evidence);
    const request = (requestId: string, type: string, token = 'runtime-token') => app.request('/v1/investigation-evidence', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        runtimeRequestId: session.runtimeRequestId,
        runtimeTaskId: submitted.runtimeTaskId,
        sessionId: session.id,
        requests: [{ requestId, type, requestingRoles: ['database'] }],
      }),
    });

    // A pre-existing host.load Evidence row from initial collection is not a
    // fresh answer: this attempt collects its own session-scoped Evidence.
    const first = await request('r1', 'host.load');
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { results: Array<{ status: string; evidenceId: string }> };
    assert.equal(firstBody.results[0]?.status, 'collected');
    assert.equal(firstBody.results[0]?.evidenceId, `inv-${session.id}-evidence-host.load`);
    assert.notEqual(firstBody.results[0]?.evidenceId, 'evd-now');
    assert.equal(collections, 1);

    // Same session + same capability reuses the session-scoped Evidence.
    const second = await request('r1', 'host.load');
    const secondBody = await second.json() as { results: Array<{ evidenceId: string }> };
    assert.equal(secondBody.results[0]?.evidenceId, `inv-${session.id}-evidence-host.load`);
    assert.equal(collections, 1);
    assert.ok(store.getEvidence('evd-now'));

    assert.equal((await request('r2', 'bash')).status, 400);
    assert.equal((await request('r3', 'host.disk')).status, 400);
    assert.equal((await request('r4', 'host.load', 'ingest-token')).status, 401);
    store.close();
  });

  it('collects fresh host.memory for a later attempt despite 10:00 history', async () => {
    const { store, incident } = seed();
    store.insertEvidence({
      id: `incident-${incident.id}-evidence-host.memory`,
      incidentId: incident.id,
      nodeId: 'test-svc-02',
      source: 'host',
      kind: 'host.memory',
      collectedAt: '2026-08-20T10:00:00.000Z',
      data: { stale: true },
      status: 'succeeded',
    });
    const loop = createInvestigationLoopService(store, {
      now: () => '2026-08-20T10:30:00.000Z',
    });
    const { session } = loop.start(incident.id);
    await loop.submit(session.id);
    store.markDelegationTaskSubmitted(session.delegationTaskId, '2026-08-20T10:30:00.000Z', 'rtask-fresh');
    const orchestrator: EvidenceOrchestrator = {
      async collectForIncident() {
        return { incidentId: incident.id, requested: 0, succeeded: 0, failed: 0, retryableFailures: 0, terminalFailures: 0 };
      },
      async collectQueriesForIncident(target, queries, collectionId) {
        for (const query of queries) {
          store.insertEvidence({
            id: `${collectionId}-evidence-${query.type}`,
            incidentId: target.id,
            nodeId: target.node_id,
            source: 'host',
            kind: query.type,
            collectedAt: '2026-08-20T10:30:05.000Z',
            data: { fresh: true },
            status: 'succeeded',
          });
        }
        return { incidentId: target.id, requested: queries.length, succeeded: queries.length, failed: 0, retryableFailures: 0, terminalFailures: 0 };
      },
    };
    const service = createInvestigationEvidenceService(store, CONFIG, orchestrator);
    const response = await service.handle({
      schemaVersion: 1,
      runtimeRequestId: session.runtimeRequestId,
      runtimeTaskId: 'rtask-fresh',
      sessionId: session.id,
      requests: [{ requestId: 'fresh-mem', type: 'host.memory', requestingRoles: ['database'] }],
    });
    assert.equal(response.results[0]?.status, 'collected');
    assert.equal(response.results[0]?.evidenceId, `inv-${session.id}-evidence-host.memory`);
    assert.notEqual(response.results[0]?.evidenceId, `incident-${incident.id}-evidence-host.memory`);
    assert.deepEqual(store.getEvidence(`incident-${incident.id}-evidence-host.memory`)?.data, { stale: true });
    store.close();
  });
});
