import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OpsEvent } from '@pi-ops/protocol';
import type { AgentConfig } from '../config.js';
import { createIncidentEngine } from '../incident.js';
import {
  createFakeReasoner,
  createReasonerRegistry,
  HYPOTHESIS_DATABASE_INVESTIGATION,
  type Reasoner,
} from '../reasoner.js';
import type { PiRuntimeClient } from '../pi-runtime-client.js';
import { createReasoningJobWorker, hashEvidenceSnapshot } from '../reasoning-worker.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    port: 0,
    ingestToken: 'ingest-token',
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
    ...overrides,
  };
}

function makeEvent(overrides: Partial<OpsEvent> = {}): OpsEvent {
  return {
    schemaVersion: 1,
    id: 'evt-reason-1',
    time: '2026-08-20T12:00:00.000Z',
    source: 'application',
    nodeId: 'test-svc-02',
    service: 'data-asset-service',
    type: 'application.slow_sql',
    severity: 'warning',
    message: 'Slow SQL',
    attributes: {
      sqlFingerprint: 'deadbeef',
      statementId: 'com.mbkj.FooMapper.select',
      containerName: 'data-asset',
    },
    ...overrides,
  };
}

function makeEvidence(incidentId: string, overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: 'evd-reason-1',
    incidentId,
    nodeId: 'test-svc-02',
    source: 'host',
    kind: 'host.load',
    collectedAt: '2026-08-20T12:00:01.000Z',
    data: { load1: 0.2, cpus: 8 },
    status: 'succeeded',
    ...overrides,
  };
}

function processNewIncident(store = createEventStore(':memory:')) {
  const engine = createIncidentEngine(store, { aggregationWindowMs: 5 * 60 * 1000 });
  const event = makeEvent();
  const result = engine.processEvent(event, event.time);
  assert.equal(result.ignored, false);
  assert.equal(result.isNew, true);
  const incident = store.getIncident(result.incidentId!)!;
  return { store, engine, event, incident };
}

