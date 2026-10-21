import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OpsEvent } from '@pi-ops/protocol';
import { DEFAULT_NOTIFICATION_POLICY, type NotificationPolicyConfig } from '../notification-config.js';
const converterPath = '../../../node-agent/src/events/log-events.ts';
const { scanContainerLog }: { scanContainerLog(lines: readonly string[], source: { container: string; nodeId: string; service: string }, instrumented: boolean): OpsEvent[] } = await import(converterPath);
import { createApp } from '../app.js';
import { createIncidentEngine } from '../incident.js';
import { createEventStore } from '../store.js';
import { buildFirstNotificationFactsFromStore } from '../notification-stored-facts.js';
import { decideFirstNotification } from '../notification-policy.js';
import { makeAgentConfig } from './test-config.js';

const time = '2026-10-21T02:00:00.000Z';
const source = { container: 'orders', nodeId: 'node-1', service: 'orders' };

async function receive(lines: string[], policy: NotificationPolicyConfig = DEFAULT_NOTIFICATION_POLICY, dbPath = ':memory:') {
  const events = scanContainerLog(lines, source, false);
  assert.ok(events.length);
  const store = createEventStore(dbPath, policy);
  const engine = createIncidentEngine(store, { aggregationWindowMs: 30_000, scheduleLocalReasoning: false });
  const app = createApp(makeAgentConfig(), store, engine);
  const response = await app.request('/v1/events', {
    method: 'POST',
    headers: { Authorization: 'Bearer ingest-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ producer: { id: 'node-1', type: 'node-agent', version: '1' }, events }),
  });
  assert.equal(response.status, 200, await response.text());
  const incident = store.findIncidentByEventId(events[0]!.id)!;
  return { store, incident, events, app, engine };
}

describe('production conversion to notification coverage', () => {
  for (const [clazz, message, reason] of [
    ['OutOfMemoryError', ': Java heap space', 'jvm-oome'],
    ['StackOverflowError', '', 'jvm-stack-overflow'],
  ]) {
    it(`notifies a Docker log ${clazz} through ingress and stored facts`, async () => {
      const { store, incident, events } = await receive([
        `${time} java.lang.${clazz}${message}`,
        '\tat com.example.Main.run(Main.java:12)',
      ]);
      try {
        const facts = buildFirstNotificationFactsFromStore(store, { incidentId: incident.id, eventIds: events.map((event) => event.id) });
        assert.equal(decideFirstNotification(facts).reason, reason);
        assert.equal(store.listNotificationJobs(incident.id).length, 1);
      } finally { store.close(); }
    });
  }

  it('notifies application JFR payloads recovered by the production log converter', async () => {
    for (const [type, clazz, message] of [
      ['JVM_OOM', 'java.lang.OutOfMemoryError', 'Java heap space'],
      ['JVM_STACK_OVERFLOW', 'java.lang.StackOverflowError', 'stack overflow'],
    ]) {
      const { store, incident } = await receive([`[PI_OPS_JFR] ${JSON.stringify({ type, timestamp: time, service: 'orders', attributes: { exceptionClass: clazz, exceptionMessage: message, stackTrace: 'at com.example.Main.run(Main.java:12)' } })}`]);
      try { assert.equal(store.listNotificationJobs(incident.id).length, 1); }
      finally { store.close(); }
    }
  });

  it('preserves a JFR-only exception stack through ingestion', async () => {
    const { store, incident } = await receive([`[PI_OPS_JFR] ${JSON.stringify({ type: 'JVM_OOM', timestamp: time, service: 'orders', attributes: { exceptionClass: 'java.lang.OutOfMemoryError', jfrStackTrace: 'at com.example.Main.run(Main.java:12)' } })}`]);
    try { assert.equal(store.listNotificationJobs(incident.id).length, 1); }
    finally { store.close(); }
  });

  it('does not authorize a Docker OOM mention without an exception stack', async () => {
    const { store, incident } = await receive([`${time} docs: java.lang.OutOfMemoryError: Java heap space`]);
    try { assert.equal(store.listNotificationJobs(incident.id).length, 0); }
    finally { store.close(); }
  });

  it('does not notify an isolated ordinary error', async () => {
    const { store, incident } = await receive([
      `${time}`,
      'java.lang.IllegalStateException: transient failure',
      '\tat com.example.Main.run(Main.java:12)',
    ]);
    try { assert.equal(store.listNotificationJobs(incident.id).length, 0); }
    finally { store.close(); }
  });

  it('distinguishes a missing incident from no observation', () => {
    const store = createEventStore(':memory:');
    try {
      assert.throws(() => buildFirstNotificationFactsFromStore(store, { incidentId: 'missing', eventIds: [] }), /does not exist/);
    } finally { store.close(); }
  });
});
