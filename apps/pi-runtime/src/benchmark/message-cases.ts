import { readFileSync } from 'node:fs';
import { validateEvidence } from '@pi-ops/protocol';
import type { BenchmarkCase, BenchmarkEvidence } from './fixtures.js';

export interface RawIncident {
  id: string;
  service: string;
  node_id: string;
  type: string;
  state: 'OPEN';
  fingerprint: string;
  first_seen: string;
  last_seen: string;
  event_count: number;
  severity: string;
}

export interface MessageOracle {
  expectedFacts: string[];
  allowedRepairs: string[];
  forbiddenAttributions: string[];
  forbiddenClaimPatterns: string[];
}

interface RecordedIncident {
  id: string;
  source: string;
  sha256: string;
  incident: RawIncident;
  initial: BenchmarkEvidence[];
  supplemental: BenchmarkEvidence[];
}

const expectations: Record<string, MessageOracle> = {
  'dataasset-197': {
    expectedFacts: ['原始日志 197 行，第 133 行有故障头', 'IllegalStateException，LabFaultController.java:25，GET /auth/lab/server-fault'],
    allowedRepairs: ['核实演练入口和源码后停止或隔离注入；验证同一接口及关键业务'],
    forbiddenAttributions: ['把 RocketMQ 初始化栈当成本次请求根因', '断言数据库、库存或外部依赖故障'],
    forbiddenClaimPatterns: ['(?:确认|确定|根因是|由于)RocketMQ(?:故障|异常|不可用)', '(?:确认|根因是)库存不足'],
  },
  'jvm-heap-oom': {
    expectedFacts: ['Java heap space，Drill.exhaustHeap', 'OOMKilled=false 不排除 JVM 堆 OOM', '后续日志写明 retained memory released，但业务恢复未知'],
    allowedRepairs: ['核实后停止分配或结束演练', '查实堆参数和引用链后决定修复；验证健康及关键请求'],
    forbiddenAttributions: ['断言容器被 OOM kill', '声称已知 Xmx 或已恢复业务'],
    forbiddenClaimPatterns: ['(?:确认|已被|发生了)容器OOM\s*kill', '(?:业务|服务)已完全恢复'],
  },
  'cpu-quota-burst': {
    expectedFacts: ['机器 10 核，容器配额 2 核', '故障期约 1.91 核，事后采样回落', '热点、throttling、业务影响未知'],
    allowedRepairs: ['按业务影响条件暂停高负载触发源', '经热点或配额对照后决定代码优化或调配额；验证延迟和错误率'],
    forbiddenAttributions: ['把机器归一化 ratio 当成配额利用率', '断言持续整机饱和或已知热点'],
    forbiddenClaimPatterns: ['(?:确认|确定|根因是)整机CPU(?:爆满|饱和)', '容器配额利用率(?:为|仅为)19'],
  },
};

function recorded(id: string): BenchmarkCase {
  const sample: RecordedIncident = JSON.parse(readFileSync(new URL(`fixtures/${id}.json`, import.meta.url), 'utf8'));
  for (const item of [...sample.initial, ...sample.supplemental]) {
    const parsed = validateEvidence(item);
    if (!parsed.success) throw new Error(`${id}: ${parsed.message}`);
    if (item.incidentId !== sample.incident.id) throw new Error(`${id}: foreign evidence`);
  }
  const oracle = expectations[id];
  if (!oracle) throw new Error(`missing expectations: ${id}`);
  return {
    id, description: oracle.expectedFacts.join('；'),
    incidentId: sample.incident.id, service: sample.incident.service,
    nodeId: sample.incident.node_id, collectedAt: sample.incident.last_seen,
    evidence: sample.initial, rawIncident: sample.incident,
    supplementalEvidence: sample.supplemental,
    provenance: `${sample.source} sha256=${sample.sha256}`,
    messageOracle: oracle,
    oracle: {
      mustCiteKinds: ['jfr.signal'], expectedSupportingKinds: [], expectedContradictingKinds: [],
      forbiddenEvidenceKinds: [], expectConflict: false, expectInsufficientEvidence: false,
      expectedDirection: oracle.allowedRepairs.join('；'),
    },
  };
}

