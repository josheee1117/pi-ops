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
import type { RuntimeModel } from '../model.js';

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

const validFinding = (role: 'jvm' | 'database' | 'container_host' | 'application_business', ids: string[], missing: string[] = []) => JSON.stringify({
  role,
  hypotheses: [`${role} injected finding on the current incident`],
  supportingEvidenceIds: ids,
  contradictingEvidenceIds: [],
  missingEvidence: missing,
  confidence: 0.91,
  summary: `${role} used injected model output`,
  status: 'completed',
});

describe('bounded multi-agent coordinator', () => {
  it('does not select database for jvm.gc_pressure', () => {
    const selected = selectSpecialists(context({
      incident: { id: 'inc-1', type: 'jvm.gc_pressure', service: 'data-asset-service' },
      evidence: [
        { id: 'evd-now', kind: 'docker.stats' },
        { id: 'evd-2', kind: 'host.memory' },
      ],
    }));
    assert.ok(selected.length <= MAX_SPECIALISTS_PER_INVESTIGATION);
    assert.ok(selected.includes('jvm'));
    assert.equal(selected.includes('database'), false);
  });

  it('uses an injected RuntimeModel', async () => {
    const model = createFakeRuntimeModel({
      specialistText: {
        database: validFinding('database', ['evd-now']),
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

  it('returns execution timeout even when the model ignores AbortSignal', async () => {
    const model: RuntimeModel = {
      provider: 'fake',
      model: 'stuck',
      networkCalls: 0,
      async invoke() {
        return new Promise(() => undefined);
      },
    };
    const started = Date.now();
    const outcome = await investigate(context(), { model, executionTimeoutMs: 40 });
    assert.ok(Date.now() - started < 500);
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.error, 'execution timeout');
  });

  it('does not apply a late model result after timeout', async () => {
    let finished = false;
    const model: RuntimeModel = {
      provider: 'fake',
      model: 'late',
      networkCalls: 0,
      async invoke() {
        await new Promise((resolve) => setTimeout(resolve, 80));
        finished = true;
        return { text: validFinding('database', ['evd-now']), provider: 'late', model: 'late' };
      },
    };
    const outcome = await investigate(context(), { model, executionTimeoutMs: 20 });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.report, undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(outcome.status, 'failed');
    assert.equal(finished, true);
  });

  it('reruns only specialists that requested newly collected evidence', async () => {
    const model = createFakeRuntimeModel({
      specialistText: {
        database: validFinding('database', ['evd-now'], ['host.memory']),
        application_business: validFinding('application_business', ['evd-now']),
      },
    });
    const rerunRoles: string[] = [];
    const original = model.invoke.bind(model);
    model.invoke = async (request) => {
      if (request.system.includes('SPECIALIST_ROLE=database') && request.user.includes('evd-mem')) {
        rerunRoles.push('database');
        return {
          text: validFinding('database', ['evd-now', 'evd-mem']),
          provider: 'fake',
          model: 'deterministic',
        };
      }
      return original(request);
    };
    const outcome = await investigate(context(), {
      model,
      runtimeRequestId: 'rreq-1',
      runtimeTaskId: 'rtask-1',
      sessionId: 'isess-1',
      evidenceClient: {
        async request() {
          return {
            schemaVersion: 1,
            runtimeRequestId: 'rreq-1',
            results: [{
              requestId: 'ereq-isess-1-host.memory',
              type: 'host.memory',
              status: 'collected',
              evidenceId: 'evd-mem',
              evidence: { id: 'evd-mem', kind: 'host.memory' },
            }],
          };
        },
      },
    });
    assert.equal(outcome.status, 'completed');
    assert.deepEqual(rerunRoles, ['database']);
    assert.ok(outcome.report?.supportingEvidenceIds.includes('evd-mem'));
  });

  it('keeps the investigation when enrichment is unavailable', async () => {
    const model = createFakeRuntimeModel({
      specialistText: {
        database: validFinding('database', ['evd-now'], ['host.memory']),
        application_business: validFinding('application_business', ['evd-now']),
      },
    });
    const outcome = await investigate(context(), {
      model,
      runtimeRequestId: 'rreq-1',
      runtimeTaskId: 'rtask-1',
      sessionId: 'isess-1',
      evidenceClient: {
        async request() {
          throw new Error('node agent down');
        },
      },
    });
    assert.equal(outcome.status, 'completed');
    assert.deepEqual(outcome.report?.supportingEvidenceIds, ['evd-now']);
  });

  it('collects host.memory once and reruns both requesting specialists', async () => {
    const ctx = context({
      incident: { id: 'inc-1', type: 'jvm.gc_pressure', service: 'data-asset-service' },
      evidence: [{ id: 'evd-now', kind: 'docker.stats' }],
    });
    const model = createFakeRuntimeModel({
      specialistText: {
        jvm: validFinding('jvm', ['evd-now'], ['host.memory']),
        container_host: validFinding('container_host', ['evd-now'], ['host.memory']),
      },
    });
    let collections = 0;
    const rerun: string[] = [];
    const original = model.invoke.bind(model);
    model.invoke = async (request) => {
      if (request.user.includes('evd-mem')) {
        if (request.system.includes('SPECIALIST_ROLE=jvm')) rerun.push('jvm');
        if (request.system.includes('SPECIALIST_ROLE=container_host')) rerun.push('container_host');
        const role = request.system.includes('SPECIALIST_ROLE=jvm') ? 'jvm' : 'container_host';
        return { text: validFinding(role, ['evd-now', 'evd-mem']), provider: 'fake', model: 'deterministic' };
      }
      return original(request);
    };
    const outcome = await investigate(ctx, {
      model,
      runtimeRequestId: 'rreq-1',
      runtimeTaskId: 'rtask-1',
      sessionId: 'isess-1',
      evidenceClient: {
        async request(input) {
          collections += 1;
          assert.equal(input.requests.length, 1);
          assert.deepEqual(new Set(input.requests[0]?.requestingRoles), new Set(['jvm', 'container_host']));
          return {
            schemaVersion: 1,
            runtimeRequestId: 'rreq-1',
            results: [{
              requestId: 'ereq-isess-1-host.memory',
              type: 'host.memory',
              status: 'collected',
              evidenceId: 'evd-mem',
              evidence: { id: 'evd-mem', kind: 'host.memory', incidentId: 'inc-1' },
            }],
          };
        },
      },
    });
    assert.equal(outcome.status, 'completed');
    assert.equal(collections, 1);
    assert.deepEqual(new Set(rerun), new Set(['jvm', 'container_host']));
  });

  it('rejects malformed and foreign evidence responses', async () => {
    const model = createFakeRuntimeModel({
      specialistText: {
        database: validFinding('database', ['evd-now'], ['host.memory']),
        application_business: validFinding('application_business', ['evd-now']),
      },
    });
    const outcome = await investigate(context(), {
      model,
      runtimeRequestId: 'rreq-1',
      runtimeTaskId: 'rtask-1',
      sessionId: 'isess-1',
      evidenceClient: {
        async request() {
          return {
            schemaVersion: 1,
            runtimeRequestId: 'rreq-other',
            results: [{
              requestId: 'ereq-isess-1-host.memory',
              type: 'host.memory',
              status: 'collected',
              evidence: { id: 'evd-foreign', kind: 'docker.stats', incidentId: 'inc-other' },
            }],
          };
        },
      },
    });
    assert.equal(outcome.status, 'completed');
    assert.deepEqual(outcome.report?.supportingEvidenceIds, ['evd-now']);
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
