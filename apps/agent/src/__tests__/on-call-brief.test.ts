import { it } from 'node:test';
import assert from 'node:assert/strict';
import { deterministicSummary } from '@pi-ops/protocol';
import { plainSummary } from '../on-call-brief.js';
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
      actions: [{ purpose: 'evidence_collection', target: 'orders', preconditions: ['只读权限'], operation: '完整原始命令', expectedResult: '确认触发分支', risk: '只读', requiresApproval: false, evidenceIds: [] }] },
  } });
  assert.deepEqual(result, summary);
  assert.doesNotMatch(JSON.stringify(result), /旧字段|完整原始命令|证据原文|候选原因原文|未知原文/);
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
