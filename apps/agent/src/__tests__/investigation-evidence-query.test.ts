import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceQueryRequest, OpsEvent } from '@pi-ops/protocol';
import type { AgentConfig } from '../config.js';
import { createEvidenceOrchestrator, type FetchLike } from '../evidence-orchestrator.js';
import { createInvestigationEvidenceService } from '../investigation-evidence.js';
import { createInvestigationLoopService } from '../investigation-loop.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

function makeConfig(): AgentConfig {
  return {
    port: 0,
    ingestToken: 'ingest-token',
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

function makeEvent(): OpsEvent {
  return {
    schemaVersion: 1,
    id: 'evt-exact-1',
    time: '2026-08-20T12:00:00.000Z',
    source: 'application',
    nodeId: 'test-svc-02',
    service: 'data-asset-service',
    type: 'application.slow_sql',
    severity: 'warning',
    message: 'slow sql',
    attributes: { sqlFingerprint: 'deadbeef' },
  };
}

const incidentData: Omit<IncidentRow, 'id'> = {
  service: 'data-asset-service',
  node_id: 'test-svc-02',
  type: 'application.slow_sql',
  state: 'OPEN',
  fingerprint: 'fp-exact',
  first_seen: '2026-08-20T12:00:00.000Z',
  last_seen: '2026-08-20T12:00:00.000Z',
  event_count: 1,
  severity: 'warning',
};

describe('exact typed evidence execution', () => {
  it('executes host.memory exactly for a slow_sql investigation', async () => {
    const store = createEventStore(':memory:');
    store.insertBatch({ producer: { id: 'producer', type: 'application', version: '1' }, events: [makeEvent()] }, '2026-08-20T12:00:00.000Z');
    const incident = store.createIncidentFromEvent(incidentData, makeEvent());
    store.insertEvidence({
      id: 'evd-load',
      incidentId: incident.id,
      nodeId: 'test-svc-02',
      source: 'host',
      kind: 'host.load',
      collectedAt: '2026-08-20T12:00:01.000Z',
      data: { load1: 0.2 },
      status: 'succeeded',
    } satisfies EvidenceRecord);
    const seen: string[] = [];
    const fetchImpl: FetchLike = (async (_input, init) => {
      const query = JSON.parse(String(init?.body)) as EvidenceQueryRequest;
      seen.push(query.type);
      return new Response(JSON.stringify({
        id: 'node-evd',
        incidentId: query.incidentId,
        nodeId: 'test-svc-02',
        source: 'host',
        kind: query.type,
        collectedAt: '2026-08-20T12:00:02.000Z',
        data: { queryType: query.type },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as FetchLike;
    const orchestrator = createEvidenceOrchestrator(makeConfig(), store, fetchImpl);
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(incident.id);
    await loop.submit(session.id);
    store.markDelegationTaskSubmitted(session.delegationTaskId, new Date().toISOString(), 'rtask-exact');
    const service = createInvestigationEvidenceService(store, makeConfig(), orchestrator);
    const response = await service.handle({
      schemaVersion: 1,
      runtimeRequestId: session.runtimeRequestId,
      runtimeTaskId: 'rtask-exact',
      sessionId: session.id,
      requests: [{
        requestId: `ereq-${session.id}-host.memory`,
        type: 'host.memory',
        requestingRoles: ['jvm'],
      }],
    });
    assert.deepEqual(seen, ['host.memory']);
    assert.equal(response.results[0]?.status, 'collected');
    assert.equal(response.results[0]?.evidenceId, `inv-${session.id}-evidence-host.memory`);
    const audit = store.getInvestigationEvidenceAudit(`ereq-${session.id}-host.memory`);
    assert.ok(audit);
    assert.deepEqual(audit.specialistRoles, ['jvm']);
    assert.equal(audit.runtimeTaskId, 'rtask-exact');
    store.close();
  });

  it('rejects unresolved docker targets and model-supplied URLs', async () => {
    const store = createEventStore(':memory:');
    store.insertBatch({ producer: { id: 'producer', type: 'application', version: '1' }, events: [makeEvent()] }, '2026-08-20T12:00:00.000Z');
    const incident = store.createIncidentFromEvent(incidentData, makeEvent());
    const orchestrator = createEvidenceOrchestrator(makeConfig(), store, (async () => {
      throw new Error('node agent should not be contacted');
    }) as FetchLike);
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(incident.id);
    await loop.submit(session.id);
    store.markDelegationTaskSubmitted(session.delegationTaskId, new Date().toISOString(), 'rtask-r');
    const service = createInvestigationEvidenceService(store, makeConfig(), orchestrator);
    const docker = await service.handle({
      schemaVersion: 1,
      runtimeRequestId: session.runtimeRequestId,
      runtimeTaskId: 'rtask-r',
      sessionId: session.id,
      requests: [{ requestId: 'r-docker', type: 'docker.stats', requestingRoles: ['database'] }],
    });
    assert.equal(docker.results[0]?.status, 'rejected');
    const http = await service.handle({
      schemaVersion: 1,
      runtimeRequestId: session.runtimeRequestId,
      runtimeTaskId: 'rtask-r',
      sessionId: session.id,
      requests: [{ requestId: 'r-http', type: 'http.probe', requestingRoles: ['application_business'] }],
    });
    assert.equal(http.results[0]?.status, 'rejected');
    store.close();
  });

  it('persists evidence audit across database reopen', async () => {
    const sqlitePath = join(mkdtempSync(join(tmpdir(), 'pi-ops-')), 'agent.sqlite');
    const store = createEventStore(sqlitePath);
    store.insertBatch({ producer: { id: 'producer', type: 'application', version: '1' }, events: [makeEvent()] }, '2026-08-20T12:00:00.000Z');
    const incident = store.createIncidentFromEvent(incidentData, makeEvent());
    const fetchImpl: FetchLike = (async (_input, init) => {
      const query = JSON.parse(String(init?.body)) as EvidenceQueryRequest;
      return new Response(JSON.stringify({
        id: 'node-evd',
        incidentId: query.incidentId,
        nodeId: 'test-svc-02',
        source: 'host',
        kind: query.type,
        collectedAt: '2026-08-20T12:00:02.000Z',
        data: {},
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as FetchLike;
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(incident.id);
    await loop.submit(session.id);
    store.markDelegationTaskSubmitted(session.delegationTaskId, new Date().toISOString(), 'rtask-a');
    await createInvestigationEvidenceService(store, makeConfig(), createEvidenceOrchestrator(makeConfig(), store, fetchImpl)).handle({
      schemaVersion: 1,
      runtimeRequestId: session.runtimeRequestId,
      runtimeTaskId: 'rtask-a',
      sessionId: session.id,
      requests: [{ requestId: 'audit-1', type: 'host.memory', requestingRoles: ['jvm', 'container_host'] }],
    });
    store.close();
    const reopened = createEventStore(sqlitePath);
    const audit = reopened.getInvestigationEvidenceAudit('audit-1');
    assert.ok(audit);
    assert.deepEqual(audit.specialistRoles, ['jvm', 'container_host']);
    assert.equal(audit.runtimeTaskId, 'rtask-a');
    assert.ok(audit.evidenceIds.length > 0);
    reopened.close();
  });
});
