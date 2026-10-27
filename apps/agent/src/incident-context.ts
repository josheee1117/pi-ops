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
  incidentId: string;
  nodeId: string;
  source: string;
  kind: string;
  collectedAt: string;
  status: 'succeeded' | 'failed';
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

/** Model-facing log bound shared by initial InvestigationContext and dynamic runtime Evidence. */
export const MODEL_SAFE_MAX_LOG_LINES = 20;
export const MODEL_SAFE_MAX_DATA_BYTES = 4096;

const SECRET_KEY = /^(authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|credentials|auth)$/i;
const ENV_KEY = /^(env|environment)$/i;

const KIND_RANK: Record<string, number> = {
  'jfr.signal': 0,
  'docker.inspect': 0,
  'source.snippet': 0,
  'http.probe': 1,
  'docker.stats': 2,
  'host.memory': 2,
  'host.load': 2,
  'host.disk': 2,
  'docker.logs': 3,
};

export function evidenceRank(item: Pick<EvidenceRecord, 'kind' | 'status'>): number {
  if (item.kind === 'jfr.signal' || item.kind === 'docker.inspect' || item.kind === 'http.probe'
    || item.kind === 'source.snippet') return 0;
  if (item.status === 'failed') return 1;
  return KIND_RANK[item.kind] ?? 4;
}

const DIVERSITY_KINDS = [
  'jfr.signal',
  'docker.inspect',
  'docker.stats',
  'host.load',
  'host.memory',
  'http.probe',
  'source.snippet',
] as const;

function compareEvidenceOrder(left: EvidenceRecord, right: EvidenceRecord): number {
  const rank = evidenceRank(left) - evidenceRank(right);
  if (rank !== 0) return rank;
  const collected = right.collectedAt.localeCompare(left.collectedAt);
  if (collected !== 0) return collected;
  return left.id.localeCompare(right.id);
}

/** Prefer one current row per key kind, then fill remaining slots by rank/freshness. */
export function selectEvidenceForContext(
  evidence: EvidenceRecord[],
  maxEvidenceItems: number,
): EvidenceRecord[] {
  const ordered = [...evidence].sort(compareEvidenceOrder);
  const selected: EvidenceRecord[] = [];
  const selectedIds = new Set<string>();
  const take = (item: EvidenceRecord | undefined) => {
    if (!item || selectedIds.has(item.id) || selected.length >= maxEvidenceItems) return;
    selected.push(item);
    selectedIds.add(item.id);
  };
  for (const kind of DIVERSITY_KINDS) {
    take(ordered.find((item) => item.kind === kind));
  }
  for (const item of ordered) take(item);
  return selected;
}

