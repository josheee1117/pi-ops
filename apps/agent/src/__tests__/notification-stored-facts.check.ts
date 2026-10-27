/**
 * 运行说明：通知存储事实层转换与真实 SQLite 行为快照
 *
 * 怎么跑：
 *   在 apps/agent 目录下运行：
 *     ./node_modules/.bin/tsx src/__tests__/notification-stored-facts.check.ts
 *   或在仓库根目录下运行：
 *     pnpm --filter @pi-ops/agent exec tsx src/__tests__/notification-stored-facts.check.ts
 *
 * 什么时候跑：
 *   修改通知存储事实层（src/notification-stored-facts.ts）、存储模型与事件关联逻辑后手动运行。
 *   本文件以 .check.ts 命名，默认 pnpm test（仅匹配 src/**\/*.test.ts）不会自动运行它。
 *   提交通知事实层改动前必须单独运行本离线检查。
 *
 * 期望输出：
 *   自备临时目录下的 SQLite 数据库并运行用例。全部通过时以 exit code 0 结束，控制台输出包含：
 *     ℹ tests 10
 *     ℹ suites 1
 *     ℹ pass 10
 *     ℹ fail 0
 *   临时目录会在退出前自动清理。若任何断言失败，抛出 AssertionError 并以非 0 状态码退出。
 *   注意：exit 0 仅表示事实层离线合同快照匹配，不代表真实环境场景 PASS。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { OpsEvent } from '@pi-ops/protocol';
import { createApp } from '../app.js';
import { createIncidentEngine } from '../incident.js';
import { createNotificationJobWorker } from '../notification-worker.js';
import { createFakeNotifier } from '../notifier.js';
import { decideFirstNotification, type FirstNotificationDecision, type MissingFact, type NotificationObservation } from '../notification-policy.js';
import { buildFirstNotificationFactsFromStore } from '../notification-stored-facts.js';
import { createEventStore, type EventStore } from '../store.js';
import { makeAgentConfig } from './test-config.js';

const unknown = { kind: 'unknown' } as const;
const none: FirstNotificationDecision = {
  action: 'record',
  reason: 'no-observation',
  missing: [],
  failures: unknown,
  requests: unknown,
  sources: [],
};
const gaps = ['failure-count', 'request-count', 'persistence', 'impact'] as const;
const REAL_STACK = 'java.lang.OutOfMemoryError: Java heap space\n\tat com.example.Main.main(Main.java:12)';

function source(id: string): NotificationObservation['source'] {
  return { kind: 'event', id };
}

function opsEvent(overrides: Partial<OpsEvent> & Pick<OpsEvent, 'id' | 'source' | 'type'>): OpsEvent {
  return {
    schemaVersion: 1,
    time: '2026-08-20T12:00:00.000Z',
    nodeId: 'test-svc-02',
    service: 'data-asset-service',
    severity: 'error',
    message: 'fixture',
    attributes: {},
    ...overrides,
  };
}

function ordinary(id: string): NotificationObservation {
  return {
    kind: 'ordinary-error',
    persistence: unknown,
    impact: unknown,
    failures: unknown,
    requests: unknown,
    logLines: unknown,
    source: source(id),
  };
}

async function ingest(
  events: OpsEvent[],
  producer: 'application' | 'node-agent',
  dbPath = ':memory:',
): Promise<{ store: EventStore; app: Awaited<ReturnType<typeof createApp>> }> {
  const store = createEventStore(dbPath);
  const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000, scheduleLocalReasoning: false });
  const app = createApp(makeAgentConfig(), store, engine);
  const response = await app.request('/v1/events', {
    method: 'POST',
    headers: { Authorization: 'Bearer ingest-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ producer: { id: 'fixture', type: producer, version: '1' }, events }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return { store, app };
}

function incidentIdOf(store: EventStore, eventId: string): string {
  const incident = store.findIncidentByEventId(eventId);
  assert.ok(incident, eventId);
  return incident.id;
}

function converted(store: EventStore, incidentId: string, eventIds: readonly string[]) {
  const facts = buildFirstNotificationFactsFromStore(store, { incidentId, eventIds });
  return { facts, decision: decideFirstNotification(facts) };
}

function assertRejectedFacts(
  store: EventStore,
  incidentId: string,
  expectedGaps: Array<{ eventId: string; reason: MissingFact }>,
): void {
  const result = converted(store, incidentId, expectedGaps.map((gap) => gap.eventId));
  assert.deepEqual(result.facts.observations, []);
  assert.deepEqual([...new Set(result.facts.gaps?.map((gap) => JSON.stringify(gap)))],
    [...new Set(expectedGaps.map((gap) => JSON.stringify(gap)))]);
  assert.deepEqual(result.decision, { ...none, missing: [...new Set(expectedGaps.map((gap) => gap.reason))] });
}

describe('stored notification facts', () => {
  it('distinguishes missing incidents and invalid times from an empty observation request', async () => {
    const event = opsEvent({ id: 'evt-validation', source: 'application', type: 'business.error' });
    const { store } = await ingest([event], 'application');
    try {
      const id = incidentIdOf(store, event.id);
      assert.deepEqual(converted(store, id, []), { facts: { observations: [] }, decision: none });
      assert.throws(() => converted(store, 'missing', []), /Incident missing does not exist/);
      assert.throws(() => buildFirstNotificationFactsFromStore(store, { incidentId: id, eventIds: [], now: 'not-a-time' }), /Invalid notification evaluation time/);
      const incident = store.getIncident(id)!;
      store.updateIncident(id, { ...incident, first_seen: 'not-a-time' });
      assert.throws(() => converted(store, id, []), /has invalid observation times/);
    } finally { store.close(); }
  });

  it('converts JFR OOME from ingress and rejects class-only, empty, and OOM text', async () => {
    const oome = opsEvent({
      id: 'evt-jfr-oome',
      source: 'jfr',
      type: 'jvm.oom',
      severity: 'critical',
      message: 'OOM',
      attributes: { exceptionClass: 'java.lang.OutOfMemoryError', exceptionMessage: 'Java heap space' },
    });
    const classOnly = opsEvent({
      id: 'evt-jfr-class',
      source: 'jfr',
      type: 'jvm.oom',
      service: 'class-only',
      attributes: { exceptionClass: 'java.lang.OutOfMemoryError', exceptionStackTrace: 'OOM not a stack' },
    });
    const empty = opsEvent({
      id: 'evt-jfr-empty',
      source: 'jfr',
      type: 'jvm.oom',
      service: 'empty-content',
      attributes: { exceptionMessage: '', stackTrace: '' },
    });
    const textOnly = opsEvent({
      id: 'evt-jfr-text',
      source: 'jfr',
      type: 'jvm.oom',
      service: 'oom-text',
      severity: 'critical',
      message: 'critical OOM Java heap space',
      attributes: { exceptionMessage: 'OOM' },
    });
    const nonStackExtended = opsEvent({
      id: 'evt-jfr-extended',
      source: 'jfr',
      type: 'jvm.oom',
      service: 'extended-stack',
      attributes: {
        exceptionClass: 'java.lang.OutOfMemoryError',
        jfrStackTrace: 'arbitrary nonblank',
      },
    });
    const { store, app } = await ingest([oome, classOnly, empty, textOnly, nonStackExtended], 'application');
    const oomeId = incidentIdOf(store, oome.id);
    const beforeIncident = structuredClone(store.getIncident(oomeId));
    const beforeJobs = structuredClone(store.listNotificationJobs(oomeId));
    const beforeEvent = structuredClone(store.getEvent(oome.id));
    const positive = converted(store, oomeId, [oome.id]);
    assert.deepEqual(positive.facts, {
      observations: [{
        kind: 'jvm-exception',
        exceptionClass: 'java.lang.OutOfMemoryError',
        exceptionMessage: 'Java heap space',
        stackTrace: '',
        source: source(oome.id),
      }],
    });
    assert.deepEqual(positive.decision, {
      action: 'alert',
      reason: 'jvm-oome',
      missing: [],
      failures: unknown,
      requests: unknown,
      sources: [source(oome.id)],
    });
    assert.deepEqual(store.getIncident(oomeId), beforeIncident);
    assert.deepEqual(store.listNotificationJobs(oomeId), beforeJobs);
    assert.deepEqual(store.getEvent(oome.id), beforeEvent);
    assert.deepEqual(converted(store, oomeId, [oome.id]).facts, positive.facts);

    const classDecision = converted(store, incidentIdOf(store, classOnly.id), [classOnly.id]);
    assert.deepEqual(classDecision.facts, {
      observations: [{
        kind: 'jvm-exception',
        exceptionClass: 'java.lang.OutOfMemoryError',
        exceptionMessage: '',
        stackTrace: '',
        source: source(classOnly.id),
      }],
    });
    assert.deepEqual(classDecision.decision, {
      action: 'record',
      reason: 'exception-not-oome',
      missing: [],
      failures: unknown,
      requests: unknown,
      sources: [source(classOnly.id)],
    });
    assertRejectedFacts(store, incidentIdOf(store, empty.id), [{ eventId: empty.id, reason: 'invalid-event' }]);
    assertRejectedFacts(store, incidentIdOf(store, textOnly.id), [{ eventId: textOnly.id, reason: 'invalid-event' }]);
    assert.deepEqual(converted(store, incidentIdOf(store, nonStackExtended.id), [nonStackExtended.id]).decision, {
      action: 'record',
      reason: 'exception-not-oome',
      missing: [],
      failures: unknown,
      requests: unknown,
      sources: [source(nonStackExtended.id)],
    });

    const replay = await app.request('/v1/events', {
      method: 'POST',
      headers: { Authorization: 'Bearer ingest-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ producer: { id: 'fixture', type: 'application', version: '1' }, events: [oome] }),
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(converted(store, oomeId, [oome.id]).facts, positive.facts);
    assert.deepEqual(store.listNotificationJobs(oomeId), beforeJobs);
    assert.deepEqual(store.getEvent(oome.id), beforeEvent);
    assert.deepEqual(store.getIncident(oomeId), beforeIncident);
    store.close();
  });

  it('keeps an equivalent parsed window and reports an event outside it as a gap', async () => {
    const event = opsEvent({
      id: 'evt-jfr-window',
      source: 'jfr',
      type: 'jvm.oom',
      attributes: { exceptionClass: 'java.lang.OutOfMemoryError', exceptionMessage: 'Java heap space' },
    });
    const { store } = await ingest([event], 'application');
    const id = incidentIdOf(store, event.id);
    const incident = store.getIncident(id)!;
    store.updateIncident(id, {
      first_seen: '2026-08-20T20:00:00+08:00',
      last_seen: '2026-08-20T20:00:00.000+08:00',
      event_count: incident.event_count,
      severity: incident.severity,
      state: incident.state,
    });
    assert.deepEqual(converted(store, id, [event.id]).decision, {
      action: 'alert',
      reason: 'jvm-oome',
      missing: [],
      failures: unknown,
      requests: unknown,
      sources: [source(event.id)],
    });
    store.updateIncident(id, {
      first_seen: '2026-08-20T13:00:00.000Z',
      last_seen: '2026-08-20T14:00:00.000Z',
      event_count: incident.event_count,
      severity: incident.severity,
      state: incident.state,
    });
    assertRejectedFacts(store, id, [{ eventId: event.id, reason: 'invalid-event' }]);
    store.close();
  });

  it('converts docker oom facts without treating type, message, or exit 137 as authorization', async () => {
    const oom = opsEvent({
      id: 'evt-docker-oom',
      source: 'docker',
      type: 'container.oom',
      service: 'box',
      severity: 'critical',
      message: 'Container box OOM',
      attributes: { dockerAction: 'oom', oomKilled: false },
    });
    const killed = opsEvent({
      id: 'evt-oom-killed',
      source: 'docker',
      type: 'container.die',
      service: 'box-killed',
      severity: 'critical',
      message: 'exit',
      attributes: { dockerAction: 'die', oomKilled: true, exitCode: 137, containerName: 'box-killed' },
    });
    const die = opsEvent({
      id: 'evt-die-137',
      source: 'docker',
      type: 'container.die',
      service: 'box-die',
      severity: 'critical',
      message: 'OOM killed',
      attributes: { dockerAction: 'die', oomKilled: false, exitCode: 137, containerName: 'box-die' },
    });
    const label = opsEvent({
      id: 'evt-oom-label',
      source: 'docker',
      type: 'container.oom',
      service: 'box-label',
      severity: 'critical',
      message: 'OOM',
      attributes: { oomKilled: 'true', exitCode: '137', containerName: 'box-label' },
    });
    const conflict = opsEvent({
      id: 'evt-docker-conflict',
      source: 'docker',
      type: 'container.oom',
      service: 'box-owner',
      message: 'OOM',
      attributes: { dockerAction: 'oom', oomKilled: true, containerName: 'other-box', nodeId: 'other-node' },
    });
    const { store } = await ingest([oom, killed, die, label, conflict], 'node-agent');
    assert.deepEqual(converted(store, incidentIdOf(store, oom.id), [oom.id]), {
      facts: {
        observations: [{
          kind: 'docker',
          dockerAction: 'oom',
          oomKilled: false,
          exitCode: { kind: 'absent' },
          source: source(oom.id),
        }],
      },
      decision: {
        action: 'alert',
        reason: 'docker-oom',
        missing: [],
        failures: unknown,
        requests: unknown,
        sources: [source(oom.id)],
      },
    });
    assert.deepEqual(converted(store, incidentIdOf(store, killed.id), [killed.id]).decision, {
      action: 'alert',
      reason: 'docker-oom',
      missing: [],
      failures: unknown,
      requests: unknown,
      sources: [source(killed.id)],
    });
    assert.deepEqual(converted(store, incidentIdOf(store, die.id), [die.id]).decision, {
      action: 'record',
      reason: 'container-exit-without-oom',
      missing: [],
      failures: unknown,
      requests: unknown,
      sources: [source(die.id)],
    });
    assert.deepEqual(converted(store, incidentIdOf(store, label.id), [label.id]), {
      facts: {
        observations: [{
          kind: 'docker',
          dockerAction: '',
          oomKilled: false,
          exitCode: { kind: 'absent' },
          source: source(label.id),
        }],
      },
      decision: {
        action: 'record',
        reason: 'container-exit-without-oom',
        missing: [],
        failures: unknown,
        requests: unknown,
        sources: [source(label.id)],
      },
    });
    assertRejectedFacts(store, incidentIdOf(store, conflict.id), [{ eventId: conflict.id, reason: 'invalid-event' }]);
    store.close();
  });

  it('keeps business gaps and does not turn repeated events into counts', async () => {
    const plain = opsEvent({
      id: 'evt-biz-z',
      source: 'application',
      type: 'business.error',
      time: '2026-08-20T12:00:00.000Z',
      attributes: { businessCode: 'E1', module: 'pay' },
    });
    const withClass = opsEvent({
      id: 'evt-biz-a',
      source: 'application',
      type: 'business.error',
      time: '2026-08-20T12:01:00.000Z',
      attributes: {
        businessCode: 'E1',
        module: 'pay',
        exceptionClass: 'java.lang.IllegalStateException',
        exceptionMessage: 'nope',
        stackTrace: REAL_STACK,
      },
    });
    const { store } = await ingest([withClass, plain], 'application');
    const id = incidentIdOf(store, plain.id);
    assert.equal(store.getIncident(id)?.event_count, 2);
    const expected = {
      observations: [ordinary(plain.id), ordinary(withClass.id)],
      unknownImpactDueAt: '2026-08-20T12:05:00.000Z',
    };
    assert.deepEqual(converted(store, id, [withClass.id, plain.id, plain.id]).facts, expected);
    assert.deepEqual(converted(store, id, [plain.id, withClass.id]).facts, expected);
    assert.deepEqual(converted(store, id, [plain.id, withClass.id]).decision, {
      action: 'analyze',
      reason: 'ordinary-without-major-fact',
      missing: [...gaps],
      failures: unknown,
      requests: unknown,
      sources: [source(plain.id), source(withClass.id)],
    });
    store.close();
  });

  it('alerts application business.error only for a real OOME and keeps the gap', async () => {
    const positive = opsEvent({
      id: 'evt-biz-oome',
      source: 'application',
      type: 'business.error',
      attributes: {
        exceptionClass: 'java.lang.OutOfMemoryError',
        exceptionMessage: 'Java heap space',
      },
    });
    const extended = opsEvent({
      id: 'evt-biz-stack',
      source: 'application',
      type: 'business.error',
      service: 'stack-service',
      attributes: {
        exceptionClass: 'java.lang.OutOfMemoryError',
        exceptionStackTrace: REAL_STACK,
      },
    });
    const nonStack = opsEvent({
      id: 'evt-biz-nonstack',
      source: 'application',
      type: 'business.error',
      service: 'nonstack-service',
      severity: 'critical',
      message: 'OOM',
      attributes: {
        exceptionClass: 'java.lang.OutOfMemoryError',
        exceptionStackTrace: 'arbitrary nonblank',
      },
    });
    const { store } = await ingest([positive, extended, nonStack], 'application');
    assert.deepEqual(converted(store, incidentIdOf(store, positive.id), [positive.id]), {
      facts: {
        gaps: [{ eventId: positive.id, reason: 'operation-binding' }],
        observations: [
          ordinary(positive.id),
          {
            kind: 'jvm-exception',
            exceptionClass: 'java.lang.OutOfMemoryError',
            exceptionMessage: 'Java heap space',
            stackTrace: '',
            source: source(positive.id),
          },
        ],
      },
      decision: {
        action: 'alert',
        reason: 'jvm-oome',
        missing: [...gaps, 'operation-binding'],
        failures: unknown,
        requests: unknown,
        sources: [source(positive.id)],
      },
    });
    const extendedResult = converted(store, incidentIdOf(store, extended.id), [extended.id]);
    assert.deepEqual(extendedResult.facts, {
      gaps: [{ eventId: extended.id, reason: 'operation-binding' }],
      observations: [
        ordinary(extended.id),
        {
          kind: 'jvm-exception',
          exceptionClass: 'java.lang.OutOfMemoryError',
          exceptionMessage: '',
          stackTrace: REAL_STACK,
          source: source(extended.id),
        },
      ],
    });
    assert.deepEqual(extendedResult.decision, {
      action: 'alert',
      reason: 'jvm-oome',
      missing: [...gaps, 'operation-binding'],
      failures: unknown,
      requests: unknown,
      sources: [source(extended.id)],
    });
    assert.deepEqual(converted(store, incidentIdOf(store, nonStack.id), [nonStack.id]), {
      facts: { observations: [ordinary(nonStack.id)], gaps: [{ eventId: nonStack.id, reason: 'operation-binding' }] },
      decision: {
        action: 'analyze',
        reason: 'ordinary-without-major-fact',
        missing: [...gaps, 'operation-binding'],
        failures: unknown,
        requests: unknown,
        sources: [source(nonStack.id)],
      },
    });
    store.close();
  });

  it('does not invent a health binding or accept unrelated identities', async () => {
    const failure = opsEvent({
      id: 'evt-health',
      source: 'health',
      type: 'health.failure',
      service: 'data-asset',
      message: 'HTTP 503',
      attributes: { status: 503, target: 'data-asset', url: 'http://127.0.0.1/health', detector: 'http.health' },
    });
    const recovered = opsEvent({
      id: 'evt-health-recovered',
      source: 'health',
      type: 'health.recovered',
      service: 'data-asset',
      time: '2026-08-20T12:05:00.000Z',
      severity: 'info',
      message: 'recovered',
      attributes: { status: 200, target: 'data-asset', url: 'http://127.0.0.1/health' },
    });
    const wrongProducer = opsEvent({
      id: 'evt-docker-app',
      source: 'docker',
      type: 'container.oom',
      service: 'foreign',
      attributes: { dockerAction: 'oom', oomKilled: true },
    });
    const applicationOom = opsEvent({
      id: 'evt-app-oom',
      source: 'application',
      type: 'jvm.oom',
      service: 'foreign-jvm',
      attributes: { exceptionClass: 'java.lang.OutOfMemoryError', exceptionMessage: 'Java heap space' },
    });
    const { store } = await ingest([failure, recovered], 'node-agent');
    const healthId = incidentIdOf(store, failure.id);
    assert.equal(store.findIncidentByEventId(recovered.id)?.id, healthId);
    assert.deepEqual(converted(store, healthId, [failure.id]), {
      facts: {
        observations: [{
          kind: 'health',
          binding: { kind: 'missing' },
          transition: { kind: 'failure' },
          source: source(failure.id),
        }],
      },
      decision: {
        action: 'record',
        reason: 'health-binding-missing',
        missing: ['health-binding'],
        failures: unknown,
        requests: unknown,
        sources: [source(failure.id)],
      },
    });
    assert.deepEqual(converted(store, healthId, [recovered.id]).decision, none);

    const other = await ingest([wrongProducer, applicationOom], 'application');
    assertRejectedFacts(other.store, incidentIdOf(other.store, wrongProducer.id), [{ eventId: wrongProducer.id, reason: 'unsupported-source' }]);
    assert.deepEqual(converted(other.store, incidentIdOf(other.store, applicationOom.id), [applicationOom.id]).decision, {
      action: 'alert', reason: 'jvm-oome', missing: [], failures: unknown, requests: unknown, sources: [source(applicationOom.id)],
    });
    assertRejectedFacts(store, healthId, [
      { eventId: wrongProducer.id, reason: 'invalid-event' },
      { eventId: 'missing-event', reason: 'invalid-event' },
    ]);

    const manual = createEventStore(':memory:');
    const nodeEvent = opsEvent({
      id: 'evt-node-mismatch',
      source: 'docker',
      type: 'container.oom',
      service: 'box',
      attributes: { dockerAction: 'oom', oomKilled: true, containerName: 'box' },
    });
    const serviceEvent = opsEvent({
      id: 'evt-service-mismatch',
      source: 'docker',
      type: 'container.die',
      service: 'box',
      attributes: { dockerAction: 'die', oomKilled: true, containerName: 'box' },
    });
    const unlinked = opsEvent({
      id: 'evt-unlinked',
      source: 'docker',
      type: 'container.oom',
      service: 'loose',
      attributes: { dockerAction: 'oom', oomKilled: true },
    });
    manual.insertBatch({
      producer: { id: 'na', type: 'node-agent', version: '1' },
      events: [nodeEvent, serviceEvent, unlinked],
    }, nodeEvent.time);
    const wrongNode = manual.createIncident({
      service: 'box',
      node_id: 'other-node',
      type: 'container.oom',
      state: 'OPEN',
      fingerprint: 'manual-node',
      first_seen: nodeEvent.time,
      last_seen: nodeEvent.time,
      event_count: 1,
      severity: 'critical',
    });
    const wrongService = manual.createIncident({
      service: 'other-service',
      node_id: 'test-svc-02',
      type: 'container.die',
      state: 'OPEN',
      fingerprint: 'manual-service',
      first_seen: serviceEvent.time,
      last_seen: serviceEvent.time,
      event_count: 1,
      severity: 'error',
    });
    assert.equal(manual.linkEventToIncident(wrongNode.id, nodeEvent.id), true);
    assert.equal(manual.linkEventToIncident(wrongService.id, serviceEvent.id), true);
    assertRejectedFacts(manual, wrongNode.id, [{ eventId: nodeEvent.id, reason: 'invalid-event' }]);
    assertRejectedFacts(manual, wrongService.id, [{ eventId: serviceEvent.id, reason: 'invalid-event' }]);
    assertRejectedFacts(manual, wrongNode.id, [{ eventId: unlinked.id, reason: 'invalid-event' }]);
    manual.close();
    other.store.close();
    store.close();
  });

  it('reports malformed attributes and event times as gaps and does not hide a closed database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stored-facts-'));
    const dbPath = join(dir, 'facts.sqlite');
    try {
      const oome = opsEvent({
        id: 'evt-bad-oome',
        source: 'jfr',
        type: 'jvm.oom',
        attributes: { exceptionClass: 'java.lang.OutOfMemoryError', exceptionMessage: 'Java heap space' },
      });
      const business = opsEvent({
        id: 'evt-bad-biz',
        source: 'application',
        type: 'business.error',
        service: 'bad-biz',
        attributes: { exceptionClass: 'java.lang.OutOfMemoryError', exceptionMessage: 'Java heap space' },
      });
      const docker = opsEvent({
        id: 'evt-bad-docker',
        source: 'docker',
        type: 'container.oom',
        service: 'bad-docker',
        attributes: { dockerAction: 'oom', oomKilled: true },
      });
      const invalidTime = opsEvent({
        id: 'evt-bad-time',
        source: 'jfr',
        type: 'jvm.oom',
        service: 'bad-time',
        attributes: { exceptionClass: 'java.lang.OutOfMemoryError', exceptionMessage: 'Java heap space' },
      });
      const { store } = await ingest([oome], 'application', dbPath);
      const dockerStore = createEventStore(join(dir, 'docker.sqlite'));
      const engine = createIncidentEngine(dockerStore, { aggregationWindowMs: 300_000, scheduleLocalReasoning: false });
      const app = createApp(makeAgentConfig(), dockerStore, engine);
      const dockerResponse = await app.request('/v1/events', {
        method: 'POST',
        headers: { Authorization: 'Bearer ingest-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ producer: { id: 'fixture', type: 'node-agent', version: '1' }, events: [docker] }),
      });
      assert.equal(dockerResponse.status, 200);
      const businessStore = createEventStore(join(dir, 'business.sqlite'));
      const businessEngine = createIncidentEngine(businessStore, { aggregationWindowMs: 300_000, scheduleLocalReasoning: false });
      const businessApp = createApp(makeAgentConfig(), businessStore, businessEngine);
      const businessResponse = await businessApp.request('/v1/events', {
        method: 'POST',
        headers: { Authorization: 'Bearer ingest-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          producer: { id: 'fixture', type: 'application', version: '1' },
          events: [business, invalidTime],
        }),
      });
      assert.equal(businessResponse.status, 200);
      rewrite(dbPath, oome.id, '[]', null);
      rewrite(join(dir, 'docker.sqlite'), docker.id, 'null', null);
      rewrite(join(dir, 'business.sqlite'), business.id, '{', null);
      rewrite(join(dir, 'business.sqlite'), invalidTime.id, null, 'not-a-time');

      assertRejectedFacts(store, incidentIdOf(store, oome.id), [{ eventId: oome.id, reason: 'invalid-event' }]);
      assertRejectedFacts(dockerStore, incidentIdOf(dockerStore, docker.id), [{ eventId: docker.id, reason: 'invalid-event' }]);
      const businessResult = converted(businessStore, incidentIdOf(businessStore, business.id), [business.id]);
      assert.deepEqual(businessResult.facts, {
        observations: [ordinary(business.id)],
        gaps: [{ eventId: business.id, reason: 'invalid-event' }, { eventId: business.id, reason: 'operation-binding' }],
      });
      assert.deepEqual(businessResult.decision, {
        action: 'analyze',
        reason: 'ordinary-without-major-fact',
        missing: [...gaps, 'invalid-event', 'operation-binding'],
        failures: unknown,
        requests: unknown,
        sources: [source(business.id)],
      });
      assertRejectedFacts(businessStore, incidentIdOf(businessStore, invalidTime.id), [{ eventId: invalidTime.id, reason: 'invalid-event' }]);
      store.close();
      dockerStore.close();
      businessStore.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const closed = createEventStore(':memory:');
    closed.close();
    assert.throws(() => buildFirstNotificationFactsFromStore(closed, { incidentId: 'missing', eventIds: ['missing'] }));
  });

  it('does not schedule or deliver an unconditional OPEN for an isolated slow SQL', async () => {
    const opened = opsEvent({
      id: 'evt-isolated-slow-sql',
      source: 'application',
      type: 'application.slow_sql',
      severity: 'warning',
      message: 'slow sql',
      attributes: { sqlFingerprint: 'deadbeef' },
    });
    const { store } = await ingest([opened], 'application');
    const id = incidentIdOf(store, opened.id);
    const notifier = createFakeNotifier();
    const worker = createNotificationJobWorker(makeAgentConfig({
      evidenceJobPollIntervalMs: 60_000,
      reasoningJobPollIntervalMs: 60_000,
      notificationJobPollIntervalMs: 60_000,
      notificationJobMaxAttempts: 3,
    }), store, notifier);
    await worker.runOnce();
    assert.deepEqual(notifier.sent, []);
    assert.deepEqual(store.listNotificationJobs(id), []);
    assert.equal(store.getNotificationDecision(id)?.action, 'analyze');
    assert.equal(store.getIncident(id)?.state, 'OPEN');
    store.close();
  });

  it('rejects an event that belongs to another Incident in the same database', async () => {
    const oom = opsEvent({
      id: 'evt-cross-oom',
      source: 'docker',
      type: 'container.oom',
      nodeId: 'test-svc-02',
      service: 'shared-box',
      time: '2026-08-20T12:00:00.000Z',
      severity: 'critical',
      message: 'Container shared-box OOM',
      attributes: { dockerAction: 'oom', oomKilled: false, containerName: 'shared-box' },
    });
    const killed = opsEvent({
      id: 'evt-cross-die',
      source: 'docker',
      type: 'container.die',
      nodeId: 'test-svc-02',
      service: 'shared-box',
      time: '2026-08-20T12:00:00.000Z',
      severity: 'critical',
      message: 'Container shared-box died',
      attributes: { dockerAction: 'die', oomKilled: true, exitCode: 137, containerName: 'shared-box' },
    });
    const { store } = await ingest([oom, killed], 'node-agent');
    const storedOom = store.getEvent(oom.id);
    const storedDie = store.getEvent(killed.id);
    const incidentOom = store.findIncidentByEventId(oom.id);
    const incidentDie = store.findIncidentByEventId(killed.id);
    assert.ok(storedOom);
    assert.ok(storedDie);
    assert.ok(incidentOom);
    assert.ok(incidentDie);
    assert.notEqual(incidentOom.id, incidentDie.id);
    assert.notEqual(incidentOom.fingerprint, incidentDie.fingerprint);
    assert.equal(storedOom.node_id, storedDie.node_id);
    assert.equal(storedOom.service, storedDie.service);
    assert.equal(storedOom.event_time, storedDie.event_time);
    assert.equal(storedOom.producer_type, 'node-agent');
    assert.equal(storedDie.producer_type, 'node-agent');
    assert.equal(incidentOom.node_id, storedOom.node_id);
    assert.equal(incidentDie.node_id, storedDie.node_id);
    assert.equal(incidentOom.service, storedOom.service);
    assert.equal(incidentDie.service, storedDie.service);
    assert.deepEqual(converted(store, incidentOom.id, [oom.id]), {
      facts: {
        observations: [{
          kind: 'docker',
          dockerAction: 'oom',
          oomKilled: false,
          exitCode: { kind: 'absent' },
          source: source(oom.id),
        }],
      },
      decision: {
        action: 'alert',
        reason: 'docker-oom',
        missing: [],
        failures: unknown,
        requests: unknown,
        sources: [source(oom.id)],
      },
    });
    assert.deepEqual(converted(store, incidentDie.id, [killed.id]), {
      facts: {
        observations: [{
          kind: 'docker',
          dockerAction: 'die',
          oomKilled: true,
          exitCode: { kind: 'known', value: 137 },
          source: source(killed.id),
        }],
      },
      decision: {
        action: 'alert',
        reason: 'docker-oom',
        missing: [],
        failures: unknown,
        requests: unknown,
        sources: [source(killed.id)],
      },
    });
    assertRejectedFacts(store, incidentOom.id, [{ eventId: killed.id, reason: 'invalid-event' }]);
    assertRejectedFacts(store, incidentDie.id, [{ eventId: oom.id, reason: 'invalid-event' }]);
    store.close();
  });
});

function rewrite(dbPath: string, id: string, attributes: string | null, eventTime: string | null): void {
  const raw = new Database(dbPath, { timeout: 5000 });
  try {
    if (attributes !== null) {
      const updated = raw.prepare('UPDATE events SET attributes = ? WHERE id = ?').run(attributes, id);
      assert.equal(updated.changes, 1);
    }
    if (eventTime !== null) {
      const updated = raw.prepare('UPDATE events SET event_time = ? WHERE id = ?').run(eventTime, id);
      assert.equal(updated.changes, 1);
    }
  } finally {
    raw.close();
  }
}
