import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceQueryRequest, OpsEvent } from '@pi-ops/protocol';
import { createApp } from '../app.js';
import type { AgentConfig } from '../config.js';
import { createEvidenceOrchestrator, type FetchLike } from '../evidence-orchestrator.js';
import { createHttpPiRuntimeClient } from '../http-pi-runtime-client.js';
import { createIncidentEngine } from '../incident.js';
import { createInvestigationEvidenceService } from '../investigation-evidence.js';
import { createInvestigationLoopService } from '../investigation-loop.js';
import { createEventStore, type EventStore } from '../store.js';

// apps/pi-runtime lives outside this package rootDir, so the real runtime is
// loaded through a computed specifier. CI still runs the real Coordinator,
// specialists, evidence client and durable runtime store — only the module
// resolution is deferred.
interface RuntimeHandle {
  app: { fetch(request: Request): Response | Promise<Response> };
  tasks: {
    getByRequestId(runtimeRequestId: string): {
      runtimeTaskId: string;
      executionStatus: string;
      deliveryStatus: string;
    } | undefined;
  };
  drain(): Promise<void>;
  close(): void;
}

interface RuntimeEvidenceClientLike {
  request(input: unknown): Promise<unknown>;
}

const runtimeDir = ['..', '..', '..', 'pi-runtime', 'src'].join('/');
const runtimeAppModule = await import(`${runtimeDir}/app.js`) as {
  createPiRuntimeApp: (config: unknown, options: unknown) => RuntimeHandle;
};
const runtimeEvidenceModule = await import(`${runtimeDir}/evidence-client.js`) as {
  createHttpRuntimeEvidenceClient: (options: unknown) => RuntimeEvidenceClientLike;
};

const AGENT_HOST = 'pi-ops-agent';
const RUNTIME_HOST = 'pi-runtime';
const CALLBACK_URL = `http://${AGENT_HOST}/v1/investigation-results`;

