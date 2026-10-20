import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { InvestigationAction, InvestigationDiagnosis } from '@pi-ops/protocol';
import { buildNotificationPayload, type NotificationPayload } from '../notification.js';
import { createWeComNotifier, TerminalNotificationError } from '../notifier.js';

// Payloads copied verbatim from the source paths recorded in this fixture.
const samples: Record<string, { source: string; payload: NotificationPayload }> = JSON.parse(
  readFileSync(new URL('./fixtures/render-actions.json', import.meta.url), 'utf8'),
);

function action(purpose: InvestigationAction['purpose'], operation: string): InvestigationAction {
  return {
    purpose, target: '本次故障服务', preconditions: ['由值班人员核对故障对象'], operation,
    expectedResult: '区分演练触发、资源限制与实际业务影响', risk: '仅检查；变更需另行审批',
    requiresApproval: false, evidenceIds: ['sample-evidence'],
  };
}

function structured(name: string): NotificationPayload {
  const payload = structuredClone(samples[name]!.payload);
  assert.ok(payload.analysis);
  const steps = payload.analysis.recommendation.split('\n').map((line) => line.replace(/^.*?\d+[).] ?/, ''));
  // Historical payloads predate diagnosis. These fields classify their original text, not new model output.
  const diagnosis: InvestigationDiagnosis = {
    observations: [{ statement: name === 'cpu' ? '05:36:37.473至05:36:38.476区间已回落至约0.009核。'
      : name === 'oom' ? '05:30:25 JVM抛出 OutOfMemoryError: Java heap space，调用栈指向Drill.exhaustHeap。'
        : '03:40:12.880Z，GET /auth/lab/server-fault 抛出 IllegalStateException，位置 LabFaultController.java:25。', evidenceIds: ['sample-evidence'] }],
    candidateCauses: [{ cause: name === 'oom' ? '高概率为Drill.exhaustHeap主动保留对象导致JVM堆空间耗尽。'
      : name === 'cpu' ? '容器内JVM出现约数秒的短时CPU突发并接近2核限制，而非持续性主机CPU饱和。'
        : '该请求命中 lab 端点后由该控制器自身抛出未捕获异常；是否为演练尚未确认。', supportingEvidenceIds: ['sample-evidence'], contradictingEvidenceIds: [] }],
    uncertainties: ['具体修复方案尚无证据确认。'],
    actions: name === 'oom' ? [
      action('evidence_collection', steps[2]!), action('verification', steps[3]!),
      { ...action('mitigation', steps[4]!), requiresApproval: true },
    ] : name === 'cpu' ? [
      action('evidence_collection', `${steps[2]}\n${steps[4]}`), action('verification', steps[3]!),
    ] : [
      action('evidence_collection', `${steps[0]}\n${steps[2]}`), action('verification', steps[5]!),
    ],
  };
  const evidenceId = payload.facts.evidenceIds[0]!;
  diagnosis.observations.forEach((item) => { item.evidenceIds = [evidenceId]; });
  diagnosis.candidateCauses.forEach((item) => { item.supportingEvidenceIds = [evidenceId]; });
  diagnosis.actions.forEach((item) => {
    item.evidenceIds = [evidenceId];
    item.target = payload.incident.service;
    if (item.purpose === 'mitigation') {
      item.expectedResult = '停止已确认的故障触发路径';
      item.risk = '暂停分配路径可能影响请求，先确认演练范围与回滚路径';
    } else if (item.purpose === 'verification') {
      item.expectedResult = '确认同一服务的业务可用性与用户影响';
    } else if (name === 'cpu') {
      item.requiresApproval = true;
      item.risk = '提高 CPU 配额会占用更多资源，仅在受控复现且批准后比较';
    }
  });
  return buildNotificationPayload({
    notificationId: payload.notificationId, type: payload.type,
    incident: { ...payload.incident, eventCount: payload.facts.eventCount },
    evidenceIds: payload.facts.evidenceIds, analysis: { ...payload.analysis, diagnosis },
  });
}

async function render(payload: NotificationPayload): Promise<string> {
  let content = '';
  await createWeComNotifier({
    webhookUrl: 'https://example.test/never-send', timeoutMs: 100, maxResponseBytes: 128,
    fetch: async (_url, init) => {
      content = JSON.parse(String(init?.body)).markdown.content;
      return new Response(JSON.stringify({ errcode: 0 }));
    },
  }).send(payload);
  assert.ok(Buffer.byteLength(content) <= 4000);
  assert.doesNotMatch(content, /对齐至的|覆盖前后|03:39:5x03:40:4x/);
  return content;
}

