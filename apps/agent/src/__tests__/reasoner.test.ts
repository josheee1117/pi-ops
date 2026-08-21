import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFakeReasoner,
  HYPOTHESIS_DATABASE_INVESTIGATION,
  HYPOTHESIS_JVM_MEMORY_PRESSURE,
  HYPOTHESIS_RESOURCE_SATURATION,
  MISSING_DATABASE_METRICS,
  MISSING_HOST_MEMORY,
} from '../reasoner.js';
import { createEventStore, type EvidenceRecord, type IncidentRow } from '../store.js';

function incident(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: 'inc-reason-1',
    service: 'data-asset-service',
    node_id: 'test-svc-02',
    type: 'application.slow_sql',
    state: 'OPEN',
    fingerprint: JSON.stringify(['application', 'test-svc-02', 'data-asset-service', 'application.slow_sql', 'fp']),
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'warning',
    ...overrides,
  };
}

function evidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: 'evd-1',
    incidentId: 'inc-reason-1',
    nodeId: 'test-svc-02',
    source: 'host',
    kind: 'host.load',
    collectedAt: '2026-08-20T12:00:01.000Z',
    data: { load1: 0.2, cpus: 8 },
    status: 'succeeded',
    ...overrides,
  };
}

describe('FakeReasoner', () => {
  it('returns identical hypotheses for the same Incident and Evidence', () => {
    const reasoner = createFakeReasoner();
    const input = incident();
    const items = [evidence()];
    const first = reasoner.reason(input, items);
    const second = reasoner.reason(input, items);
    assert.deepEqual(first, second);
    assert.deepEqual(first.hypotheses, [HYPOTHESIS_DATABASE_INVESTIGATION]);
    assert.equal(first.confidence, 0.6);
  });

  it('changes hypothesis when CPU evidence is high', () => {
    const reasoner = createFakeReasoner();
    const input = incident();
    const normal = reasoner.reason(input, [evidence()]);
    const highCpu = reasoner.reason(input, [
      evidence({
        id: 'evd-cpu',
        source: 'docker',
        kind: 'docker.stats',
        data: { cpuPercent: 92 },
      }),
    ]);
    assert.deepEqual(normal.hypotheses, [HYPOTHESIS_DATABASE_INVESTIGATION]);
    assert.deepEqual(highCpu.hypotheses, [HYPOTHESIS_RESOURCE_SATURATION]);
    assert.notEqual(normal.hypotheses[0], highCpu.hypotheses[0]);
  });

  it('does not mutate the Incident', () => {
    const reasoner = createFakeReasoner();
    const input = incident({ state: 'OPEN', event_count: 3, severity: 'warning' });
    const before = structuredClone(input);
    reasoner.reason(input, [evidence()]);
    assert.deepEqual(input, before);
  });

  it('persists ReasoningResult separately from Incident', () => {
    const store = createEventStore(':memory:');
    const row = store.createIncident({
      service: 'data-asset-service',
      node_id: 'test-svc-02',
      type: 'application.slow_sql',
      state: 'OPEN',
      fingerprint: 'fp-reason',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'warning',
    });
    const snapshot = { ...store.getIncident(row.id)! };
    const reasoned = createFakeReasoner().reason(row, [evidence({ incidentId: row.id })]);
    store.insertReasoningResult(reasoned);
    assert.deepEqual(store.getIncident(row.id), snapshot);
    const stored = store.listReasoningResults(row.id);
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0], reasoned);
    assert.equal(store.listEvidence(row.id).length, 0);
    store.close();
  });

  it('emits missing database metrics for slow_sql without CPU pressure', () => {
    const reasoned = createFakeReasoner().reason(incident(), [
      evidence({ kind: 'host.load', data: { load1: 0.1, cpus: 8 } }),
      evidence({
        id: 'evd-mem',
        kind: 'host.memory',
        data: { total: 1000, used: 200, usagePercent: '20.00' },
      }),
    ]);
    assert.deepEqual(reasoned.missingEvidence, [MISSING_DATABASE_METRICS]);
    assert.equal(reasoned.status, 'incomplete');
    assert.deepEqual(reasoned.hypotheses, [HYPOTHESIS_DATABASE_INVESTIGATION]);
  });

  it('hypothesizes JVM memory pressure for gc_pressure with high memory', () => {
    const reasoned = createFakeReasoner().reason(
      incident({ type: 'jvm.gc_pressure' }),
      [
        evidence({
          id: 'evd-mem',
          kind: 'host.memory',
          data: { total: 1000, used: 950, usagePercent: '95.00' },
        }),
      ],
    );
    assert.deepEqual(reasoned.hypotheses, [HYPOTHESIS_JVM_MEMORY_PRESSURE]);
    assert.deepEqual(reasoned.missingEvidence, []);
    assert.equal(reasoned.status, 'complete');
    assert.equal(reasoned.confidence, 0.85);
  });

  it('requests host.memory when gc_pressure has no memory evidence', () => {
    const reasoned = createFakeReasoner().reason(
      incident({ type: 'jvm.gc_pressure' }),
      [evidence({ kind: 'docker.logs', source: 'docker', data: { lines: [] } })],
    );
    assert.deepEqual(reasoned.missingEvidence, [MISSING_HOST_MEMORY]);
    assert.equal(reasoned.status, 'incomplete');
  });
});
