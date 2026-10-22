import { it } from 'node:test';
import assert from 'node:assert/strict';
import { deterministicSummary } from '@pi-ops/protocol';
import { plainSummary } from '../on-call-brief.js';
import { formatWeComMarkdown } from '../notifier.js';
import type { NotificationPayload } from '../notification.js';

const notification: NotificationPayload = {
  schemaVersion: 1, notificationId: 'n-1', type: 'INVESTIGATION_COMPLETED',
  incident: { id: 'inc-1', service: 'orders', nodeId: 'node-1', type: 'business.error', state: 'OPEN', severity: 'error', firstSeen: '2026-10-21T00:00:00Z', lastSeen: '2026-10-21T00:00:00Z' },
  facts: { eventCount: 1, evidenceIds: ['ev-1'] },
};

it('uses the coordinator summary instead of parsing old prose or sending the full diagnosis', () => {
  const summary = { ...deterministicSummary(notification.incident), scene: '订单服务登录请求', whatHappened: '登录接口返回错误，触发分支待核对。' };
  const result = plainSummary({ ...notification, analysis: {
    investigationSessionId: 's-1', reasoningResultId: 'r-1', hypothesis: '旧字段不能盖掉摘要。', recommendation: '完整原始命令', confidence: 0.8,
    diagnosis: { summary, observations: [{ statement: '证据原文', evidenceIds: ['ev-1'] }],
      candidateCauses: [{ cause: '候选原因原文', supportingEvidenceIds: ['ev-1'], contradictingEvidenceIds: [] }], uncertainties: ['未知原文'],
      actions: [{ purpose: 'repair', target: 'orders', preconditions: ['已确认源码缺陷'], operation: '完整原始命令', expectedResult: '缺陷消除', risk: '发布需回滚', requiresApproval: true, evidenceIds: ['ev-1'] }] },
  } });
  assert.deepEqual(result, summary);
  assert.doesNotMatch(JSON.stringify(result), /旧字段|完整原始命令|证据原文|候选原因原文|未知原文/);
});

it('renders an honest bounded next step when evidence is insufficient without inventing a repair', () => {
  const next = '核对当前生效路由与同部署版本接口契约，区分路径错误和请求到达错误实例。';
  const payload: NotificationPayload = { ...notification, analysis: {
    investigationSessionId: 's-1', reasoningResultId: 'r-1', hypothesis: '请求返回404，原因未知。', recommendation: '先补证。', confidence: 0.4,
    diagnosis: { summary: { ...deterministicSummary(notification.incident), recovery: ['经批准隔离持续失败的请求。', '核对路由。', '验证关键业务请求。'] },
      observations: [{ statement: '请求返回404。', evidenceIds: ['ev-1'] }],
      candidateCauses: [{ cause: '路由或目标实例待核实。', supportingEvidenceIds: ['ev-1'], contradictingEvidenceIds: [] }],
      uncertainties: ['缺少路由与部署契约。'], actions: [{ purpose: 'evidence_collection', target: 'orders',
        preconditions: ['只读权限'], operation: next, expectedResult: '确定修复方向。', risk: '只读', requiresApproval: false, evidenceIds: [] }] },
  } };
  const original = structuredClone(payload);
  const result = plainSummary(payload);
  assert.match(formatWeComMarkdown(payload), /修复尚未确定/);
  assert.ok(result.recovery.includes('修复尚未确定：先核对orders，按详情补证动作及其前提采证后确定修复方向。'));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(next));
  assert.equal(result.recovery[0], '经批准隔离持续失败的请求。');
  assert.equal(result.recovery[2], '验证关键业务请求。');
  assert.equal(result.recovery.length, 3);
  assert.deepEqual(payload, original);
  const diagnosis = payload.analysis!.diagnosis!;
  diagnosis.actions[0]!.target = '核对路由与部署契约。'.repeat(30);
  assert.ok(plainSummary(payload).recovery.every((line) => line.length <= 100));
  diagnosis.summary!.recovery[1] = '修复尚未确定：先核对部署契约。';
  assert.deepEqual(plainSummary(payload).recovery, diagnosis.summary!.recovery);
  assert.doesNotMatch(plainSummary({ ...payload, type: 'INCIDENT_RECOVERED' }).recovery.join(''), /修复尚未确定/);
  diagnosis.actions = [];
  diagnosis.summary!.recovery = ['核对当前影响。'];
  assert.match(plainSummary(payload).recovery.join(''), /修复尚未确定：.*源码.*配置.*契约/);
});

it('uses deterministic copy for old, incomplete and manual-confirmation reports', () => {
  for (const hypothesis of ['旧格式长诊断'.repeat(200), '诊断不完整：模型输出截断。']) {
    const result = plainSummary({ ...notification, analysis: { investigationSessionId: 's-1', reasoningResultId: 'r-1', hypothesis, recommendation: '旧格式长建议'.repeat(200), confidence: 0.3 } });
    assert.match(result.whatHappened, /接口出现未处理异常/);
    assert.doesNotMatch(JSON.stringify(result), /旧格式长/);
    if (hypothesis.startsWith('诊断不完整')) assert.match(result.whatHappened, /诊断不完整/);
  }
  assert.match(plainSummary({ ...notification, notice: 'manual-confirmation' }).whatHappened, /需要人工确认/);
});
