import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpsEvent } from '@pi-ops/protocol';
import { deterministicSummary, summarySeverityForType } from '@pi-ops/protocol';
import { createApp } from '../app.js';
import { planEvidenceQueries } from '../evidence-orchestrator.js';
import { computeFingerprint } from '../fingerprint.js';
import { toRuntimeSafeEvidence } from '../incident-context.js';
import { createIncidentEngine } from '../incident.js';
import { decideFirstNotification, type NotificationObservation } from '../notification-policy.js';
import * as notificationDecision from '../notification-decision.js';
import {
  DEFAULT_NOTIFICATION_POLICY,
  loadNotificationPolicy,
  type NotificationPolicyConfig,
} from '../notification-config.js';
import { buildFirstNotificationFactsFromStore } from '../notification-stored-facts.js';
import { formatWeComMarkdown } from '../notifier.js';
import { createEventStore, type EventStore } from '../store.js';
import { makeAgentConfig } from './test-config.js';

const origin = Date.parse('2026-10-24T03:30:01.000Z');
const at = (ms: number) => new Date(origin + ms).toISOString();
const HOUR = 3_600_000;
const PYTHON_STACK = [
  'Traceback (most recent call last):',
  '  File "/app/ragflow/api.py", line 12, in handler',
  '    raise MemoryError()',
  'MemoryError',
].join('\n');
const PYTHON_RECURSION = [
  'Traceback (most recent call last):',
  '  File "/app/ragflow/deep.py", line 3, in recurse',
  'RecursionError: maximum recursion depth exceeded',
].join('\n');
const NODE_STACK = [
  'RangeError: Maximum call stack size exceeded',
  '    at recurse (/app/worker.js:4:3)',
  '    at /app/worker.js:8:1',
].join('\n');
const NODE_HEAP = 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory';

function policy(services: NotificationPolicyConfig['services'] = {}, extra: Partial<NotificationPolicyConfig> = {}): NotificationPolicyConfig {
  return {
    ...DEFAULT_NOTIFICATION_POLICY,
    logErrorRecurrenceGapMs: HOUR,
    services: { ...DEFAULT_NOTIFICATION_POLICY.services, ...services },
    ...extra,
  };
}

function event(overrides: Partial<OpsEvent> & Pick<OpsEvent, 'id' | 'type'>): OpsEvent {
  return {
    schemaVersion: 1,
    time: at(0),
    source: 'docker',
    nodeId: 'node-1',
    service: 'ragflow',
    severity: 'error',
    message: overrides.type,
    attributes: {},
    ...overrides,
  };
}

function harness(selected = policy()) {
  const store = createEventStore(':memory:', selected);
  const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000, scheduleLocalReasoning: false });
  const app = createApp(makeAgentConfig(), store, engine);
  async function ingest(events: OpsEvent[], producer: 'node-agent' | 'application' = 'node-agent') {
    const response = await app.request('/v1/events', {
      method: 'POST',
      headers: { Authorization: 'Bearer ingest-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ producer: { id: 'node-1', type: producer, version: '1' }, events }),
    });
    assert.equal(response.status, 200, await response.text());
    return store.findIncidentByEventId(events[0]!.id);
  }
  return { store, ingest };
}

function openJobs(store: EventStore, incidentId: string) {
  return store.listNotificationJobs(incidentId).filter((job) => job.type === 'INCIDENT_OPEN');
}

function wecom(store: EventStore, incidentId: string): string {
  const job = openJobs(store, incidentId)[0];
  assert.ok(job, incidentId);
  return formatWeComMarkdown(job.payload);
}

const fatalCases = [
  {
    name: 'python oom',
    type: 'runtime.oom' as const,
    service: 'ragflow',
    scene: /运行时内存耗尽/,
    attributes: {
      containerName: 'ragflow',
      observedVia: 'docker.logs',
      runtime: 'python',
      exceptionClass: 'MemoryError',
      exceptionMessage: '',
      stackTrace: PYTHON_STACK,
    },
  },
  {
    name: 'python stack overflow',
    type: 'runtime.stack_overflow' as const,
    service: 'ragflow-recursion',
    scene: /运行时调用栈溢出/,
    attributes: {
      containerName: 'ragflow',
      observedVia: 'docker.logs',
      runtime: 'python',
      exceptionClass: 'RecursionError',
      exceptionMessage: 'maximum recursion depth exceeded',
      stackTrace: PYTHON_RECURSION,
    },
  },
  {
    name: 'node oom',
    type: 'runtime.oom' as const,
    service: 'askdata',
    scene: /运行时内存耗尽/,
    attributes: {
      containerName: 'askdata',
      observedVia: 'docker.logs',
      runtime: 'node',
      stackTrace: NODE_HEAP,
      stackIncomplete: true,
    },
    message: NODE_HEAP,
    incomplete: true,
  },
  {
    name: 'node stack overflow',
    type: 'runtime.stack_overflow' as const,
    service: 'askdata-worker',
    scene: /运行时调用栈溢出/,
    attributes: {
      containerName: 'askdata-worker',
      observedVia: 'docker.logs',
      runtime: 'node',
      exceptionClass: 'RangeError',
      exceptionMessage: 'Maximum call stack size exceeded',
      stackTrace: NODE_STACK,
    },
  },
];

