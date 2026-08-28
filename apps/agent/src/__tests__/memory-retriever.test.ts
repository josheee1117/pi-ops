import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentContext } from '../incident-context.js';
import { createMemoryGovernanceService } from '../memory-governance.js';
import { createMemoryRetriever } from '../memory-retriever.js';
import { createFakeReasoner, createReasonerRegistry } from '../reasoner.js';
import { createReasoningEvaluationService } from '../reasoning-evaluation.js';
import { createReasoningJobWorker } from '../reasoning-worker.js';
import { createIncidentEngine } from '../incident.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';
import type { AgentConfig } from '../config.js';
import type { OpsEvent } from '@pi-ops/protocol';

const BOUNDS = { maxEvidenceItems: 8, maxContextBytes: 8192, maxLogLines: 20 };

function makeConfig(): AgentConfig {
  return {
    port: 0,
    ingestToken: 'ingest-token',
    operatorToken: 'operator-token',
    investigationRetryMaxAttempts: 3,
    investigationRetryBackoffMs: 0,
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
    reasoningMaxContextBytes: 8192,
    reasoningMaxEvidenceItems: 8,
    reasoningMaxLogLines: 20,
    reasoningMaxOutputBytes: 2048,
  };
}

function seedCandidate(
  store = createEventStore(':memory:'),
  overrides: { service?: string; type?: string; fingerprint?: string } = {},
) {
  const incident = store.createIncident({
    service: overrides.service ?? 'data-asset-service',
    node_id: 'test-svc-02',
    type: overrides.type ?? 'application.slow_sql',
    state: 'OPEN',
    fingerprint: overrides.fingerprint ?? 'fp-mem-1',
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'warning',
  } satisfies Omit<IncidentRow, 'id'>);
  const evidence: EvidenceRecord[] = [{
    id: `evd-${incident.id}`,
    incidentId: incident.id,
    nodeId: 'test-svc-02',
    source: 'host',
    kind: 'host.load',
    collectedAt: '2026-08-20T12:00:01.000Z',
    data: { load1: 0.2, cpus: 8 },
    status: 'succeeded',
  }];
  store.insertEvidence(evidence[0]!);
  const reasoned = createFakeReasoner().reason(incident, evidence);
  store.insertReasoningResult({
    ...reasoned,
    status: 'complete',
    missingEvidence: [],
    reasoningJobId: `rj-${incident.id}`,
    evidenceIds: [evidence[0]!.id],
    evidenceSnapshotHash: `hash-${incident.id}`,
  });
  const { candidate } = createReasoningEvaluationService(store).evaluate({
    reasoningResultId: reasoned.id,
    score: 0.9,
    feedback: 'Confirmed by DBA',
  });
  assert.ok(candidate);
  return { store, incident, evidence, candidate };
}

function seedApproved(
  store = createEventStore(':memory:'),
  overrides: { service?: string; type?: string; fingerprint?: string } = {},
) {
  const seeded = seedCandidate(store, overrides);
  const entry = createMemoryGovernanceService(seeded.store).approve(seeded.candidate.id);
  return { ...seeded, entry };
}

describe('MemoryRetriever', () => {
  it('retrieves ACTIVE memory for a matching IncidentContext', () => {
    const { store, incident, evidence, entry } = seedApproved();
    const retrieved = createMemoryRetriever(store).retrieve(buildIncidentContext(incident, evidence, BOUNDS)).memories;
    assert.equal(retrieved.length, 1);
    assert.equal(retrieved[0]?.id, entry.id);
    store.close();
  });

  it('does not retrieve DISABLED memory', () => {
    const { store, incident, evidence, entry } = seedApproved();
    createMemoryGovernanceService(store).disable(entry.id);
    const retrieved = createMemoryRetriever(store).retrieve(buildIncidentContext(incident, evidence, BOUNDS)).memories;
    assert.equal(retrieved.length, 0);
    store.close();
  });

  it('does not retrieve a rejected candidate', () => {
    const { store, incident, evidence, candidate } = seedCandidate();
    createMemoryGovernanceService(store).reject(candidate.id);
    const retrieved = createMemoryRetriever(store).retrieve(buildIncidentContext(incident, evidence, BOUNDS)).memories;
    assert.equal(retrieved.length, 0);
    store.close();
  });

  it('returns deterministic retrieval order', () => {
    const first = seedApproved();
    const second = seedApproved(first.store, { fingerprint: 'fp-mem-2' });
    const retriever = createMemoryRetriever(first.store);
    const context = buildIncidentContext(first.incident, first.evidence, BOUNDS);
    const once = retriever.retrieve(context).memories.map((item) => item.id);
    const twice = retriever.retrieve(context).memories.map((item) => item.id);
    assert.deepEqual(once, twice);
    assert.ok(once.includes(first.entry.id));
    assert.ok(once.includes(second.entry.id));
    first.store.close();
  });

  it('does not fail reasoning when no memory exists', async () => {
    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: 5 * 60 * 1000 });
    const event: OpsEvent = {
      schemaVersion: 1,
      id: 'evt-mem-none',
      time: '2026-08-20T12:00:00.000Z',
      source: 'application',
      nodeId: 'test-svc-02',
      service: 'data-asset-service',
      type: 'application.slow_sql',
      severity: 'warning',
      message: 'Slow SQL',
      attributes: { sqlFingerprint: 'deadbeef' },
    };
    const created = engine.processEvent(event, event.time);
    store.insertEvidence({
      id: 'evd-none',
      incidentId: created.incidentId!,
      nodeId: 'test-svc-02',
      source: 'host',
      kind: 'host.load',
      collectedAt: '2026-08-20T12:00:01.000Z',
      data: { load1: 0.2, cpus: 8 },
      status: 'succeeded',
    });
    const worker = createReasoningJobWorker(
      makeConfig(),
      store,
      createReasonerRegistry([createFakeReasoner()]),
      undefined,
      createMemoryRetriever(store),
    );
    await worker.runOnce();
    const results = store.listReasoningResults(created.incidentId!);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.usedMemoryEntryIds, undefined);
    assert.equal(store.getReasoningJob(`rj-${created.incidentId}`)?.status, 'COMPLETED');
    store.close();
  });

  it('records used memory ids on the ReasoningResult', async () => {
    const { store, entry } = seedApproved();
    const engine = createIncidentEngine(store, { aggregationWindowMs: 5 * 60 * 1000 });
    const event: OpsEvent = {
      schemaVersion: 1,
      id: 'evt-mem-used',
      time: '2026-08-20T12:05:00.000Z',
      source: 'application',
      nodeId: 'test-svc-02',
      service: 'data-asset-service',
      type: 'application.slow_sql',
      severity: 'warning',
      message: 'Slow SQL again',
      attributes: { sqlFingerprint: 'beefdead' },
    };
    const created = engine.processEvent(event, event.time);
    store.insertEvidence({
      id: 'evd-used',
      incidentId: created.incidentId!,
      nodeId: 'test-svc-02',
      source: 'host',
      kind: 'host.load',
      collectedAt: '2026-08-20T12:05:01.000Z',
      data: { load1: 0.3, cpus: 8 },
      status: 'succeeded',
    });
    const worker = createReasoningJobWorker(
      makeConfig(),
      store,
      createReasonerRegistry([createFakeReasoner()]),
      undefined,
      createMemoryRetriever(store),
    );
    await worker.runOnce();
    const result = store.listReasoningResults(created.incidentId!)[0];
    assert.deepEqual(result?.usedMemoryEntryIds, [entry.id]);
    store.close();
  });
});
