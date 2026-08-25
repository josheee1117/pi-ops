import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INVESTIGATION_SCHEMA_VERSION } from '../investigation-context.js';
import { createInvestigationLoopService } from '../investigation-loop.js';
import type { InvestigationReportCallback, PiRuntimeClient } from '../pi-runtime-client.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

function seedIncident(store = createEventStore(':memory:')) {
  const incident = store.createIncident({
    service: 'data-asset-service',
    node_id: 'test-svc-02',
    type: 'application.slow_sql',
    state: 'OPEN',
    fingerprint: 'fp-runtime-contract',
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'warning',
  } satisfies Omit<IncidentRow, 'id'>);
  store.insertEvidence({
    id: 'evd-rt-1',
    incidentId: incident.id,
    nodeId: 'test-svc-02',
    source: 'host',
    kind: 'host.load',
    collectedAt: '2026-08-20T12:00:01.000Z',
    data: { load1: 0.2, cpus: 8 },
    status: 'succeeded',
  } satisfies EvidenceRecord);
  return { store, incident };
}

function countingRuntime(): { runtime: PiRuntimeClient; submits: () => number } {
  let submits = 0;
  return {
    submits: () => submits,
    runtime: {
      async submit() {},
      async poll() {
        return undefined;
      },
      async submitInvestigation(session) {
        submits += 1;
        return { runtimeTaskId: `rt-${session.runtimeRequestId}` };
      },
    },
  };
}

function report() {
  return {
    hypothesis: 'database side investigation required',
    supportingEvidenceIds: ['evd-rt-1'],
    contradictingEvidenceIds: [],
    confidence: 0.7,
    recommendation: 'inspect SQL and indexes',
  };
}

function callback(
  sessionId: string,
  runtimeRequestId: string,
  runtimeTaskId: string,
  overrides: Partial<InvestigationReportCallback> = {},
): InvestigationReportCallback {
  return {
    schemaVersion: INVESTIGATION_SCHEMA_VERSION,
    runtimeRequestId,
    runtimeTaskId,
    sessionId,
    report: report(),
    ...overrides,
  };
}

describe('Pi Runtime production contract', () => {
  it('submits the same runtimeRequestId only once', async () => {
    const { store, incident } = seedIncident();
    const { runtime, submits } = countingRuntime();
    const loop = createInvestigationLoopService(store, { runtime });
    const first = loop.start(incident.id);
    const second = loop.start(incident.id);
    assert.equal(second.session.id, first.session.id);
    assert.equal(second.session.runtimeRequestId, first.session.runtimeRequestId);
    await loop.submit(first.session.id);
    await loop.submit(second.session.id);
    assert.equal(submits(), 1);
    const task = store.getDelegationTask(first.session.delegationTaskId)!;
    assert.equal(task.runtimeRequestId, first.session.runtimeRequestId);
    assert.equal(task.runtimeTaskId, `rt-${first.session.runtimeRequestId}`);
    store.close();
  });

  it('returns the existing report on a duplicate callback', async () => {
    const { store, incident } = seedIncident();
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(incident.id);
    const submitted = await loop.submit(session.id);
    const task = store.getDelegationTask(submitted.delegationTaskId)!;
    const payload = callback(session.id, session.runtimeRequestId, task.runtimeTaskId!);
    const first = loop.handleCallback(payload);
    const second = loop.handleCallback({
      ...payload,
      report: { ...report(), hypothesis: 'should not replace' },
    });
    assert.equal(second.id, first.id);
    assert.equal(second.hypothesis, first.hypothesis);
    assert.equal(store.listReasoningResults(incident.id).length, 1);
    store.close();
  });

  it('rejects an invalid callback without writing a report', async () => {
    const { store, incident } = seedIncident();
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(incident.id);
    await loop.submit(session.id);
    assert.throws(
      () => loop.handleCallback(callback(session.id, session.runtimeRequestId, 'rt-unknown')),
      /runtimeTaskId/,
    );
    assert.throws(
      () => loop.handleCallback(callback(session.id, 'rreq-other', 'rt-unknown')),
      /runtimeRequestId/,
    );
    assert.equal(store.getInvestigationReportBySessionId(session.id), undefined);
    assert.equal(store.getInvestigationSession(session.id)?.status, 'SUBMITTED');
    store.close();
  });

  it('fails a SUBMITTED session after a runtime timeout without changing the Incident', async () => {
    const { store, incident } = seedIncident();
    const before = structuredClone(store.getIncident(incident.id)!);
    let now = '2026-08-21T06:00:00.000Z';
    const loop = createInvestigationLoopService(store, { now: () => now });
    const { session } = loop.start(incident.id);
    await loop.submit(session.id);
    now = '2026-08-21T06:20:00.000Z';
    const timedOut = loop.reconcile({ timeoutMs: 10 * 60 * 1000 });
    assert.equal(timedOut.length, 1);
    assert.equal(timedOut[0]?.status, 'FAILED');
    assert.deepEqual(store.getIncident(incident.id), before);
    assert.equal(store.getInvestigationReportBySessionId(session.id), undefined);
    store.close();
  });

  it('rejects a callback with a schema mismatch', async () => {
    const { store, incident } = seedIncident();
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(incident.id);
    const submitted = await loop.submit(session.id);
    const task = store.getDelegationTask(submitted.delegationTaskId)!;
    assert.throws(
      () => loop.handleCallback(callback(
        session.id,
        session.runtimeRequestId,
        task.runtimeTaskId!,
        { schemaVersion: 99 },
      )),
      /schemaVersion/,
    );
    assert.equal(store.getInvestigationReportBySessionId(session.id), undefined);
    store.close();
  });

  it('fails closed when the runtime is unavailable without mutating Incident or Evidence', async () => {
    const { store, incident } = seedIncident();
    const beforeIncident = structuredClone(store.getIncident(incident.id)!);
    const beforeEvidence = structuredClone(store.listEvidence(incident.id));
    const loop = createInvestigationLoopService(store, {
      runtime: {
        async submit() {},
        async poll() {
          return undefined;
        },
        async submitInvestigation() {
          throw new Error('runtime unavailable');
        },
      },
    });
    const { session } = loop.start(incident.id);
    const failed = await loop.submit(session.id);
    assert.equal(failed.status, 'FAILED');
    assert.deepEqual(store.getIncident(incident.id), beforeIncident);
    assert.deepEqual(store.listEvidence(incident.id), beforeEvidence);
    assert.equal(store.getInvestigationReportBySessionId(session.id), undefined);
    store.close();
  });

  it('preserves the provenance chain on the ReasoningResult', async () => {
    const { store, incident } = seedIncident();
    const loop = createInvestigationLoopService(store);
    const { session } = loop.start(incident.id);
    const submitted = await loop.submit(session.id);
    const task = store.getDelegationTask(submitted.delegationTaskId)!;
    loop.handleCallback(callback(session.id, session.runtimeRequestId, task.runtimeTaskId!));
    const result = store.listReasoningResults(incident.id)[0]!;
    assert.equal(result.incidentId, incident.id);
    assert.ok(result.evidenceSnapshotHash);
    assert.deepEqual(result.evidenceIds, ['evd-rt-1']);
    assert.equal(result.investigationSessionId, session.id);
    assert.equal(result.runtimeRequestId, session.runtimeRequestId);
    assert.equal(result.runtimeTaskId, task.runtimeTaskId);
    assert.equal(result.delegationTaskId, task.id);
    store.close();
  });
});
