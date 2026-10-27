import type { InvestigationSummary } from './investigation-runtime.js';

export const DEFAULT_SUMMARY_SEVERITY = {
  unavailableTypes: ['jvm.oom', 'container.oom', 'jvm.stack_overflow', 'runtime.oom', 'runtime.stack_overflow', 'health.failure', 'container.die'],
  unavailable: { level: '严重', reason: '服务可能不可用，需要优先止损。' },
  criticalOperation: { level: '高', reason: '已配置的关键接口或核心业务流程报错。' },
  other: { level: '一般', reason: '尚无服务不可用或关键业务受影响的确认事实。' },
} satisfies {
  unavailableTypes: string[];
  unavailable: InvestigationSummary['severity'];
  criticalOperation: InvestigationSummary['severity'];
  other: InvestigationSummary['severity'];
};

const FAULTS: Record<string, { scene: string; happened: string; repair: string }> = {
  'jvm.oom': { scene: '应用内存耗尽', happened: '应用报告内存耗尽，请求可能失败。', repair: '修复：核对异常栈和内存限制，区分应用堆与容器内存。' },
  'container.oom': { scene: '容器内存耗尽', happened: '容器因内存不足被系统终止，服务可能中断。', repair: '修复：核对容器限额与实际占用，确认原因后再调整。' },
  'jvm.stack_overflow': { scene: '应用调用栈溢出', happened: '应用调用层级过深，请求可能持续失败。', repair: '修复：按异常栈核对重复调用，确认终止条件。' },
  'runtime.oom': { scene: '运行时内存耗尽', happened: '应用报告内存耗尽，请求可能失败。', repair: '修复：核对异常栈和内存限制，区分应用内存与容器内存。' },
  'runtime.stack_overflow': { scene: '运行时调用栈溢出', happened: '应用调用层级过深，请求可能持续失败。', repair: '修复：按异常栈核对重复调用，确认终止条件。' },
  'health.failure': { scene: '服务健康检查', happened: '健康检查连续没有通过，服务可能不可用。', repair: '修复：核对健康检查响应、应用日志和依赖状态。' },
  'business.error': { scene: '业务接口请求', happened: '应用接口出现未处理异常，影响范围待确认。', repair: '修复：按异常位置核对对应版本源码，修复尚未确定。' },
  'container.die': { scene: '容器退出', happened: '容器进程退出，服务可能中断。', repair: '修复：核对退出记录与最近发布，不凭退出码认定内存耗尽。' },
  'container.restart': { scene: '容器重启', happened: '容器发生重启，需要确认业务是否受影响。', repair: '修复：核对重启记录、应用日志与最近变更。' },
  'jvm.cpu_pressure': { scene: '应用处理器负载', happened: '检测到应用处理器压力，是否持续影响请求待确认。', repair: '修复：比较故障期负载、资源配额和请求耗时。' },
  'jvm.gc_pressure': { scene: '应用内存回收', happened: '应用内存回收频繁，请求可能变慢。', repair: '修复：比较回收后占用、分配栈和内存限制。' },
  'host.memory_pressure': { scene: '机器内存压力', happened: '机器可用内存不足，服务可能变慢。', repair: '修复：核对主要进程占用和容器限制，不盲目清缓存。' },
  'host.disk_pressure': { scene: '机器磁盘空间', happened: '机器磁盘空间不足，写入可能失败。', repair: '修复：核对增长目录与保留策略，不直接删除业务数据。' },
  'application.slow_sql': { scene: '数据库查询', happened: '数据库查询变慢，业务请求可能超时。', repair: '修复：核对慢查询、锁等待与执行计划，不直接终止事务。' },
};

export function summarySeverityForType(type: string): InvestigationSummary['severity'] {
  return DEFAULT_SUMMARY_SEVERITY.unavailableTypes.includes(type)
    ? DEFAULT_SUMMARY_SEVERITY.unavailable : DEFAULT_SUMMARY_SEVERITY.other;
}

export function deterministicSummary(incident: { service: string; type: string }, severity = summarySeverityForType(incident.type)): InvestigationSummary {
  const fault = FAULTS[incident.type] ?? { scene: '服务异常', happened: '检测到服务异常，原因和影响范围待确认。', repair: '修复：核对故障期日志和最近变更，修复尚未确定。' };
  return {
    scene: `${incident.service.slice(0, 50)}，${fault.scene}`,
    whatHappened: fault.happened,
    severity,
    recovery: [
      '止损：若仍影响业务，先确认备用容量与回滚路径，经批准切走故障流量或暂停触发任务。',
      fault.repair,
      '验证：检查健康响应和关键业务请求，确认错误与超时恢复。',
    ],
  };
}
