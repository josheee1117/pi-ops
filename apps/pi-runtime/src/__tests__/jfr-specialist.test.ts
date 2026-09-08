import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { investigate } from '../coordinator.js';
import { createFakeRuntimeModel } from '../model.js';
import type { RuntimeInvestigationContext } from '@pi-ops/protocol';

function context(overrides: Partial<RuntimeInvestigationContext> = {}): RuntimeInvestigationContext {
  return {
    schemaVersion: 1,
    incident: { id: 'inc-1', type: 'jvm.cpu_pressure', service: 'data-asset-service' },
    evidence: [
      {
        id: 'jfr-evt-1',
        incidentId: 'inc-1',
        nodeId: 'test-svc-02',
        source: 'jfr',
        kind: 'jfr.signal',
        collectedAt: '2026-08-20T12:00:02.000Z',
        data: { attributes: { jvmUser: 0.9 } },
      },
      {
        id: 'evd-load',
        incidentId: 'inc-1',
        nodeId: 'test-svc-02',
        source: 'host',
        kind: 'host.load',
        collectedAt: '2026-08-20T12:00:02.000Z',
        data: { load1: 0.2 },
      },
    ],
    historicalKnowledgeStatus: 'available',
    historicalKnowledge: {
      similarIncidents: [],
      historicalHypotheses: [],
      previousResolutions: [],
      relatedMemories: [],
    },
    ...overrides,
  };
}

describe('JVM specialist JFR evidence', () => {
  it('cites jfr.signal from the current incident', async () => {
    const outcome = await investigate(context());
    assert.ok(outcome.report?.supportingEvidenceIds.includes('jfr-evt-1'));
  });

  it('rejects a foreign JFR Evidence id', async () => {
    const outcome = await investigate(context(), {
      model: createFakeRuntimeModel({
        specialistText: {
          jvm: JSON.stringify({
            role: 'jvm',
            hypotheses: ['foreign jfr'],
            supportingEvidenceIds: ['jfr-other-incident'],
            contradictingEvidenceIds: [],
            missingEvidence: [],
            confidence: 0.91,
            summary: 'cited foreign jfr',
            status: 'completed',
          }),
          container_host: JSON.stringify({
            role: 'container_host',
            hypotheses: ['host ok'],
            supportingEvidenceIds: ['evd-load'],
            contradictingEvidenceIds: [],
            missingEvidence: [],
            confidence: 0.5,
            summary: 'host signals',
            status: 'completed',
          }),
        },
      }),
    });
    assert.equal(outcome.specialistStatus['jvm'], 'failed');
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.report?.supportingEvidenceIds.includes('jfr-other-incident'), false);
  });
});
