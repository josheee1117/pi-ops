import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVIDENCE_QUERY_TYPES,
  MAX_SPECIALISTS_PER_INVESTIGATION,
  RUNTIME_ALLOWED_EVIDENCE_TYPES,
  RUNTIME_FORBIDDEN_CAPABILITIES,
} from '@pi-ops/protocol';
import { boundInvestigationContext, jsonSize } from '../bound-context.js';
import { runtimeCapabilities } from '../capabilities.js';
import { investigate } from '../coordinator.js';
import { selectSpecialists } from '../specialists.js';
import type { RuntimeInvestigationContext } from '@pi-ops/protocol';

function context(overrides: Partial<RuntimeInvestigationContext> = {}): RuntimeInvestigationContext {
  return {
    schemaVersion: 1,
    incident: { id: 'inc-1', type: 'application.slow_sql', service: 'data-asset-service' },
    evidence: [{ id: 'evd-now', kind: 'host.load' }],
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

describe('bounded multi-agent coordinator', () => {
  it('selects at most three specialists', () => {
    const selected = selectSpecialists(context({
      incident: { id: 'inc-1', type: 'jvm.gc_pressure', service: 'data-asset-service' },
      evidence: [
        { id: 'evd-now', kind: 'docker.stats' },
        { id: 'evd-2', kind: 'host.memory' },
      ],
    }));
    assert.ok(selected.length <= MAX_SPECIALISTS_PER_INVESTIGATION);
    assert.ok(selected.includes('jvm'));
    assert.ok(selected.includes('database') || selected.includes('container_host'));
  });

  it('isolates a specialist failure', () => {
    const outcome = investigate(context(), { failRoles: ['database'] });
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.specialistStatus['database'], 'failed');
    assert.ok(Object.values(outcome.specialistStatus).includes('completed'));
    assert.ok(outcome.report);
    assert.deepEqual(outcome.report.supportingEvidenceIds, ['evd-now']);
  });

  it('fails the runtime task when every specialist fails', () => {
    const outcome = investigate(context(), {
      failRoles: ['database', 'container_host', 'application_business', 'jvm'],
    });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.report, undefined);
  });

  it('does not let historical knowledge replace current Evidence', () => {
    const outcome = investigate(context({
      historicalKnowledge: {
        similarIncidents: [{ incident: { id: 'inc-old' } }],
        historicalHypotheses: [],
        previousResolutions: [{ text: 'reboot the host' }],
        relatedMemories: [{ memory: { conclusion: 'disk full', resolution: 'reboot the host' } }],
      },
      conflictingMemories: [{ conclusion: 'disk full' }],
    }));
    assert.equal(outcome.status, 'completed');
    assert.deepEqual(outcome.report?.supportingEvidenceIds, ['evd-now']);
    assert.equal(outcome.report?.supportingEvidenceIds.includes('inc-old'), false);
    assert.match(outcome.report?.hypothesis ?? '', /current incident/);
    assert.match(outcome.report?.recommendation ?? '', /advisory/i);
    assert.match(outcome.report?.recommendation ?? '', /Evidence describes the current incident/);
  });

  it('drops evidence ids that are not on the current incident', () => {
    const outcome = investigate(context());
    assert.ok(outcome.report);
    for (const id of outcome.report.supportingEvidenceIds) {
      assert.equal(id, 'evd-now');
    }
  });

  it('keeps runtime context bounded', () => {
    const huge = context({
      historicalKnowledge: {
        similarIncidents: Array.from({ length: 40 }, (_, index) => ({ padding: 'x'.repeat(800), index })),
        historicalHypotheses: [],
        previousResolutions: [],
        relatedMemories: [],
      },
    });
    const bounded = boundInvestigationContext(huge, 4096);
    assert.ok(jsonSize(huge) > 4096);
    assert.ok(jsonSize(bounded) <= 4096);
    assert.equal(bounded.evidence[0]?.id, 'evd-now');
    const outcome = investigate(huge, { maxContextBytes: 4096 });
    assert.equal(outcome.status, 'completed');
  });

  it('exposes no shell or remediation capability', () => {
    assert.deepEqual([...runtimeCapabilities.evidenceTypes], [...EVIDENCE_QUERY_TYPES]);
    assert.deepEqual([...RUNTIME_ALLOWED_EVIDENCE_TYPES], [...EVIDENCE_QUERY_TYPES]);
    for (const forbidden of RUNTIME_FORBIDDEN_CAPABILITIES) {
      assert.equal((runtimeCapabilities.evidenceTypes as readonly string[]).includes(forbidden), false);
    }
  });
});
