/**
 * 运行说明：通知策略纯函数判定与决策隔离快照
 *
 * 怎么跑：
 *   在 apps/agent 目录下运行：
 *     ./node_modules/.bin/tsx src/__tests__/notification-policy.check.ts
 *   或在仓库根目录下运行：
 *     pnpm --filter @pi-ops/agent exec tsx src/__tests__/notification-policy.check.ts
 *
 * 什么时候跑：
 *   修改通知策略（src/notification-policy.ts）、通知决策（src/notification-decision.ts）或相关配置后手动运行。
 *   本文件以 .check.ts 命名，默认 pnpm test（仅匹配 src/**\/*.test.ts）不会自动运行它。
 *   提交通知策略改动前必须单独运行本离线检查。
 *
 * 期望输出：
 *   所有测试套件通过时以 exit code 0 结束，控制台输出包含：
 *     ℹ tests 16
 *     ℹ suites 2
 *     ℹ pass 16
 *     ℹ fail 0
 *   若任何断言失败，抛出 AssertionError 并以非 0 状态码退出。
 *   注意：exit 0 仅表示纯函数的离线合同快照匹配，不代表真实环境场景 PASS。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OpsEvent } from '@pi-ops/protocol';
import { createIncidentEngine } from '../incident.js';
import { createNotificationJobWorker } from '../notification-worker.js';
import { createFakeNotifier } from '../notifier.js';
import {
  decideFirstNotification,
  type FirstNotificationDecision,
  type FirstNotificationFacts,
  type NotificationObservation,
} from '../notification-policy.js';
import { createEventStore } from '../store.js';
import { makeAgentConfig } from './test-config.js';

const unknown = { kind: 'unknown' } as const;
const event = (id: string): NotificationObservation['source'] => ({ kind: 'event', id });

function facts(observations: NotificationObservation[]): FirstNotificationFacts {
  return { observations };
}

function assertDecision(observations: NotificationObservation[], expected: FirstNotificationDecision): void {
  assert.deepEqual(decideFirstNotification(facts(observations)), expected);
}

describe('first notification decision', () => {
  it('analyzes an ordinary error without turning unknown counts into 0 or 1', () => {
    assertDecision([{
      kind: 'ordinary-error',
      persistence: { kind: 'known', value: 'brief' },
      impact: { kind: 'unknown' },
      failures: unknown,
      requests: unknown,
      logLines: { kind: 'known', value: 7 },
      source: event('evt-ordinary'),
    }], {
      action: 'analyze',
      reason: 'ordinary-without-major-fact',
      missing: ['failure-count', 'request-count', 'impact'],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-ordinary')],
    });
  });

  it('records a classified expected rejection without inventing one failure', () => {
    assertDecision([{
      kind: 'expected-rejection',
      failures: unknown,
      requests: unknown,
      source: event('evt-rejected'),
    }], {
      action: 'record',
      reason: 'expected-rejection',
      missing: ['failure-count', 'request-count'],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-rejected')],
    });
  });

  it('records a known short peak', () => {
    assertDecision([{
      kind: 'short-peak',
      failures: unknown,
      requests: unknown,
      source: event('evt-peak'),
    }], {
      action: 'record',
      reason: 'short-peak',
      missing: ['failure-count', 'request-count'],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-peak')],
    });
  });

  it('analyzes proven sustained impact-unknown and does not use log lines as the request total', () => {
    assertDecision([{
      kind: 'ordinary-error',
      persistence: { kind: 'known', value: 'sustained' },
      impact: unknown,
      failures: unknown,
      requests: unknown,
      logLines: { kind: 'known', value: 40 },
      source: event('evt-sustained'),
    }], {
      action: 'analyze',
      reason: 'sustained-impact-unknown',
      missing: ['failure-count', 'request-count', 'impact'],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-sustained')],
    });
  });

  it('analyzes unknown persistence without treating it as sustained', () => {
    assertDecision([{
      kind: 'ordinary-error',
      persistence: unknown,
      impact: unknown,
      failures: unknown,
      requests: unknown,
      logLines: unknown,
      source: event('evt-unproven'),
    }], {
      action: 'analyze',
      reason: 'ordinary-without-major-fact',
      missing: ['failure-count', 'request-count', 'persistence', 'impact'],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-unproven')],
    });
  });

  it('alerts on OutOfMemoryError with valid message or stack and does not require a threshold version', () => {
    const source = event('evt-oome');
    for (const content of [
      { exceptionMessage: 'Java heap space', stackTrace: '' },
      { exceptionMessage: '', stackTrace: 'at Drill.exhaustHeap(Drill.java:300)' },
    ]) {
      assertDecision([{
        kind: 'jvm-exception',
        exceptionClass: 'java.lang.OutOfMemoryError',
        ...content,
        source,
      }], {
        action: 'alert',
        reason: 'jvm-oome',
        missing: [],
        failures: unknown,
        requests: unknown,
        sources: [source],
      });
    }
  });

  it('does not alert on class-only, blank content, or critical/OOM text without a recognized OOME fact', () => {
    const cases: NotificationObservation[] = [
      {
        kind: 'jvm-exception',
        exceptionClass: 'java.lang.OutOfMemoryError',
        exceptionMessage: '',
        stackTrace: '',
        source: event('evt-class-only'),
      },
      {
        kind: 'jvm-exception',
        exceptionClass: 'java.lang.OutOfMemoryError',
        exceptionMessage: ' ',
        stackTrace: ' ',
        source: event('evt-blank'),
      },
      {
        kind: 'jvm-exception',
        exceptionClass: 'java.lang.IllegalStateException',
        exceptionMessage: 'critical',
        stackTrace: 'OOM',
        source: event('evt-text'),
      },
    ];
    for (const observation of cases) {
      assertDecision([observation], {
        action: 'record',
        reason: 'exception-not-oome',
        missing: [],
        failures: unknown,
        requests: unknown,
        sources: [observation.source],
      });
    }
  });

  it('alerts on docker oom action or oomKilled, and records die plus exit 137 alone', () => {
    assertDecision([{
      kind: 'docker',
      dockerAction: 'oom',
      oomKilled: false,
      exitCode: { kind: 'absent' },
      source: event('evt-docker-oom'),
    }], {
      action: 'alert',
      reason: 'docker-oom',
      missing: [],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-docker-oom')],
    });
    assertDecision([{
      kind: 'docker',
      dockerAction: 'die',
      oomKilled: true,
      exitCode: { kind: 'known', value: 137 },
      source: event('evt-oom-killed'),
    }], {
      action: 'alert',
      reason: 'docker-oom',
      missing: [],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-oom-killed')],
    });
    assertDecision([{
      kind: 'docker',
      dockerAction: 'die',
      oomKilled: false,
      exitCode: { kind: 'known', value: 137 },
      source: event('evt-137'),
    }], {
      action: 'record',
      reason: 'container-exit-without-oom',
      missing: [],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-137')],
    });
  });

  it('prefers a recognized OOME over a short-peak record and keeps unknown counts unknown', () => {
    assertDecision([
      {
        kind: 'short-peak',
        failures: unknown,
        requests: unknown,
        source: event('evt-peak'),
      },
      {
        kind: 'jvm-exception',
        exceptionClass: 'java.lang.OutOfMemoryError',
        exceptionMessage: 'Java heap space',
        stackTrace: '',
        source: event('evt-oome'),
      },
    ], {
      action: 'alert',
      reason: 'jvm-oome',
      missing: ['failure-count', 'request-count'],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-oome')],
    });
  });

  it('alerts on a bound health failure and does not treat a missing binding or HTTP 200 as unavailability', () => {
    assertDecision([{
      kind: 'health',
      binding: { kind: 'bound', target: 'data-asset', ruleId: 'health-target-v3' },
      transition: { kind: 'failure' },
      source: event('evt-health-down'),
    }], {
      action: 'alert',
      reason: 'health-unavailable',
      missing: [],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-health-down')],
    });
    assertDecision([{
      kind: 'health',
      binding: { kind: 'missing' },
      transition: { kind: 'failure' },
      source: event('evt-health-unbound'),
    }], {
      action: 'record',
      reason: 'health-binding-missing',
      missing: ['health-binding'],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-health-unbound')],
    });
    assertDecision([{
      kind: 'health',
      binding: { kind: 'bound', target: ' ', ruleId: 'health-target-v3' },
      transition: { kind: 'failure' },
      source: event('evt-health-blank'),
    }], {
      action: 'record',
      reason: 'health-binding-missing',
      missing: ['health-binding'],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-health-blank')],
    });
    assertDecision([{
      kind: 'health',
      binding: { kind: 'bound', target: 'data-asset', ruleId: 'health-target-v3' },
      transition: { kind: 'status', code: 200 },
      source: event('evt-health-200'),
    }], {
      action: 'record',
      reason: 'health-not-unavailable',
      missing: [],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-health-200')],
    });
  });

  it('alerts on a bound critical-task impact and records a missing binding', () => {
    assertDecision([{
      kind: 'critical-task',
      result: 'failed',
      binding: { kind: 'bound', objectKey: 'submit-order', ruleId: 'critical-task-v1' },
      source: event('evt-task'),
    }], {
      action: 'alert',
      reason: 'critical-task-impact',
      missing: [],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-task')],
    });
    assertDecision([{
      kind: 'critical-task',
      result: 'failed',
      binding: { kind: 'missing' },
      source: event('evt-task-unbound'),
    }], {
      action: 'record',
      reason: 'critical-task-binding-missing',
      missing: ['critical-task-binding'],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-task-unbound')],
    });
  });

  it('records a bound critical task when the result is unknown or succeeded', () => {
    assertDecision([{
      kind: 'critical-task',
      result: 'unknown',
      binding: { kind: 'bound', objectKey: 'submit-order', ruleId: 'critical-task-v1' },
      source: event('evt-task-unknown'),
    }], {
      action: 'record',
      reason: 'critical-task-result-unknown',
      missing: ['critical-task-result'],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-task-unknown')],
    });
    assertDecision([{
      kind: 'critical-task',
      result: 'succeeded',
      binding: { kind: 'bound', objectKey: 'submit-order', ruleId: 'critical-task-v1' },
      source: event('evt-task-ok'),
    }], {
      action: 'record',
      reason: 'critical-task-succeeded',
      missing: [],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-task-ok')],
    });
  });

  it('alerts a failed critical task only when the object and rule binding are present', () => {
    assertDecision([{
      kind: 'critical-task',
      result: 'failed',
      binding: { kind: 'bound', objectKey: 'submit-order', ruleId: 'critical-task-v1' },
      source: event('evt-task-failed'),
    }], {
      action: 'alert',
      reason: 'critical-task-impact',
      missing: [],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-task-failed')],
    });
    assertDecision([{
      kind: 'critical-task',
      result: 'failed',
      binding: { kind: 'missing' },
      source: event('evt-task-failed-unbound'),
    }], {
      action: 'record',
      reason: 'critical-task-binding-missing',
      missing: ['critical-task-binding'],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-task-failed-unbound')],
    });
  });

  it('records conflicting known short-peak counts as unknown gaps without summing', () => {
    assertDecision([
      {
        kind: 'short-peak',
        failures: { kind: 'known', value: 1 },
        requests: { kind: 'known', value: 10 },
        source: event('evt-peak-a'),
      },
      {
        kind: 'short-peak',
        failures: { kind: 'known', value: 2 },
        requests: { kind: 'known', value: 20 },
        source: event('evt-peak-b'),
      },
    ], {
      action: 'record',
      reason: 'short-peak',
      missing: ['failure-count', 'request-count'],
      failures: unknown,
      requests: unknown,
      sources: [event('evt-peak-a'), event('evt-peak-b')],
    });
  });

  it('marks only a conflicting count and keeps an agreed known count', () => {
    assertDecision([
      {
        kind: 'short-peak',
        failures: { kind: 'known', value: 1 },
        requests: { kind: 'known', value: 10 },
        source: event('evt-peak-c'),
      },
      {
        kind: 'short-peak',
        failures: { kind: 'known', value: 2 },
        requests: { kind: 'known', value: 10 },
        source: event('evt-peak-d'),
      },
    ], {
      action: 'record',
      reason: 'short-peak',
      missing: ['failure-count'],
      failures: unknown,
      requests: { kind: 'known', value: 10 },
      sources: [event('evt-peak-c'), event('evt-peak-d')],
    });
    assertDecision([
      {
        kind: 'short-peak',
        failures: { kind: 'known', value: 1 },
        requests: { kind: 'known', value: 10 },
        source: event('evt-peak-e'),
      },
      {
        kind: 'short-peak',
        failures: { kind: 'known', value: 1 },
        requests: { kind: 'known', value: 10 },
        source: event('evt-peak-f'),
      },
    ], {
      action: 'record',
      reason: 'short-peak',
      missing: [],
      failures: { kind: 'known', value: 1 },
      requests: { kind: 'known', value: 10 },
      sources: [event('evt-peak-e'), event('evt-peak-f')],
    });
  });
});

describe('notification decision isolation', () => {
  it('keeps the database unchanged when the pure function runs and does not deliver an isolated slow SQL', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const opened: OpsEvent = {
      schemaVersion: 1,
      id: 'evt-open',
      time: '2026-08-20T12:00:00.000Z',
      source: 'application',
      nodeId: 'test-svc-02',
      service: 'data-asset-service',
      type: 'application.slow_sql',
      severity: 'warning',
      message: 'slow sql',
      attributes: { sqlFingerprint: 'deadbeef' },
    };
    store.insertBatch({ producer: { id: 'app', type: 'application', version: '1' }, events: [opened] }, opened.time);
    const created = engine.processEvent(opened, opened.time);
    assert.equal(created.ignored, false);
    if (created.ignored) return;
    const incidentId = created.incidentId;
    const beforeIncident = structuredClone(store.getIncident(incidentId));
    const beforeJobs = structuredClone(store.listNotificationJobs(incidentId));
    decideFirstNotification(facts([{
      kind: 'ordinary-error',
      persistence: { kind: 'known', value: 'brief' },
      impact: unknown,
      failures: unknown,
      requests: unknown,
      logLines: unknown,
      source: event('evt-open'),
    }]));
    assert.deepEqual(store.getIncident(incidentId), beforeIncident);
    assert.deepEqual(store.listNotificationJobs(incidentId), beforeJobs);

    const notifier = createFakeNotifier();
    const worker = createNotificationJobWorker(makeAgentConfig({
      evidenceJobPollIntervalMs: 60_000,
      reasoningJobPollIntervalMs: 60_000,
      notificationJobPollIntervalMs: 60_000,
      notificationJobMaxAttempts: 3,
    }), store, notifier);
    await worker.runOnce();
    assert.deepEqual(notifier.sent, []);
    assert.deepEqual(beforeJobs, []);

    const afterIncident = structuredClone(store.getIncident(incidentId));
    const afterJobs = structuredClone(store.listNotificationJobs(incidentId));
    decideFirstNotification(facts([{
      kind: 'jvm-exception',
      exceptionClass: 'java.lang.OutOfMemoryError',
      exceptionMessage: 'Java heap space',
      stackTrace: '',
      source: event('evt-open'),
    }]));
    assert.deepEqual(store.getIncident(incidentId), afterIncident);
    assert.deepEqual(store.listNotificationJobs(incidentId), afterJobs);
    assert.deepEqual(afterJobs, []);
    store.close();
  });
});
