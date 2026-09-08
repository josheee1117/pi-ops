import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSpecialistFinding, type OpsEvent } from '@pi-ops/protocol';
import { createApp } from '../app.js';
import type { AgentConfig } from '../config.js';
import { classifyEvidence } from '../evidence-intelligence.js';
import { createEvidenceOrchestrator, type FetchLike } from '../evidence-orchestrator.js';
import { createIncidentEngine } from '../incident.js';
import { buildInvestigationContext } from '../investigation-context.js';
import { createInvestigationEvidenceService } from '../investigation-evidence.js';
import { createInvestigationLoopService } from '../investigation-loop.js';
import {
  jfrEvidenceId,
  persistJfrSignalEvidence,
  projectJfrSignalEvidence,
} from '../jfr-evidence.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

const CONFIG: AgentConfig = {
  port: 0,
  ingestToken: 'test-token',
  operatorToken: 'operator-token',
  investigationRetryMaxAttempts: 3,
  investigationRetryBackoffMs: 0,
  investigationStaleTimeoutMs: 60_000,
  externalRuntimeEnabled: false,
  sqlitePath: ':memory:',
  nodeId: 'test-node',
  maxBodySize: 1024 * 1024,
  aggregationWindowMs: 5 * 60 * 1000,
  nodeAgents: new Map([
    ['test-svc-02', { nodeId: 'test-svc-02', url: 'http://node-agent.test', token: 'node-token' }],
  ]),
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

function loadGolden(): { batch: unknown; event: OpsEvent } {
  const batch = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dataasset-jvm-cpu.eventbatch.json'),
    'utf8',
  )) as { events: OpsEvent[] };
  return { batch, event: batch.events[0]! };
}

