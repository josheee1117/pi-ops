import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpsEvent } from '@pi-ops/protocol';
import type { AgentConfig } from '../config.js';
import type { EvidenceOrchestrator } from '../evidence-orchestrator.js';
import { createEvidenceJobWorker } from '../evidence-worker.js';
import { createIncidentEngine } from '../incident.js';
import { createEventStore } from '../store.js';

function makeConfig(sqlitePath = ':memory:'): AgentConfig {
  return {
    port: 0,
    ingestToken: 'ingest-token',
    sqlitePath,
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
  };
}

function makeEvent(): OpsEvent {
  return {
    schemaVersion: 1,
    id: 'evt-job-1',
    time: '2026-08-20T12:00:00.000Z',
    source: 'docker',
    nodeId: 'test-svc-02',
    service: 'dataease',
    type: 'container.die',
    severity: 'error',
    message: 'Container died',
    attributes: { containerName: 'dataease' },
  };
}

describe('durable evidence jobs', () => {
  it('atomically creates a pending job with a new Incident', () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const result = engine.processEvent(makeEvent(), makeEvent().time);
    assert.ok(result.incidentId);

    const job = store.getEvidenceJob(`job-${result.incidentId}`);
    assert.ok(job);
    assert.equal(job.state, 'PENDING');
    assert.equal(job.incidentId, result.incidentId);
    assert.equal(job.triggeringEvent.id, 'evt-job-1');
    assert.equal(store.incidentCount(), 1);
    store.close();
  });

  it('processes a pending job and marks it completed', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const result = engine.processEvent(makeEvent(), makeEvent().time);
    assert.ok(result.incidentId);
    let calls = 0;
    let collectionId: string | undefined;
    const orchestrator: EvidenceOrchestrator = {
      async collectForIncident(incident, _event, id) {
        calls++;
        collectionId = id;
        return { incidentId: incident.id, requested: 2, succeeded: 2, failed: 0 };
      },
    };
    const worker = createEvidenceJobWorker(makeConfig(), store, orchestrator);
    await worker.runOnce();

    assert.equal(calls, 1);
    assert.equal(collectionId, `job-${result.incidentId}`);
    assert.equal(store.getEvidenceJob(`job-${result.incidentId}`)?.state, 'COMPLETED');
    await worker.stop();
    store.close();
  });

  it('resets and resumes a RUNNING job after process restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-ops-evidence-job-'));
    const dbPath = join(directory, 'agent.sqlite');
    const store1 = createEventStore(dbPath);
    const engine = createIncidentEngine(store1, { aggregationWindowMs: 300_000 });
    const result = engine.processEvent(makeEvent(), makeEvent().time);
    assert.ok(result.incidentId);
    const jobId = `job-${result.incidentId}`;
    assert.equal(store1.markEvidenceJobRunning(jobId), true);
    assert.equal(store1.getEvidenceJob(jobId)?.state, 'RUNNING');
    store1.close();

    const store2 = createEventStore(dbPath);
    let calls = 0;
    const orchestrator: EvidenceOrchestrator = {
      async collectForIncident(incident) {
        calls++;
        return { incidentId: incident.id, requested: 0, succeeded: 0, failed: 0 };
      },
    };
    const worker = createEvidenceJobWorker(makeConfig(dbPath), store2, orchestrator);
    worker.start();
    await worker.runOnce();
    await worker.stop();

    assert.equal(calls, 1);
    assert.equal(store2.getEvidenceJob(jobId)?.state, 'COMPLETED');
    store2.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('does not create another job for a transport retry', () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const event = makeEvent();
    const first = engine.processEvent(event, event.time);
    const retry = engine.processEvent(event, '2026-08-20T13:00:00.000Z');
    assert.equal(retry.incidentId, first.incidentId);
    assert.equal(store.listPendingEvidenceJobs(10).length, 1);
    store.close();
  });
});
