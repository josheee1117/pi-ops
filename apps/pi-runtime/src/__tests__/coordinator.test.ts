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

const evidenceRow = (id: string, kind: string, incidentId = 'inc-1') => ({
  id,
  incidentId,
  nodeId: 'test-svc-02',
  source: kind.split('.')[0] ?? 'host',
  kind,
  collectedAt: '2026-08-20T12:00:02.000Z',
  data: { kind },
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
              evidence: evidenceRow('evd-mem', 'host.memory'),
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
          assert.deepEqual(input.requests[0]?.requestingRoles, ['jvm', 'container_host']);
          return {
            schemaVersion: 1,
            runtimeRequestId: 'rreq-1',
            results: [{
              requestId: 'ereq-isess-1-host.memory',
              type: 'host.memory',
              status: 'collected',
              evidenceId: 'evd-mem',
              evidence: evidenceRow('evd-mem', 'host.memory'),
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
              evidenceId: 'evd-foreign',
              evidence: evidenceRow('evd-foreign', 'docker.stats', 'inc-other'),
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

  it('reruns specialists with collected Evidence.data', async () => {
    const seen: number[] = [];
    const model = createFakeRuntimeModel({
      specialistText: {
        database: validFinding('database', ['evd-now'], ['host.memory']),
        application_business: validFinding('application_business', ['evd-now']),
      },
    });
    const original = model.invoke.bind(model);
    model.invoke = async (request) => {
      if (request.system.includes('SPECIALIST_ROLE=database')) {
        const payload = JSON.parse(request.user) as {
          evidence: Array<{ data?: { usedPercent?: number } }>;
        };
        const percent = payload.evidence.find((item) => typeof item.data?.usedPercent === 'number')?.data?.usedPercent;
        if (percent !== undefined) {
          seen.push(percent);
          return {
            text: validFinding('database', ['evd-now', 'evd-mem']),
            provider: 'fake',
            model: 'deterministic',
          };
        }
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
              evidence: {
                ...evidenceRow('evd-mem', 'host.memory'),
                data: { totalBytes: 16_000_000_000, availableBytes: 1_280_000_000, usedPercent: 92 },
              },
            }],
          };
        },
      },
    });
    assert.equal(outcome.status, 'completed');
    assert.deepEqual(seen, [92]);
  });

  it('changes the specialist finding when only Evidence.data changes', async () => {
    async function run(usedPercent: number): Promise<string> {
      let finding = '';
      const model = createFakeRuntimeModel({
        specialistText: {
          database: validFinding('database', ['evd-now'], ['host.memory']),
          application_business: validFinding('application_business', ['evd-now']),
        },
      });
      const original = model.invoke.bind(model);
      model.invoke = async (request) => {
        if (request.system.includes('SPECIALIST_ROLE=database')) {
          const payload = JSON.parse(request.user) as {
            evidence: Array<{ data?: { usedPercent?: number } }>;
          };
          const percent = payload.evidence.find((item) => typeof item.data?.usedPercent === 'number')?.data?.usedPercent;
          if (percent !== undefined) {
            finding = percent > 90 ? 'memory-pressure' : 'not-memory';
            return {
              text: JSON.stringify({
                role: 'database',
                hypotheses: [finding],
                supportingEvidenceIds: ['evd-now', 'evd-mem'],
                contradictingEvidenceIds: [],
                missingEvidence: [],
                confidence: percent > 90 ? 0.91 : 0.41,
                summary: finding,
                status: 'completed',
              }),
              provider: 'fake',
              model: 'deterministic',
            };
          }
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
                evidence: {
                  ...evidenceRow('evd-mem', 'host.memory'),
                  data: { usedPercent },
                },
              }],
            };
          },
        },
      });
      assert.equal(outcome.status, 'completed');
      return finding;
    }
    assert.equal(await run(92), 'memory-pressure');
    assert.equal(await run(20), 'not-memory');
  });

  it('fails closed when newly collected Evidence exceeds the context bound', async () => {
    const model = createFakeRuntimeModel({
      specialistText: {
        database: validFinding('database', ['evd-now'], ['host.memory']),
        application_business: validFinding('application_business', ['evd-now']),
      },
    });
    const outcome = await investigate(context(), {
      model,
      maxContextBytes: 2048,
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
              evidence: {
                ...evidenceRow('evd-mem', 'host.memory'),
                data: { blob: 'x'.repeat(20_000) },
              },
            }],
          };
        },
      },
    });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.error, 'context_too_large');
  });

  it('does not let stale same-kind Evidence suppress a fresh request', async () => {
    const model = createFakeRuntimeModel({
      specialistText: {
        database: validFinding('database', ['evd-now', 'incident-inc-1-evidence-host.memory'], ['host.memory']),
        application_business: validFinding('application_business', ['evd-now']),
      },
    });
    let requested: string[] = [];
    const outcome = await investigate(context({
      evidence: [
        { id: 'evd-now', kind: 'host.load' },
        { id: 'incident-inc-1-evidence-host.memory', kind: 'host.memory' },
      ],
    }), {
      model,
      runtimeRequestId: 'rreq-1',
      runtimeTaskId: 'rtask-1',
      sessionId: 'isess-1',
      evidenceClient: {
        async request(input) {
          requested = input.requests.map((item) => item.type);
          assert.deepEqual(input.requests[0]?.requestingRoles, ['database']);
          return {
            schemaVersion: 1,
            runtimeRequestId: 'rreq-1',
            results: [{
              requestId: 'ereq-isess-1-host.memory',
              type: 'host.memory',
              status: 'collected',
              evidenceId: 'inv-isess-1-evidence-host.memory',
              evidence: evidenceRow('inv-isess-1-evidence-host.memory', 'host.memory'),
            }],
          };
        },
      },
    });
    assert.deepEqual(requested, ['host.memory']);
    assert.equal(outcome.status, 'completed');
  });

  it('strips duplicate historical fields so factsOnly is facts only', () => {
    const bounded = boundInvestigationContext(context({
      relatedMemories: [{ id: 'legacy' }],
      previousResolutions: ['legacy resolution'],
      historicalResolutions: ['supported hypothesis'],
      similarHypotheses: [{ statement: 'supported hypothesis' }],
      relatedIncidents: [{ incident: { id: 'inc-old' } }],
    } as unknown as Partial<RuntimeInvestigationContext>));
    assert.equal('relatedMemories' in bounded, false);
    assert.equal('previousResolutions' in bounded, false);
    assert.equal('historicalResolutions' in bounded, false);
    assert.equal('similarHypotheses' in bounded, false);
    assert.equal('relatedIncidents' in bounded, false);
    assert.ok(bounded.incident);
    assert.ok(bounded.evidence);
  });

  it('exposes no shell or remediation capability', () => {
    for (const type of runtimeCapabilities.evidenceTypes) {
      assert.ok((EVIDENCE_QUERY_TYPES as readonly string[]).includes(type));
    }
    assert.equal((RUNTIME_ALLOWED_EVIDENCE_TYPES as readonly string[]).includes('host.disk'), false);
    for (const forbidden of RUNTIME_FORBIDDEN_CAPABILITIES) {
      assert.equal((runtimeCapabilities.evidenceTypes as readonly string[]).includes(forbidden), false);
    }
  });
});