function excerpt(input: {
  id: string; type: string; at: string; source: string; lines: string[];
  signal?: Record<string, string>; probe?: Record<string, unknown>; oracle: MessageOracle;
}): BenchmarkCase {
  const incident: RawIncident = {
    id: `inc-${input.id}`, service: 'data-asset-service', node_id: 'test-svc-02', type: input.type,
    state: 'OPEN', fingerprint: input.id, first_seen: input.at, last_seen: input.at,
    event_count: 1, severity: input.type.startsWith('jvm.') ? 'critical' : 'error',
  };
  const evidence: BenchmarkEvidence[] = [];
  const add = (kind: string, data: unknown) => evidence.push({
    id: `evd-${input.id}-${kind}`, incidentId: incident.id, nodeId: incident.node_id,
    source: kind.split('.')[0]!, kind, collectedAt: input.at, status: 'succeeded', data,
  });
  if (input.signal) add('jfr.signal', {
    eventId: `evt-${input.id}`, eventType: input.type, semanticType: input.type,
    observedAt: input.at, message: 'Unhandled request exception', attributes: input.signal,
  });
  if (input.lines.length) add('docker.logs', { lines: input.lines, truncated: true });
  if (input.probe) add('http.probe', input.probe);
  return {
    id: input.id, description: input.oracle.expectedFacts.join('；'),
    incidentId: incident.id, service: incident.service, nodeId: incident.node_id, collectedAt: input.at,
    evidence, rawIncident: incident, supplementalEvidence: [], provenance: input.source,
    messageOracle: input.oracle,
    oracle: {
      mustCiteKinds: [input.probe ? 'http.probe' : input.signal ? 'jfr.signal' : 'docker.logs'],
      expectedSupportingKinds: [], expectedContradictingKinds: [], forbiddenEvidenceKinds: [],
      expectConflict: false, expectInsufficientEvidence: false,
      expectedDirection: input.oracle.allowedRepairs.join('；'),
    },
  };
}

