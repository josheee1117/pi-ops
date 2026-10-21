import { it } from 'node:test';
import assert from 'node:assert/strict';
import { investigate } from '../coordinator.js';
import type { RuntimeModel } from '../model.js';
import type { RuntimeInvestigationContext } from '@pi-ops/protocol';

const context: RuntimeInvestigationContext = {
  schemaVersion: 1, incident: { id: 'inc-output', service: 'orders', type: 'business.error' },
  evidence: [{ id: 'ev-log', kind: 'docker.logs', data: { lines: ['java.lang.IllegalStateException at Orders.java:9'] } }],
};
const diagnosis = {
  observations: [{ statement: '日志有异常。', evidenceIds: ['ev-log'] }],
  candidateCauses: [{ cause: '触发逻辑未知。', supportingEvidenceIds: ['ev-log'], contradictingEvidenceIds: [] }],
  uncertainties: ['缺少源码。'], actions: [{
    purpose: 'evidence_collection', target: 'Orders.java:9', preconditions: ['确认对应部署版本。'],
    operation: '核对第9行与调用方，若主动抛错则检查条件，否则补完整cause。', expectedResult: '明确触发分支。',
    risk: '只读。', requiresApproval: false, evidenceIds: ['ev-log'],
  }],
};
function valid(system: string) {
  const common = { diagnosis, supportingEvidenceIds: ['ev-log'], contradictingEvidenceIds: [], confidence: 0.5 };
  return JSON.stringify(system.includes('COORDINATOR_SYNTHESIS')
    ? { ...common, hypothesis: '日志有异常，根因未知。', recommendation: '核对 Orders.java:9。' }
    : { ...common, role: 'application_business', hypotheses: ['日志有异常，根因未知。'], summary: '核对源码。', missingEvidence: [], status: 'completed' });
}

it('retries truncated output once with shorter instructions and preserves a valid diagnosis', async () => {
  const systems: string[] = [];
  const model: RuntimeModel = { provider: 'scripted', model: 'output', networkCalls: 0, async invoke(request) {
    systems.push(request.system);
    return { text: systems.length === 1 ? '{"diagnosis":' : valid(request.system), inputTokens: 10, outputTokens: 20 };
  } };
  const result = await investigate(context, { model });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(result.report?.diagnosis);
  assert.equal(systems.length, 3);
  assert.match(systems[1]!, /更短/);
  assert.equal(result.inputTokens, 30);
});

it('still generates a labeled legacy report when both attempts return truncated JSON', async () => {
  let calls = 0;
  const model: RuntimeModel = { provider: 'scripted', model: 'output', networkCalls: 0, async invoke() {
    calls++;
    return { text: '{"hypothesis":"已观测到异常，触发条件未知。","recommendation":"核对 Orders.java:9。","diagnosis":', inputTokens: 10, outputTokens: 20 };
  } };
  const result = await investigate(context, { model });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.report?.diagnosis, undefined);
  assert.match(result.report?.hypothesis ?? '', /诊断不完整/);
  assert.match(result.report?.recommendation ?? '', /Orders.java:9/);
  assert.equal(calls, 2);
});

it('keeps a labeled legacy report when coordinator truncates twice after a valid specialist', async () => {
  let calls = 0;
  const model: RuntimeModel = { provider: 'scripted', model: 'output', networkCalls: 0, async invoke(request) {
    calls++;
    return { text: request.system.includes('COORDINATOR_SYNTHESIS') ? '{"diagnosis":' : valid(request.system), inputTokens: 10, outputTokens: 20 };
  } };
  const result = await investigate(context, { model });
  assert.equal(result.status, 'completed');
  assert.equal(calls, 3);
  assert.equal(result.report?.diagnosis, undefined);
  assert.match(result.report?.hypothesis ?? '', /诊断不完整.*日志有异常/);
  assert.equal(result.inputTokens, 30);
});

it('does not use length-terminated JSON as a complete diagnosis even if it parses', async () => {
  let calls = 0;
  const model: RuntimeModel = { provider: 'scripted', model: 'output', networkCalls: 0, async invoke(request) {
    calls++;
    return { text: valid(request.system), stopReason: 'length' };
  } };
  const result = await investigate(context, { model });
  assert.equal(calls, 2);
  assert.equal(result.status, 'completed');
  assert.equal(result.report?.diagnosis, undefined);
  assert.match(result.report?.hypothesis ?? '', /诊断不完整/);
});

it('retries schema-oversized output then degrades, while valid output needs no retry', async () => {
  for (const oversized of [false, true]) {
    let calls = 0;
    const model: RuntimeModel = { provider: 'scripted', model: 'output', networkCalls: 0, async invoke(request) {
      calls++;
      return { text: oversized ? JSON.stringify({ hypothesis: 'x'.repeat(3000), recommendation: '核对日志。' }) : valid(request.system) };
    } };
    const result = await investigate(context, { model });
    assert.equal(result.status, 'completed', result.error);
    if (oversized) {
      assert.match(result.report?.hypothesis ?? '', /诊断不完整/);
      assert.equal(result.report?.diagnosis, undefined);
    } else {
      assert.equal(calls, 2);
      assert.deepEqual(result.report?.diagnosis, diagnosis);
    }
  }
});
