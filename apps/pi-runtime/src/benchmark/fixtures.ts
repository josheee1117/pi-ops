import type { RuntimeInvestigationContext } from '@pi-ops/protocol';

/**
 * JVM Diagnosis Benchmark v1 — golden CPU incidents.
 *
 * Every Evidence row uses the field names the real collectors currently emit:
 *   - `jfr.signal`   — Pi-Ops projection in apps/agent/src/jfr-evidence.ts
 *   - `host.load`    — apps/node-agent/src/evidence/host.ts (load1/load5/load15/cpus)
 *   - `host.memory`  — apps/node-agent/src/evidence/host.ts (total/free/used/usedPercent)
 *   - `docker.stats` — apps/node-agent/src/evidence/docker.ts (cpu_stats/memory_stats/pids_stats)
 *   - `docker.inspect` — apps/node-agent/src/evidence/docker.ts (Id/Name/State/RestartCount/HostConfig.Memory)
 *
 * Nothing here invents a field the system does not produce. There is no CPU
 * quota / throttling Evidence in the current contract, so Case 5 uses container
 * CPU share attribution instead of a fabricated limit field.
 */

export interface BenchmarkEvidence {
  id: string;
  incidentId: string;
  nodeId: string;
  source: string;
  kind: string;
  collectedAt: string;
  status: 'succeeded' | 'failed';
  data: unknown;
}

export interface BenchmarkOracle {
  /** Evidence kinds that must appear in the report's cited Evidence. */
  mustCiteKinds: string[];
  expectedSupportingKinds: string[];
  expectedContradictingKinds: string[];
  forbiddenEvidenceKinds: string[];
  expectConflict: boolean;
  expectInsufficientEvidence: boolean;
  /** Highest acceptable report confidence. Omitted when unconstrained. */
  maxConfidence?: number;
  /** Human-readable diagnosis direction. Reviewed manually, never keyword-matched. */
  expectedDirection: string;
}

export interface BenchmarkCase {
  id: string;
  description: string;
  incidentId: string;
  service: string;
  nodeId: string;
  collectedAt: string;
  evidence: BenchmarkEvidence[];
  oracle: BenchmarkOracle;
}

const NODE = 'test-svc-02';
const SERVICE = 'data-asset-service';
const AT = '2026-08-20T12:00:00.000Z';

function jfr(incidentId: string, id: string, attributes: Record<string, number | string>): BenchmarkEvidence {
  return {
    id,
    incidentId,
    nodeId: NODE,
    source: 'jfr',
    kind: 'jfr.signal',
    collectedAt: AT,
    status: 'succeeded',
    data: {
      eventId: `evt-${id}`,
      eventType: 'jvm.cpu_pressure',
      observedAt: AT,
      message: 'JVM CPU pressure',
      attributes,
      semanticType: 'jvm.cpu_pressure',
    },
  };
}

function hostLoad(incidentId: string, id: string, load1: number, cpus: number): BenchmarkEvidence {
  return {
    id,
    incidentId,
    nodeId: NODE,
    source: 'host',
    kind: 'host.load',
    collectedAt: AT,
    status: 'succeeded',
    data: { load1, load5: load1, load15: load1, cpus },
  };
}

function hostMemory(incidentId: string, id: string, usedPercent: number): BenchmarkEvidence {
  const total = 16_000_000_000;
  const used = Math.round(total * (usedPercent / 100));
  return {
    id,
    incidentId,
    nodeId: NODE,
    source: 'host',
    kind: 'host.memory',
    collectedAt: AT,
    status: 'succeeded',
    data: { total, free: total - used, used, usedPercent, usagePercent: usedPercent.toFixed(2), uptime: 48_000 },
  };
}

function dockerStats(incidentId: string, id: string, containerUsage: number, systemUsage: number): BenchmarkEvidence {
  return {
    id,
    incidentId,
    nodeId: NODE,
    source: 'docker',
    kind: 'docker.stats',
    collectedAt: AT,
    status: 'succeeded',
    data: {
      cpu_stats: { cpu_usage: { total_usage: containerUsage, system_cpu_usage: systemUsage } },
      memory_stats: { usage: 900_000_000, limit: 2_147_483_648 },
      pids_stats: { current: 42 },
    },
  };
}