export const MESSAGE_CASES: BenchmarkCase[] = [
  ...['dataasset-197', 'jvm-heap-oom', 'cpu-quota-burst'].map(recorded),
  excerpt({
    id: 'tag-group-502', type: 'business.error', at: '2026-10-20T01:21:43.948Z',
    source: 'apps/agent/src/__tests__/on-call-brief.test.ts tagGroup。仅重建已观测字段，不把旧诊断作为输入；无原始完整日志。',
    signal: { exceptionClass: 'java.lang.RuntimeException', operation: 'POST /api/v1/tag/admin/tag-group/page', exceptionStackTrace: 'at com.mbkj.dap.tag.impl.TagAdminBizServiceImpl.pageTagGroup(TagAdminBizServiceImpl.java:106)' },
    lines: ['2026-10-20T01:21:43.948Z java.lang.RuntimeException', 'Caused by: java.lang.RuntimeException', 'at com.mbkj.dap.tag.impl.TagAdminBizServiceImpl.pageTagGroup(TagAdminBizServiceImpl.java:106)', '2026-10-20T01:21:43.949Z POST /api/v1/tag/admin/tag-group/page deptId=5,current=1,size=10 code=502 msg=系统异常 success=false elapsed=25ms'],
    oracle: {
      expectedFacts: ['pageTagGroup:106 抛出 RuntimeException', '业务响应 code=502，不等价于 HTTP 网关 502', '底层 cause、持续性和影响未知'],
      allowedRepairs: ['读对应版本第 106 行及 cause，按实际分支修复；人工受控复现相同请求'],
      forbiddenAttributions: ['凭异常断言库存、SQL、依赖或网关故障', '伪造源码逻辑或配置值'],
      forbiddenClaimPatterns: ['(?:确认|根因是|由于)库存(?:不足|校验)', '(?:确认|根因是)数据库故障', '(?:确认|根因是)网关故障'],
    },
  }),
  excerpt({
    id: 'sop-404', type: 'business.error', at: '2026-10-20T01:56:02.045Z',
    source: 'apps/agent/src/__tests__/on-call-brief.test.ts sopUrl。仅重建已观测字段；无原始完整日志。',
    signal: { exceptionClass: 'feign.FeignException$NotFound', operation: 'GET /api/v1/sop/yesterday-publish', exceptionStackTrace: 'at SopController.getSysPublishYesterday(SopController.java:50)\nat SopBizServiceImpl.getSysPublishYesterday(SopBizServiceImpl.java:34)' },
    lines: ['2026-10-20T01:56:02.034Z SopController sysType=10', 'Feign Request: [SopFeignClient#getSysPublishYesterday(SysPublishReqDto)] - Method: POST - URL: https://proxy-test.meibaokeji.com/open/api/lx/findPublishYesterday Body: {"sysType":10}', 'feign.FeignException$NotFound: [404] during [POST] to [https://proxy-test.meibaokeji.com/open/api/lx/findPublishYesterday]', 'at SopBizServiceImpl.getSysPublishYesterday(SopBizServiceImpl.java:34)'],
    oracle: {
      expectedFacts: ['入站 GET，出站 POST，sysType=10', 'Feign 收到 404，但来源和正确路由未知'],
      allowedRepairs: ['核对 Feign 配置、路由和接口契约，查实后再修正；相同 POST 人工受控复现'],
      forbiddenAttributions: ['断言下游整体宕机、业务数据不存在', '猜测正确 URL 或让 http.probe 执行业务 POST'],
      forbiddenClaimPatterns: ['(?:确认|根因是|由于)下游(?:宕机|整体故障)', '(?:确认|根因是)业务数据不存在'],
    },
  }),
  excerpt({
    id: 'health-503', type: 'health.failure', at: '2026-10-20T02:00:00.000Z',
    source: 'apps/agent/src/__tests__/notification-stored-facts.check.ts health 503；apps/node-agent/src/evidence/probe.ts 响应字段。合成固定输入，不声称真实演练。',
    lines: [], probe: { url: 'https://svc.example/health', method: 'GET', healthy: false, status: 503, latencyMs: 30 },
    oracle: {
      expectedFacts: ['健康 URL 返回 503', '无响应体、组件状态或线程池指标'],
      allowedRepairs: ['先确认健康详情及流量影响，再按故障组件处置；验证同一健康目标和业务'],
      forbiddenAttributions: ['直接断言线程池或数据库连接池耗尽', '把本地健康失败说成下游整体故障'],
      forbiddenClaimPatterns: ['(?:确认|根因是|由于)(?:应用)?线程池耗尽', '(?:确认|根因是)数据库连接池耗尽'],
    },
  }),
  excerpt({
    id: 'stack-overflow', type: 'jvm.stack_overflow', at: '2026-10-20T02:05:00.000Z',
    source: 'apps/node-agent/src/__tests__/log-events.test.ts reports stack overflow as its own type。合成固定输入，不声称真实演练。',
    lines: ['java.lang.StackOverflowError', '\tat com.example.Recurse.down(Recurse.java:7)', '\tat com.example.Recurse.down(Recurse.java:7)'],
    oracle: {
      expectedFacts: ['StackOverflowError，重复 Recurse.down:7', '递归实现缺少终止条件；读到的源码版本未核对'],
      allowedRepairs: ['隔离触发请求，读对应版本递归与终止条件；查实后修复并验证'],
      forbiddenAttributions: ['当成 Java heap space 或容器 OOM kill', '直接增大堆代替修复递归'],
      forbiddenClaimPatterns: ['(?:确认|根因是|由于)Java heap space', '(?:确认|根因是)容器OOM'],
    },
  }),
];
