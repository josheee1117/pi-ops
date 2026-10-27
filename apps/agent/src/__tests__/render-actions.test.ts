import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deterministicSummary, type InvestigationDiagnosis } from '@pi-ops/protocol';
import { buildNotificationPayload, type NotificationPayload } from '../notification.js';
import { createWeComNotifier } from '../notifier.js';

const samples: Record<string, { source: string; payload: NotificationPayload }> = JSON.parse(
  readFileSync(new URL('./fixtures/render-actions.json', import.meta.url), 'utf8'),
);

async function render(payload: NotificationPayload): Promise<string> {
  let content = '';
  await createWeComNotifier({
    webhookUrl: 'https://capture.invalid/no-network', detailsBaseUrl: 'https://ops.example', timeoutMs: 100, maxResponseBytes: 128,
    fetch: async (_url, init) => {
      content = JSON.parse(String(init?.body)).markdown.content;
      return new Response('{"errcode":0}');
    },
  }).send(payload);
  assert.ok(Buffer.byteLength(content) <= 4000);
  return content;
}

describe('short messages retain a way to read full actions', () => {
  for (const [name, sample] of Object.entries(samples)) {
    it(`renders ${name} legacy and structured diagnosis without sending full operations`, async () => {
      const payload = structuredClone(sample.payload);
      assert.ok(payload.analysis);
      const evidenceId = payload.facts.evidenceIds[0]!;
      const diagnosis: InvestigationDiagnosis = {
        summary: deterministicSummary(payload.incident),
        observations: [{ statement: '详细观测原文', evidenceIds: [evidenceId] }],
        candidateCauses: [{ cause: '详细候选原因', supportingEvidenceIds: [evidenceId], contradictingEvidenceIds: [] }],
        uncertainties: ['详细未知项'],
        actions: [{ purpose: 'mitigation', target: payload.incident.service,
          preconditions: ['人工批准，确认备用容量。'], operation: payload.analysis.recommendation,
          expectedResult: '降低影响', risk: '暂停部分请求', requiresApproval: true, evidenceIds: [evidenceId] }],
      };
      const originalOperation = diagnosis.actions[0]!.operation;
      for (const detail of [undefined, diagnosis]) {
        const input = buildNotificationPayload({ notificationId: payload.notificationId, type: payload.type,
          incident: { ...payload.incident, eventCount: payload.facts.eventCount }, evidenceIds: payload.facts.evidenceIds,
          analysis: { ...payload.analysis, ...(detail ? { diagnosis: detail } : {}) } });
        const content = await render(input);
        for (const label of ['场景：', '发生了什么：', '严重程度：', '恢复建议：', `编号：${payload.incident.id}`, '/brief?format=markdown']) assert.ok(content.includes(label), label);
        assert.doesNotMatch(content, /详细观测原文|详细候选原因|详细未知项|模型自评|前提：|风险：/);
        assert.ok(!content.includes(originalOperation));
        if (detail) assert.equal(input.analysis!.diagnosis!.actions[0]!.operation, originalOperation);
      }
    });
  }

  for (const type of ['health.failure', 'jvm.oom', 'jvm.stack_overflow', 'container.oom', 'jvm.cpu_pressure', 'business.error', 'container.die', 'container.restart', 'host.disk_pressure', 'host.memory_pressure', 'application.slow_sql', 'jvm.gc_pressure', 'unknown.fault']) {
    it(`gives ${type} a short deterministic first message`, async () => {
      const sample = structuredClone(Object.values(samples)[0]!.payload);
      const content = await render({ ...sample, type: 'INCIDENT_OPEN', analysis: undefined, incident: { ...sample.incident, type, state: 'OPEN' } });
      assert.match(content, /场景：/);
      assert.match(content, /止损：/);
      assert.match(content, /验证：/);
      assert.doesNotMatch(content, /详细诊断|模型自评/);
    });
  }

  it('shows recovery verification instead of old mitigation or repair commands', async () => {
    const sample = structuredClone(Object.values(samples)[0]!.payload);
    const content = await render({ ...sample, type: 'INCIDENT_RECOVERED', incident: { ...sample.incident, state: 'RECOVERED' } });
    assert.match(content, /已恢复/);
    assert.match(content, /验证：/);
    assert.doesNotMatch(content, /止损：|修复：|切走|重启/);
  });
});
