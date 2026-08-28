import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpsEvent } from '@pi-ops/protocol';
import { createIncidentEngine } from '../incident.js';
import { createInvestigationLoopService } from '../investigation-loop.js';
import { createNotificationJobWorker } from '../notification-worker.js';
import {
  createFakeNotifier,
  createHttpWebhookNotifier,
  RetryableNotificationError,
  TerminalNotificationError,
} from '../notifier.js';
import { notificationJobId } from '../notification.js';
import { createEventStore } from '../store.js';
import type { AgentConfig } from '../config.js';

const CONFIG: AgentConfig = {
  port: 0,
  ingestToken: 'ingest-token',
    operatorToken: 'operator-token',
    investigationRetryMaxAttempts: 3,
    investigationRetryBackoffMs: 0,
    investigationStaleTimeoutMs: 60_000,
    externalRuntimeEnabled: false,
  sqlitePath: ':memory:',
  nodeId: 'central',
  maxBodySize: 1024 * 1024,
  aggregationWindowMs: 5 * 60 * 1000,
  nodeAgents: new Map(),
  evidenceTimeoutMs: 1000,
  evidenceMaxResponseBytes: 1024 * 1024,
  evidenceLogsMaxLines: 200,
  evidenceJobPollIntervalMs: 60_000,
  evidenceJobMaxAttempts: 3,
  evidenceJobBatchSize: 10,
  eventReplayBatchSize: 100,
  reasoningJobPollIntervalMs: 60_000,
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
  notificationJobMaxAttempts: 3,
};

function slowSql(overrides: Partial<OpsEvent> = {}): OpsEvent {
  return {
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
    ...overrides,
  };
}

function report() {
  return {
    hypothesis: 'sql is waiting on IO',
    supportingEvidenceIds: [] as string[],
    contradictingEvidenceIds: [] as string[],
    confidence: 0.7,
    recommendation: 'check disk latency',
  };
}

describe('durable operational notifications', () => {
  it('schedules exactly one OPEN job with a new Incident', () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const event = slowSql();
    store.insertBatch({ producer: { id: 'app', type: 'application', version: '1' }, events: [event] }, event.time);
    const first = engine.processEvent(event, event.time);
    engine.processEvent(event, event.time);
    const jobs = store.listNotificationJobs(first.incidentId!);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.type, 'INCIDENT_OPEN');
    assert.equal(jobs[0]?.id, notificationJobId('INCIDENT_OPEN', first.incidentId!));
    assert.equal(jobs[0]?.payload.incident.id, first.incidentId);
    assert.equal(jobs[0]?.payload.notificationId, jobs[0]?.id);
    assert.equal('analysis' in jobs[0]!.payload, false);
    store.close();
  });

  it('schedules INVESTIGATION_COMPLETED once per session and survives callback replay', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const event = slowSql();
    store.insertBatch({ producer: { id: 'app', type: 'application', version: '1' }, events: [event] }, event.time);
    const created = engine.processEvent(event, event.time);
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(created.incidentId!);
    await loop.submit(session.id);
    loop.complete(session.id, report());
    loop.complete(session.id, report());
    const jobs = store.listNotificationJobs(created.incidentId!).filter((job) => job.type === 'INVESTIGATION_COMPLETED');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.investigationSessionId, session.id);
    assert.ok(jobs[0]?.reasoningResultId);
    assert.equal(jobs[0]?.payload.analysis?.investigationSessionId, session.id);
    store.close();
  });

  it('schedules INCIDENT_RECOVERED exactly once', () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const event = slowSql();
    store.insertBatch({ producer: { id: 'app', type: 'application', version: '1' }, events: [event] }, event.time);
    const created = engine.processEvent(event, event.time);
    const recovery = slowSql({
      id: 'evt-recovered',
      time: '2026-08-20T12:10:00.000Z',
      type: 'application.slow_sql_recovered',
      severity: 'info',
      message: 'recovered',
    });
    store.insertBatch({ producer: { id: 'app', type: 'application', version: '1' }, events: [recovery] }, recovery.time);
    engine.processEvent(recovery, recovery.time);
    engine.processEvent(recovery, recovery.time);
    const recovered = store.listNotificationJobs(created.incidentId!).filter((job) => job.type === 'INCIDENT_RECOVERED');
    assert.equal(recovered.length, 1);
    assert.equal(store.getIncident(created.incidentId!)?.state, 'RECOVERED');
    assert.equal('analysis' in recovered[0]!.payload, false);
    store.close();
  });

  it('delivers PENDING jobs through FakeNotifier without mutating facts', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const event = slowSql();
    store.insertBatch({ producer: { id: 'app', type: 'application', version: '1' }, events: [event] }, event.time);
    const created = engine.processEvent(event, event.time);
    const before = structuredClone(store.getIncident(created.incidentId!)!);
    const notifier = createFakeNotifier();
    const worker = createNotificationJobWorker(CONFIG, store, notifier);
    await worker.runOnce();
    const job = store.getNotificationJob(notificationJobId('INCIDENT_OPEN', created.incidentId!))!;
    assert.equal(job.status, 'DELIVERED');
    assert.equal(notifier.sent.length, 1);
    assert.deepEqual(store.getIncident(created.incidentId!), before);
    await worker.runOnce();
    assert.equal(notifier.sent.length, 1);
    store.close();
  });

  it('resets RUNNING jobs on start and does not duplicate DELIVERED jobs', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const event = slowSql();
    store.insertBatch({ producer: { id: 'app', type: 'application', version: '1' }, events: [event] }, event.time);
    const created = engine.processEvent(event, event.time);
    assert.equal(store.markNotificationJobRunning(notificationJobId('INCIDENT_OPEN', created.incidentId!)), true);
    const notifier = createFakeNotifier();
    const worker = createNotificationJobWorker(CONFIG, store, notifier);
    worker.start();
    await worker.runOnce();
    await worker.stop();
    assert.equal(store.listNotificationJobs(created.incidentId!).length, 1);
    assert.equal(store.getNotificationJob(notificationJobId('INCIDENT_OPEN', created.incidentId!))?.status, 'DELIVERED');
    store.close();
  });
});

