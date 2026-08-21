import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';
import { createPiReasoner } from '../pi-reasoner.js';
import { createPiSdkClient } from '../pi-sdk-client.js';
import type { EvidenceRecord, IncidentRow } from '../store.js';

const enabled = process.env['PI_OPS_PI_SMOKE'] === '1';

describe('PiReasoner live smoke', { skip: !enabled }, () => {
  it('returns schema-validated output from the real Pi SDK', async () => {
    const config = loadConfig();
    const reasoner = createPiReasoner({
      config,
      client: await createPiSdkClient(config),
    });
    const incident: IncidentRow = {
      id: 'inc-smoke',
      service: 'data-asset-service',
      node_id: 'test-svc-02',
      type: 'application.slow_sql',
      state: 'OPEN',
      fingerprint: 'fp-smoke',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'warning',
    };
    const evidence: EvidenceRecord[] = [{
      id: 'evd-smoke',
      incidentId: incident.id,
      nodeId: 'test-svc-02',
      source: 'host',
      kind: 'host.load',
      collectedAt: '2026-08-20T12:00:01.000Z',
      data: { load1: 0.2, cpus: 8 },
      status: 'succeeded',
    }];
    const result = await reasoner.reason(incident, evidence);
    assert.equal(result.reasonerType, 'pi');
    assert.ok(result.hypotheses[0]);
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
  });
});
