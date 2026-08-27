import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentContext } from '../incident-context.js';
import type { EvidenceRecord, IncidentRow } from '../store.js';

function incident(): IncidentRow {
  return {
    id: 'inc-fresh',
    service: 'data-asset-service',
    node_id: 'test-svc-02',
    type: 'application.slow_sql',
    state: 'OPEN',
    fingerprint: 'fp',
    first_seen: '2026-08-20T10:00:00.000Z',
    last_seen: '2026-08-20T10:30:00.000Z',
    event_count: 2,
    severity: 'warning',
  };
}

function evidence(id: string, kind: string, collectedAt: string): EvidenceRecord {
  return {
    id,
    incidentId: 'inc-fresh',
    nodeId: 'test-svc-02',
    source: 'host',
    kind,
    collectedAt,
    data: { id },
    status: 'succeeded',
  };
}

describe('incident context evidence freshness', () => {
  it('prefers newer collectedAt before id when rank is equal', () => {
    const older = evidence('evd-zzz', 'host.memory', '2026-08-20T10:00:00.000Z');
    const newer = evidence('evd-aaa', 'host.memory', '2026-08-20T10:30:00.000Z');
    const context = buildIncidentContext(incident(), [older, newer], {
      maxEvidenceItems: 1,
      maxContextBytes: 8192,
      maxLogLines: 20,
    });
    assert.deepEqual(context.evidence.map((item) => item.id), ['evd-aaa']);
    assert.equal(context.truncation?.droppedEvidenceIds[0], 'evd-zzz');
  });
});