export function buildIncidentContext(
  incident: IncidentRow,
  evidence: EvidenceRecord[],
  bounds: IncidentContextBounds,
): IncidentContext {
  const ordered = [...evidence].sort(compareEvidenceOrder);
  const droppedEvidenceIds: string[] = [];
  const truncatedItems: string[] = [];
  const maxItemBytes = Math.max(256, Math.min(16_384, Math.floor(bounds.maxContextBytes / 2)));

  const selected = selectEvidenceForContext(ordered, bounds.maxEvidenceItems);
  const selectedIds = new Set(selected.map((item) => item.id));
  for (const extra of ordered) {
    if (!selectedIds.has(extra.id)) droppedEvidenceIds.push(extra.id);
  }

  const items = selected.map((item) => toRuntimeSafeEvidence(item, bounds.maxLogLines, {
    eventTime: incident.last_seen,
    maxDataBytes: maxItemBytes,
  }));

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
    truncatedItems.splice(0, truncatedItems.length, ...items
      .filter((item) => isRecord(item.data) && item.data.truncated === true)
      .map((item) => item.id)
      .sort((left, right) => left.localeCompare(right)));
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
    const largest = [...items].sort((left, right) => jsonBytes(right.data) - jsonBytes(left.data))
      .find((item) => jsonBytes(item.data) > 256);
    const original = selected.find((item) => item.id === largest?.id);
    if (largest && original) {
      const smaller = toRuntimeSafeEvidence(original, bounds.maxLogLines, {
        eventTime: incident.last_seen,
        maxDataBytes: Math.max(256, Math.floor(jsonBytes(largest.data) * 0.75)),
      });
      if (jsonBytes(smaller.data) < jsonBytes(largest.data)) {
        largest.data = smaller.data;
        context = assemble();
        continue;
      }
    }
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

/** Detail and raw endpoints show snippet metadata but never the source body. */
export function withoutSourceSnippetText<T extends { kind: string; data: unknown }>(item: T): T {
  if (item.kind !== 'source.snippet' || !isRecord(item.data) || !('text' in item.data)) return item;
  const { text: _text, ...metadata } = item.data;
  return { ...item, data: metadata };
}

export function toRuntimeSafeEvidence(
  item: Pick<EvidenceRecord, 'id' | 'incidentId' | 'nodeId' | 'source' | 'kind' | 'collectedAt' | 'status' | 'data'>,
  maxLogLines: number,
  options: { eventTime?: string; maxDataBytes?: number } = {},
): IncidentContextEvidence {
  return {
    id: item.id,
    incidentId: item.incidentId,
    nodeId: item.nodeId,
    source: item.source,
    kind: item.kind,
    collectedAt: item.collectedAt,
    status: item.status === 'failed' ? 'failed' : 'succeeded',
    data: projectData(redactSecrets(item.data), maxLogLines, {
      eventTime: options.eventTime ?? item.collectedAt,
      maxDataBytes: options.maxDataBytes ?? MODEL_SAFE_MAX_DATA_BYTES,
    }),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const EXCEPTION_HEAD = /(?:\b(?:ERROR|FATAL)\b|(?:[\w$]+\.)*[\w$]*(?:Exception|Error)\b\s*:|^\s*(?:Caused by:|Suppressed:)|异常信息[:：])/;
const STACK_FRAME = /^\s*(?:at\s+)+/;
const FRAMEWORK_FRAME = /^(?:(?:java\.[\w.]+\/)?(?:java|javax|jakarta|jdk|sun)\.|org\.(?:springframework|apache|hibernate)\.|io\.netty\.|com\.(?:sun|fasterxml|zaxxer)\.)/;

function lineTime(line: string): number {
  const timestamp = line.match(/^\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:\d{2})?)/)?.[1];
  if (!timestamp) return NaN;
  const iso = timestamp.replace(' ', 'T').replace(',', '.');
  // Logs without an offset use the event's UTC timeline, not the agent host's timezone.
  return Date.parse(/[Z]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`);
}

function projectData(
  data: unknown,
  maxLogLines: number,
  options: { eventTime: string; maxDataBytes: number },
): unknown {
  const record = isRecord(data) ? data : undefined;
  const fields = ['lines', 'logs'].flatMap((key) => {
    const value = record?.[key];
    if (!Array.isArray(value) && typeof value !== 'string') return [];
    return [{ key, value, lines: typeof value === 'string' ? value.split('\n') : value }];
  });
  const eventTime = Date.parse(options.eventTime);
  const candidates = fields.flatMap((field) => {
    let distance = Infinity;
    const heads = new Set<number>();
    field.lines.forEach((line, index) => {
      if (typeof line === 'string' && EXCEPTION_HEAD.test(line) && !STACK_FRAME.test(line)) heads.add(index);
    });
    return field.lines.map((value: unknown, index: number) => {
      const line = typeof value === 'string' ? value : '';
      const timestamp = lineTime(line);
      if (Number.isFinite(timestamp) && Number.isFinite(eventTime)) distance = Math.abs(timestamp - eventTime);
      const business = STACK_FRAME.test(line) && !FRAMEWORK_FRAME.test(line.replace(STACK_FRAME, ''));
      const rank = heads.has(index) ? 0 : business ? 1 : Number.isFinite(distance) ? 2
        : heads.has(index - 1) || heads.has(index + 1) ? 3 : 4;
      return { key: field.key, index, value, rank, distance, partial: false };
    });
  }).sort((left, right) => left.rank - right.rank || left.distance - right.distance
    || left.index - right.index || left.key.localeCompare(right.key));
  const kept = candidates.slice(0, Math.max(0, maxLogLines));
  const trimmedFields = new Set<string>();
  let remainder: unknown = record
    ? Object.fromEntries(Object.entries(record).filter(([key]) => !fields.some((field) => field.key === key)))
    : data;
  const render = (): unknown => {
    const output = isRecord(remainder) ? { ...remainder } : remainder;
    const clipped = kept.length < candidates.length || kept.some((line) => line.partial) || trimmedFields.size > 0;
    if (!isRecord(output)) return clipped ? { value: output, truncated: true } : output;
    if (fields.length > 0) {
      output.logProjection = Object.fromEntries(fields.map((field) => {
        const lines = kept.filter((line) => line.key === field.key).sort((left, right) => left.index - right.index);
        output[field.key] = typeof field.value === 'string' ? lines.map((line) => line.value).join('\n') : lines.map((line) => line.value);
        const retainedRanges: Array<{ startLine: number; endLine: number }> = [];
        for (const line of lines) {
          const last = retainedRanges.at(-1);
          if (last && last.endLine === line.index) last.endLine = line.index + 1;
          else retainedRanges.push({ startLine: line.index + 1, endLine: line.index + 1 });
        }
        const partialLineNumbers = lines.filter((line) => line.partial).map((line) => line.index + 1);
        return [field.key, {
          originalLineCount: field.lines.length,
          retainedRanges,
          ...(partialLineNumbers.length ? { partialLineNumbers } : {}),
        }];
      }));
    }
    if (clipped) output.truncated = true;
    if (trimmedFields.size) output.truncatedFields = [...trimmedFields].sort();
    return output;
  };

  let output = render();
  while (jsonBytes(output) > options.maxDataBytes) {
    const reduced = shrinkSection(remainder) ?? (kept.length === 0 ? shrinkSection(remainder, true) : undefined);
    if (reduced) {
      remainder = reduced.value;
      trimmedFields.add(reduced.path);
    } else if (kept.length) {
      const oversized = kept.find((line) => jsonBytes(line.value) > Math.max(128, options.maxDataBytes / 2));
      if (oversized && typeof oversized.value === 'string') {
        oversized.value = halveString(oversized.value);
        oversized.partial = true;
      } else {
        kept.pop();
      }
    } else {
      break;
    }
    output = render();
  }
  return output;
}

function halveString(value: string): string {
  const characters = Array.from(value);
  return characters.slice(0, Math.floor(characters.length / 2)).join('');
}

/** Trim text/array sections before dropping scalar facts or sibling fields. */
function shrinkSection(value: unknown, dropFields = false): { value: unknown; path: string } | undefined {
  if (typeof value === 'string' && value !== '[redacted]' && jsonBytes(value) > 32) {
    return { value: halveString(value), path: '$' };
  }
  if (Array.isArray(value) && value.length > 0) {
    return { value: value.slice(0, Math.floor(value.length / 2)), path: '$' };
  }
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  for (const [key, child] of [...entries].sort((left, right) => jsonBytes(right[1]) - jsonBytes(left[1]))) {
    const smaller = shrinkSection(child, dropFields);
    if (smaller) return { value: { ...value, [key]: smaller.value }, path: `${key}${smaller.path === '$' ? '' : `.${smaller.path}`}` };
  }
  if (dropFields && entries.length > 0) {
    return { value: Object.fromEntries(entries.slice(0, Math.floor(entries.length / 2))), path: '$' };
  }
  return undefined;
}
