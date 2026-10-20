import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSpecialistFinding, type OpsEvent } from '@pi-ops/protocol';
import { createApp } from '../app.js';
import { makeAgentConfig } from './test-config.js';
import { classifyEvidence } from '../evidence-intelligence.js';
import { createEvidenceOrchestrator, type FetchLike } from '../evidence-orchestrator.js';
import { createIncidentEngine } from '../incident.js';
import { buildInvestigationContext, type InvestigationContext } from '../investigation-context.js';
import { createInvestigationEvidenceService } from '../investigation-evidence.js';
import { createInvestigationLoopService } from '../investigation-loop.js';
import type { PiRuntimeClient } from '../pi-runtime-client.js';
import {
  jfrEvidenceId,
  persistJfrSignalEvidence,
  projectJfrSignalEvidence,
  recognizedJfrSemantic,
} from '../jfr-evidence.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

const CONFIG = makeAgentConfig({
  ingestToken: 'test-token',
  nodeId: 'test-node',
  evidenceTimeoutMs: 5000,
  nodeAgents: new Map([
    ['test-svc-02', { nodeId: 'test-svc-02', url: 'http://node-agent.test', token: 'node-token' }],
  ]),
  piRuntimeToken: 'runtime-token',
});

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
  return { store, engine, app, response };
}

const OFFLINE_SAFE_SUMMARY = 'Unhandled request exception';
const OFFLINE_EXCEPTION_CLASS = 'java.lang.IllegalStateException';
const OFFLINE_EXCEPTION_STACK = 'at com.mbkj.dap.exception.GlobalExceptionHandler.handleGenericException(GlobalExceptionHandler.java:109)';

/** Offline contract sample from UnhandledExceptionSeamProbe assertions. Not a captured HTTP send. */
function offlineApplicationBusinessError(
  attributes: Record<string, unknown> = {},
  overrides: Partial<OpsEvent> = {},
): OpsEvent {
  return {
    schemaVersion: 1,
    id: 'evt-offline-unhandled',
    time: '2026-08-20T12:00:00.000Z',
    source: 'application',
    nodeId: 'test-svc-02',
    service: 'data-asset-service',
    type: 'business.error',
    severity: 'error',
    message: OFFLINE_SAFE_SUMMARY,
    attributes: {
      businessCode: 'UNHANDLED_EXCEPTION',
      module: '/probe/boom',
      operation: 'GET /probe/boom',
      exceptionClass: OFFLINE_EXCEPTION_CLASS,
      exceptionStackTrace: OFFLINE_EXCEPTION_STACK,
      responseStatus: 500,
      safeMessage: OFFLINE_SAFE_SUMMARY,
      ...attributes,
    },
    ...overrides,
  };
}

