import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { INVESTIGATION_RUNTIME_SCHEMA_VERSION } from '@pi-ops/protocol';
import { createApp } from '../app.js';
import type { AgentConfig } from '../config.js';
import { createHttpPiRuntimeClient } from '../http-pi-runtime-client.js';
import { createIncidentEngine } from '../incident.js';
import { createInvestigationLoopService } from '../investigation-loop.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

const CONFIG: AgentConfig = {
  port: 0,
  ingestToken: 'test-token',
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

function seed(store = createEventStore(':memory:')) {
  const incident = store.createIncident({
    service: 'data-asset-service',
    node_id: 'test-svc-02',
    type: 'application.slow_sql',
    state: 'OPEN',
    fingerprint: 'fp-runtime-e2e',
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'warning',
  } satisfies Omit<IncidentRow, 'id'>);
  store.insertEvidence({
    id: 'evd-e2e-1',
    incidentId: incident.id,
    nodeId: 'test-svc-02',
    source: 'host',
    kind: 'host.load',
    collectedAt: '2026-08-20T12:00:01.000Z',
    data: { load1: 0.2, cpus: 8 },
    status: 'succeeded',
  } satisfies EvidenceRecord);
  return { store, incident };
}

function createStubRuntime(route: (request: Request) => Promise<Response>) {
  const seen = new Map<string, string>();
  const queued: Array<() => Promise<void>> = [];
  const app = new Hono();
  app.post('/v1/investigations', async (c) => {
    const body = await c.req.json() as {
      runtimeRequestId: string;
      sessionId: string;
      callbackUrl: string;
      context: { evidence: Array<{ id: string }> };
    };
    const existing = seen.get(body.runtimeRequestId);
    const runtimeTaskId = existing ?? `rtask-${body.runtimeRequestId}`;
    const duplicate = Boolean(existing);
    if (!existing) seen.set(body.runtimeRequestId, runtimeTaskId);
    if (!duplicate) {
      const evidenceId = body.context.evidence[0]?.id;
      queued.push(async () => {
        await route(new Request(body.callbackUrl, {
          method: 'POST',
          headers: {
            authorization: 'Bearer runtime-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            schemaVersion: INVESTIGATION_RUNTIME_SCHEMA_VERSION,
            runtimeRequestId: body.runtimeRequestId,
            runtimeTaskId,
            sessionId: body.sessionId,
            status: 'completed',
            report: {
              hypothesis: 'SQL contention on the current incident',
              supportingEvidenceIds: evidenceId ? [evidenceId] : [],
              contradictingEvidenceIds: [],
              confidence: 0.7,
              recommendation: 'Evidence describes the current incident. Historical knowledge is advisory.',
            },
            metadata: {
              runtimeRequestId: body.runtimeRequestId,
              runtimeTaskId,
              selectedSpecialists: ['database', 'application_business'],
              specialistStatus: { database: 'completed', application_business: 'completed' },
              latencyMs: 1,
              provider: 'fake',
              model: 'deterministic',
              reportStatus: 'completed',
            },
          }),
        }));
      });
    }
    return c.json({
      schemaVersion: INVESTIGATION_RUNTIME_SCHEMA_VERSION,
      runtimeRequestId: body.runtimeRequestId,
      runtimeTaskId,
      duplicate,
    });
  });
  return {
    app,
    drain: async () => {
      const jobs = queued.splice(0);
      await Promise.all(jobs.map((job) => job()));
    },
  };
}

describe('external Pi Runtime E2E', () => {
  it('submits to the runtime and persists a ReasoningResult from the callback', async () => {
    const { store, incident } = seed();
    const engine = createIncidentEngine(store, { aggregationWindowMs: CONFIG.aggregationWindowMs });
    let agentApp: ReturnType<typeof createApp>;
    const runtime = createStubRuntime((request) => Promise.resolve(agentApp.fetch(request)));
    const runtimeClient = createHttpPiRuntimeClient({
      baseUrl: 'http://pi-runtime',
      token: 'runtime-token',
      callbackUrl: 'http://pi-ops-agent/v1/investigation-results',
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const host = new URL(request.url).host;
        if (host === 'pi-runtime') return Promise.resolve(runtime.app.fetch(request));
        if (host === 'pi-ops-agent') return Promise.resolve(agentApp.fetch(request));
        throw new Error(`unexpected host ${host}`);
      },
    });
    const loop = createInvestigationLoopService(store, { runtime: runtimeClient });
    agentApp = createApp(CONFIG, store, engine, undefined, loop);
    const before = structuredClone(store.getIncident(incident.id)!);
    const { session } = loop.start(incident.id);
    await loop.submit(session.id);
    await runtime.drain();
    const report = store.getInvestigationReportBySessionId(session.id);
    const results = store.listReasoningResults(incident.id);
    assert.ok(report);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.runtimeRequestId, session.runtimeRequestId);
    assert.equal(report.supportingEvidenceIds[0], 'evd-e2e-1');
    assert.deepEqual(store.getIncident(incident.id), before);
    store.close();
  });

  it('rejects invalid evidence references on the callback', async () => {
    const { store, incident } = seed();
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(incident.id);
    const submitted = await loop.submit(session.id);
    const task = store.getDelegationTask(submitted.delegationTaskId)!;
    assert.throws(
      () => loop.handleRuntimeResult({
        schemaVersion: 1,
        runtimeRequestId: session.runtimeRequestId,
        runtimeTaskId: task.runtimeTaskId!,
        sessionId: session.id,
        status: 'completed',
        report: {
          hypothesis: 'foreign evidence',
          supportingEvidenceIds: ['evd-other'],
          contradictingEvidenceIds: [],
          confidence: 0.5,
          recommendation: 'none',
        },
      }),
      /does not belong/,
    );
    assert.equal(store.getInvestigationReportBySessionId(session.id), undefined);
    assert.equal(store.getIncident(incident.id)?.id, incident.id);
    store.close();
  });

  it('keeps Incident and Evidence unchanged when the runtime is unavailable', async () => {
    const { store, incident } = seed();
    const beforeIncident = structuredClone(store.getIncident(incident.id)!);
    const beforeEvidence = structuredClone(store.listEvidence(incident.id));
    const loop = createInvestigationLoopService(store, {
      runtime: createHttpPiRuntimeClient({
        baseUrl: 'http://127.0.0.1:1',
        token: 'runtime-token',
        callbackUrl: 'http://pi-ops-agent/v1/investigation-results',
        timeoutMs: 50,
        fetch: async () => {
          throw new Error('runtime unavailable');
        },
      }),
    });
    const { session } = loop.start(incident.id);
    const failed = await loop.submit(session.id);
    assert.equal(failed.status, 'FAILED');
    assert.deepEqual(store.getIncident(incident.id), beforeIncident);
    assert.deepEqual(store.listEvidence(incident.id), beforeEvidence);
    store.close();
  });
});
