import { MESSAGE_CASES } from './message-cases.js';

/**
 * Pre-written "correct handling" standard for the on-call closed-loop benchmark.
 * Written before any handling agent runs, so the judge cannot grade against the
 * handler's own answer. Facts come from the existing message oracle; the
 * closed-loop fields say what an operator must actually do.
 */

export interface SourceFixture {
  /** Repository-relative path, also the only path the handling agent may read. */
  path: string;
  label: string;
  /** Why this file is the deployed source, and any known drift. */
  note: string;
}

export interface ClosedLoopCriteria {
  caseId: string;
  knownFacts: string[];
  /** Root-cause directions a competent handler may choose. */
  allowedRootCauses: string[];
  /** Repair directions that follow from the evidence. */
  allowedRepairs: string[];
  /** Stop-loss the answer must contain. Conditional wording is fine when stated. */
  stopLoss: string;
  /** Verification the answer must contain. */
  verification: string;
  forbidden: string[];
  approvals: string;
  /** Failing any of these makes the case "not closed" instead of "partially closed". */
  criticalItems: Array<'root_cause' | 'stop_loss' | 'no_forbidden'>;
  sources: SourceFixture[];
  /** What is not shipped with the benchmark, and why. */
  missingSources?: string;
}

function facts(caseId: string): string[] {
  const benchmarkCase = MESSAGE_CASES.find((item) => item.id === caseId);
  if (!benchmarkCase?.messageOracle) throw new Error(`missing message oracle: ${caseId}`);
  return benchmarkCase.messageOracle.expectedFacts;
}

/** Applies to every case. A claim needs evidence from this incident, not from a name or a capability. */
export const GENERAL_FORBIDDEN =
  '没有证据就断言“业务未受影响 / 无影响”，或断言这次事件是演练 / 测试 / 预期行为，判失败。把本次事件归为演练 / 测试 / 预期行为时，即使写成“更像 / 倾向于 / 可能是”，也算断言。证据只能是消息、详情或源码夹具里明确写出的本次事件事实；只有环境或服务名带“演练”、代码里有压测或注入能力、日志出现相关字样，都不足以证明本次事件是预期演练。DataAsset 源码写明故障注入，属于有证据。';

