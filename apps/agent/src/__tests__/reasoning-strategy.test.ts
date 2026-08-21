import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeReasoner, HYPOTHESIS_DATABASE_INVESTIGATION } from '../reasoner.js';
import {
  createDefaultReasoningStrategies,
  createDelegatedAnalysisStrategy,
  strategyNameFor,
} from '../reasoning-strategy.js';
import type { EvidenceRecord, IncidentRow } from '../store.js';

function incident(): IncidentRow {
  return {
    id: 'inc-strategy-1',
    service: 'data-asset-service',
    node_id: 'test-svc-02',
    type: 'application.slow_sql',
    state: 'OPEN',
    fingerprint: 'fp-strategy',
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'warning',
  };
}

function evidence(): EvidenceRecord[] {
  return [{
    id: 'evd-strategy-1',
    incidentId: 'inc-strategy-1',
    nodeId: 'test-svc-02',
    source: 'host',
    kind: 'host.load',
    collectedAt: '2026-08-20T12:00:01.000Z',
    data: { load1: 0.2, cpus: 8 },
    status: 'succeeded',
  }];
}

describe('ReasoningStrategy', () => {
  it('maps fake to deterministic and pi to single_reasoner', () => {
    assert.equal(strategyNameFor('fake'), 'deterministic');
    assert.equal(strategyNameFor('pi'), 'single_reasoner');
    assert.equal(strategyNameFor('delegated_analysis'), 'delegated_analysis');
  });

  it('fails closed for an unknown strategy', () => {
    assert.throws(() => strategyNameFor('mystery-agent'), /unknown reasoning strategy/);
  });

  it('keeps FakeReasoner output unchanged through the deterministic strategy', async () => {
    const reasoner = createFakeReasoner();
    const input = { incident: incident(), evidence: evidence(), reasoner };
    const direct = reasoner.reason(input.incident, input.evidence);
    const strategy = createDefaultReasoningStrategies().get('deterministic');
    assert.ok(strategy);
    const viaStrategy = await strategy.execute(input);
    assert.deepEqual(viaStrategy, direct);
    assert.deepEqual(viaStrategy.hypotheses, [HYPOTHESIS_DATABASE_INVESTIGATION]);
  });

  it('keeps FakeReasoner output unchanged through single_reasoner', async () => {
    const reasoner = createFakeReasoner();
    const input = { incident: incident(), evidence: evidence(), reasoner };
    const direct = reasoner.reason(input.incident, input.evidence);
    const strategy = createDefaultReasoningStrategies().get('single_reasoner');
    assert.ok(strategy);
    assert.deepEqual(await strategy.execute(input), direct);
  });

  it('does not implement delegated_analysis in Pi-Ops', () => {
    assert.throws(
      () => createDelegatedAnalysisStrategy().execute({
        incident: incident(),
        evidence: evidence(),
        reasoner: createFakeReasoner(),
      }),
      /Pi Runtime/,
    );
  });
});