async function ingest(body: unknown) {
  const store = createEventStore(':memory:');
  const engine = createIncidentEngine(store, { aggregationWindowMs: CONFIG.aggregationWindowMs });
  const app = createApp(CONFIG, store, engine);
  const response = await app.request('/v1/events', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { store, engine, response };
}

function nodeAgentFetch(): FetchLike {
  let calls = 0;
  const fetchImpl = (async (_input, init) => {
    calls += 1;
    const query = JSON.parse(String(init?.body)) as { type: string; incidentId: string };
    return new Response(JSON.stringify({
      id: `node-${query.type}`,
      incidentId: query.incidentId,
      nodeId: 'test-svc-02',
      source: query.type.split('.')[0],
      kind: query.type,
      collectedAt: '2026-08-20T12:00:05.000Z',
      data: query.type === 'host.load' ? { load1: 0.2 } : { cpuPercent: 12 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as FetchLike & { calls: () => number };
  fetchImpl.calls = () => calls;
  return fetchImpl;
}

describe('JFR semantic evidence projector', () => {
  it('A. golden jvm.cpu_pressure EventBatch yields exactly one jfr.signal', async () => {
    const { batch, event } = loadGolden();
    const { store, response } = await ingest(batch);
    assert.equal(response.status, 200);
    const incident = store.findIncidentByEventId(event.id);
    assert.ok(incident);
    const jfr = store.listEvidence(incident.id).filter((item) => item.kind === 'jfr.signal');
    assert.equal(jfr.length, 1);
    assert.equal(jfr[0]!.id, jfrEvidenceId(event.id));
    assert.equal(jfr[0]!.source, 'jfr');
    assert.equal(jfr[0]!.status, 'succeeded');
    const data = jfr[0]!.data as { attributes: Record<string, unknown>; eventId: string };
    assert.equal(data.eventId, event.id);
    assert.equal(data.attributes.jvmUser, 0.9);
    assert.equal(data.attributes.jvmSystem, 0.1);
    assert.equal(data.attributes.machineTotal, 0.95);
    assert.equal(data.attributes.containerName, 'data-asset');
    store.close();
  });

  it('B/C. replay and persist retry stay idempotent', async () => {
    const { batch, event } = loadGolden();
    const { store, engine, response } = await ingest(batch);
    assert.equal(response.status, 200);
    const incident = store.findIncidentByEventId(event.id)!;
    engine.processEvent(event, event.time);
    persistJfrSignalEvidence(store, incident, event);
    persistJfrSignalEvidence(store, incident, event);
    const jfr = store.listEvidence(incident.id).filter((item) => item.kind === 'jfr.signal');
    assert.equal(jfr.length, 1);
    store.close();
  });

  it('D. attribute allowlist drops secrets and unknown fields', () => {
    const event: OpsEvent = {
      schemaVersion: 1,
      id: 'evt-secret',
      time: '2026-08-20T12:00:00.000Z',
      source: 'jfr',
      nodeId: 'test-svc-02',
      service: 'data-asset-service',
      type: 'jvm.cpu_pressure',
      severity: 'warning',
      message: 'JVM CPU pressure',
      attributes: {
        jvmUser: 0.9,
        secret: 's3cret',
        password: 'p@ss',
        randomHugeObject: { nested: 'x'.repeat(5000) },
        unexpectedField: 'nope',
      },
    };
    const projected = projectJfrSignalEvidence({ id: 'inc-1', node_id: 'test-svc-02' }, event)!;
    const attributes = (projected.data as { attributes: Record<string, unknown> }).attributes;
    assert.equal(attributes.jvmUser, 0.9);
    assert.equal(attributes.secret, undefined);
    assert.equal(attributes.password, undefined);
    assert.equal(attributes.randomHugeObject, undefined);
    assert.equal(attributes.unexpectedField, undefined);
  });

  it('C. illegal CPU ratio types and ranges are dropped', () => {
    const event: OpsEvent = {
      schemaVersion: 1,
      id: 'evt-bad-ratio',
      time: '2026-08-20T12:00:00.000Z',
      source: 'jfr',
      nodeId: 'test-svc-02',
      service: 'data-asset-service',
      type: 'jvm.cpu_pressure',
      severity: 'warning',
      message: 'JVM CPU pressure',
      attributes: {
        jvmUser: '0.9',
        jvmSystem: true,
        machineTotal: 2,
        containerName: 'data-asset',
      },
    };
    const attributes = (projectJfrSignalEvidence({ id: 'inc-1', node_id: 'test-svc-02' }, event)!
      .data as { attributes: Record<string, unknown> }).attributes;
    assert.equal(attributes.jvmUser, undefined);
    assert.equal(attributes.jvmSystem, undefined);
    assert.equal(attributes.machineTotal, undefined);
    assert.equal(attributes.containerName, 'data-asset');
  });

  it('D. overlong containerName and message are bounded', () => {
    const event: OpsEvent = {
      schemaVersion: 1,
      id: 'evt-long',
      time: '2026-08-20T12:00:00.000Z',
      source: 'jfr',
      nodeId: 'test-svc-02',
      service: 'data-asset-service',
      type: 'jvm.cpu_pressure',
      severity: 'warning',
      message: 'm'.repeat(2000),
      attributes: {
        jvmUser: 0.9,
        jvmSystem: 0.1,
        machineTotal: 0.95,
        containerName: 'c'.repeat(400),
      },
    };
    const projected = projectJfrSignalEvidence({ id: 'inc-1', node_id: 'test-svc-02' }, event)!;
    const data = projected.data as { message: string; attributes: { containerName: string } };
    assert.equal(data.message.length, 1024);
    assert.equal(data.attributes.containerName.length, 256);
  });

  it('E. valid CPU contract ratios stay unchanged', () => {
    const event: OpsEvent = {
      schemaVersion: 1,
      id: 'evt-ok',
      time: '2026-08-20T12:00:00.000Z',
      source: 'jfr',
      nodeId: 'test-svc-02',
      service: 'data-asset-service',
      type: 'jvm.cpu_pressure',
      severity: 'warning',
      message: 'JVM CPU pressure',
      attributes: { jvmUser: 0.9, jvmSystem: 0.1, machineTotal: 0.95, containerName: 'data-asset' },
    };
    const attributes = (projectJfrSignalEvidence({ id: 'inc-1', node_id: 'test-svc-02' }, event)!
      .data as { attributes: Record<string, number | string> }).attributes;
    assert.equal(attributes.jvmUser, 0.9);
    assert.equal(attributes.jvmSystem, 0.1);
    assert.equal(attributes.machineTotal, 0.95);
    assert.equal(attributes.containerName, 'data-asset');
  });

  it('E/I. InvestigationContext keeps jfr.signal with host/docker and does not drop conflict', async () => {
    const { batch, event } = loadGolden();
    const { store } = await ingest(batch);
    const incident = store.findIncidentByEventId(event.id)!;
    const fetchImpl = nodeAgentFetch();
    const orchestrator = createEvidenceOrchestrator(CONFIG, store, fetchImpl);
    await orchestrator.collectForIncident(incident, event);
    const host: EvidenceRecord = {
      id: 'evd-host-conflict',
      incidentId: incident.id,
      nodeId: incident.node_id,
      source: 'host',
      kind: 'host.load',
      collectedAt: '2026-08-20T12:00:06.000Z',
      status: 'succeeded',
      data: { load1: 0.05 },
    };
    store.insertEvidence(host);
    const context = buildInvestigationContext(incident, store.listEvidence(incident.id), store);
    const kinds = context.evidence.map((item) => item.kind);
    assert.ok(kinds.includes('jfr.signal'));
    assert.ok(kinds.includes('host.load'));
    assert.ok(kinds.includes('docker.stats'));
    const jfr = context.evidence.find((item) => item.kind === 'jfr.signal')!;
    assert.equal((jfr.data as { attributes: { jvmUser: number } }).attributes.jvmUser, 0.9);
    assert.ok(context.evidence.some((item) => item.id === 'evd-host-conflict'));
    store.close();
  });

  it('H. jfr.signal is not a RuntimeEvidenceRequest type', () => {
    const finding = validateSpecialistFinding({
      role: 'jvm',
      hypotheses: ['need jfr'],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      missingEvidence: ['jfr.signal'],
      confidence: 0.4,
      summary: 'cannot request jfr',
      status: 'completed',
    });
    assert.equal(finding.success, false);
  });

  it('H. investigation evidence service rejects jfr.signal queries', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({
      service: 'data-asset-service',
      node_id: 'test-svc-02',
      type: 'jvm.cpu_pressure',
      state: 'OPEN',
      fingerprint: 'fp-jfr',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'warning',
    } satisfies Omit<IncidentRow, 'id'>);
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(incident.id);
    await loop.submit(session.id);
    store.markDelegationTaskSubmitted(session.delegationTaskId, '2026-08-20T12:00:01.000Z', 'rtask-jfr');
    const orchestrator = createEvidenceOrchestrator(CONFIG, store, nodeAgentFetch());
    const service = createInvestigationEvidenceService(store, CONFIG, orchestrator);
    const response = await service.handle({
      schemaVersion: 1,
      runtimeRequestId: session.runtimeRequestId,
      runtimeTaskId: 'rtask-jfr',
      sessionId: session.id,
      requests: [{
        requestId: 'r-jfr',
        type: 'jfr.signal' as 'host.load',
        requestingRoles: ['jvm'],
      }],
    });
    assert.equal(response.results[0]?.status, 'rejected');
    store.close();
  });

  it('J. unknown JFR type materializes without copying attributes', () => {
    const event: OpsEvent = {
      schemaVersion: 1,
      id: 'evt-unknown',
      time: '2026-08-20T12:00:00.000Z',
      source: 'jfr',
      nodeId: 'test-svc-02',
      service: 'data-asset-service',
      type: 'jvm.mystery_signal',
      severity: 'warning',
      message: 'unknown jfr',
      attributes: { secret: 'nope', heap: 99 },
    };
    const projected = projectJfrSignalEvidence({ id: 'inc-1', node_id: 'test-svc-02' }, event)!;
    assert.equal(projected.kind, 'jfr.signal');
    assert.deepEqual((projected.data as { attributes: Record<string, unknown> }).attributes, {});
  });

  it('jfr.signal is first-party primary evidence, not weak', () => {
    const profile = classifyEvidence({
      id: 'jfr-1',
      incidentId: 'inc-1',
      nodeId: 'n',
      source: 'jfr',
      kind: 'jfr.signal',
      collectedAt: '2026-08-20T12:00:00.000Z',
      status: 'succeeded',
      data: { semanticType: 'jvm.cpu_pressure', attributes: { jvmUser: 0.9 } },
    });
    assert.equal(profile.category, 'primary_signal');
    const logs = classifyEvidence({
      id: 'logs-1',
      incidentId: 'inc-1',
      nodeId: 'n',
      source: 'docker',
      kind: 'docker.logs',
      collectedAt: '2026-08-20T12:00:00.000Z',
      status: 'succeeded',
      data: {},
    });
    assert.equal(logs.category, 'weak_signal');
    assert.ok(profile.diagnosticWeight > logs.diagnosticWeight);
  });
});
