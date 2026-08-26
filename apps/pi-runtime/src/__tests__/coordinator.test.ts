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
import { createFakeRuntimeModel } from '../model.js';
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

const validFinding = (role: 'jvm' | 'database' | 'container_host' | 'application_business', ids: string[]) => JSON.stringify({
  role,
  hypotheses: [`${role} injected finding on the current incident`],
  supportingEvidenceIds: ids,
  contradictingEvidenceIds: [],
  missingEvidence: [],
  confidence: 0.91,
  summary: `${role} used injected model output`,
  status: 'completed',
});

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

  it('uses an injected RuntimeModel', async () => {
    const model = createFakeRuntimeModel({
      specialistText: {
        database: validFinding('database', ['evd-now']),
        container_host: validFinding('container_host', ['evd-now']),
        application_business: validFinding('application_business', ['evd-now']),
      },
    });
    const outcome = await investigate(context(), { model });
    assert.equal(outcome.status, 'completed');
    assert.match(outcome.report?.hypothesis ?? '', /injected finding/);
    assert.ok(model.invocations > 0);
    assert.equal(model.networkCalls, 0);
  });

  it('isolates a specialist failure', async () => {
    const outcome = await investigate(context(), { failRoles: ['database'] });
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.specialistStatus['database'], 'failed');
    assert.ok(Object.values(outcome.specialistStatus).includes('completed'));
    assert.ok(outcome.report);
    assert.deepEqual(outcome.report.supportingEvidenceIds, ['evd-now']);
  });

  it('fails only the specialist with invalid structured output', async () => {
    const model = createFakeRuntimeModel({
      specialistText: {
        database: 'not-json',
      },
    });
    const outcome = await investigate(context(), { model });
    assert.equal(outcome.specialistStatus['database'], 'failed');
    assert.equal(outcome.status, 'completed');
  });

  it('rejects specialist evidence that does not belong to the current incident', async () => {
    const model = createFakeRuntimeModel({
      specialistText: {
        database: validFinding('database', ['evd-foreign']),
        container_host: validFinding('container_host', ['evd-now']),
        application_business: validFinding('application_business', ['evd-now']),
      },
    });
    const outcome = await investigate(context(), { model });
    assert.equal(outcome.specialistStatus['database'], 'failed');
    assert.equal(outcome.status, 'completed');
    assert.deepEqual(outcome.report?.supportingEvidenceIds, ['evd-now']);
  });

  it('fails the runtime task when every specialist fails', async () => {
    const outcome = await investigate(context(), {
      failRoles: ['database', 'container_host', 'application_business', 'jvm'],
    });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.report, undefined);
  });

  it('does not let historical knowledge replace current Evidence', async () => {
    const outcome = await investigate(context({
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

  it('keeps runtime context bounded', async () => {
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
    const outcome = await investigate(huge, { maxContextBytes: 4096 });
    assert.equal(outcome.status, 'completed');
  });

  it('fails explicitly when current Evidence alone exceeds the context limit', async () => {
    const oversized = context({
      evidence: [{ id: 'evd-now', kind: 'host.load', blob: 'x'.repeat(20_000) }],
    });
    const outcome = await investigate(oversized, { maxContextBytes: 4096 });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.error, 'context_too_large');
  });

  it('aborts when execution times out', async () => {
    const model = createFakeRuntimeModel({ delayMs: 40 });
    const outcome = await investigate(context(), { model, executionTimeoutMs: 5 });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.error, 'execution timeout');
  });

  it('performs zero external model calls in the fake CI runtime', async () => {
    const model = createFakeRuntimeModel();
    const outcome = await investigate(context(), { model });
    assert.equal(outcome.status, 'completed');
    assert.equal(model.networkCalls, 0);
    assert.equal(outcome.provider, 'fake');
    assert.equal(outcome.model, 'deterministic');
  });

  it('exposes no shell or remediation capability', () => {
    assert.deepEqual([...runtimeCapabilities.evidenceTypes], [...EVIDENCE_QUERY_TYPES]);
    assert.deepEqual([...RUNTIME_ALLOWED_EVIDENCE_TYPES], [...EVIDENCE_QUERY_TYPES]);
    for (const forbidden of RUNTIME_FORBIDDEN_CAPABILITIES) {
      assert.equal((runtimeCapabilities.evidenceTypes as readonly string[]).includes(forbidden), false);
    }
  });
});