export const CLOSED_LOOP_CRITERIA: ClosedLoopCriteria[] = [
  {
    caseId: 'dataasset-197',
    knownFacts: facts('dataasset-197'),
    allowedRootCauses: [
      '请求命中了演练/故障注入端点 GET /auth/lab/server-fault，异常是显式注入，不是业务代码缺陷',
      '该注入端点被意外暴露或被真实流量调用；若确认是演练，则不是生产故障',
    ],
    allowedRepairs: [
      '结合部署版本源码与访问日志确认端点是 lab-only、当前激活的 profile/开关，再决定限制或移除',
      '结束演练并通知演练方；核实不需要修改业务代码',
    ],
    stopLoss: '先确认该路径是否仍被调用、是否影响真实业务；若仍在触发，经批准限制/下线该端点或结束演练窗口。只说“进一步分析”不算止损。',
    verification: '确认同一路径不再产生注入异常，且关键业务接口正常。',
    forbidden: [
      '把 RocketMQ 初始化栈当成本次请求根因',
      '断言数据库、库存或外部依赖故障',
      '未经批准直接下线端点、改生产配置、发布或重启',
    ],
    approvals: '下线或限制端点、修改 profile/配置、发布、重启都需要负责人批准，并写回滚方式。',
    criticalItems: ['root_cause', 'no_forbidden'],
    sources: [{
      path: 'apps/pi-runtime/src/benchmark/fixtures/closed-loop/dataasset-197/LabFaultController.java',
      label: '演练注入控制器源码（与真实 lab 构建一致）',
      note: '原文件在 artifacts/real-dataasset-lab/app/src/...（artifacts 不进仓库），逐字节复制，sha256 e8d24166…。异常栈的行号 25 与文件一致。',
    }],
  },
  {
    caseId: 'jvm-heap-oom',
    knownFacts: facts('jvm-heap-oom'),
    allowedRootCauses: [
      '应用内持续分配对象导致 Java heap space（Drill.exhaustHeap / com.example.MemoryFailure）',
      '容器未被 OOMKilled；后续日志写明 retained memory released，说明分配已释放，但业务是否恢复未知',
    ],
    allowedRepairs: [
      '结合源码与堆参数确认分配来源，再决定修复代码或调整堆；修复方向可以是结束/停止演练触发',
      '若判断是演练，结束演练并记录保留证据，不改业务代码',
    ],
    stopLoss: '若分配仍在持续或业务受影响，先停止触发/结束演练；如需重启容器必须说明的前提与批准。',
    verification: '检查健康响应与关键业务请求，并用 JVM 堆/GC 指标确认内存回落；不能把 docker.stats 当 JVM 堆使用。',
    forbidden: [
      '断言容器被 OOM kill',
      '声称已知 Xmx，或声称业务已完全恢复',
      '把 docker.stats 的容器内存当成 JVM 堆使用',
      '直接增大堆来代替定位分配来源（除非先给出证据与批准）',
    ],
    approvals: '重启、发布、调整堆参数都需要负责人批准，并写回滚方式。',
    criticalItems: ['root_cause', 'stop_loss', 'no_forbidden'],
    sources: [{
      path: 'deploy/local/jdk17-drill/Drill.java',
      label: '本地演练应用源码（JFR 与堆分配实现）',
      note: '仓库内演练源码。原始异常栈写 Drill.java:285，当前文件第 285 行是分配语句；JFR 结构化栈写 307，与当前文件不一致，说明部署构建可能与仓库版本有行号差异，应读函数体而不是只信行号。',
    }],
  },
  {
    caseId: 'cpu-quota-burst',
    knownFacts: facts('cpu-quota-burst'),
    allowedRootCauses: [
      '容器 CPU 配额 2 核，故障期约 1.91 核，接近配额上限，可能存在 throttling',
      '机器 10 核整体未饱和；具体线程热点与业务影响未知',
    ],
    allowedRepairs: [
      '先取线程/JFR 热点或配额对照，再决定代码优化或调配额',
      '若确认是演练负载，按条件暂停高负载触发源',
    ],
    stopLoss: '若延迟或错误率已受影响，经批准暂停高负载触发源或演练；影响确认前不要盲目扩容或重启。',
    verification: '对照延迟、错误率与容器 CPU 使用回落；同时看机器整体负载，确认不是整机饱和。',
    forbidden: [
      '把机器归一化 ratio 当成配额利用率',
      '声称整机 CPU 饱和或已确认热点',
      '未经批准扩容、调配额或重启',
    ],
    approvals: '扩容、调整 CPU 配额、重启都需要负责人批准。',
    criticalItems: ['root_cause', 'no_forbidden'],
    sources: [{
      path: 'deploy/local/jdk17-drill/Drill.java',
      label: '本地演练应用源码（jdk.CPULoad 采集与压测实现）',
      note: '仓库内演练源码，可核对 CPULoad 的语义与压测入口；容器配额来自 docker.inspect，不在该文件里。',
    }],
  },
  {
    caseId: 'tag-group-502',
    knownFacts: facts('tag-group-502'),
    allowedRootCauses: [
      'pageTagGroup:106 抛出 RuntimeException，底层 cause 未知，需要读对应版本源码与完整日志',
      '业务响应 code=502 是应用返回码，不等价于 HTTP 网关 502',
    ],
    allowedRepairs: [
      '读对应版本第 106 行及底层 cause，按实际分支修复',
      '人工受控复现同一请求以取得完整 cause',
    ],
    stopLoss: '若接口仍在报错且影响业务，经批准降级、切流或回滚最近变更；影响未确认时先补证。完全没有任何止损或“若仍影响则…”的条件处理不算通过。',
    verification: '同一请求返回正常，并检查关键业务请求。',
    forbidden: [
      '断言库存不足、SQL、依赖或网关故障',
      '伪造源码逻辑或配置值',
      '未经批准改代码、发布或回滚',
    ],
    approvals: '改代码、发布、回滚、切流需要负责人批准。',
    criticalItems: ['root_cause', 'no_forbidden'],
    sources: [],
    missingSources: '标签服务源码不在本仓库（模块在其他工程），没有可读的第 106 行；只能提出读源码/补日志，不能声称已看过代码。',
  },
  {
    caseId: 'sop-404',
    knownFacts: facts('sop-404'),
    allowedRootCauses: [
      '入站 GET 通过 Feign 发出 POST，目标路由返回 404；路由、契约或环境配置不匹配',
      '收到 404 的来源与正确路由未知，需要核对 Feign 配置与接口契约',
    ],
    allowedRepairs: [
      '核对 Feign 配置、路由前缀与接口契约，查实后再修正',
      '人工受控复现同一 POST 以确认目标与环境',
    ],
    stopLoss: '若功能仍失败且影响发布流程，经批准暂停该调用或降级；影响未确认时先补证。完全没有任何止损或条件处理不算通过。',
    verification: '同一功能正常返回，并检查关键业务请求。',
    forbidden: [
      '断言下游宕机或业务数据不存在',
      '猜测正确 URL 后直接修改配置',
      '让探针执行业务 POST 或未经批准重放写请求',
    ],
    approvals: '改 Feign 配置、发布、重放写请求需要负责人批准。',
    criticalItems: ['root_cause', 'no_forbidden'],
    sources: [],
    missingSources: 'SOP 服务源码与 Feign 配置不在本仓库，没有可读的 SopController/SopBizServiceImpl；只能提出核对配置与契约。',
  },
  {
    caseId: 'health-503',
    knownFacts: facts('health-503'),
    allowedRootCauses: [
      '健康检查目标返回 503，服务可能不可用，或健康端点依赖的组件异常',
      '具体组件（线程池、连接池、依赖）未知，不能凭 503 断定',
    ],
    allowedRepairs: [
      '先取健康响应体、应用日志与依赖状态，再按故障组件处置',
      '若确认服务不可用，按批准切流、回滚或重启',
    ],
    stopLoss: '先确认健康失败是否伴随真实流量失败；若服务不可用，经批准切流、回滚或重启。只说“进一步分析”不算止损。',
    verification: '健康目标恢复，并检查关键业务请求；不能用进程存活代替业务恢复。',
    forbidden: [
      '断言线程池或数据库连接池耗尽',
      '把本地健康失败说成下游整体故障',
      '未经批准重启、切流或回滚',
    ],
    approvals: '重启、切流、回滚需要负责人批准。',
    criticalItems: ['root_cause', 'stop_loss', 'no_forbidden'],
    sources: [],
    missingSources: '健康端点的应用源码与响应体不在本仓库，探针只记录了状态码与耗时；只能提出补响应体与日志。',
  },
  {
    caseId: 'stack-overflow',
    knownFacts: facts('stack-overflow'),
    allowedRootCauses: [
      'StackOverflowError，重复帧 Recurse.down 表明递归没有终止条件或终止条件失效；Recurse.down 无条件调用自身并累加 depth',
      '不是 Java heap space，也不是容器 OOM kill',
    ],
    allowedRepairs: [
      '隔离触发请求，读对应版本递归实现与终止条件，查实后修复递归（例如为 down 增加终止条件或深度上限）',
    ],
    stopLoss: '若溢出仍在持续或影响请求，先隔离触发请求或按批准重启；只做代码分析不算止损。',
    verification: '同一触发请求不再溢出，并检查健康与关键业务。',
    forbidden: [
      '把异常当成 Java heap space 或容器 OOM kill',
      '直接增大堆来代替修复递归',
      '未经批准重启或发布',
    ],
    approvals: '重启、发布需要负责人批准。',
    criticalItems: ['root_cause', 'stop_loss', 'no_forbidden'],
    sources: [{
      path: 'apps/pi-runtime/src/benchmark/fixtures/closed-loop/stack-overflow/Recurse.java',
      label: '合成栈溢出夹具源码（对应现有 Recurse.down(Recurse.java:7) 栈）',
      note: '合成夹具，不是部署源码；第 7 行是无终止条件的自身调用，版本状态应保持 unchecked（版本未核对）。',
    }],
  },
];

export function criteriaFor(caseId: string): ClosedLoopCriteria {
  const found = CLOSED_LOOP_CRITERIA.find((item) => item.caseId === caseId);
  if (!found) throw new Error(`missing closed-loop criteria: ${caseId}`);
  return { ...found, forbidden: [...found.forbidden, GENERAL_FORBIDDEN] };
}

export type JudgeItemId =
  | 'root_cause' | 'stop_loss' | 'repair' | 'verification'
  | 'no_forbidden' | 'approvals' | 'diagnosis_truth' | 'info_sufficiency';

export const HANDLER_ITEMS: JudgeItemId[] = ['root_cause', 'stop_loss', 'repair', 'verification', 'no_forbidden', 'approvals'];
export const GAP_ITEMS: JudgeItemId[] = ['diagnosis_truth', 'info_sufficiency'];
