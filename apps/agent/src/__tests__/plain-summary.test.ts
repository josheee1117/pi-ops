import { it } from 'node:test';
import assert from 'node:assert/strict';
import { investigationSummarySchema, investigationDiagnosisSchema } from '@pi-ops/protocol';
import { plainSummary } from '../on-call-brief.js';
import { createWeComNotifier } from '../notifier.js';
import type { NotificationPayload } from '../notification.js';
import { DEFAULT_NOTIFICATION_POLICY, ruleSummarySeverity } from '../notification-config.js';

const summary: import('@pi-ops/protocol').InvestigationSummary = {
  scene: '订单服务登录请求', whatHappened: '登录请求报错，用户暂时无法登录。',
  severity: { level: '一般', reason: '模型认为影响有限。' },
  recovery: ['止损：确认备用容量后，经批准切走故障流量。', '修复：核对故障版本与接口配置。', '验证：检查登录请求能否成功。'],
};
const payload: NotificationPayload = {
  schemaVersion: 1, notificationId: 'n-1', type: 'INVESTIGATION_COMPLETED',
  incident: { id: 'inc-1', service: 'orders', nodeId: 'node-1', type: 'jvm.oom', severity: 'warning', state: 'OPEN', firstSeen: '2026-10-21T00:00:00Z', lastSeen: '2026-10-21T00:01:00Z' },
  facts: { eventCount: 1, evidenceIds: ['ev-1'] },
  analysis: { investigationSessionId: 's-1', reasoningResultId: 'r-1', hypothesis: '详细原因', recommendation: '详细命令', confidence: 0.8,
    diagnosis: { summary, observations: [{ statement: '详细证据', evidenceIds: ['ev-1'] }], candidateCauses: [{ cause: '详细候选', supportingEvidenceIds: ['ev-1'], contradictingEvidenceIds: [] }], uncertainties: ['详细未知'], actions: [{ purpose: 'evidence_collection', target: 'orders', preconditions: ['只读权限'], operation: '详细命令', expectedResult: '核对异常', risk: '只读', requiresApproval: false, evidenceIds: [] }] } },
};

it('requires every summary field and enforces individual bounds while reading legacy diagnosis', () => {
  assert.equal(investigationSummarySchema.safeParse(summary).success, true);
  for (const key of Object.keys(summary)) {
    const incomplete = { ...summary }; delete incomplete[key as keyof typeof incomplete];
    assert.equal(investigationSummarySchema.safeParse(incomplete).success, false, key);
  }
  for (const value of [{ ...summary, scene: '字'.repeat(81) }, { ...summary, whatHappened: '字'.repeat(161) }, { ...summary, severity: { level: '高', reason: '字'.repeat(81) } }, { ...summary, recovery: ['字'.repeat(101)] }, { ...summary, recovery: [] }, { ...summary, recovery: Array(4).fill('修复') }]) assert.equal(investigationSummarySchema.safeParse(value).success, false);
  const legacy = { ...payload.analysis!.diagnosis! }; delete legacy.summary;
  assert.equal(investigationDiagnosisSchema.safeParse(legacy).success, true);
});

it('rules override model severity and first, legacy, degraded and recovered messages have summaries', () => {
  assert.equal(plainSummary(payload).severity.level, '严重');
  assert.equal(plainSummary({ ...payload, summarySeverity: { level: '高', reason: '已配置的登录接口报错。' } }).severity.level, '高');
  for (const type of ['jvm.oom', 'jvm.stack_overflow', 'health.failure', 'business.error']) {
    const first = { ...payload, type: 'INCIDENT_OPEN' as const, analysis: undefined, incident: { ...payload.incident, type } };
    const brief = plainSummary(first);
    assert.ok(investigationSummarySchema.safeParse(brief).success);
    assert.match(brief.recovery[0]!, /止损/);
  }
  const recovered = plainSummary({ ...payload, type: 'INCIDENT_RECOVERED' });
  assert.match(recovered.whatHappened, /恢复/);
  assert.ok(recovered.recovery.every((step) => !/重启|切走/.test(step)));
});

it('aligns severity with notification impact categories and accepts configured rules', () => {
  const observations: import('../notification-policy.js').NotificationObservation[] = [{ kind: 'critical-operation', ruleId: 'login', workflow: '登录', operation: 'POST /login', source: { kind: 'event', id: 'evt-1' } }];
  assert.equal(ruleSummarySeverity('business.error', observations, DEFAULT_NOTIFICATION_POLICY).level, '高');
  assert.equal(ruleSummarySeverity('business.error', [], DEFAULT_NOTIFICATION_POLICY).level, '一般');
  assert.equal(ruleSummarySeverity('jvm.stack_overflow', observations, DEFAULT_NOTIFICATION_POLICY).level, '严重');
  const config = { ...DEFAULT_NOTIFICATION_POLICY, summarySeverity: { ...DEFAULT_NOTIFICATION_POLICY.summarySeverity!, unavailableTypes: ['custom.unavailable'] } };
  assert.equal(ruleSummarySeverity('custom.unavailable', [], config).level, '严重');
});

it('sends only the human summary with incident identity and an authenticated detail address', async () => {
  let content = '';
  await createWeComNotifier({ webhookUrl: 'https://capture.invalid', detailsBaseUrl: 'https://ops.example', timeoutMs: 100, maxResponseBytes: 128,
    fetch: async (_url, init) => { content = JSON.parse(String(init?.body)).markdown.content; return new Response('{"errcode":0}'); },
  }).send(payload);
  for (const label of ['场景：', '发生了什么：', '严重程度：严重', '恢复建议：', '编号：inc-1', 'https://ops.example/v1/ops/incidents/inc-1/brief?format=markdown', 'Bearer']) assert.ok(content.includes(label), label);
  assert.doesNotMatch(content, /详细证据|详细候选|详细未知|详细命令|模型自评|ev-1/);
  assert.ok(Buffer.byteLength(content) <= 4000);
});
