import type { EvidenceRecord, IncidentRow } from './store.js';

export type ReasoningStatus = 'complete' | 'incomplete';

export interface ReasoningUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ReasoningResult {
  id: string;
  incidentId: string;
  createdAt: string;
  hypotheses: string[];
  missingEvidence: string[];
  confidence: number;
  status: ReasoningStatus;
  reasoningJobId?: string;
  reasonerType?: string;
  reasonerVersion?: string;
  evidenceIds?: string[];
  evidenceSnapshotHash?: string;
  provider?: string;
  model?: string;
  reasoningSummary?: string;
  recommendedActions?: string[];
  needHuman?: boolean;
  usage?: ReasoningUsage;
  truncated?: boolean;
  missingCapability?: string[];
  usedMemoryEntryIds?: string[];
  strategy?: string;
  strategyVersion?: string;
  investigationPlanId?: string;
  delegationTaskId?: string;
  investigationSessionId?: string;
  investigationReportId?: string;
  runtimeTaskId?: string;
  runtimeRequestId?: string;
}

export interface Reasoner {
  readonly type: string;
  readonly version: string;
  reason(incident: IncidentRow, evidence: EvidenceRecord[]): ReasoningResult | Promise<ReasoningResult>;
}

export interface SyncReasoner extends Reasoner {
  reason(incident: IncidentRow, evidence: EvidenceRecord[]): ReasoningResult;
}

export interface ReasonerRegistry {
  get(type: string): Reasoner | undefined;
}

export function createReasonerRegistry(reasoners: Reasoner[]): ReasonerRegistry {
  const byType = new Map(reasoners.map((reasoner) => [reasoner.type, reasoner]));
  return {
    get(type: string): Reasoner | undefined {
      return byType.get(type);
    },
  };
}

export const HYPOTHESIS_RESOURCE_SATURATION = 'application resource saturation';
export const HYPOTHESIS_DATABASE_INVESTIGATION = 'database side investigation required';
export const HYPOTHESIS_JVM_MEMORY_PRESSURE = 'JVM memory pressure';
export const MISSING_DATABASE_METRICS = 'database.metrics';
export const MISSING_HOST_MEMORY = 'host.memory';

const CPU_HIGH_PERCENT = 80;
const CPU_LOAD_RATIO = 0.8;
const MEMORY_PRESSURE_RATIO = 0.9;

function succeeded(item: EvidenceRecord): boolean {
  return item.status === 'succeeded';
}

function asRecord(data: unknown): Record<string, unknown> | undefined {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function nested(data: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return asRecord(data[key]);
}

export function isCpuHigh(evidence: EvidenceRecord[]): boolean {
  for (const item of evidence.filter(succeeded)) {
    const data = asRecord(item.data);
    if (!data) continue;
    if (item.kind === 'docker.stats') {
      const percent = numeric(data['cpuPercent'])
        ?? numeric(nested(data, 'cpu')?.['usagePercent']);
      if (percent !== undefined && percent >= CPU_HIGH_PERCENT) return true;
    }
    if (item.kind === 'host.load') {
      const load1 = numeric(data['load1']);
      const cpus = numeric(data['cpus']) ?? 1;
      if (load1 !== undefined && cpus > 0 && load1 / cpus >= CPU_LOAD_RATIO) return true;
    }
  }
  return false;
}

export function hasMemoryEvidence(evidence: EvidenceRecord[]): boolean {
  return evidence.some((item) =>
    succeeded(item) && (item.kind === 'host.memory' || item.kind === 'docker.stats'),
  );
}

export function isMemoryPressure(evidence: EvidenceRecord[]): boolean {
  for (const item of evidence.filter(succeeded)) {
    const data = asRecord(item.data);
    if (!data) continue;
    if (item.kind === 'host.memory') {
      const percent = numeric(data['usagePercent']);
      if (percent !== undefined && percent >= MEMORY_PRESSURE_RATIO * 100) return true;
      const used = numeric(data['used']);
      const total = numeric(data['total']);
      if (used !== undefined && total && used / total >= MEMORY_PRESSURE_RATIO) return true;
    }
    if (item.kind === 'docker.stats') {
      const memory = nested(data, 'memory_stats');
      const usage = numeric(memory?.['usage']);
      const limit = numeric(memory?.['limit']);
      if (usage !== undefined && limit && usage / limit >= MEMORY_PRESSURE_RATIO) return true;
    }
  }
  return false;
}

function result(
  incident: IncidentRow,
  hypotheses: string[],
  missingEvidence: string[],
  confidence: number,
): ReasoningResult {
  const status: ReasoningStatus = missingEvidence.length > 0 ? 'incomplete' : 'complete';
  return {
    id: `reason-${incident.id}`,
    incidentId: incident.id,
    createdAt: incident.last_seen,
    hypotheses,
    missingEvidence,
    confidence,
    status,
  };
}

export function createFakeReasoner(): SyncReasoner {
  return {
    type: 'fake',
    version: '1',
    reason(incident: IncidentRow, evidence: EvidenceRecord[]): ReasoningResult {
      if (incident.type === 'application.slow_sql') {
        if (isCpuHigh(evidence)) {
          return result(incident, [HYPOTHESIS_RESOURCE_SATURATION], [], 0.8);
        }
        return result(
          incident,
          [HYPOTHESIS_DATABASE_INVESTIGATION],
          [MISSING_DATABASE_METRICS],
          0.6,
        );
      }
      if (incident.type === 'jvm.gc_pressure') {
        if (isMemoryPressure(evidence)) {
          return result(incident, [HYPOTHESIS_JVM_MEMORY_PRESSURE], [], 0.85);
        }
        if (!hasMemoryEvidence(evidence)) {
          return result(incident, [], [MISSING_HOST_MEMORY], 0.4);
        }
        return result(incident, [], [], 0);
      }
      return result(incident, [], [], 0);
    },
  };
}