describe('HttpWebhookNotifier', () => {
  it('retries 429, 5xx, timeout and connection errors', async () => {
    const retryable = [429, 500, 503];
    for (const status of retryable) {
      const notifier = createHttpWebhookNotifier({
        url: 'http://notifier.test/hook',
        timeoutMs: 50,
        maxResponseBytes: 128,
        fetch: async () => new Response('no', { status }),
      });
      await assert.rejects(() => notifier.send({
        schemaVersion: 1,
        notificationId: 'njob-open-inc',
        type: 'INCIDENT_OPEN',
        incident: {
          id: 'inc', service: 'svc', nodeId: 'n', severity: 'warning', state: 'OPEN',
          firstSeen: 't', lastSeen: 't',
        },
        facts: { eventCount: 1, evidenceIds: [] },
      }), /notification webhook/);
    }
    const timeout = createHttpWebhookNotifier({
      url: 'http://notifier.test/hook',
      timeoutMs: 20,
      maxResponseBytes: 128,
      fetch: async (_input, init) => {
        await new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
        return new Response('ok');
      },
    });
    await assert.rejects(() => timeout.send({
      schemaVersion: 1,
      notificationId: 'njob-open-inc',
      type: 'INCIDENT_OPEN',
      incident: {
        id: 'inc', service: 'svc', nodeId: 'n', severity: 'warning', state: 'OPEN',
        firstSeen: 't', lastSeen: 't',
      },
      facts: { eventCount: 1, evidenceIds: [] },
    }), /timeout/);
    const connection = createHttpWebhookNotifier({
      url: 'http://notifier.test/hook',
      timeoutMs: 50,
      maxResponseBytes: 128,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await assert.rejects(() => connection.send({
      schemaVersion: 1,
      notificationId: 'njob-open-inc',
      type: 'INCIDENT_OPEN',
      incident: {
        id: 'inc', service: 'svc', nodeId: 'n', severity: 'warning', state: 'OPEN',
        firstSeen: 't', lastSeen: 't',
      },
      facts: { eventCount: 1, evidenceIds: [] },
    }), /connection error/);
  });

  it('treats ordinary 4xx as terminal and exhausts retries to FAILED', async () => {
    for (const status of [400, 401, 403]) {
      const notifier = createHttpWebhookNotifier({
        url: 'http://notifier.test/hook',
        timeoutMs: 50,
        maxResponseBytes: 128,
        fetch: async () => new Response('no', { status }),
      });
      await assert.rejects(
        () => notifier.send({
          schemaVersion: 1,
          notificationId: 'njob-open-inc',
          type: 'INCIDENT_OPEN',
          incident: {
            id: 'inc', service: 'svc', nodeId: 'n', severity: 'warning', state: 'OPEN',
            firstSeen: 't', lastSeen: 't',
          },
          facts: { eventCount: 1, evidenceIds: [] },
        }),
        (error: unknown) => error instanceof TerminalNotificationError,
      );
    }
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const event = slowSql();
    store.insertBatch({ producer: { id: 'app', type: 'application', version: '1' }, events: [event] }, event.time);
    const created = engine.processEvent(event, event.time);
    const beforeIncident = structuredClone(store.getIncident(created.incidentId!)!);
    const beforeEvidence = structuredClone(store.listEvidence(created.incidentId!));
    const worker = createNotificationJobWorker(CONFIG, store, {
      async send() {
        throw new TerminalNotificationError('notification webhook 400');
      },
    });
    await worker.runOnce();
    assert.equal(store.getNotificationJob(notificationJobId('INCIDENT_OPEN', created.incidentId!))?.status, 'FAILED');
    assert.deepEqual(store.getIncident(created.incidentId!), beforeIncident);
    assert.deepEqual(store.listEvidence(created.incidentId!), beforeEvidence);
    store.close();
  });

  it('sends a stable Idempotency-Key and optional bearer token', async () => {
    const headers: string[] = [];
    const notifier = createHttpWebhookNotifier({
      url: 'http://notifier.test/hook',
      timeoutMs: 50,
      maxResponseBytes: 128,
      token: 'hook-token',
      fetch: async (_input, init) => {
        const raw = init?.headers as Record<string, string> | undefined;
        headers.push(raw?.['Idempotency-Key'] ?? '', raw?.authorization ?? '');
        return new Response('ok', { status: 200 });
      },
    });
    await notifier.send({
      schemaVersion: 1,
      notificationId: 'njob-open-inc-1',
      type: 'INCIDENT_OPEN',
      incident: {
        id: 'inc', service: 'svc', nodeId: 'n', severity: 'warning', state: 'OPEN',
        firstSeen: 't', lastSeen: 't',
      },
      facts: { eventCount: 1, evidenceIds: [] },
    });
    assert.deepEqual(headers, ['njob-open-inc-1', 'Bearer hook-token']);
  });
});

describe('notification delivery safety', () => {
  it('exhausts retryable 500 exactly at maxAttempts without mutating facts', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const event = slowSql();
    store.insertBatch({ producer: { id: 'app', type: 'application', version: '1' }, events: [event] }, event.time);
    const created = engine.processEvent(event, event.time);
    const beforeIncident = structuredClone(store.getIncident(created.incidentId!)!);
    const beforeEvidence = structuredClone(store.listEvidence(created.incidentId!));
    let sends = 0;
    const worker = createNotificationJobWorker(CONFIG, store, {
      async send() {
        sends += 1;
        throw new RetryableNotificationError('notification webhook 500');
      },
    });
    await worker.runOnce();
    assert.equal(store.getNotificationJob(notificationJobId('INCIDENT_OPEN', created.incidentId!))?.status, 'PENDING');
    await worker.runOnce();
    assert.equal(store.getNotificationJob(notificationJobId('INCIDENT_OPEN', created.incidentId!))?.status, 'PENDING');
    await worker.runOnce();
    assert.equal(store.getNotificationJob(notificationJobId('INCIDENT_OPEN', created.incidentId!))?.status, 'FAILED');
    await worker.runOnce();
    assert.equal(sends, 3);
    assert.deepEqual(store.getIncident(created.incidentId!), beforeIncident);
    assert.deepEqual(store.listEvidence(created.incidentId!), beforeEvidence);
    assert.equal(store.listReasoningResults(created.incidentId!).length, 0);
    store.close();
  });

  it('rejects stale transitions out of terminal states', () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const event = slowSql();
    store.insertBatch({ producer: { id: 'app', type: 'application', version: '1' }, events: [event] }, event.time);
    const created = engine.processEvent(event, event.time);
    const openId = notificationJobId('INCIDENT_OPEN', created.incidentId!);
    assert.equal(store.markNotificationJobRunning(openId), true);
    assert.equal(store.markNotificationJobDelivered(openId), true);
    assert.equal(store.markNotificationJobRetry(openId, 'late', false), false);
    assert.equal(store.markNotificationJobDelivered(openId), false);
    assert.equal(store.getNotificationJob(openId)?.status, 'DELIVERED');

    const recovery = slowSql({
      id: 'evt-recovered',
      time: '2026-08-20T12:10:00.000Z',
      type: 'application.slow_sql_recovered',
      severity: 'info',
      message: 'recovered',
    });
    store.insertBatch({ producer: { id: 'app', type: 'application', version: '1' }, events: [recovery] }, recovery.time);
    engine.processEvent(recovery, recovery.time);
    const recoveredId = notificationJobId('INCIDENT_RECOVERED', created.incidentId!);
    assert.equal(store.markNotificationJobRunning(recoveredId), true);
    assert.equal(store.markNotificationJobRetry(recoveredId, 'terminal', true), true);
    assert.equal(store.markNotificationJobDelivered(recoveredId), false);
    assert.equal(store.getNotificationJob(recoveredId)?.status, 'FAILED');
    store.close();
  });

  it('resends RUNNING jobs after restart with the same logical identity', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const event = slowSql();
    store.insertBatch({ producer: { id: 'app', type: 'application', version: '1' }, events: [event] }, event.time);
    const created = engine.processEvent(event, event.time);
    const openId = notificationJobId('INCIDENT_OPEN', created.incidentId!);
    assert.equal(store.markNotificationJobRunning(openId), true);
    const notifier = createFakeNotifier();
    const worker = createNotificationJobWorker(CONFIG, store, notifier);
    worker.start();
    await worker.runOnce();
    await worker.stop();
    assert.deepEqual(notifier.identities, [openId]);
    assert.equal(notifier.sent[0]?.notificationId, openId);
    store.close();
  });

  it('delivers OPEN before RECOVERED after historical replay', async () => {
    const sqlitePath = join(mkdtempSync(join(tmpdir(), 'pi-ops-nreplay-')), 'replay.sqlite');
    const store = createEventStore(sqlitePath);
    const failure = slowSql({ id: 'evt-hist-fail', time: '2026-08-01T10:00:00.000Z' });
    const recovery = slowSql({
      id: 'evt-hist-rec',
      time: '2026-08-01T10:10:00.000Z',
      type: 'application.slow_sql_recovered',
      severity: 'info',
      message: 'recovered',
    });
    store.insertBatch({
      producer: { id: 'app', type: 'application', version: '1' },
      events: [failure, recovery],
    }, '2026-08-20T18:00:00.000Z');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    store.replayPendingEvents((event) => engine.processEvent(event, event.time), '2026-08-20T18:00:00.000Z', 100);
    engine.reconcilePendingRecoveries();
    const incident = store.listIncidents()[0]!;
    const pending = store.listPendingNotificationJobs(10);
    assert.deepEqual(pending.map((job) => job.type), ['INCIDENT_OPEN', 'INCIDENT_RECOVERED']);
    assert.ok(pending[0]!.createdAt <= pending[1]!.createdAt);
    assert.equal(pending[0]!.payload.incident.firstSeen, '2026-08-01T10:00:00.000Z');
    assert.equal(pending[1]!.payload.incident.lastSeen, '2026-08-01T10:10:00.000Z');
    const notifier = createFakeNotifier();
    const worker = createNotificationJobWorker(CONFIG, store, notifier);
    await worker.runOnce();
    assert.deepEqual(notifier.sent.map((item) => item.type), ['INCIDENT_OPEN', 'INCIDENT_RECOVERED']);
    assert.deepEqual(notifier.identities, [
      notificationJobId('INCIDENT_OPEN', incident.id),
      notificationJobId('INCIDENT_RECOVERED', incident.id),
    ]);
    store.close();
  });
});
