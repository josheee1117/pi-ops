import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OpsEvent } from '@pi-ops/protocol';
import { classifyEvidence } from '../evidence-intelligence.js';
import { projectJfrSignalEvidence } from '../jfr-evidence.js';

function cpuEvent(overrides: Partial<OpsEvent> = {}): OpsEvent {
  return {
    schemaVersion: 1,
    id: 'evt-cpu',
    time: '2026-08-20T12:00:00.000Z',
    source: 'jfr',
    nodeId: 'n',
    service: 'data-asset-service',
    type: 'jvm.cpu_pressure',
    severity: 'warning',
    message: 'JVM CPU pressure',
    attributes: { jvmUser: 0.9, jvmSystem: 0.1, machineTotal: 0.95, containerName: 'data-asset' },
    ...overrides,
  };
}

describe('JFR evidence weighting', () => {
  it('A. known semantic jvm.cpu_pressure is primary_signal', () => {
    const projected = projectJfrSignalEvidence({ id: 'inc-1', node_id: 'n' }, cpuEvent())!;
    assert.equal((projected.data as { semanticType: string }).semanticType, 'jvm.cpu_pressure');
    const profile = classifyEvidence(projected);
    assert.equal(profile.category, 'primary_signal');
    assert.equal(profile.reliabilityScore, 0.95);
    assert.equal(profile.diagnosticWeight, 1);
  });

  it('B. unknown JFR envelope is weak_signal', () => {
    const projected = projectJfrSignalEvidence({ id: 'inc-1', node_id: 'n' }, cpuEvent({
      id: 'evt-mystery',
      type: 'jvm.mystery_signal',
      message: 'unknown jfr',
      attributes: { heap: 99 },
    }))!;
    assert.equal((projected.data as { semanticType?: string }).semanticType, undefined);
    assert.deepEqual((projected.data as { attributes: object }).attributes, {});
    const profile = classifyEvidence(projected);
    assert.equal(profile.category, 'weak_signal');
  });

  it('C. known type with no valid semantic attributes is weak_signal', () => {
    const projected = projectJfrSignalEvidence({ id: 'inc-1', node_id: 'n' }, cpuEvent({
      id: 'evt-empty-cpu',
      attributes: { jvmUser: '0.9', jvmSystem: true, machineTotal: 2 },
    }))!;
    assert.equal((projected.data as { semanticType?: string }).semanticType, undefined);
    assert.deepEqual((projected.data as { attributes: object }).attributes, {});
    const profile = classifyEvidence(projected);
    assert.equal(profile.category, 'weak_signal');
  });
});
