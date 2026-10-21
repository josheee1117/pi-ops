import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import type { OpsEvent } from '@pi-ops/protocol';
import { createApp } from '../app.js';
import { createIncidentEngine } from '../incident.js';
import { createEventStore } from '../store.js';
import { DEFAULT_NOTIFICATION_POLICY, type NotificationPolicyConfig } from '../notification-config.js';
import { createInvestigationLoopService } from '../investigation-loop.js';
import { createNotificationJobWorker } from '../notification-worker.js';
import { createFakeNotifier, createWeComNotifier } from '../notifier.js';
import { makeAgentConfig } from './test-config.js';
const converterPath = '../../../node-agent/src/events/log-events.ts';
const { scanContainerLog }: { scanContainerLog(lines: readonly string[], source: { container: string; nodeId: string; service: string }, instrumented: boolean): OpsEvent[] } = await import(converterPath);
const healthPath = '../../../node-agent/src/detectors/health.ts';
const { createHealthDetector } = await import(healthPath);
const nodeConfigPath = '../../../node-agent/src/__tests__/test-config.ts';
const { makeNodeAgentConfig: makeConfig } = await import(nodeConfigPath);
const diskPath = '../../../node-agent/src/detectors/disk.ts';
const { createDiskDetector } = await import(diskPath);
const dockerPath = '../../../node-agent/src/events/docker-events.ts';
const { dockerEventToOpsEvent } = await import(dockerPath);

