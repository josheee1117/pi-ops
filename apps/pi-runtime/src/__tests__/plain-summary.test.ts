import { it } from 'node:test';
import assert from 'node:assert/strict';
import { investigate } from '../coordinator.js';
import { investigationSummarySchema, type RuntimeInvestigationContext } from '@pi-ops/protocol';
import { createFakeRuntimeModel, type RuntimeModelRequest, type RuntimeModel } from '../model.js';

const context: RuntimeInvestigationContext = {
  schemaVersion: 1, incident: { id: 'inc-1', service: 'orders', type: 'jvm.oom' },
  evidence: [{ id: 'ev-1', kind: 'docker.logs', data: { lines: ['OutOfMemoryError'] } }],
};
it('constrains label-only inference and unconfirmed business impact in every specialist and summary prompt', async () => {
  const input: RuntimeInvestigationContext = {
    schemaVersion: 1, incident: { id: 'inc-label', service: 'orders', type: 'jvm.oom' },
    evidence: [{ id: 'ev-label', kind: 'docker.inspect', data: { Name: '/orders-local-drill' } }],
  };
  const requests: RuntimeModelRequest[] = [];
  const diagnosis = {
    summary: { scene: 'orders 容器名含 local-drill。', whatHappened: '收到内存告警，影响未确认。',
      severity: { level: '严重', reason: '服务可能不可用。' }, recovery: ['核对请求错误率和关键接口。'] },
    observations: [{ statement: '容器名含 local-drill。', evidenceIds: ['ev-label'] }],
    candidateCauses: [{ cause: '触发原因未知。', supportingEvidenceIds: ['ev-label'], contradictingEvidenceIds: [] }],
    uncertainties: ['业务影响未确认。'], actions: [{ purpose: 'evidence_collection', target: 'orders',
      preconditions: ['具备只读权限。'], operation: '核对故障窗口请求错误率、关键接口失败与用户报障。',
      expectedResult: '确认业务影响。', risk: '只读。', requiresApproval: false, evidenceIds: ['ev-label'] }],
  };
  const model: RuntimeModel = { provider: 'scripted', model: 'label-only', networkCalls: 0, async invoke(request) {
    requests.push(request);
    const common = { diagnosis, supportingEvidenceIds: ['ev-label'], contradictingEvidenceIds: [], confidence: 0.3 };
    return { text: JSON.stringify(request.system.includes('COORDINATOR_SYNTHESIS')
      ? { ...common, hypothesis: '触发原因未知，影响未确认。', recommendation: '核对请求错误率和关键接口。' }
      : { ...common, role: request.system.includes('SPECIALIST_ROLE=jvm') ? 'jvm' : 'container_host',
        hypotheses: ['触发原因未知。'], summary: '业务影响未确认。', missingEvidence: [], status: 'completed' }) };
  } };
  const result = await investigate(input, { model });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.match(request.user, /orders-local-drill/);
    assert.match(request.system, /环境标签只能作为事实陈述/);
    assert.match(request.system, /不得由名称推断.*演练.*预期行为.*故意触发/);
    assert.match(request.system, /倾向于.*更像.*可能是演练.*同样禁止/);
    assert.match(request.system, /源码或日志明确说明本次事件是故障注入.*引用出处/);
    assert.match(request.system, /没有请求错误率、关键接口失败或用户报障等直接证据.*影响未确认.*给出确认方法/);
    assert.match(request.system, /未影响业务.*未发生故障/);
    assert.match(request.system, /没看到服务不可用.*不能扩大为.*业务未受影响/);
    assert.match(request.system, /以上约束覆盖.*summary.*动作前提/);
  }
});

it('fake and degraded coordinator reports have a human summary and an evidenced mitigation for unavailable services', async () => {
  for (const type of ['jvm.oom', 'jvm.stack_overflow', 'health.failure']) {
    for (const model of [createFakeRuntimeModel(), { provider: 'scripted', model: 'broken', networkCalls: 0, async invoke() { return { text: '{"diagnosis":' }; } }]) {
      const result = await investigate({ ...context, incident: { ...context.incident, type } }, { model });
      assert.equal(result.status, 'completed', result.error);
      assert.equal(investigationSummarySchema.safeParse(result.report?.diagnosis?.summary).success, true);
      assert.equal(result.report?.diagnosis?.summary?.severity.level, '严重');
      const mitigation = result.report?.diagnosis?.actions.find((item) => item.purpose === 'mitigation');
      assert.ok(mitigation);
      assert.equal(mitigation.requiresApproval, true);
      assert.deepEqual(mitigation.evidenceIds, ['ev-1']);
    }
  }
});

it('requires summary in fresh coordinator output and supplies the rule level instead of the model level', async () => {
  const systems: string[] = [];
  const summary = { scene: '订单服务内存耗尽', whatHappened: '应用报告内存耗尽。', severity: { level: '一般', reason: '模型理由。' }, recovery: ['止损：经批准暂停触发任务。'] };
  const diagnosis = { summary, observations: [], candidateCauses: [{ cause: '根因待核对。', supportingEvidenceIds: [], contradictingEvidenceIds: [] }], uncertainties: ['缺源码。'], actions: [{ purpose: 'evidence_collection', target: 'orders', preconditions: ['只读权限'], operation: '核对异常栈', expectedResult: '确认抛出位置', risk: '只读', requiresApproval: false, evidenceIds: [] }] };
  for (const missing of [false, true]) {
    const model = { provider: 'scripted', model: 'summary', networkCalls: 0, async invoke(request: { system: string }) {
      systems.push(request.system);
      const detail = structuredClone(diagnosis);
      if (missing && request.system.includes('COORDINATOR_SYNTHESIS')) delete (detail as { summary?: unknown }).summary;
      return { text: JSON.stringify(request.system.includes('COORDINATOR_SYNTHESIS')
        ? { hypothesis: '应用报错。', recommendation: '核对源码。', confidence: 0.5, supportingEvidenceIds: [], contradictingEvidenceIds: [], diagnosis: detail }
        : { role: request.system.includes('SPECIALIST_ROLE=jvm') ? 'jvm' : 'container_host', hypotheses: ['应用报错。'], summary: '核对源码。', confidence: 0.5, supportingEvidenceIds: [], contradictingEvidenceIds: [], missingEvidence: [], status: 'completed', diagnosis: detail }) };
    } };
    const result = await investigate(context, { model });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.report?.diagnosis?.summary?.severity.level, '严重');
    assert.equal(result.report?.hypothesis.includes('诊断不完整'), missing);
  }
  assert.ok(systems.some((text) => text.includes('数字和单位必须逐字引用')));
  assert.ok(systems.some((text) => text.includes('容器内存不是应用堆内存')));
});