describe('actions reach WeCom messages', () => {
  for (const name of ['oom', 'cpu', 'dataasset']) {
    it(`keeps original ${name} actions and query times via structured diagnosis`, async () => {
      const payload = structured(name);
      const content = await render(payload);
      for (const item of payload.analysis!.diagnosis!.actions) assert.ok(content.includes(item.operation), item.operation);
      assert.match(content, /修复尚未确定/);
      if (name === 'oom') {
        assert.match(content, /需批准/);
        assert.match(content, /05:30:25/);
        assert.match(content, /结束演练并隔离告警/);
        assert.match(content, /关键下单链路探测/);
      } else if (name === 'cpu') {
        assert.match(content, /05:35:40至05:35:45/);
        assert.match(content, /已回落/);
        assert.doesNotMatch(content, /占用持续过高/);
      } else {
        assert.match(content, /03:39:5x–03:40:4x/);
        assert.match(content, /LabFaultController.java 第25行/);
      }
    });

    it(`keeps ${name} legacy query times without broken sentences`, async () => {
      const content = await render(samples[name]!.payload);
      assert.ok(content.includes(name === 'oom' ? '05:30:25' : name === 'cpu' ? '05:35:40至05:35:45' : '03:39:5x–03:40:4x'));
      if (name === 'cpu') {
        assert.match(content, /短时CPU突发/);
        assert.doesNotMatch(content, /占用持续过高/);
      }
    });
  }

  it('selects mitigation, repair and verification by purpose, not order or Chinese keywords', async () => {
    const payload = structured('oom');
    const diagnosis = payload.analysis!.diagnosis!;
    diagnosis.actions = [action('evidence_collection', '不应挤占修复。'),
      action('verification', '验证输出。'), action('repair', 'apply --at 05:30:25 --file Config.java:106'),
      { ...action('mitigation', 'stop --job drill --timeout 30'), requiresApproval: true,
        preconditions: ['05:30:25 故障仍持续；已核对 Config.java:106'], risk: '暂停订单分配；保留 -Xmx512m 和回滚命令 resume --job drill' }];
    payload.analysis!.hypothesis = '结论：这段旧文本不能代替结构化字段。';
    const content = await render(payload);
    assert.ok(content.indexOf('stop --job') < content.indexOf('apply --at'));
    assert.ok(content.indexOf('apply --at') < content.indexOf('验证输出'));
    assert.doesNotMatch(content, /不应挤占|旧文本|修复尚未确定/);
    for (const item of diagnosis.actions.slice(1)) {
      for (const value of [item.target, ...item.preconditions, item.operation, item.expectedResult, item.risk]) assert.ok(content.includes(value), value);
    }
  });

  it('drops explanations before touching complete commands, preconditions or risks', async () => {
    const payload = structured('oom');
    const diagnosis = payload.analysis!.diagnosis!;
    diagnosis.observations = [{ statement: '长解释'.repeat(600), evidenceIds: ['sample-evidence'] }];
    diagnosis.candidateCauses[0]!.cause = '长原因'.repeat(600);
    diagnosis.uncertainties = ['长未知'.repeat(300)];
    diagnosis.actions = (['mitigation', 'repair', 'verification'] as const).map((purpose) => action(
      purpose, `run --file Config.java:106 --at 05:30:25 ${'--parameter=value '.repeat(25)}`,
    ));
    const content = await render(payload);
    for (const item of diagnosis.actions) {
      for (const value of [...item.preconditions, item.operation, item.risk]) assert.ok(content.includes(value), value);
    }
  });

  it('provides a cause-discriminating check and verification when diagnosis has neither', async () => {
    const payload = structured('oom');
    payload.analysis!.diagnosis!.actions = [action('mitigation', '暂停已确认的触发任务。')];
    const content = await render(payload);
    assert.match(content, /修复尚未确定/);
    assert.match(content, /支持和反证/);
    assert.match(content, /验证：检查同一服务/);
  });

  it('rejects irreducibly oversized actions instead of sending a cut command', async () => {
    const payload = structured('oom');
    payload.analysis!.diagnosis!.actions = [action('mitigation', '执行'.repeat(1000))];
    await assert.rejects(() => render(payload), TerminalNotificationError);
  });

  for (const [type, expected] of [
    ['health.failure', /健康.*响应体|响应体.*健康/], ['jvm.oom', /-Xmx/],
    ['jvm.cpu_pressure', /cpu.stat/], ['business.error', /异常.*源码|源码.*异常/],
    ['container.oom', /-Xmx/], ['jvm.gc_pressure', /GC/], ['jvm.stack_overflow', /源码/],
    ['container.die', /退出码/], ['container.restart', /部署操作/],
    ['host.disk_pressure', /inode/], ['host.memory_pressure', /可用内存/],
    ['application.slow_sql', /执行计划/], ['unknown.fault', /日志/],
  ] as const) {
    it(`gives ${type} a deterministic first response without analysis`, async () => {
      const payload = structured('oom');
      delete payload.analysis;
      payload.type = 'INCIDENT_OPEN';
      payload.incident.type = type;
      const content = await render(payload);
      assert.match(content, /下一步/);
      assert.match(content, /修复尚未确定/);
      assert.match(content, expected);
      assert.match(content, /验证/);
    });
  }

  it('gives recovery a verification step without recommending another repair', async () => {
    const payload = structured('oom');
    delete payload.analysis;
    payload.type = 'INCIDENT_RECOVERED';
    payload.incident.state = 'RECOVERED';
    const content = await render(payload);
    assert.match(content, /下一步/);
    assert.match(content, /验证/);
    assert.doesNotMatch(content, /止损|重启|修复尚未确定/);
  });
});