describe('ReasoningJob worker', () => {
  it('creates a pending ReasoningJob from a new Incident without a result', () => {
    const { store, incident } = processNewIncident();
    const jobs = store.listPendingReasoningJobs(10);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.incidentId, incident.id);
    assert.equal(jobs[0]?.status, 'PENDING');
    assert.equal(jobs[0]?.reasonerType, 'fake');
    assert.equal(store.listReasoningResults(incident.id).length, 0);
    store.close();
  });

  it('writes one ReasoningResult after evidence is collected', async () => {
    const { store, incident } = processNewIncident();
    store.insertEvidence(makeEvidence(incident.id));
    const worker = createReasoningJobWorker(
      makeConfig(),
      store,
      createReasonerRegistry([createFakeReasoner()]),
    );
    await worker.runOnce();
    const results = store.listReasoningResults(incident.id);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0]?.hypotheses, [HYPOTHESIS_DATABASE_INVESTIGATION]);
    assert.equal(store.getReasoningJob(`rj-${incident.id}`)?.status, 'COMPLETED');
    assert.equal(worker.metrics().completed, 1);
    store.close();
  });

  it('records evidence ids and snapshot hash on the result', async () => {
    const { store, incident } = processNewIncident();
    const evidence = makeEvidence(incident.id);
    store.insertEvidence(evidence);
    const worker = createReasoningJobWorker(
      makeConfig(),
      store,
      createReasonerRegistry([createFakeReasoner()]),
    );
    await worker.runOnce();
    const result = store.listReasoningResults(incident.id)[0];
    assert.deepEqual(result?.evidenceIds, [evidence.id]);
    assert.equal(result?.evidenceSnapshotHash, hashEvidenceSnapshot([evidence]));
    assert.equal(result?.reasoningJobId, `rj-${incident.id}`);
    assert.equal(result?.reasonerType, 'fake');
    assert.equal(result?.reasonerVersion, '1');
    store.close();
  });

  it('recovers a RUNNING job after crash without losing retry_count', async () => {
    const { store, incident } = processNewIncident();
    store.insertEvidence(makeEvidence(incident.id));
    const jobId = `rj-${incident.id}`;
    assert.equal(store.markReasoningJobRunning(jobId), true);
    assert.equal(store.getReasoningJob(jobId)?.status, 'RUNNING');
    assert.equal(store.getReasoningJob(jobId)?.attempts, 1);
    assert.equal(store.resetRunningReasoningJobs(), 1);
    const recovered = store.getReasoningJob(jobId);
    assert.equal(recovered?.status, 'PENDING');
    assert.equal(recovered?.attempts, 1);
    const worker = createReasoningJobWorker(
      makeConfig(),
      store,
      createReasonerRegistry([createFakeReasoner()]),
    );
    await worker.runOnce();
    assert.equal(store.getReasoningJob(jobId)?.status, 'COMPLETED');
    assert.equal(store.getReasoningJob(jobId)?.attempts, 2);
    assert.equal(store.listReasoningResults(incident.id).length, 1);
    store.close();
  });

  it('marks the job FAILED when the Reasoner throws', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({
      service: 'data-asset-service',
      node_id: 'test-svc-02',
      type: 'application.slow_sql',
      state: 'OPEN',
      fingerprint: 'fp-boom',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'warning',
    });
    const boom: Reasoner = {
      type: 'fake',
      version: '1',
      reason(): never {
        throw new Error('reasoner exploded');
      },
    };
    store.createReasoningJob({
      id: `rj-${incident.id}`,
      incidentId: incident.id,
      reasonerType: 'fake',
      reasonerVersion: '1',
      createdAt: incident.last_seen,
    });
    const worker = createReasoningJobWorker(
      makeConfig(),
      store,
      createReasonerRegistry([boom]),
    );
    await worker.runOnce();
    const job = store.getReasoningJob(`rj-${incident.id}`);
    assert.equal(job?.status, 'FAILED');
    assert.equal(job?.lastError, 'reasoner exploded');
    assert.equal(store.listReasoningResults(incident.id).length, 0);
    assert.equal(worker.metrics().failed, 1);
    store.close();
  });

  it('does not insert a duplicate ReasoningResult for the same job', async () => {
    const { store, incident } = processNewIncident();
    store.insertEvidence(makeEvidence(incident.id));
    const worker = createReasoningJobWorker(
      makeConfig(),
      store,
      createReasonerRegistry([createFakeReasoner()]),
    );
    await worker.runOnce();
    const first = store.listReasoningResults(incident.id)[0]!;
    assert.equal(store.insertReasoningResult(first), false);
    store.markReasoningJobFailed(`rj-${incident.id}`, 'retry');
    // Re-queue as PENDING would require a new API; simulate retry of completed output.
    assert.equal(store.insertReasoningResult({
      ...first,
      hypotheses: ['should-not-appear'],
    }), false);
    const stored = store.listReasoningResults(incident.id);
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0]?.hypotheses, first.hypotheses);
    store.close();
  });

  it('keeps FakeReasoner output identical for the same Incident and Evidence', () => {
    const reasoner = createFakeReasoner();
    const incident: IncidentRow = {
      id: 'inc-same',
      service: 'data-asset-service',
      node_id: 'test-svc-02',
      type: 'application.slow_sql',
      state: 'OPEN',
      fingerprint: 'fp',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'warning',
    };
    const evidence = [makeEvidence(incident.id)];
    assert.deepEqual(reasoner.reason(incident, evidence), reasoner.reason(incident, evidence));
  });

  it('does not mutate Incident or Evidence while reasoning', async () => {
    const { store, incident } = processNewIncident();
    const evidence = makeEvidence(incident.id);
    store.insertEvidence(evidence);
    const incidentBefore = structuredClone(store.getIncident(incident.id)!);
    const evidenceBefore = structuredClone(store.listEvidence(incident.id));
    const worker = createReasoningJobWorker(
      makeConfig(),
      store,
      createReasonerRegistry([createFakeReasoner()]),
    );
    await worker.runOnce();
    assert.deepEqual(store.getIncident(incident.id), incidentBefore);
    assert.deepEqual(store.listEvidence(incident.id), evidenceBefore);
    store.close();
  });

  it('records strategy provenance on a deterministic ReasoningResult', async () => {
    const { store, incident } = processNewIncident();
    store.insertEvidence(makeEvidence(incident.id));
    const worker = createReasoningJobWorker(
      makeConfig(),
      store,
      createReasonerRegistry([createFakeReasoner()]),
    );
    await worker.runOnce();
    const result = store.listReasoningResults(incident.id)[0];
    assert.equal(result?.strategy, 'deterministic');
    assert.equal(result?.strategyVersion, '1');
    assert.equal(result?.investigationPlanId, undefined);
    store.close();
  });

  it('creates only an InvestigationPlan for delegated_analysis and does not execute a reasoner', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({
      service: 'data-asset-service',
      node_id: 'test-svc-02',
      type: 'application.slow_sql',
      state: 'OPEN',
      fingerprint: 'fp-delegated',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'warning',
    });
    store.insertEvidence(makeEvidence(incident.id));
    let executed = 0;
    const spy: Reasoner = {
      type: 'delegated_analysis',
      version: '1',
      reason() {
        executed += 1;
        throw new Error('reasoner must not run');
      },
    };
    store.createReasoningJob({
      id: `rj-${incident.id}`,
      incidentId: incident.id,
      reasonerType: 'delegated_analysis',
      reasonerVersion: '1',
      createdAt: incident.last_seen,
    });
    const submitted: string[] = [];
    const runtime: PiRuntimeClient = {
      async submit(plan) {
        submitted.push(plan.id);
      },
      async poll() {
        return undefined;
      },
      async submitInvestigation() {
        return undefined;
      },
    };
    const worker = createReasoningJobWorker(
      makeConfig(),
      store,
      createReasonerRegistry([spy]),
      undefined,
      undefined,
      runtime,
    );
    await worker.runOnce();
    const plans = store.listInvestigationPlansByJob(`rj-${incident.id}`);
    assert.equal(plans.length, 1);
    assert.equal(plans[0]?.strategy, 'delegated_analysis');
    assert.deepEqual(plans[0]?.requestedCapabilities, ['pi.runtime.delegated_analysis']);
    assert.deepEqual(submitted, [plans[0]?.id]);
    assert.equal(await runtime.poll(plans[0]!.id), undefined);
    assert.equal(executed, 0);
    assert.equal(store.listReasoningResults(incident.id).length, 0);
    assert.equal(store.getReasoningJob(`rj-${incident.id}`)?.status, 'WAITING_DELEGATION');
    assert.equal(store.getDelegationTaskByPlanId(plans[0]!.id)?.status, 'SUBMITTED');
    assert.equal(store.listPendingReasoningJobs(10).length, 0);
    store.close();
  });

  it('fails closed when the strategy is unknown', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({
      service: 'data-asset-service',
      node_id: 'test-svc-02',
      type: 'application.slow_sql',
      state: 'OPEN',
      fingerprint: 'fp-unknown-strategy',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'warning',
    });
    store.createReasoningJob({
      id: `rj-${incident.id}`,
      incidentId: incident.id,
      reasonerType: 'mystery-agent',
      reasonerVersion: '1',
      createdAt: incident.last_seen,
    });
    const worker = createReasoningJobWorker(
      makeConfig(),
      store,
      createReasonerRegistry([createFakeReasoner()]),
    );
    await worker.runOnce();
    assert.equal(store.getReasoningJob(`rj-${incident.id}`)?.status, 'FAILED');
    assert.match(store.getReasoningJob(`rj-${incident.id}`)?.lastError ?? '', /unknown reasoning strategy/);
    assert.equal(store.listReasoningResults(incident.id).length, 0);
    store.close();
  });
});
