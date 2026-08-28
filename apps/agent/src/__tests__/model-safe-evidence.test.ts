import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentConfig } from '../config.js';
import {
  buildIncidentContext,
  MODEL_SAFE_MAX_LOG_LINES,
  toRuntimeSafeEvidence,
} from '../incident-context.js';
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

const SECRET_DATA = {
  Config: {
    Env: [
      'DB_PASSWORD=super-secret',
      'API_TOKEN=abc123',
    ],
  },
  Authorization: 'Bearer dangerous-token',
  password: 'db-password',
  cookie: 'session-cookie',
  safeField: 'must-survive',
};

function incidentRow(): Omit<IncidentRow, 'id'> {
  return {
    service: 'data-asset-service',
    node_id: 'test-svc-02',
    type: 'container.die',
    state: 'OPEN',
    fingerprint: 'fp-safe',
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'error',
  };
}

async function preparedSession(store: ReturnType<typeof createEventStore>, incidentId: string) {
  const loop = createInvestigationLoopService(store);
  const { session } = loop.start(incidentId);
  await loop.submit(session.id);
  store.markDelegationTaskSubmitted(session.delegationTaskId, '2026-08-20T12:00:01.000Z', 'rtask-safe');
  return session;
}

function collecting(store: ReturnType<typeof createEventStore>, data: unknown, kind = 'docker.inspect'): EvidenceOrchestrator {
  return {
    async collectForIncident() {
      return { incidentId: '', requested: 0, succeeded: 0, failed: 0, retryableFailures: 0, terminalFailures: 0 };
    },
    async collectQueriesForIncident(target, queries, collectionId) {
      for (const query of queries) {
        store.insertEvidence({
          id: `${collectionId}-evidence-${query.type}`,
          incidentId: target.id,
          nodeId: target.node_id,
          source: query.type.split('.')[0] ?? 'docker',
          kind,
          collectedAt: '2026-08-20T12:00:05.000Z',
          data,
          status: 'succeeded',
        });
      }
      return {
        incidentId: target.id,
        requested: queries.length,
        succeeded: queries.length,
        failed: 0,
        retryableFailures: 0,
        terminalFailures: 0,
      };
    },
  };
}

describe('model-safe evidence transport', () => {
  it('redacts docker.inspect secrets in runtime Evidence without mutating the store', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident(incidentRow());
    const session = await preparedSession(store, incident.id);
    const service = createInvestigationEvidenceService(store, CONFIG, collecting(store, SECRET_DATA));
    const response = await service.handle({
      schemaVersion: 1,
      runtimeRequestId: session.runtimeRequestId,
      runtimeTaskId: 'rtask-safe',
      sessionId: session.id,
      requests: [{ requestId: 'r-inspect', type: 'docker.inspect', requestingRoles: ['container_host'] }],
    });
    assert.equal(response.results[0]?.status, 'collected');
    const encoded = JSON.stringify(response.results[0]);
    assert.equal(encoded.includes('super-secret'), false);
    assert.equal(encoded.includes('abc123'), false);
    assert.equal(encoded.includes('dangerous-token'), false);
    assert.equal(encoded.includes('db-password'), false);
    assert.equal(encoded.includes('session-cookie'), false);
    assert.equal(encoded.includes('must-survive'), true);
    assert.equal(encoded.includes('[redacted]'), true);

    const raw = store.getEvidence(`inv-${session.id}-evidence-docker.inspect`);
    assert.ok(raw);
    assert.deepEqual(raw.data, SECRET_DATA);
    store.close();
  });

  it('bounds and redacts dynamic docker.logs without rewriting stored rows', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({ ...incidentRow(), type: 'container.die' });
    const session = await preparedSession(store, incident.id);
    const lines = Array.from({ length: 40 }, (_, index) => `log-line-${index}`);
    const service = createInvestigationEvidenceService(
      store,
      CONFIG,
      collecting(store, { lines, password: 'super-secret' }, 'docker.logs'),
    );
    const response = await service.handle({
      schemaVersion: 1,
      runtimeRequestId: session.runtimeRequestId,
      runtimeTaskId: 'rtask-safe',
      sessionId: session.id,
      requests: [{ requestId: 'r-logs', type: 'docker.logs', requestingRoles: ['container_host'] }],
    });
    assert.equal(response.results[0]?.status, 'collected');
    const projected = response.results[0] && response.results[0].status === 'collected'
      ? response.results[0].evidence.data as { lines: string[]; password: string }
      : undefined;
    assert.ok(projected);
    assert.equal(projected.lines.length, MODEL_SAFE_MAX_LOG_LINES);
    assert.equal(projected.lines.includes('log-line-21'), false);
    assert.equal(projected.password, '[redacted]');
    assert.equal(JSON.stringify(projected).includes('super-secret'), false);
    const raw = store.getEvidence(`inv-${session.id}-evidence-docker.logs`);
    assert.equal((raw?.data as { lines: string[] }).lines.length, 40);
    assert.equal((raw?.data as { password: string }).password, 'super-secret');
    store.close();
  });

  it('keeps host.memory usedPercent visible to the runtime', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({ ...incidentRow(), type: 'application.slow_sql' });
    const session = await preparedSession(store, incident.id);
    const service = createInvestigationEvidenceService(
      store,
      CONFIG,
      collecting(store, { usedPercent: 92, totalBytes: 16_000_000_000 }, 'host.memory'),
    );
    const response = await service.handle({
      schemaVersion: 1,
      runtimeRequestId: session.runtimeRequestId,
      runtimeTaskId: 'rtask-safe',
      sessionId: session.id,
      requests: [{ requestId: 'r-mem', type: 'host.memory', requestingRoles: ['database'] }],
    });
    assert.equal(response.results[0]?.status, 'collected');
    const data = response.results[0] && response.results[0].status === 'collected'
      ? response.results[0].evidence.data as { usedPercent: number }
      : undefined;
    assert.equal(data?.usedPercent, 92);
    store.close();
  });

  it('applies the same projection to initial context and dynamic runtime Evidence', () => {
    const record: EvidenceRecord = {
      id: 'evd-parity',
      incidentId: 'inc-fresh',
      nodeId: 'test-svc-02',
      source: 'docker',
      kind: 'docker.inspect',
      collectedAt: '2026-08-20T12:00:05.000Z',
      status: 'succeeded',
      data: SECRET_DATA,
    };
    const incident: IncidentRow = {
      id: 'inc-fresh',
      ...incidentRow(),
    };
    const initial = buildIncidentContext(incident, [record], {
      maxEvidenceItems: 8,
      maxContextBytes: 8192,
      maxLogLines: MODEL_SAFE_MAX_LOG_LINES,
    }).evidence[0];
    const dynamic = toRuntimeSafeEvidence(record, MODEL_SAFE_MAX_LOG_LINES);
    assert.deepEqual(dynamic, initial);
  });
});