function nodeAgentFetch(): FetchLike & { calls: () => number } {
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
  it('projects bounded real exception fields into the model-safe context without naming an allocation cause', async () => {
    for (const type of ['jvm.oom', 'business.error']) {
      const { event: base } = loadGolden();
      const event: OpsEvent = { ...base, id: `evt-${type}`, type, attributes: {
        exceptionClass: type === 'jvm.oom' ? 'java.lang.OutOfMemoryError' : 'java.lang.IllegalStateException',
        exceptionMessage: type === 'jvm.oom' ? 'Java heap space' : 'inventory unavailable',
        stackTrace: 'at Drill.exhaustHeap(Drill.java:300)', jfrStackTrace: 'at Drill.record(Drill.java:305)',
        jfrEventName: type === 'jvm.oom' ? 'com.example.MemoryFailure' : 'com.example.OrderFailure',
        jfrStartTime: base.time, jfrEndTime: base.time, containerName: 'data-asset', operation: 'submitOrder',
        secret: 'must-not-copy', allocationPath: 'invented',
      } };
      const { store } = await ingest({ producer: { id: 'application', type: 'application', version: '1' }, events: [event] });
      const incident = store.findIncidentByEventId(event.id)!;
      const evidence = store.listEvidence(incident.id)[0]!;
      assert.equal(classifyEvidence(evidence).category, 'primary_signal');
      const context = buildInvestigationContext(incident, [evidence], store);
      const data = context.evidence[0]!.data as { semanticType: string; attributes: Record<string, unknown> };
      assert.equal(data.semanticType, type);
      for (const key of ['exceptionClass', 'exceptionMessage', 'stackTrace', 'jfrStackTrace', 'jfrEventName', 'jfrStartTime', 'jfrEndTime', 'containerName']) {
        assert.equal(data.attributes[key], event.attributes[key]);
      }
      assert.equal(data.attributes.operation, type === 'business.error' ? 'submitOrder' : undefined);
      assert.equal(data.attributes.secret, undefined);
      assert.equal(data.attributes.allocationPath, undefined);
      store.close();
    }
  });

  it('exception recognition needs a valid diagnostic fact, not container/JFR metadata', () => {
    const { event: base } = loadGolden();
    for (const type of ['jvm.oom', 'business.error']) {
      for (const attributes of [
        { containerName: 'data-asset', jfrEventName: 'com.example.MemoryFailure', jfrStartTime: base.time },
        { exceptionClass: 1, exceptionMessage: {}, stackTrace: [] },
        { exceptionClass: 'bad class', exceptionMessage: 'something' },
        { exceptionClass: 'java.lang.OutOfMemoryError', exceptionMessage: ' ' },
      ]) {
        const projected = projectJfrSignalEvidence({ id: 'inc-1', node_id: 'n' }, { ...base, type, attributes })!;
        assert.equal(classifyEvidence(projected).category, 'weak_signal');
      }
    }
    const projected = projectJfrSignalEvidence({ id: 'inc-1', node_id: 'n' }, { ...base, type: 'jvm.oom', attributes: {
      exceptionClass: 'java.lang.IllegalStateException', exceptionMessage: 'not OOME',
      stackTrace: 's'.repeat(5000), jfrStartTime: 'invalid', operation: 'irrelevant',
    } })!;
    const data = projected.data as { attributes: Record<string, string> };
    assert.equal(classifyEvidence(projected).category, 'weak_signal');
    assert.equal(data.attributes.stackTrace!.length, 4096);
    assert.equal(data.attributes.jfrStartTime, undefined);
    assert.equal(data.attributes.operation, undefined);
    assert.equal(recognizedJfrSemantic({ eventType: 'business.error', semanticType: 'jvm.oom', attributes: {
      exceptionClass: 'java.lang.OutOfMemoryError', exceptionMessage: 'Java heap space',
    } }), false);
  });

  it('Runtime supplements CPU/OOM/business evidence through the shared mapped-target policy; missing maps fail closed', async () => {
    for (const type of ['jvm.cpu_pressure', 'jvm.oom', 'business.error']) {
      for (const mapped of [true, false]) {
        const { batch, event: base } = loadGolden();
        const event: OpsEvent = { ...base, id: `${type}-${mapped}`, type, attributes: mapped ? { containerName: 'data-asset' } : {} };
        const { store } = await ingest({ ...(batch as object), events: [event] });
        const incident = store.findIncidentByEventId(event.id)!;
        const loop = createInvestigationLoopService(store);
        const { session } = loop.start(incident.id);
        await loop.submit(session.id);
        store.markDelegationTaskSubmitted(session.delegationTaskId, base.time, 'rtask-mapped');
        const fetchImpl = nodeAgentFetch();
        const service = createInvestigationEvidenceService(store, CONFIG, createEvidenceOrchestrator(CONFIG, store, fetchImpl));
        const response = await service.handle({ schemaVersion: 1, runtimeRequestId: session.runtimeRequestId,
          runtimeTaskId: 'rtask-mapped', sessionId: session.id,
          requests: ['docker.inspect', 'docker.stats', 'docker.logs'].map((capability) => ({
            requestId: capability, type: capability as 'docker.inspect' | 'docker.stats' | 'docker.logs', requestingRoles: ['jvm' as const],
          })),
        });
        assert.equal(response.results.length, 3);
        assert.ok(response.results.every((result) => result.status === (mapped ? 'collected' : 'rejected')));
        assert.equal(fetchImpl.calls(), mapped ? 3 : 0);
        store.close();
      }
    }
  });

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

  it('A. known semantic jvm.cpu_pressure is primary_signal', () => {
    const projected = projectJfrSignalEvidence({ id: 'inc-1', node_id: 'n' }, {
      schemaVersion: 1,
      id: 'evt-cpu',
      time: '2026-08-20T12:00:00.000Z',
      source: 'jfr',
      nodeId: 'n',
      service: 'data-asset-service',
      type: 'jvm.cpu_pressure',
      severity: 'warning',
      message: 'JVM CPU pressure',
      attributes: { jvmUser: 0.9, jvmSystem: 0.1, machineTotal: 0.95, containerName: 'data-asset' },
    })!;
    assert.equal((projected.data as { semanticType: string }).semanticType, 'jvm.cpu_pressure');
    const profile = classifyEvidence(projected);
    assert.equal(profile.category, 'primary_signal');
    assert.equal(profile.reliabilityScore, 0.95);
    assert.equal(profile.diagnosticWeight, 1);
  });

  it('B. unknown JFR envelope is weak_signal', () => {
    const projected = projectJfrSignalEvidence({ id: 'inc-1', node_id: 'n' }, {
      schemaVersion: 1,
      id: 'evt-mystery',
      time: '2026-08-20T12:00:00.000Z',
      source: 'jfr',
      nodeId: 'n',
      service: 'data-asset-service',
      type: 'jvm.mystery_signal',
      severity: 'warning',
      message: 'unknown jfr',
      attributes: { heap: 99 },
    })!;
    assert.equal((projected.data as { semanticType?: string }).semanticType, undefined);
    assert.deepEqual((projected.data as { attributes: object }).attributes, {});
    const profile = classifyEvidence(projected);
    assert.equal(profile.category, 'weak_signal');
  });

  it('C. known type with no valid semantic attributes is weak_signal', () => {
    const projected = projectJfrSignalEvidence({ id: 'inc-1', node_id: 'n' }, {
      schemaVersion: 1,
      id: 'evt-empty-cpu',
      time: '2026-08-20T12:00:00.000Z',
      source: 'jfr',
      nodeId: 'n',
      service: 'data-asset-service',
      type: 'jvm.cpu_pressure',
      severity: 'warning',
      message: 'JVM CPU pressure',
      attributes: { jvmUser: '0.9', jvmSystem: true, machineTotal: 2 },
    })!;
    assert.equal((projected.data as { semanticType?: string }).semanticType, undefined);
    assert.deepEqual((projected.data as { attributes: object }).attributes, {});
    const profile = classifyEvidence(projected);
    assert.equal(profile.category, 'weak_signal');
  });

  it('offline application business.error contract reaches one primary signal in the frozen runtime context', async () => {
    const event = offlineApplicationBusinessError({ secret: 'must-not-copy', nested: { token: 'nope' } });
    assert.equal(Object.hasOwn(event.attributes, 'exceptionMessage'), false);
    const batch = {
      producer: { id: 'data-asset', type: 'application' as const, version: '0.1.0' },
      events: [event],
    };
    const { store, engine, app, response } = await ingest(batch);
    assert.equal(response.status, 200);
    const incident = store.findIncidentByEventId(event.id)!;
    const derived = store.listEvidence(incident.id);
    assert.equal(derived.length, 1);
    assert.equal(derived[0]!.id, jfrEvidenceId(event.id));
    assert.equal(derived[0]!.kind, 'jfr.signal');
    assert.equal(derived[0]!.source, 'application');
    assert.equal(classifyEvidence(derived[0]!).category, 'primary_signal');
    const data = derived[0]!.data as {
      semanticType: string;
      message: string;
      attributes: Record<string, unknown>;
    };
    assert.equal(data.semanticType, 'business.error');
    assert.equal(data.message, OFFLINE_SAFE_SUMMARY);
    assert.equal(data.attributes.exceptionClass, OFFLINE_EXCEPTION_CLASS);
    assert.equal(data.attributes.exceptionStackTrace, OFFLINE_EXCEPTION_STACK);
    assert.equal(data.attributes.exceptionMessage, undefined);
    assert.equal(data.attributes.operation, 'GET /probe/boom');
    for (const dropped of ['secret', 'nested', 'module', 'businessCode', 'responseStatus', 'safeMessage']) {
      assert.equal(data.attributes[dropped], undefined);
    }

    let submitted: InvestigationContext | undefined;
    const runtime: PiRuntimeClient = {
      async submitInvestigation(_session, context) {
        submitted = context;
        return { runtimeTaskId: 'rt-offline-contract' };
      },
    };
    const loop = createInvestigationLoopService(store, { runtime });
    const { session } = loop.start(incident.id);
    await loop.submit(session.id);
    assert.ok(submitted);
    assert.equal(Object.isFrozen(submitted), true);
    const frozen = submitted.evidence.find((item) => item.id === derived[0]!.id)!;
    assert.equal(frozen.source, 'application');
    assert.equal(frozen.kind, 'jfr.signal');
    assert.equal(Object.isFrozen(frozen.data), true);
    const frozenAttributes = (frozen.data as { attributes: Record<string, unknown> }).attributes;
    assert.equal(frozenAttributes.exceptionClass, OFFLINE_EXCEPTION_CLASS);
    assert.equal(frozenAttributes.exceptionStackTrace, OFFLINE_EXCEPTION_STACK);

    const replay = await app.request('/v1/events', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(batch),
    });
    assert.equal(replay.status, 200);
    engine.processEvent(event, event.time);
    persistJfrSignalEvidence(store, incident, event);
    assert.equal(store.listEvidence(incident.id).filter((item) => item.kind === 'jfr.signal').length, 1);
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
    store.close();
  });

  it('does not project other sources or fact-less application business.error', () => {
    const incident = { id: 'inc-1', node_id: 'n' };
    const event = offlineApplicationBusinessError();
    assert.equal(projectJfrSignalEvidence(incident, { ...event, type: 'application.slow_sql' }), null);
    assert.equal(projectJfrSignalEvidence(incident, { ...event, source: 'docker' }), null);
    assert.equal(projectJfrSignalEvidence(incident, { ...event, source: 'host', type: 'jvm.oom' }), null);
    const golden = JSON.parse(readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dataasset-business-error.eventbatch.json'),
      'utf8',
    )) as { events: OpsEvent[] };
    assert.equal(projectJfrSignalEvidence(incident, golden.events[0]!), null);
    for (const attributes of [
      { exceptionClass: 'bad class', exceptionStackTrace: OFFLINE_EXCEPTION_STACK },
      { exceptionClass: OFFLINE_EXCEPTION_CLASS },
      { exceptionClass: OFFLINE_EXCEPTION_CLASS, exceptionStackTrace: '   ' },
      { exceptionClass: OFFLINE_EXCEPTION_CLASS, exceptionStackTrace: '' },
      { exceptionClass: OFFLINE_EXCEPTION_CLASS, exceptionStackTrace: OFFLINE_SAFE_SUMMARY },
      {
        containerName: 'data-asset',
        module: '/probe/boom',
        operation: 'GET /probe/boom',
        responseStatus: 500,
        safeMessage: OFFLINE_SAFE_SUMMARY,
        businessCode: 'UNHANDLED_EXCEPTION',
      },
    ]) {
      assert.equal(projectJfrSignalEvidence(incident, { ...event, id: 'evt-no-fact', attributes }), null);
    }
    const bounded = projectJfrSignalEvidence(incident, offlineApplicationBusinessError({
      exceptionStackTrace: `${OFFLINE_EXCEPTION_STACK}\n${'at com.example.Boom.fail(Boom.java:2)\n'.repeat(300)}`,
    }))!;
    const stack = (bounded.data as { attributes: { exceptionStackTrace: string } }).attributes.exceptionStackTrace;
    assert.equal(stack.length, 4096);
    assert.equal(stack.startsWith('at '), true);
    assert.equal(classifyEvidence(bounded).category, 'primary_signal');
    assert.equal(bounded.source, 'application');
  });
});