const origin = Date.parse('2026-10-21T02:00:00.000Z');
const at = (seconds: number) => new Date(origin + seconds * 1000).toISOString();
const source = { container: 'orders', nodeId: 'node-1', service: 'orders' };
const policy: NotificationPolicyConfig = {
  ...DEFAULT_NOTIFICATION_POLICY,
  defaultUnknownImpactWaitMs: 60_000, defaultObservationMaxGapMs: 40_000,
  services: { orders: { unknownImpactWaitMs: 60_000, observationMaxGapMs: 40_000,
    criticalOperations: [{ ruleId: 'login-v1', path: '/login', workflow: '登录' }] } },
};
function business(seconds: number, operation = 'GET /other', status = 500) {
  return scanContainerLog([`[PI_OPS_JFR] ${JSON.stringify({ type: 'BUSINESS_ERROR', timestamp: at(seconds), service: 'orders', attributes: {
    exceptionClass: 'java.lang.IllegalStateException', exceptionMessage: 'failed', operation,
    responseStatus: status, errorCode: 'UNHANDLED_EXCEPTION',
  } })}`], source, true);
}
function harness(path = ':memory:', selected = policy) {
  const store = createEventStore(path, selected);
  const engine = createIncidentEngine(store, { aggregationWindowMs: 30_000, scheduleLocalReasoning: false });
  const app = createApp(makeAgentConfig(), store, engine);
  async function ingest(events: OpsEvent[]) {
    const response = await app.request('/v1/events', { method: 'POST',
      headers: { Authorization: 'Bearer ingest-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ producer: { id: 'node-1', type: 'node-agent', version: '1' }, events }) });
    assert.equal(response.status, 200, await response.text());
    return store.findIncidentByEventId(events[0]!.id)!;
  }
  return { store, ingest };
}
async function markdown(payload: Parameters<ReturnType<typeof createWeComNotifier>['send']>[0]) {
  let content = '';
  await createWeComNotifier({ webhookUrl: 'http://notifier.test', timeoutMs: 1000, maxResponseBytes: 8192,
    fetch: async (_url, init) => { content = JSON.parse(String(init?.body)).markdown.content; return new Response('{"errcode":0}'); },
  }).send(payload);
  return content;
}

describe('notification lifecycle from production converters', () => {
  it('notifies configured critical paths and operations, not expected rejections', async () => {
    for (const [operation, status, count] of [['POST /login', 500, 1], ['POST /login', 401, 0], ['GET /other', 500, 0]] as const) {
      const { store, ingest } = harness();
      try {
        const incident = await ingest(business(0, operation, status));
        assert.equal(store.listNotificationJobs(incident.id).length, count);
      } finally { store.close(); }
    }
    const { store, ingest } = harness(':memory:', { ...policy, services: { orders: { ...policy.services.orders!, criticalOperations: [{ ruleId: 'submit-v1', operation: 'submitOrder', workflow: '下单' }] } } });
    try { assert.equal(store.listNotificationJobs((await ingest(business(0, 'submitOrder'))).id).length, 1); }
    finally { store.close(); }
  });

  it('waits for sustained unknown impact, survives reopen, and escalates once even after model failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'notify-wait-'));
    const path = join(directory, 'agent.sqlite');
    let h = harness(path);
    try {
      const incident = await h.ingest(business(0));
      await h.ingest(business(30));
      await h.ingest(business(50));
      assert.equal(h.store.listIncidents().length, 1);
      const loop = createInvestigationLoopService(h.store);
      const { session } = loop.start(incident.id);
      loop.fail(session.id, 'model unavailable');
      h.store.evaluateNotification(incident.id, at(59));
      assert.equal(h.store.listNotificationJobs(incident.id).length, 0);
      h.store.close();
      h = harness(path);
      h.store.reconcileNotifications(at(60));
      h.store.reconcileNotifications(at(61));
      assert.equal(h.store.getNotificationDecision(incident.id)?.facts?.observations.some((item) => item.kind === 'ordinary-error' && item.persistence.kind === 'known'), true);
      await createNotificationJobWorker(makeAgentConfig(), h.store).runOnce();
      const jobs = h.store.listNotificationJobs(incident.id);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]?.payload.notice, 'manual-confirmation');
      assert.equal(jobs[0]?.status, 'PENDING');
      assert.match(await markdown(jobs[0]!.payload), /需要人工确认/);
      assert.equal(h.store.getNotificationDecision(incident.id)?.facts?.observations.some((item) => item.kind === 'ordinary-error' && item.persistence.kind === 'known'), true);
    } finally { h.store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps repeated unknown-impact observations in one episode across the aggregation window', async () => {
    const { store, ingest } = harness();
    try {
      const first = await ingest(business(0));
      for (const second of [25, 50, 75, 100]) await ingest(business(second));
      assert.equal(store.listIncidents().length, 1);
      store.reconcileNotifications(at(100));
      assert.equal(store.listNotificationJobs(first.id).length, 1);
      await ingest(business(100));
      assert.equal(store.listNotificationJobs(first.id).length, 1);
    } finally { store.close(); }
  });

  it('does not escalate a short burst after observations stop', async () => {
    const { store, ingest } = harness();
    try {
      const incident = await ingest(business(0));
      await ingest(business(5));
      store.reconcileNotifications(at(60));
      assert.equal(store.listNotificationJobs(incident.id).length, 0);
    } finally { store.close(); }
  });

  it('binds real health detector transitions, merges across windows, and sends recovered-before-delivery once', async () => {
    const now = new Date().toISOString();
    const target = { name: 'orders', url: 'http://orders/health', ruleId: 'health-orders', ruleVersion: 1, intervalMs: 1000 };
    const selected = { ...policy, healthRules: [{ ...target, service: 'orders', target: 'orders', nodeId: 'node-1', method: 'GET', failureSamples: 2 }] };
    const { store, ingest } = harness(':memory:', selected);
    const events: OpsEvent[] = [];
    let ok = false;
    const detector = createHealthDetector(makeConfig({ nodeId: 'node-1', healthTargets: [target], healthFailureDuration: 2 }), { enqueue: (event: OpsEvent) => events.push(event) }, async () => ({ ok, status: ok ? 200 : 503 }));
    try {
      await detector.pollOnce();
      assert.equal(events.length, 0);
      await detector.pollOnce();
      const incident = await ingest(events.splice(0));
      assert.equal(store.listNotificationJobs(incident.id).length, 1);
      const duplicate = { ...JSON.parse(store.getEvent(store.listIncidentEventIds(incident.id)[0]!)!.attributes) };
      const repeated = { ...store.getEvidenceJob(`job-${incident.id}`)!.triggeringEvent, id: 'later-health', time: new Date(Date.parse(now) + 300_000).toISOString(), attributes: duplicate };
      assert.equal((await ingest([repeated])).id, incident.id);
      ok = true;
      await detector.pollOnce(); await detector.pollOnce();
      const recovery = events[0]!;
      recovery.time = new Date(Date.parse(repeated.time) + 1000).toISOString();
      await ingest([recovery]);
      const lateLoop = createInvestigationLoopService(store);
      const lateSession = lateLoop.start(incident.id).session;
      await lateLoop.submit(lateSession.id);
      lateLoop.complete(lateSession.id, { hypothesis: 'late report', confidence: 0.9, supportingEvidenceIds: [], contradictingEvidenceIds: [], recommendation: 'verify recovery' });
      assert.equal(store.listNotificationJobs(incident.id).length, 1);
      const notifier = createFakeNotifier();
      const worker = createNotificationJobWorker(makeAgentConfig(), store, notifier);
      await worker.runOnce(); await worker.runOnce();
      assert.equal(notifier.sent.length, 1);
      assert.equal(notifier.sent[0]?.notice, 'recovered-before-delivery');
      assert.match(await markdown(notifier.sent[0]!), /曾发生、现已恢复/);
    } finally { store.close(); }
  });

  it('handles recovery while first send is RUNNING and sends recovery only after delivery', async () => {
    const target = { name: 'orders', url: 'http://orders/health', ruleId: 'running-health', ruleVersion: 1, intervalMs: 1000 };
    const selected = { ...policy, healthRules: [{ ...target, service: 'orders', target: 'orders', nodeId: 'node-1', method: 'GET', failureSamples: 1 }] };
    const { store, ingest } = harness(':memory:', selected);
    const events: OpsEvent[] = [];
    let ok = false;
    const detector = createHealthDetector(makeConfig({ nodeId: 'node-1', healthTargets: [target], healthFailureDuration: 1 }), { enqueue: (event: OpsEvent) => events.push(event) }, async () => ({ ok, status: ok ? 200 : 503 }));
    try {
      await detector.pollOnce();
      const incident = await ingest(events.splice(0));
      const sent: string[] = [];
      const worker = createNotificationJobWorker(makeAgentConfig(), store, { async send(payload) {
        sent.push(payload.type);
        if (payload.type === 'INCIDENT_OPEN') { ok = true; await detector.pollOnce(); await ingest(events.splice(0)); }
      } });
      await worker.runOnce(); await worker.runOnce();
      assert.deepEqual(sent, ['INCIDENT_OPEN', 'INCIDENT_RECOVERED']);
      assert.equal(store.listNotificationJobs(incident.id).every((job) => job.status === 'DELIVERED'), true);
    } finally { store.close(); }
  });

  it('rewrites a failed RUNNING first send after recovery before retry or restart', async () => {
    const target = { name: 'orders', url: 'http://orders/health', ruleId: 'retry-health', ruleVersion: 1, intervalMs: 1000 };
    const selected = { ...policy, healthRules: [{ ...target, service: 'orders', target: 'orders', nodeId: 'node-1', method: 'GET', failureSamples: 1 }] };
    const { store, ingest } = harness(':memory:', selected);
    const events: OpsEvent[] = [];
    let ok = false;
    const detector = createHealthDetector(makeConfig({ nodeId: 'node-1', healthTargets: [target], healthFailureDuration: 1 }), { enqueue: (event: OpsEvent) => events.push(event) }, async () => ({ ok, status: ok ? 200 : 503 }));
    try {
      await detector.pollOnce(); const incident = await ingest(events.splice(0));
      const initial = store.listNotificationJobs(incident.id)[0]!;
      store.markNotificationJobRunning(initial.id);
      ok = true; await detector.pollOnce(); await ingest(events.splice(0));
      store.markNotificationJobRetry(initial.id, 'network error', false);
      assert.equal(store.getNotificationJob(initial.id)?.payload.notice, 'recovered-before-delivery');
      store.markNotificationJobRunning(initial.id);
      store.resetRunningNotificationJobs();
      assert.equal(store.getNotificationJob(initial.id)?.payload.notice, 'recovered-before-delivery');
      const notifier = createFakeNotifier();
      await createNotificationJobWorker(makeAgentConfig(), store, notifier).runOnce();
      assert.equal(notifier.sent.length, 1);
      assert.equal(notifier.sent[0]?.notice, 'recovered-before-delivery');
      assert.equal(store.listNotificationJobs(incident.id).length, 1);
    } finally { store.close(); }
  });

  it('sends one valuable repair update, ignores confidence changes and late reports after recovery', async () => {
    const { store, ingest } = harness();
    try {
      const incident = await ingest(business(0, 'POST /login'));
      const initial = store.listNotificationJobs(incident.id)[0]!;
      store.markNotificationJobRunning(initial.id); store.markNotificationJobDelivered(initial.id);
      const loop = createInvestigationLoopService(store);
      const base = { hypothesis: 'route mismatch', supportingEvidenceIds: [] as string[], contradictingEvidenceIds: [] as string[], confidence: 0.6, recommendation: 'check route' };
      const first = loop.start(incident.id).session;
      await loop.submit(first.id); loop.complete(first.id, base);
      const second = loop.start(incident.id).session;
      await loop.submit(second.id); loop.complete(second.id, { ...base, confidence: 0.9 });
      assert.equal(store.listNotificationJobs(incident.id).length, 1);
      const evidenceId = store.listEvidence(incident.id)[0]!.id;
      const diagnosis = { observations: [], candidateCauses: [{ cause: 'route mismatch', supportingEvidenceIds: [evidenceId], contradictingEvidenceIds: [] }], uncertainties: [], actions: [{
        purpose: 'repair' as const, target: 'orders route', preconditions: ['contract checked'], operation: 'restore deployed route', expectedResult: 'request succeeds', risk: 'deployment change', requiresApproval: true, evidenceIds: [evidenceId],
      }] };
      const third = loop.start(incident.id).session;
      await loop.submit(third.id); loop.complete(third.id, { ...base, diagnosis });
      loop.complete(third.id, { ...base, diagnosis });
      assert.equal(store.listNotificationJobs(incident.id).length, 2);
      const update = store.listNotificationJobs(incident.id).find((job) => job.type === 'INVESTIGATION_COMPLETED')!;
      assert.deepEqual(update.payload.analysis?.diagnosis, diagnosis);
      assert.match(await markdown(update.payload), /诊断更新/);
      const fourth = loop.start(incident.id).session;
      await loop.submit(fourth.id); loop.complete(fourth.id, { ...base, diagnosis: { ...diagnosis, actions: [{ ...diagnosis.actions[0]!, operation: 'another repair' }] } });
      assert.equal(store.listNotificationJobs(incident.id).length, 2);
      store.markNotificationJobRunning(update.id);
      const fifth = loop.start(incident.id).session;
      await loop.submit(fifth.id);
      const recovery = { ...business(90, 'POST /login')[0]!, id: 'recovery', type: 'business.recovered' };
      store.insertBatch({ producer: { id: 'node-1', type: 'node-agent', version: '1' }, events: [recovery] }, recovery.time);
      store.applyRecovery(incident.id, recovery);
      store.markNotificationJobRetry(update.id, 'network failed during recovery', false);
      loop.complete(fifth.id, { ...base, diagnosis });
      assert.equal(store.listNotificationJobs(incident.id).filter((job) => job.type === 'INVESTIGATION_COMPLETED').length, 1);
      assert.equal(store.getNotificationJob(update.id)?.status, 'FAILED');
      assert.match(store.getNotificationJob(update.id)?.lastError ?? '', /suppressed/);
    } finally { store.close(); }
  });

  it('rechecks new successful evidence and reports a new impact once after investigation', async () => {
    const { store, ingest } = harness();
    try {
      const incident = await ingest(business(0, 'POST /login'));
      const evidenceId = store.listEvidence(incident.id)[0]!.id;
      assert.equal(store.listNotificationJobs(incident.id).length, 1);
      const job = store.listNotificationJobs(incident.id)[0]!;
      store.markNotificationJobRunning(job.id); store.markNotificationJobDelivered(job.id);
      const loop = createInvestigationLoopService(store);
      const session = loop.start(incident.id).session;
      await loop.submit(session.id);
      loop.complete(session.id, { hypothesis: 'observed failure', confidence: 0.5, supportingEvidenceIds: [evidenceId], contradictingEvidenceIds: [], recommendation: 'inspect', diagnosis: { observations: [], candidateCauses: [{ cause: 'unknown', supportingEvidenceIds: [evidenceId], contradictingEvidenceIds: [] }], uncertainties: ['unknown'], actions: [{ purpose: 'evidence_collection', target: 'orders', preconditions: ['read only'], operation: 'inspect memory', expectedResult: 'locate pressure', risk: 'none', requiresApproval: false, evidenceIds: [evidenceId] }] } });
      assert.equal(store.listNotificationJobs(incident.id).length, 1);
      store.insertEvidence({ id: 'inspect-old-oom', incidentId: incident.id, nodeId: 'node-1', source: 'docker', kind: 'docker.inspect', collectedAt: at(2), status: 'succeeded', data: { Name: '/orders', State: { OOMKilled: true, FinishedAt: at(-10) } } });
      assert.equal(store.listNotificationJobs(incident.id).length, 1);
      store.insertEvidence({ id: 'inspect-current-oom', incidentId: incident.id, nodeId: 'node-1', source: 'docker', kind: 'docker.inspect', collectedAt: at(2), status: 'succeeded', data: { Name: '/orders', State: { OOMKilled: true, FinishedAt: at(1) } } });
      assert.equal(store.listNotificationJobs(incident.id).length, 2);
      store.evaluateNotification(incident.id);
      assert.equal(store.listNotificationJobs(incident.id).length, 2);
    } finally { store.close(); }
  });

  it('notifies container OOM from the Docker converter but not exit 137', async () => {
    const { store, ingest } = harness();
    try {
      const event = dockerEventToOpsEvent({ Type: 'container', Action: 'oom', Actor: { ID: 'container-1', Attributes: { name: 'orders' } }, time: origin / 1000, timeNano: origin * 1000000 }, makeConfig({ nodeId: 'node-1' }));
      const incident = await ingest([event]);
      await ingest([event]);
      assert.equal(store.listNotificationJobs(incident.id).length, 1);
    } finally { store.close(); }
  });

  it('escalates latched resource pressure after its service wait and records recovery without a second first alert', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let free = 10;
    t.mock.method(fs, 'statfsSync', () => ({ bsize: 4096, blocks: 100, bfree: free, bavail: free }));
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const events: OpsEvent[] = [];
    const detector = createDiskDetector(makeConfig({ nodeId: 'node-1', diskPressureThreshold: 0.8, diskPressureDuration: 1, detectorPollIntervalMs: 10 }), { enqueue: (event: OpsEvent) => events.push(event) });
    const { store, ingest } = harness();
    try {
      detector.start(); t.mock.timers.tick(10);
      const incident = await ingest(events.splice(0));
      assert.equal(store.listNotificationJobs(incident.id).length, 0);
      store.reconcileNotifications(new Date(Date.parse(incident.first_seen) + 60_000).toISOString());
      assert.equal(store.listNotificationJobs(incident.id)[0]?.payload.notice, 'manual-confirmation');
      free = 60; t.mock.timers.tick(10);
      await ingest(events.splice(0));
      assert.equal(store.listNotificationJobs(incident.id).length, 1);
      assert.equal(store.listNotificationJobs(incident.id)[0]?.payload.notice, 'recovered-before-delivery');
    } finally { detector.stop(); store.close(); }
  });

  it('records missing health bindings and isolated exit 137 without notifying', async () => {
    const { store, ingest } = harness();
    try {
      const events: OpsEvent[] = [];
      const detector = createHealthDetector(makeConfig({ nodeId: 'node-1', healthTargets: [{ name: 'orders', url: 'http://orders/health' }], healthFailureDuration: 1 }), { enqueue: (event: OpsEvent) => events.push(event) }, async () => ({ ok: false, status: 503 }));
      await detector.pollOnce();
      const incident = await ingest(events);
      assert.equal(store.listNotificationJobs(incident.id).length, 0);
      assert.ok(store.getNotificationDecision(incident.id)?.missing.includes('health-binding'));
      const event = dockerEventToOpsEvent({ Type: 'container', Action: 'die', Actor: { ID: 'container-1', Attributes: { name: 'orders', exitCode: '137' } }, time: origin / 1000, timeNano: origin * 1000000 }, makeConfig({ nodeId: 'node-1' }));
      const died = await ingest([event]);
      assert.equal(store.listNotificationJobs(died.id).length, 0);
    } finally { store.close(); }
  });
});