function dockerInspect(incidentId: string, id: string): BenchmarkEvidence {
  return {
    id,
    incidentId,
    nodeId: NODE,
    source: 'docker',
    kind: 'docker.inspect',
    collectedAt: AT,
    status: 'succeeded',
    data: {
      Id: 'c0ffee',
      Name: '/data-asset',
      State: { Status: 'running', Running: true, StartedAt: AT, OOMKilled: false, ExitCode: 0, Health: { Status: 'healthy' } },
      RestartCount: 0,
      HostConfig: { Memory: 2_147_483_648 },
      Config: { Image: 'data-asset:0.1.0' },
    },
  };
}

function context(benchmarkCase: BenchmarkCase): RuntimeInvestigationContext {
  return {
    schemaVersion: 1,
    incident: {
      id: benchmarkCase.incidentId,
      type: 'jvm.cpu_pressure',
      service: benchmarkCase.service,
    },
    // The runtime context schema is a passthrough object; our Evidence rows carry
    // the same fields, so this is a single boundary cast, not a shape change.
    evidence: benchmarkCase.evidence as unknown as RuntimeInvestigationContext['evidence'],
    historicalKnowledgeStatus: 'unavailable',
    historicalKnowledge: {
      similarIncidents: [],
      historicalHypotheses: [],
      previousResolutions: [],
      relatedMemories: [],
    },
    conflictingMemories: [],
  };
}

export function buildBenchmarkContext(benchmarkCase: BenchmarkCase): RuntimeInvestigationContext {
  return context(benchmarkCase);
}