describe('multi-language log faults at the center', () => {
  for (const sample of fatalCases) {
    it(`first-notifies ${sample.name} without calling it a JVM fault`, async () => {
      const { store, ingest } = harness();
      try {
        const body = event({
          id: `fatal-${sample.service}`,
          type: sample.type,
          service: sample.service,
          severity: 'critical',
          message: sample.message ?? sample.type,
          attributes: sample.attributes,
        });
        const incident = await ingest([body]);
        assert.ok(incident);
        assert.equal(store.listIncidents().filter((item) => item.service === sample.service).length, 1);
        assert.equal(openJobs(store, incident.id).length, 1);
        assert.equal(openJobs(store, incident.id)[0]?.payload.notice, 'fault');
        assert.equal(store.getSummarySeverity(incident.id).level, '严重');
        const plan = planEvidenceQueries(incident, body, 120);
        assert.ok(plan.length > 0, sample.name);
        assert.ok(plan.some((query) => query.type === 'docker.logs' || query.type === 'docker.inspect' || query.type === 'host.memory'));
        const text = wecom(store, incident.id);
        assert.match(text, /严重程度：严重/);
        assert.match(text, sample.scene);
        assert.doesNotMatch(text, /JVM/);
        if (sample.incomplete) assert.match(text, /栈不完整/);
        else assert.doesNotMatch(text, /栈不完整/);
        const keys = store.getNotificationDecision(incident.id)?.valueKeys ?? [];
        assert.ok(keys.some((key) => key.startsWith('runtime:')), keys.join(','));
      } finally { store.close(); }
    });
  }

  it('does not authorize a fatal notice from a mention, a JSON string, or a stackless runtime event', async () => {
    const { store, ingest } = harness();
    try {
      const mentioned = event({
        id: 'mention-memory',
        type: 'business.error',
        message: 'docs mention MemoryError and FATAL ERROR: JavaScript heap out of memory',
        attributes: {
          containerName: 'ragflow',
          businessCode: 'LOG_ERROR',
          module: 'docs',
          logEpisode: true,
          exceptionMessage: '{"error":"FATAL ERROR: JavaScript heap out of memory"}',
          stackTrace: 'see MemoryError in the README',
        },
      });
      const bare = event({
        id: 'bare-runtime',
        type: 'runtime.oom',
        service: 'bare-runtime',
        severity: 'critical',
        message: 'MemoryError appears in an ordinary sentence',
        attributes: { containerName: 'ragflow', runtime: 'python', exceptionClass: 'MemoryError', stackTrace: 'MemoryError appears in an ordinary sentence' },
      });
      await ingest([mentioned, bare]);
      for (const id of [mentioned.id, bare.id]) {
        const incident = store.findIncidentByEventId(id);
        assert.ok(incident);
        assert.equal(openJobs(store, incident.id).length, 0, id);
        const facts = buildFirstNotificationFactsFromStore(store, { incidentId: incident.id, eventIds: [id] });
        assert.equal(facts.observations.some((item) => item.kind === 'runtime-fatal'), false, id);
      }
    } finally { store.close(); }
  });

  for (const [exceptionClass, exceptionMessage, type, stack] of [
    ['MemoryError', '', 'runtime.oom', PYTHON_STACK],
    ['RecursionError', 'maximum recursion depth exceeded', 'runtime.stack_overflow', PYTHON_RECURSION],
  ]) {
    for (const fatalLast of [false, true]) {
      it(`notifies a Python chain with ${exceptionClass} ${fatalLast ? 'wrapping' : 'wrapped by'} an ordinary exception`, async () => {
        const { store, ingest } = harness();
        try {
          const ordinary = 'Traceback (most recent call last):\n  File "worker.py", line 9, in run\nRuntimeError: wrapper';
          const body = event({
            id: 'python-chain', type: type!, severity: 'critical',
            attributes: {
              containerName: 'ragflow', runtime: 'python',
              exceptionClass: fatalLast ? exceptionClass : 'RuntimeError',
              exceptionMessage: fatalLast ? exceptionMessage : 'wrapper',
              outerExceptionClass: fatalLast ? 'RuntimeError' : exceptionClass,
              outerExceptionMessage: fatalLast ? 'wrapper' : exceptionMessage,
              stackTrace: [fatalLast ? ordinary : stack, 'During handling of the above exception, another exception occurred:', fatalLast ? stack : ordinary].join('\n\n'),
            },
          });
          const incident = await ingest([body]);
          assert.ok(incident);
          assert.equal(openJobs(store, incident.id).length, 1);
          const facts = buildFirstNotificationFactsFromStore(store, { incidentId: incident.id, eventIds: [body.id] });
          const fatal = facts.observations.find((item) => item.kind === 'runtime-fatal');
          assert.ok(fatal?.kind === 'runtime-fatal');
          assert.equal(fatal.exceptionClass, exceptionClass);
          assert.equal(fatal.exceptionMessage, exceptionMessage);
        } finally { store.close(); }
      });
    }
  }

  for (const recursionLast of [false, true]) {
    it(`does not borrow a recursion message from the other Python chain endpoint (${recursionLast})`, async () => {
      const { store, ingest } = harness();
      try {
        const body = event({
          id: 'wrong-recursion-message', type: 'runtime.stack_overflow',
          attributes: {
            containerName: 'ragflow', runtime: 'python',
            exceptionClass: recursionLast ? 'RecursionError' : 'RuntimeError',
            exceptionMessage: recursionLast ? 'other recursion error' : 'maximum recursion depth exceeded',
            outerExceptionClass: recursionLast ? 'RuntimeError' : 'RecursionError',
            outerExceptionMessage: recursionLast ? 'maximum recursion depth exceeded' : 'other recursion error',
            stackTrace: 'Traceback (most recent call last):\n  File "worker.py", line 9, in run\nRecursionError: other recursion error',
          },
        });
        const incident = await ingest([body]);
        assert.ok(incident);
        assert.equal(openJobs(store, incident.id).length, 0);
      } finally { store.close(); }
    });
  }

  it('requires the Node heap fatal line in stackTrace rather than only in message', async () => {
    const { store, ingest } = harness();
    try {
      const body = event({
        id: 'node-heap-message-only', type: 'runtime.oom', message: NODE_HEAP,
        attributes: { containerName: 'ragflow', runtime: 'node', exceptionClass: 'Error', stackTrace: '', stackIncomplete: true },
      });
      const incident = await ingest([body]);
      assert.ok(incident);
      assert.equal(openJobs(store, incident.id).length, 0);
    } finally { store.close(); }
  });

  it('alerts a runtime fatal fact without using the Java JFR semantic check', () => {
    const observation: NotificationObservation = {
      kind: 'runtime-fatal',
      runtime: 'python',
      fault: 'oom',
      exceptionClass: 'MemoryError',
      exceptionMessage: '',
      stackTrace: PYTHON_STACK,
      source: { kind: 'event', id: 'evt-py' },
    };
    const decision = decideFirstNotification({ observations: [observation] });
    assert.equal(decision.action, 'alert');
    assert.equal(decision.reason, 'runtime-oom');
    const label = (notificationDecision as { impactLabel?: (key: string) => string }).impactLabel;
    assert.equal(label?.('runtime:python:oom'), 'Python 内存耗尽');
    assert.equal(label?.('runtime:node:stack-overflow'), 'Node 调用栈溢出');
    assert.equal(label?.('runtime:python:stack-overflow'), 'Python 调用栈溢出');
    assert.equal(label?.('runtime:node:oom'), 'Node 内存耗尽');
    for (const key of ['runtime:python:oom', 'runtime:node:oom', 'runtime:python:stack-overflow', 'runtime:node:stack-overflow']) {
      assert.doesNotMatch(label?.(key) ?? '', /JVM/);
    }
  });

  it('keeps runtime identity at service level and ignores the container', () => {
    const base = {
      nodeId: 'node-1',
      service: 'ragflow',
      type: 'runtime.oom',
      attributes: { runtime: 'python', containerName: 'ragflow-a', stackTrace: PYTHON_STACK, logRecordCount: 4 },
    };
    const docker = computeFingerprint({ source: 'docker', ...base });
    const application = computeFingerprint({ source: 'application', ...base, attributes: { ...base.attributes, containerName: 'ragflow-b' } });
    assert.equal(docker, application);
    assert.equal(JSON.parse(docker).includes('ragflow-a'), false);
    assert.notEqual(docker, computeFingerprint({ source: 'docker', ...base, service: 'askdata' }));
    assert.notEqual(docker, computeFingerprint({ source: 'docker', ...base, type: 'runtime.stack_overflow' }));
  });

  it('keeps a 15 second disconnect from notifying at every phase, and states the wait and gap boundaries', async () => {
    const selected = policy({
      ragflow: { unknownImpactWaitMs: 300_000, observationMaxGapMs: 120_000, criticalOperations: [] },
    });
    const burst = [0, 5_000, 10_000, 15_000].map((offset) => event({
      id: `burst-${offset}`,
      type: 'business.error',
      time: at(offset),
      message: `Can't connect to MySQL server on '127.0.0.1' (${offset})`,
      attributes: { containerName: 'ragflow', businessCode: 'LOG_ERROR', module: 'db-connect', logEpisode: true, exceptionMessage: "Can't connect to MySQL" },
    }));
    const phases = [1_000, 8_000, 15_000, 20_000, 120_000, 299_999, 300_000, 315_000];
    for (const phase of phases) {
      const { store, ingest } = harness(selected);
      try {
        const incident = await ingest(burst);
        assert.ok(incident);
        store.evaluateNotification(incident.id, at(phase));
        assert.equal(openJobs(store, incident.id).length, 0, `phase ${phase}`);
      } finally { store.close(); }
    }
    const tail = burst.slice(2);
    const { store, ingest } = harness(selected);
    try {
      const incident = await ingest(tail);
      assert.ok(incident);
      store.evaluateNotification(incident.id, at(15_000 + 300_000));
      assert.equal(openJobs(store, incident.id).length, 0);
    } finally { store.close(); }

    const sustained = [0, 60_000, 120_000, 180_000, 240_000, 300_000].map((offset) => event({
      id: `sustained-${offset}`,
      type: 'business.error',
      time: at(offset),
      message: 'Lost connection to MySQL server during query',
      attributes: { containerName: 'ragflow', businessCode: 'LOG_ERROR', module: 'db-lost', logEpisode: true },
    }));
    const waited = harness(selected);
    try {
      const incident = await waited.ingest(sustained);
      assert.ok(incident);
      waited.store.evaluateNotification(incident.id, at(300_000 - 1));
      assert.equal(openJobs(waited.store, incident.id).length, 0, 'before wait');
      waited.store.evaluateNotification(incident.id, at(300_000));
      assert.equal(openJobs(waited.store, incident.id).length, 1, 'at wait');
      assert.equal(openJobs(waited.store, incident.id)[0]?.payload.notice, 'manual-confirmation');
    } finally { waited.store.close(); }

    const gapped = [0, 60_000, 60_000 + 120_000 + 1].map((offset) => event({
      id: `gap-${offset}`,
      type: 'business.error',
      time: at(offset),
      message: 'Lost connection to MySQL server during query',
      attributes: { containerName: 'ragflow', businessCode: 'LOG_ERROR', module: 'db-gap', logEpisode: true },
    }));
    const gapRun = harness(selected);
    try {
      const incident = await gapRun.ingest(gapped);
      assert.ok(incident);
      gapRun.store.evaluateNotification(incident.id, at(60_000 + 120_000 + 1));
      assert.equal(openJobs(gapRun.store, incident.id).length, 0, 'gap resets the run before its own wait');
      gapRun.store.evaluateNotification(incident.id, at(60_000 + 120_000 + 1 + 120_000));
      assert.equal(openJobs(gapRun.store, incident.id).length, 0, 'last sample is outside the max gap');
      gapRun.store.evaluateNotification(incident.id, at(60_000 + 120_000 + 1 + 120_000 - 1));
      assert.equal(openJobs(gapRun.store, incident.id).length, 0, 'reset run has not waited');
    } finally { gapRun.store.close(); }
  });

  it('stores an ignored log error, records its rule, and does not let it sustain one real error', async () => {
    const selected = policy({
      ragflow: {
        unknownImpactWaitMs: 10_000,
        observationMaxGapMs: 60_000,
        criticalOperations: [],
        expectedLogErrors: [{ ruleId: 'ragflow-doc-owner-v1', contains: "you don't own the document" }],
      },
    });
    const { store, ingest } = harness(selected);
    try {
      const real = event({
        id: 'real-once',
        type: 'business.error',
        time: at(0),
        message: "Lost connection to MySQL server during query",
        attributes: { containerName: 'ragflow', businessCode: 'UNHANDLED_EXCEPTION', module: 'pymysql.err.OperationalError', logEpisode: true, exceptionMessage: 'Lost connection' },
      });
      const ignored = [1_000, 2_000].map((offset) => event({
        id: `ignored-${offset}`,
        type: 'business.error',
        time: at(offset),
        message: "you don't own the document 32",
        attributes: { containerName: 'ragflow', businessCode: 'UNHANDLED_EXCEPTION', module: 'pymysql.err.OperationalError', logEpisode: true, exceptionMessage: 'permission' },
      }));
      const incident = await ingest([real, ...ignored]);
      assert.ok(incident);
      assert.equal(store.findIncidentByEventId(ignored[0]!.id)?.id, incident.id);
      assert.ok(store.getEvent(ignored[0]!.id));
      store.evaluateNotification(incident.id, at(10_000));
      assert.equal(openJobs(store, incident.id).length, 0);
      const facts = buildFirstNotificationFactsFromStore(store, {
        incidentId: incident.id,
        eventIds: [real.id, ...ignored.map((item) => item.id)],
        policy: selected,
        now: at(10_000),
      });
      const rejection = facts.observations.find((item) => item.kind === 'expected-rejection');
      assert.equal(rejection?.kind, 'expected-rejection');
      assert.equal(rejection && 'ruleId' in rejection ? rejection.ruleId : undefined, 'ragflow-doc-owner-v1');
      assert.equal(facts.observations.some((item) => item.kind === 'ordinary-error' && item.persistence.kind === 'known'), false);
    } finally { store.close(); }
  });

  it('matches ignore text case-sensitively on message and exceptionMessage, not on the stack', async () => {
    const selected = policy({
      ragflow: {
        unknownImpactWaitMs: 10_000,
        observationMaxGapMs: 60_000,
        criticalOperations: [],
        expectedLogErrors: [{ ruleId: 'ragflow-doc-owner-v1', contains: "you don't own the document" }],
      },
    });
    const upper = [0, 1_000].map((offset) => event({
      id: `upper-${offset}`,
      type: 'business.error',
      time: at(offset),
      message: "You Don't Own The Document",
      attributes: { containerName: 'ragflow', businessCode: 'LOG_ERROR', module: 'doc-case', logEpisode: true },
    }));
    const stackOnly = [0, 1_000].map((offset) => event({
      id: `stack-${offset}`,
      type: 'business.error',
      time: at(offset),
      message: 'permission denied',
      attributes: {
        containerName: 'ragflow',
        businessCode: 'LOG_ERROR',
        module: 'doc-stack',
        logEpisode: true,
        exceptionMessage: 'permission denied',
        stackTrace: "you don't own the document",
      },
    }));
    const messageHit = event({
      id: 'message-hit',
      type: 'business.error',
      message: 'GET failed: you don\'t own the document',
      attributes: { containerName: 'ragflow', businessCode: 'LOG_ERROR', module: 'doc-message', logEpisode: true },
    });
    const exceptionHit = event({
      id: 'exception-hit',
      type: 'business.error',
      message: 'permission',
      attributes: { containerName: 'ragflow', businessCode: 'UNHANDLED_EXCEPTION', module: 'doc-exception', logEpisode: true, exceptionMessage: "you don't own the document" },
    });
    const { store, ingest } = harness(selected);
    try {
      await ingest([...upper, ...stackOnly, messageHit, exceptionHit]);
      store.evaluateNotification(store.findIncidentByEventId(upper[0]!.id)!.id, at(10_000));
      store.evaluateNotification(store.findIncidentByEventId(stackOnly[0]!.id)!.id, at(10_000));
      assert.equal(openJobs(store, store.findIncidentByEventId(upper[0]!.id)!.id).length, 1, 'wrong case stays ordinary');
      assert.equal(openJobs(store, store.findIncidentByEventId(stackOnly[0]!.id)!.id).length, 1, 'stack text is not an ignore field');
      for (const id of [messageHit.id, exceptionHit.id]) {
        const incident = store.findIncidentByEventId(id)!;
        store.evaluateNotification(incident.id, at(10_000));
        assert.equal(openJobs(store, incident.id).length, 0, id);
        const facts = buildFirstNotificationFactsFromStore(store, { incidentId: incident.id, eventIds: [id], policy: selected, now: at(10_000) });
        assert.equal(facts.observations[0]?.kind, 'expected-rejection');
      }
    } finally { store.close(); }
  });

  it('does not ignore a fatal event that contains the expected-error text', async () => {
    const selected = policy({
      ragflow: {
        unknownImpactWaitMs: 10_000,
        observationMaxGapMs: 60_000,
        criticalOperations: [],
        expectedLogErrors: [{ ruleId: 'ragflow-doc-owner-v1', contains: "you don't own the document" }],
      },
    });
    const { store, ingest } = harness(selected);
    try {
      const body = event({
        id: 'fatal-with-phrase',
        type: 'runtime.oom',
        severity: 'critical',
        message: "you don't own the document",
        attributes: {
          containerName: 'ragflow',
          observedVia: 'docker.logs',
          runtime: 'python',
          exceptionClass: 'MemoryError',
          exceptionMessage: "you don't own the document",
          stackTrace: PYTHON_STACK,
        },
      });
      const incident = await ingest([body]);
      assert.ok(incident);
      assert.equal(openJobs(store, incident.id).length, 1);
      assert.equal(openJobs(store, incident.id)[0]?.payload.notice, 'fault');
    } finally { store.close(); }
  });

  it('defaults a missing recurrence gap and ignore list, and rejects a bad field', () => {
    const directory = mkdtempSync(join(tmpdir(), 'log-scan-policy-'));
    const path = join(directory, 'policy.json');
    try {
      const missing = {
        defaultUnknownImpactWaitMs: 1000,
        defaultObservationMaxGapMs: 500,
        services: { ragflow: { unknownImpactWaitMs: 1000, observationMaxGapMs: 500, criticalOperations: [] } },
        healthRules: [],
      };
      writeFileSync(path, JSON.stringify(missing));
      const loaded = loadNotificationPolicy(path);
      assert.equal(loaded.logErrorRecurrenceGapMs, HOUR);
      assert.equal(loaded.services.ragflow?.expectedLogErrors, undefined);
      const present = {
        ...missing,
        logErrorRecurrenceGapMs: 60_000,
        services: { ragflow: { ...missing.services.ragflow, expectedLogErrors: [{ ruleId: 'ragflow-doc-owner-v1', contains: "you don't own the document" }] } },
      };
      writeFileSync(path, JSON.stringify(present));
      const withRules = loadNotificationPolicy(path);
      assert.equal(withRules.logErrorRecurrenceGapMs, 60_000);
      assert.deepEqual(withRules.services.ragflow?.expectedLogErrors, [{ ruleId: 'ragflow-doc-owner-v1', contains: "you don't own the document" }]);
      for (const bad of [
        { ...missing, logErrorRecurrenceGapMs: 0 },
        { ...missing, logErrorRecurrenceGapMs: -1 },
        { ...missing, logErrorRecurrenceGapMs: 1.5 },
        { ...missing, logErrorRecurrenceGapMs: '3600000' },
        { ...missing, services: { ragflow: { ...missing.services.ragflow, expectedLogErrors: 'you don\'t own the document' } } },
        { ...missing, services: { ragflow: { ...missing.services.ragflow, expectedLogErrors: [{ ruleId: 'x' }] } } },
        { ...missing, services: { ragflow: { ...missing.services.ragflow, expectedLogErrors: [{ contains: 'x' }] } } },
        { ...missing, services: { ragflow: { ...missing.services.ragflow, expectedLogErrors: [{ ruleId: '', contains: 'x' }] } } },
        { ...missing, services: { ragflow: { ...missing.services.ragflow, expectedLogErrors: [{ ruleId: 'x', contains: '' }] } } },
        { ...missing, services: { ragflow: { ...missing.services.ragflow, expectedLogErrors: [{ ruleId: 'x', contains: 1 }] } } },
      ]) {
        writeFileSync(path, JSON.stringify(bad));
        assert.throws(() => loadNotificationPolicy(path), /Invalid/);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('opens a new incident after a notified log error is silent for 61 minutes, and keeps 59 minutes on the old one', async () => {
    const selected = policy({
      ragflow: { unknownImpactWaitMs: 60_000, observationMaxGapMs: 30_000, criticalOperations: [] },
    });
    async function episode(silenceMs: number) {
      const { store, ingest } = harness(selected);
      const first = [0, 30_000, 60_000].map((offset) => event({
        id: `first-${silenceMs}-${offset}`,
        type: 'business.error',
        time: at(offset),
        message: 'Lost connection to MySQL server during query',
        attributes: { containerName: 'ragflow', businessCode: 'LOG_ERROR', module: 'db-recur', logEpisode: true },
      }));
      const incident = await ingest(first);
      assert.ok(incident);
      store.evaluateNotification(incident.id, at(60_000));
      assert.equal(openJobs(store, incident.id).length, 1);
      assert.equal(openJobs(store, incident.id)[0]?.payload.notice, 'manual-confirmation');
      const againAt = 60_000 + silenceMs;
      const again = [0, 30_000, 60_000].map((offset) => event({
        id: `again-${silenceMs}-${offset}`,
        type: 'business.error',
        time: at(againAt + offset),
        message: 'Lost connection to MySQL server during query',
        attributes: { containerName: 'ragflow', businessCode: 'LOG_ERROR', module: 'db-recur', logEpisode: true },
      }));
      await ingest(again);
      return { store, incident, againId: again[0]!.id, againAt };
    }
    const late = await episode(61 * 60_000);
    try {
      const created = late.store.findIncidentByEventId(late.againId);
      assert.ok(created);
      assert.notEqual(created.id, late.incident.id);
      late.store.evaluateNotification(created.id, at(late.againAt + 60_000));
      assert.equal(openJobs(late.store, created.id).length, 1);
      assert.equal(openJobs(late.store, created.id)[0]?.payload.notice, 'manual-confirmation');
      assert.equal(openJobs(late.store, late.incident.id).length, 1);
    } finally { late.store.close(); }
    const early = await episode(59 * 60_000);
    try {
      assert.equal(early.store.findIncidentByEventId(early.againId)?.id, early.incident.id);
      early.store.evaluateNotification(early.incident.id, at(early.againAt + 60_000));
      assert.equal(openJobs(early.store, early.incident.id).length, 1);
    } finally { early.store.close(); }
  });

  it('still merges a Java log exception, a JFR OOM, and a health failure after 61 silent minutes', async () => {
    const selected = policy({}, {
      healthRules: [{
        ruleId: 'ragflow-health', ruleVersion: 1, nodeId: 'node-1', service: 'ragflow-health', target: 'ragflow',
        url: 'http://ragflow/health', method: 'GET', failureSamples: 2, intervalMs: 30_000, container: 'ragflow',
      }],
    });
    const java = harness(policy({
      'order-service': { unknownImpactWaitMs: 60_000, observationMaxGapMs: 30_000, criticalOperations: [] },
    }));
    try {
      const first = [0, 30_000, 60_000].map((offset) => event({
        id: `java-${offset}`,
        type: 'business.error',
        service: 'order-service',
        time: at(offset),
        message: 'submit failed',
        attributes: { exceptionClass: 'java.lang.IllegalStateException', exceptionMessage: 'failed', module: 'com.example.Order', businessCode: 'UNHANDLED_EXCEPTION' },
      }));
      const incident = await java.ingest(first, 'application');
      assert.ok(incident);
      java.store.evaluateNotification(incident.id, at(60_000));
      assert.equal(openJobs(java.store, incident.id).length, 1);
      const later = event({
        id: 'java-later',
        type: 'business.error',
        service: 'order-service',
        time: at(60_000 + 61 * 60_000),
        message: 'submit failed again',
        attributes: { exceptionClass: 'java.lang.IllegalStateException', exceptionMessage: 'failed', module: 'com.example.Order', businessCode: 'UNHANDLED_EXCEPTION' },
      });
      await java.ingest([later], 'application');
      assert.equal(java.store.findIncidentByEventId(later.id)?.id, incident.id);
      assert.equal(openJobs(java.store, incident.id).length, 1);
    } finally { java.store.close(); }

    const jfr = harness(selected);
    try {
      const first = event({
        id: 'jfr-oom',
        source: 'jfr',
        type: 'jvm.oom',
        service: 'order-service',
        severity: 'critical',
        message: 'Java heap space',
        attributes: { exceptionClass: 'java.lang.OutOfMemoryError', exceptionMessage: 'Java heap space' },
      });
      const incident = await jfr.ingest([first], 'application');
      assert.ok(incident);
      assert.equal(openJobs(jfr.store, incident.id).length, 1);
      const later = event({
        id: 'jfr-oom-later',
        source: 'jfr',
        type: 'jvm.oom',
        service: 'order-service',
        time: at(61 * 60_000),
        severity: 'critical',
        message: 'Java heap space',
        attributes: { exceptionClass: 'java.lang.OutOfMemoryError', exceptionMessage: 'Java heap space' },
      });
      await jfr.ingest([later], 'application');
      assert.equal(jfr.store.findIncidentByEventId(later.id)?.id, incident.id);
      assert.equal(openJobs(jfr.store, incident.id).length, 1);
    } finally { jfr.store.close(); }

    const health = harness(selected);
    try {
      const attributes = {
        ruleId: 'ragflow-health', ruleVersion: 1, target: 'ragflow', url: 'http://ragflow/health', method: 'GET',
        containerName: 'ragflow', failureSamples: 2, intervalMs: 30_000, detector: 'http.health',
      };
      const first = event({
        id: 'health-1', source: 'health', type: 'health.failure', service: 'ragflow-health', message: 'HTTP 503', attributes,
      });
      const incident = await health.ingest([first]);
      assert.ok(incident);
      assert.equal(openJobs(health.store, incident.id).length, 1);
      const later = event({
        id: 'health-later', source: 'health', type: 'health.failure', service: 'ragflow-health', time: at(61 * 60_000),
        message: 'HTTP 503', attributes,
      });
      await health.ingest([later]);
      assert.equal(health.store.findIncidentByEventId(later.id)?.id, incident.id);
      assert.equal(openJobs(health.store, incident.id).length, 1);
    } finally { health.store.close(); }
  });

  it('keeps Python and Node frames when Docker timestamps prefix the log lines', () => {
    const stamp = (body: string, ms = 0) => `${new Date(origin + ms).toISOString().replace('.000Z', '.123456789Z')} ${body}`;
    const noise = Array.from({ length: 25 }, (_, index) => stamp(`INFO noise ${index}`));
    const python = [
      ...noise,
      stamp('Traceback (most recent call last):'),
      stamp('  File "/app/ragflow/api.py", line 12, in handler'),
      stamp('MemoryError: out of memory'),
      ...noise,
    ];
    const node = [
      ...noise,
      stamp('RangeError: Maximum call stack size exceeded'),
      stamp('    at recurse (/app/worker.js:4:3)'),
      stamp('    at /app/worker.js:8:1'),
      ...noise,
    ];
    const java = [
      ...noise,
      stamp('java.lang.OutOfMemoryError: Java heap space'),
      stamp('\tat com.example.Main.main(Main.java:12)'),
      ...noise,
    ];
    const project = (lines: string[]) => toRuntimeSafeEvidence({
      id: 'logs', incidentId: 'inc', nodeId: 'node-1', source: 'docker', kind: 'docker.logs',
      collectedAt: at(0), status: 'succeeded', data: { lines },
    }, 20, { eventTime: at(0), maxDataBytes: 8192 });
    const pythonLines = (project(python).data as { lines: string[] }).lines.join('\n');
    const nodeLines = (project(node).data as { lines: string[] }).lines.join('\n');
    const javaLines = (project(java).data as { lines: string[] }).lines.join('\n');
    assert.match(pythonLines, /File "\/app\/ragflow\/api.py", line 12/);
    assert.match(nodeLines, /at recurse \(\/app\/worker.js:4:3\)/);
    assert.match(nodeLines, /at \/app\/worker.js:8:1/);
    assert.match(javaLines, /at com\.example\.Main\.main\(Main\.java:12\)/);
  });

  it('describes runtime faults as severe and does not call them JVM faults', () => {
    for (const type of ['runtime.oom', 'runtime.stack_overflow']) {
      assert.equal(summarySeverityForType(type).level, '严重');
      const summary = deterministicSummary({ service: 'ragflow', type });
      assert.equal(summary.severity.level, '严重');
      assert.doesNotMatch(`${summary.scene} ${summary.whatHappened} ${summary.recovery.join(' ')}`, /JVM/);
    }
  });
});

const fixturePath = new URL('../../../../test/fixtures/log-scan/node-agent-events.json', import.meta.url);
describe('node-agent log-scan contract', { skip: existsSync(fixturePath) ? false : 'waiting for test/fixtures/log-scan/node-agent-events.json' }, () => {
  const expectedOpenCounts: Record<string, number> = {
    '0330-window': 0,
    'lost-connection-traceback': 0,
    'jwt-warning-noise': 0,
    'doc-owner-rejection': 0,
    'python-oom': 1,
    'python-stack-overflow': 1,
    'node-oom': 1,
    'node-stack-overflow': 1,
    'python-ordinary': 0,
    'node-ordinary': 0,
    'node-json': 0,
    'java-fatal-mentions': 0,
    'python-chain': 1,
  };
  const { groups } = JSON.parse(readFileSync(fixturePath, 'utf8')) as { groups: Record<string, OpsEvent[]> };
  it('specifies the notification count for every fixture group', () => {
    assert.deepEqual(Object.keys(expectedOpenCounts).sort(), Object.keys(groups).sort());
  });
  for (const [name, count] of Object.entries(expectedOpenCounts)) {
    it(`produces ${count} first notifications for ${name}`, async () => {
      const { store, ingest } = harness();
      try {
        const events = groups[name]!;
        if (events.length) await ingest(events);
        assert.equal(store.listIncidents().reduce((total, incident) => total + openJobs(store, incident.id).length, 0), count, name);
      } finally { store.close(); }
    });
  }

  it('runs the produced events through facts, evidence plans, and notification decisions', async () => {
    const parsed = JSON.parse(readFileSync(fixturePath, 'utf8')) as { groups: Record<string, OpsEvent[]> };
    const groups = parsed.groups;
    for (const name of ['0330-window', 'doc-owner-rejection', 'python-oom', 'python-stack-overflow', 'node-oom', 'node-stack-overflow']) {
      assert.ok(Array.isArray(groups[name]) && groups[name]!.length > 0, name);
    }
    const selected = policy({
      ragflow: {
        unknownImpactWaitMs: 300_000,
        observationMaxGapMs: 120_000,
        criticalOperations: [],
        expectedLogErrors: [{ ruleId: 'ragflow-doc-owner-v1', contains: "you don't own the document" }],
      },
    });
    const window = harness(selected);
    try {
      const events = groups['0330-window']!;
      await window.ingest(events);
      const incidents = new Set(events.map((item) => window.store.findIncidentByEventId(item.id)?.id).filter(Boolean));
      for (const id of incidents) {
        const row = window.store.getIncident(id!)!;
        window.store.evaluateNotification(id!, row.last_seen);
        window.store.evaluateNotification(id!, new Date(Date.parse(row.last_seen) + 300_000).toISOString());
        assert.equal(openJobs(window.store, id!).length, 0, id);
      }
    } finally { window.store.close(); }

    const stretched = harness(selected);
    try {
      const sample = groups['0330-window']![0]!;
      const copies = [0, 60_000, 120_000, 180_000, 240_000, 300_000].map((offset, index) => ({
        ...sample,
        id: `${sample.id}-stretch-${index}`,
        time: new Date(Date.parse(sample.time) + offset).toISOString(),
      }));
      const incident = await stretched.ingest(copies);
      assert.ok(incident);
      stretched.store.evaluateNotification(incident.id, copies.at(-1)!.time);
      assert.equal(openJobs(stretched.store, incident.id).length, 1);
      assert.equal(openJobs(stretched.store, incident.id)[0]?.payload.notice, 'manual-confirmation');
    } finally { stretched.store.close(); }

    const rejected = harness(selected);
    try {
      const events = groups['doc-owner-rejection']!;
      await rejected.ingest(events);
      for (const item of events) {
        const incident = rejected.store.findIncidentByEventId(item.id);
        assert.ok(incident, item.id);
        rejected.store.evaluateNotification(incident.id, new Date(Date.parse(item.time) + 300_000).toISOString());
        assert.equal(openJobs(rejected.store, incident.id).length, 0, item.id);
        const facts = buildFirstNotificationFactsFromStore(rejected.store, {
          incidentId: incident.id, eventIds: [item.id], policy: selected, now: item.time,
        });
        assert.equal(facts.observations.some((observation) => observation.kind === 'expected-rejection' && observation.ruleId === 'ragflow-doc-owner-v1'), true, item.id);
      }
    } finally { rejected.store.close(); }

    for (const name of ['python-oom', 'python-stack-overflow', 'node-oom', 'node-stack-overflow'] as const) {
      const { store, ingest } = harness(selected);
      try {
        const body = groups[name]![0]!;
        const incident = await ingest([body]);
        assert.ok(incident);
        assert.equal(store.listIncidents().length, 1);
        assert.equal(openJobs(store, incident.id).length, 1);
        assert.equal(store.getSummarySeverity(incident.id).level, '严重');
        assert.ok(planEvidenceQueries(incident, body, 120).length > 0, name);
        const facts = buildFirstNotificationFactsFromStore(store, { incidentId: incident.id, eventIds: [body.id], policy: selected });
        assert.equal(decideFirstNotification(facts).action, 'alert');
        assert.doesNotMatch(wecom(store, incident.id), /JVM/);
      } finally { store.close(); }
    }
  });
});