function agentConfig(sqlitePath: string): AgentConfig {
  return {
    port: 0,
    ingestToken: 'ingest-token',
    sqlitePath,
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

function runtimeConfig(sqlitePath: string) {
  return {
    port: 0,
    token: 'runtime-token',
    maxBodySize: 256 * 1024,
    maxContextBytes: 32_768,
    sqlitePath,
    callbackBaseUrl: CALLBACK_URL,
    callbackTimeoutMs: 2000,
    executionTimeoutMs: 5000,
    deliveryBackoffMs: 10,
    maxDeliveryAttempts: 5,
    piProvider: '',
    piModel: '',
  };
}

function slowSqlEvent(): OpsEvent {
  return {
    schemaVersion: 1,
    id: 'evt-e2e-slow-sql',
    time: '2026-08-20T12:00:00.000Z',
    source: 'application',
    nodeId: 'test-svc-02',
    service: 'data-asset-service',
    type: 'application.slow_sql',
    severity: 'warning',
    message: 'slow sql detected',
    attributes: { sqlFingerprint: 'deadbeef', durationMs: 4200 },
  };
}

/** Deterministic specialist model: the database specialist needs host.memory. */
function scriptedModel() {
  const calls: Array<{ role: string; kinds: string[] }> = [];
  const model = {
    provider: 'fake',
    model: 'deterministic',
    networkCalls: 0,
    calls,
    async invoke(request: { system: string; user: string }) {
      const role = /SPECIALIST_ROLE=([a-z_]+)/.exec(request.system)?.[1];
      if (!role) {
        return { text: '{}', provider: 'fake', model: 'deterministic' };
      }
      const payload = JSON.parse(request.user) as { evidence: Array<{ id: string; kind: string }> };
      const kinds = payload.evidence.map((item) => item.kind);
      calls.push({ role, kinds });
      const ids = payload.evidence.map((item) => item.id);
      const hasMemory = kinds.includes('host.memory');
      const finding = {
        role,
        hypotheses: [`${role} hypothesis for the current incident`],
        supportingEvidenceIds: ids,
        contradictingEvidenceIds: [],
        missingEvidence: role === 'database' && !hasMemory ? ['host.memory'] : [],
        confidence: role === 'database' ? (hasMemory ? 0.86 : 0.55) : 0.5,
        summary: `${role} reviewed ${kinds.join(',') || 'no'} evidence`,
        status: 'completed',
      };
      return {
        text: JSON.stringify(finding),
        provider: 'fake',
        model: 'deterministic',
        inputTokens: 8,
        outputTokens: 16,
      };
    },
  };
  return model;
}

function nodeAgentFetch(behaviour: { failTypes?: string[] } = {}): FetchLike {
  return (async (_input, init) => {
    const query = JSON.parse(String(init?.body)) as EvidenceQueryRequest;
    if (behaviour.failTypes?.includes(query.type)) {
      return new Response('node agent unavailable', { status: 503 });
    }
    return new Response(JSON.stringify({
      id: `node-${query.type}`,
      incidentId: query.incidentId,
      nodeId: 'test-svc-02',
      source: query.type.split('.')[0],
      kind: query.type,
      collectedAt: '2026-08-20T12:00:05.000Z',
      data: { queryType: query.type },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as FetchLike;
}

interface Harness {
  store: EventStore;
  agentApp: ReturnType<typeof createApp>;
  runtime: RuntimeHandle;
  loop: ReturnType<typeof createInvestigationLoopService>;
  orchestrator: ReturnType<typeof createEvidenceOrchestrator>;
  model: ReturnType<typeof scriptedModel>;
  nodeAgentCalls: string[];
  close(): void;
}

function buildHarness(options: { failEvidenceTypes?: string[]; runtimeReachable?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'pi-ops-e2e-'));
  const store = createEventStore(join(dir, 'agent.sqlite'));
  const config = agentConfig(join(dir, 'agent.sqlite'));
  const nodeAgentCalls: string[] = [];
  const baseNodeFetch = nodeAgentFetch({ ...(options.failEvidenceTypes ? { failTypes: options.failEvidenceTypes } : {}) });
  const recordingNodeFetch: FetchLike = (async (input, init) => {
    const query = JSON.parse(String(init?.body)) as EvidenceQueryRequest;
    nodeAgentCalls.push(query.type);
    return baseNodeFetch(input, init);
  }) as FetchLike;

  const orchestrator = createEvidenceOrchestrator(config, store, recordingNodeFetch);
  const engine = createIncidentEngine(store, {
    aggregationWindowMs: config.aggregationWindowMs,
    reasonerType: 'fake',
    reasonerVersion: '1',
  });

  let agentApp!: ReturnType<typeof createApp>;
  let runtime!: RuntimeHandle;

  const routedFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input as string, init);
    const host = new URL(request.url).host;
    if (host === AGENT_HOST) return agentApp.fetch(request);
    if (host === RUNTIME_HOST) return runtime.app.fetch(request);
    throw new Error(`unexpected host ${host}`);
  };

  const model = scriptedModel();
  const evidenceClient = runtimeEvidenceModule.createHttpRuntimeEvidenceClient({
    baseUrl: `http://${AGENT_HOST}`,
    token: 'runtime-token',
    timeoutMs: 2000,
    fetch: routedFetch,
  });
  runtime = runtimeAppModule.createPiRuntimeApp(runtimeConfig(join(dir, 'runtime.sqlite')), {
    model,
    evidenceClient,
    fetch: routedFetch,
  });

  const runtimeClient = createHttpPiRuntimeClient({
    baseUrl: options.runtimeReachable === false ? 'http://unreachable-runtime' : `http://${RUNTIME_HOST}`,
    token: 'runtime-token',
    callbackUrl: CALLBACK_URL,
    timeoutMs: 2000,
    fetch: options.runtimeReachable === false
      ? (async () => {
        throw new Error('runtime unreachable');
      })
      : routedFetch,
  });

  const loop = createInvestigationLoopService(store, { runtime: runtimeClient });
  const evidenceService = createInvestigationEvidenceService(store, config, orchestrator);
  agentApp = createApp(config, store, engine, undefined, loop, evidenceService);

  return {
    store,
    agentApp,
    runtime,
    loop,
    orchestrator,
    model,
    nodeAgentCalls,
    close: () => {
      runtime.close();
      store.close();
    },
  };
}

async function ingestAndCollectInitialEvidence(harness: Harness) {
  const response = await harness.agentApp.request('/v1/events', {
    method: 'POST',
    headers: { authorization: 'Bearer ingest-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      producer: { id: 'data-asset-service', type: 'application', version: '1.0.0' },
      events: [slowSqlEvent()],
    }),
  });
  assert.equal(response.status, 200);
  const incident = harness.store.listIncidents()[0]!;
  const job = harness.store.getEvidenceJob(`job-${incident.id}`)!;
  await harness.orchestrator.collectForIncident(incident, job.triggeringEvent);
  return incident;
}

describe('deterministic investigation E2E', () => {
  it('runs ingest → investigation → typed enrichment → report with full provenance', async () => {
    const harness = buildHarness();
    const incident = await ingestAndCollectInitialEvidence(harness);
    const beforeIncident = structuredClone(harness.store.getIncident(incident.id)!);
    const initialEvidenceIds = harness.store.listEvidence(incident.id).map((row) => row.id);
    assert.ok(initialEvidenceIds.some((id) => id.endsWith('-evidence-host.load')));

    const { session } = harness.loop.start(incident.id);
    await harness.loop.submit(session.id);
    await harness.runtime.drain();

    // Runtime task provenance
    const runtimeTask = harness.runtime.tasks.getByRequestId(session.runtimeRequestId);
    assert.ok(runtimeTask);
    assert.equal(runtimeTask.executionStatus, 'completed');
    assert.equal(runtimeTask.deliveryStatus, 'delivered');

    // Session / job / task lifecycle
    const finalSession = harness.store.getInvestigationSession(session.id)!;
    assert.equal(finalSession.status, 'COMPLETED');
    const task = harness.store.getDelegationTask(session.delegationTaskId)!;
    assert.equal(task.status, 'COMPLETED');
    assert.equal(task.runtimeTaskId, runtimeTask.runtimeTaskId);
    const plan = harness.store.getInvestigationPlan(task.investigationPlanId)!;
    const job = harness.store.getReasoningJob(plan.reasoningJobId)!;
    assert.equal(job.status, 'COMPLETED');
    assert.equal(job.id, `rj-inv-${session.id}`);

    // Typed evidence enrichment actually collected host.memory
    const enrichedEvidenceId = `inv-${session.id}-evidence-host.memory`;
    const enriched = harness.store.getEvidence(enrichedEvidenceId)!;
    assert.equal(enriched.kind, 'host.memory');
    assert.equal(enriched.status, 'succeeded');
    assert.ok(harness.nodeAgentCalls.includes('host.memory'));

    // Evidence request audit provenance
    const audits = harness.store.listInvestigationEvidenceAudits(session.id);
    assert.equal(audits.length, 1);
    const audit = audits[0]!;
    assert.equal(audit.evidenceType, 'host.memory');
    assert.equal(audit.status, 'collected');
    assert.deepEqual(audit.specialistRoles, ['database']);
    assert.equal(audit.runtimeRequestId, session.runtimeRequestId);
    assert.equal(audit.runtimeTaskId, runtimeTask.runtimeTaskId);
    assert.deepEqual(audit.evidenceIds, [enrichedEvidenceId]);

    // Only the requesting specialist reran
    const databaseCalls = harness.model.calls.filter((call) => call.role === 'database');
    const otherCalls = harness.model.calls.filter((call) => call.role !== 'database');
    assert.equal(databaseCalls.length, 2);
    assert.ok(databaseCalls[1]?.kinds.includes('host.memory'));
    for (const call of otherCalls) {
      assert.equal(call.kinds.includes('host.memory'), false);
    }

    // Report + ReasoningResult provenance
    const report = harness.store.getInvestigationReportBySessionId(session.id)!;
    assert.ok(report.supportingEvidenceIds.includes(enrichedEvidenceId));
    const result = harness.store.getReasoningResultByJobId(job.id)!;
    assert.equal(result.investigationSessionId, session.id);
    assert.equal(result.runtimeRequestId, session.runtimeRequestId);
    assert.equal(result.runtimeTaskId, runtimeTask.runtimeTaskId);
    assert.equal(result.investigationReportId, report.id);
    assert.ok(result.evidenceIds?.includes(enrichedEvidenceId));
    assert.equal(result.provider, 'fake');

    // Incident facts unchanged by the investigation
    assert.deepEqual(harness.store.getIncident(incident.id), beforeIncident);
    for (const id of initialEvidenceIds) {
      assert.ok(harness.store.getEvidence(id));
    }
    harness.close();
  });
});

describe('investigation failure E2E', () => {
  it('keeps the investigation alive when enrichment is unavailable', async () => {
    const harness = buildHarness({ failEvidenceTypes: ['host.memory'] });
    const incident = await ingestAndCollectInitialEvidence(harness);
    const evidenceBefore = harness.store.listEvidence(incident.id).map((row) => row.id).sort();

    const { session } = harness.loop.start(incident.id);
    await harness.loop.submit(session.id);
    await harness.runtime.drain();

    const audits = harness.store.listInvestigationEvidenceAudits(session.id);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.evidenceType, 'host.memory');
    assert.equal(audits[0]?.status, 'unavailable');
    assert.deepEqual(audits[0]?.evidenceIds, []);

    const finalSession = harness.store.getInvestigationSession(session.id)!;
    assert.equal(finalSession.status, 'COMPLETED');
    const report = harness.store.getInvestigationReportBySessionId(session.id)!;
    assert.ok(report.supportingEvidenceIds.length > 0);
    assert.equal(report.supportingEvidenceIds.some((id) => id.includes('host.memory')), false);

    const succeeded = harness.store.listEvidence(incident.id)
      .filter((row) => row.status === 'succeeded')
      .map((row) => row.id)
      .sort();
    assert.deepEqual(succeeded, evidenceBefore);
    harness.close();
  });

  it('fails session, task and ReasoningJob when the runtime is unreachable', async () => {
    const harness = buildHarness({ runtimeReachable: false });
    const incident = await ingestAndCollectInitialEvidence(harness);
    const beforeIncident = structuredClone(harness.store.getIncident(incident.id)!);
    const beforeEvidence = structuredClone(harness.store.listEvidence(incident.id));

    const { session } = harness.loop.start(incident.id);
    const failed = await harness.loop.submit(session.id);
    assert.equal(failed.status, 'FAILED');

    const task = harness.store.getDelegationTask(session.delegationTaskId)!;
    assert.equal(task.status, 'FAILED');
    const plan = harness.store.getInvestigationPlan(task.investigationPlanId)!;
    assert.equal(harness.store.getReasoningJob(plan.reasoningJobId)?.status, 'FAILED');
    assert.equal(harness.store.getInvestigationReportBySessionId(session.id), undefined);
    assert.deepEqual(harness.store.getIncident(incident.id), beforeIncident);
    assert.deepEqual(harness.store.listEvidence(incident.id), beforeEvidence);
    harness.close();
  });
});
