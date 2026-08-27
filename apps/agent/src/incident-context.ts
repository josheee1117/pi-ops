import type { EvidenceRecord, IncidentRow } from './store.js';

export interface IncidentContextIncident {
  id: string;
  nodeId: string;
  service: string;
  type: string;
  severity: string;
  state: string;
  firstSeen: string;
  lastSeen: string;
  eventCount: number;
}

export interface IncidentContextEvidence {
  id: string;
  source: string;
  kind: string;
  collectedAt: string;
  status: string;
  data: unknown;
}

export interface IncidentContextTruncation {
  droppedEvidenceIds: string[];
  truncatedItems: string[];
}

export interface IncidentContext {
  incident: IncidentContextIncident;
  evidence: IncidentContextEvidence[];
  truncation?: IncidentContextTruncation;
}

export interface IncidentContextBounds {
  maxEvidenceItems: number;
  maxContextBytes: number;
  maxLogLines: number;
}

const SECRET_KEY = /^(authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|credentials|auth)$/i;
const ENV_KEY = /^(env|environment)$/i;

const KIND_RANK: Record<string, number> = {
  'docker.inspect': 0,
  'http.probe': 1,
  'docker.stats': 2,
  'host.memory': 2,
  'host.load': 2,
  'host.disk': 2,
  'docker.logs': 3,
};

export function evidenceRank(item: Pick<EvidenceRecord, 'kind' | 'status'>): number {
  if (item.kind === 'docker.inspect' || item.kind === 'http.probe') return 0;
  if (item.status === 'failed') return 1;
  return KIND_RANK[item.kind] ?? 4;
}

export function buildIncidentContext(
  incident: IncidentRow,
  evidence: EvidenceRecord[],
  bounds: IncidentContextBounds,
): IncidentContext {
  const ordered = [...evidence].sort((left, right) => {
    const rank = evidenceRank(left) - evidenceRank(right);
    if (rank !== 0) return rank;
    const collected = right.collectedAt.localeCompare(left.collectedAt);
    if (collected !== 0) return collected;
    return left.id.localeCompare(right.id);
  });

  const droppedEvidenceIds: string[] = [];
  const truncatedItems: string[] = [];
  const maxItemBytes = Math.max(256, Math.min(16_384, Math.floor(bounds.maxContextBytes / 2)));

  const selected = ordered.slice(0, bounds.maxEvidenceItems);
  for (const extra of ordered.slice(bounds.maxEvidenceItems)) {
    droppedEvidenceIds.push(extra.id);
  }

  const items: IncidentContextEvidence[] = selected.map((item) => {
    const sanitized = sanitizeEvidence(item, bounds.maxLogLines);
    const encoded = jsonBytes(sanitized.data);
    if (encoded <= maxItemBytes) return sanitized;
    truncatedItems.push(item.id);
    return { ...sanitized, data: { truncated: true } };
  });

  const base = {
    incident: {
      id: incident.id,
      nodeId: incident.node_id,
      service: incident.service,
      type: incident.type,
      severity: incident.severity,
      state: incident.state,
      firstSeen: incident.first_seen,
      lastSeen: incident.last_seen,
      eventCount: incident.event_count,
    },
    evidence: items,
  };

  const assemble = (): IncidentContext => {
    droppedEvidenceIds.sort((left, right) => left.localeCompare(right));
    truncatedItems.sort((left, right) => left.localeCompare(right));
    if (droppedEvidenceIds.length === 0 && truncatedItems.length === 0) return { ...base };
    return {
      ...base,
      truncation: {
        droppedEvidenceIds: [...droppedEvidenceIds],
        truncatedItems: [...truncatedItems],
      },
    };
  };

  let context = assemble();
  while (items.length > 0 && jsonBytes(context) > bounds.maxContextBytes) {
    const removed = items.pop();
    if (!removed) break;
    droppedEvidenceIds.push(removed.id);
    context = assemble();
  }
  return context;
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function sanitizeEvidence(item: EvidenceRecord, maxLogLines: number): IncidentContextEvidence {
  return {
    id: item.id,
    source: item.source,
    kind: item.kind,
    collectedAt: item.collectedAt,
    status: item.status,
    data: boundLogs(redactSecrets(item.data), maxLogLines),
  };
}

export function redactSecrets(value: unknown, key?: string): unknown {
  if (key && (SECRET_KEY.test(key) || ENV_KEY.test(key))) return '[redacted]';
  if (Array.isArray(value)) {
    if (key === 'Env') return '[redacted]';
    return value.map((entry) => redactSecrets(entry));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      output[childKey] = redactSecrets(childValue, childKey);
    }
    return output;
  }
  return value;
}

function boundLogs(data: unknown, maxLogLines: number): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const record = { ...(data as Record<string, unknown>) };
  for (const key of ['lines', 'logs']) {
    const value = record[key];
    if (Array.isArray(value)) {
      record[key] = value.slice(0, maxLogLines);
    } else if (typeof value === 'string') {
      record[key] = value.split('\n').slice(0, maxLogLines).join('\n');
    }
  }
  return record;
}
