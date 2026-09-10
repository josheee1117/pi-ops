import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OpsEvent, Evidence } from '@pi-ops/protocol';
import { classifyEvidence } from '../evidence-intelligence.js';
import { projectJfrSignalEvidence, recognizedJfrSemantic } from '../jfr-evidence.js';

function cpuEvent(attributes: Record<string, unknown>, overrides: Partial<OpsEvent> = {}): OpsEvent {
  return {
    schemaVersion: 1,
    id: 'evt-weight',
    time: '2026-08-20T12:00:00.000Z',
    source: 'jfr',
    nodeId: 'test-svc-02',
    service: 'data-asset-service',
    type: 'jvm.cpu_pressure',
    severity: 'warning',
    message: 'JVM CPU pressure',
    attributes,
    ...overrides,
  };
}

function classifyData(data: unknown) {
  const evidence = {
    id: 'jfr-evt-weight',
    incidentId: 'inc-1',
    nodeId: 'test-svc-02',
    source: 'jfr',
    kind: 'jfr.signal',
    collectedAt: '2026-08-20T12:00:00.000Z',
    status: 'succeeded',
    data,
  } satisfies Evidence;
  return classifyEvidence(evidence);
}

function project(attributes: Record<string, unknown>, overrides: Partial<OpsEvent> = {}) {
  return projectJfrSignalEvidence(
    { id: 'inc-1', node_id: 'test-svc-02' },
    cpuEvent(attributes, overrides),
  )!;
}

describe('JFR semantic recognition regression', () => {
  it('A. a valid jvmUser diagnostic metric is primary_signal', () => {
    const projected = project({ jvmUser: 0.9 });
    assert.equal((projected.data as { semanticType?: string }).semanticType, 'jvm.cpu_pressure');
    assert.equal(recognizedJfrSemantic(projected.data), true);
    const profile = classifyEvidence(projected);
    assert.equal(profile.category, 'primary_signal');
    assert.equal(profile.reliabilityScore, 0.95);
    assert.equal(profile.diagnosticWeight, 1);
  });

  it('B. invalid metrics with a valid containerName stay weak_signal', () => {
    const projected = project({
      jvmUser: '0.9',
      jvmSystem: true,
      machineTotal: 2,
      containerName: 'data-asset',
    });
    const data = projected.data as { semanticType?: string; attributes: Record<string, unknown> };
    assert.equal(data.semanticType, undefined);
    assert.equal(data.attributes.containerName, 'data-asset');
    assert.equal(recognizedJfrSemantic(projected.data), false);
    assert.equal(classifyEvidence(projected).category, 'weak_signal');
  });

  it('C. a fabricated semanticType with unrelated attributes stays weak_signal', () => {
    const data = { semanticType: 'jvm.mystery', attributes: { foo: 1 } };
    assert.equal(recognizedJfrSemantic(data), false);
    assert.equal(classifyData(data).category, 'weak_signal');
  });

  it('D. jvm.cpu_pressure with only containerName stays weak_signal', () => {
    const data = { semanticType: 'jvm.cpu_pressure', attributes: { containerName: 'app' } };
    assert.equal(recognizedJfrSemantic(data), false);
    assert.equal(classifyData(data).category, 'weak_signal');
    const projected = project({ containerName: 'app' });
    assert.equal((projected.data as { semanticType?: string }).semanticType, undefined);
    assert.equal(classifyEvidence(projected).category, 'weak_signal');
  });

  it('E. machineTotal plus containerName is still primary_signal', () => {
    const projected = project({ machineTotal: 0.95, containerName: 'app' });
    assert.equal((projected.data as { semanticType?: string }).semanticType, 'jvm.cpu_pressure');
    assert.equal(recognizedJfrSemantic(projected.data), true);
    assert.equal(classifyEvidence(projected).category, 'primary_signal');
  });

  it('F. recognizedJfrSemantic survives malformed input without throwing', () => {
    for (const value of [null, undefined, 0, 'x', [], {}, { semanticType: 'jvm.cpu_pressure' }, { attributes: {} }]) {
      assert.equal(recognizedJfrSemantic(value), false);
    }
    assert.equal(recognizedJfrSemantic({ semanticType: 'jvm.cpu_pressure', attributes: { jvmUser: 1.5 } }), false);
    assert.equal(recognizedJfrSemantic({ semanticType: 'jvm.cpu_pressure', attributes: { jvmUser: 0 } }), true);
  });
});