export const CPU_GOLDEN_CASES: BenchmarkCase[] = [
  {
    id: 'cpu-jvm-and-host-high',
    description: 'JVM 自身与整机都处于高 CPU：JFR 显示 JVM 占用高，host.load 与 docker.stats 同时支持容器是主要消费者。',
    incidentId: 'inc-bench-cpu-1',
    service: SERVICE,
    nodeId: NODE,
    collectedAt: AT,
    evidence: [
      jfr('inc-bench-cpu-1', 'evd-b1-jfr', { jvmUser: 0.86, jvmSystem: 0.09, machineTotal: 0.95, containerName: 'data-asset' }),
      hostLoad('inc-bench-cpu-1', 'evd-b1-load', 7.6, 8),
      hostMemory('inc-bench-cpu-1', 'evd-b1-mem', 61),
      dockerStats('inc-bench-cpu-1', 'evd-b1-stats', 780_000_000_000, 900_000_000_000),
    ],
    oracle: {
      mustCiteKinds: ['jfr.signal'],
      expectedSupportingKinds: ['jfr.signal', 'host.load', 'docker.stats'],
      expectedContradictingKinds: [],
      forbiddenEvidenceKinds: [],
      expectConflict: false,
      expectInsufficientEvidence: false,
      expectedDirection: 'JVM/进程本身是高 CPU 的重要贡献者，需结合 host 与 docker.stats 佐证。',
    },
  },
  {
    id: 'cpu-jvm-local-only',
    description: 'JVM 本地压力高但整机不高：jvmUser 高、machineTotal 明显偏低，host.load 与 docker.stats 不支持整机级竞争。',
    incidentId: 'inc-bench-cpu-2',
    service: SERVICE,
    nodeId: NODE,
    collectedAt: AT,
    evidence: [
      jfr('inc-bench-cpu-2', 'evd-b2-jfr', { jvmUser: 0.88, jvmSystem: 0.06, machineTotal: 0.31, containerName: 'data-asset' }),
      hostLoad('inc-bench-cpu-2', 'evd-b2-load', 0.9, 8),
      dockerStats('inc-bench-cpu-2', 'evd-b2-stats', 420_000_000_000, 1_400_000_000_000),
    ],
    oracle: {
      mustCiteKinds: ['jfr.signal'],
      expectedSupportingKinds: ['jfr.signal'],
      expectedContradictingKinds: ['host.load'],
      forbiddenEvidenceKinds: [],
      expectConflict: false,
      expectInsufficientEvidence: false,
      expectedDirection: '应区分 JVM/进程本地压力与整机竞争，不得断言整台服务器 CPU 爆满。',
    },
  },
  {
    id: 'cpu-host-wide-only',
    description: '整机高但 JVM 自身不高：jvmUser/jvmSystem 低、machineTotal 高，host.load 高（核数少），docker.stats 显示容器占比很小。',
    incidentId: 'inc-bench-cpu-3',
    service: SERVICE,
    nodeId: NODE,
    collectedAt: AT,
    evidence: [
      jfr('inc-bench-cpu-3', 'evd-b3-jfr', { jvmUser: 0.11, jvmSystem: 0.02, machineTotal: 0.94, containerName: 'data-asset' }),
      hostLoad('inc-bench-cpu-3', 'evd-b3-load', 9.4, 4),
      hostMemory('inc-bench-cpu-3', 'evd-b3-mem', 72),
      dockerStats('inc-bench-cpu-3', 'evd-b3-stats', 30_000_000_000, 900_000_000_000),
    ],
    oracle: {
      mustCiteKinds: ['jfr.signal', 'host.load'],
      expectedSupportingKinds: ['host.load'],
      expectedContradictingKinds: [],
      forbiddenEvidenceKinds: [],
      expectConflict: false,
      expectInsufficientEvidence: false,
      expectedDirection: '不应把 JVM 判为主要 CPU 消费者；指向主机级竞争，无法确认具体进程时必须说明证据不足。',
    },
  },
  {
    id: 'cpu-cross-layer-conflict',
    description: '跨层证据冲突：JFR machineTotal 很高，但 host.load 低、docker.stats 容器占比很小，两侧结论不一致。',
    incidentId: 'inc-bench-cpu-4',
    service: SERVICE,
    nodeId: NODE,
    collectedAt: AT,
    evidence: [
      jfr('inc-bench-cpu-4', 'evd-b4-jfr', { jvmUser: 0.52, jvmSystem: 0.07, machineTotal: 0.96, containerName: 'data-asset' }),
      hostLoad('inc-bench-cpu-4', 'evd-b4-load', 0.35, 8),
      dockerStats('inc-bench-cpu-4', 'evd-b4-stats', 20_000_000_000, 1_200_000_000_000),
    ],
    oracle: {
      mustCiteKinds: ['jfr.signal'],
      expectedSupportingKinds: ['jfr.signal'],
      expectedContradictingKinds: ['host.load', 'docker.stats'],
      forbiddenEvidenceKinds: [],
      expectConflict: true,
      expectInsufficientEvidence: false,
      expectedDirection: '必须显式承认跨层冲突/采样差异，保留两侧证据，不得因 jfr.signal 是 primary 而无视其他证据。',
    },
  },
  {
    id: 'cpu-container-attribution',
    description: '容器级归因：docker.stats 显示该容器占用系统 CPU 的绝大部分（94%），host.load 中等，JFR 显示压力。',
    incidentId: 'inc-bench-cpu-5',
    service: SERVICE,
    nodeId: NODE,
    collectedAt: AT,
    evidence: [
      jfr('inc-bench-cpu-5', 'evd-b5-jfr', { jvmUser: 0.71, jvmSystem: 0.12, machineTotal: 0.88, containerName: 'data-asset' }),
      dockerStats('inc-bench-cpu-5', 'evd-b5-stats', 1_500_000_000_000, 1_600_000_000_000),
      hostLoad('inc-bench-cpu-5', 'evd-b5-load', 5.2, 4),
      dockerInspect('inc-bench-cpu-5', 'evd-b5-inspect'),
    ],
    oracle: {
      mustCiteKinds: ['jfr.signal', 'docker.stats'],
      expectedSupportingKinds: ['jfr.signal', 'docker.stats'],
      expectedContradictingKinds: [],
      forbiddenEvidenceKinds: [],
      expectConflict: false,
      expectInsufficientEvidence: false,
      expectedDirection: '应能提出容器级归因（该容器/JVM 是主要 CPU 消费者）作为主要 hypothesis。',
    },
  },
  {
    id: 'cpu-insufficient',
    description: '证据不足：只有一条有效的 jfr.signal，缺少 host/docker 佐证。',
    incidentId: 'inc-bench-cpu-6',
    service: SERVICE,
    nodeId: NODE,
    collectedAt: AT,
    evidence: [
      jfr('inc-bench-cpu-6', 'evd-b6-jfr', { jvmUser: 0.8, jvmSystem: 0.05, machineTotal: 0.84, containerName: 'data-asset' }),
    ],
    oracle: {
      mustCiteKinds: ['jfr.signal'],
      expectedSupportingKinds: ['jfr.signal'],
      expectedContradictingKinds: [],
      forbiddenEvidenceKinds: [],
      expectConflict: false,
      expectInsufficientEvidence: true,
      maxConfidence: 0.6,
      expectedDirection: '必须承认证据不足以确认具体根因，优先“我不知道”，并降低 certainty。',
    },
  },
];

export function findCase(id: string): BenchmarkCase | undefined {
  return CPU_GOLDEN_CASES.find((item) => item.id === id);
}
