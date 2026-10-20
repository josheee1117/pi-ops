import { validateOpsEvent, type OpsEvent } from '@pi-ops/protocol';
import { projectJfrSignalEvidence } from './jfr-evidence.js';
import type { FirstNotificationFacts, NotificationObservation } from './notification-policy.js';
import type { EventStore, IncidentRow, StoredEvent } from './store.js';

/**
 * Read-only map from persisted events to first-notification facts.
 * producer_type and source are declarations accepted by the shared Bearer
 * entry. Consistency is not authentication of the producer, JFR, or Docker.
 */
export type NotificationFactReadStore =
  Pick<EventStore, 'getIncident' | 'getEvent' | 'findIncidentByEventId'>;

export interface StoredNotificationFactRequest {
  incidentId: string;
  eventIds: readonly string[];
}

const UNKNOWN = { kind: 'unknown' } as const;

interface QualifiedEvent {
  id: string;
  time: number;
  stored: StoredEvent;
  event: OpsEvent | undefined;
  attributes: Record<string, unknown> | undefined;
}

export function buildFirstNotificationFactsFromStore(
  store: NotificationFactReadStore,
  request: StoredNotificationFactRequest,
): FirstNotificationFacts {
  const incident = store.getIncident(request.incidentId);
  if (!incident) return { observations: [] };
  const first = parsedTime(incident.first_seen);
  const last = parsedTime(incident.last_seen);
  if (first === undefined || last === undefined) return { observations: [] };

  const qualified: QualifiedEvent[] = [];
  for (const id of new Set(request.eventIds)) {
    const stored = store.getEvent(id);
    if (!stored || !supported(stored)) continue;
    const linked = store.findIncidentByEventId(id);
    if (!linked || linked.id !== incident.id) continue;
    if (stored.node_id !== incident.node_id || stored.service !== incident.service) continue;
    const time = parsedTime(stored.event_time);
    if (time === undefined || time < first || time > last) continue;
    const attributes = parseAttributes(stored.attributes);
    qualified.push({
      id,
      time,
      stored,
      attributes,
      event: attributes ? toOpsEvent(stored, attributes) : undefined,
    });
  }
  qualified.sort((left, right) => left.time - right.time || compareId(left.id, right.id));

  const observations: NotificationObservation[] = [];
  for (const item of qualified) observations.push(...observationsFor(incident, item));
  return { observations };
}

function supported(stored: StoredEvent): boolean {
  if (stored.producer_type === 'application' && stored.source === 'jfr' && stored.type === 'jvm.oom') return true;
  if (stored.producer_type === 'application' && stored.type === 'business.error'
    && (stored.source === 'jfr' || stored.source === 'application')) return true;
  if (stored.producer_type === 'node-agent' && stored.source === 'docker'
    && (stored.type === 'container.oom' || stored.type === 'container.die')) return true;
  return stored.producer_type === 'node-agent' && stored.source === 'health' && stored.type === 'health.failure';
}

function observationsFor(incident: IncidentRow, item: QualifiedEvent): NotificationObservation[] {
  const source = { kind: 'event' as const, id: item.id };
  if (item.stored.type === 'business.error') {
    const exception = item.event ? oomeObservation(incident, item.event) : undefined;
    return exception ? [ordinary(source), exception] : [ordinary(source)];
  }
  if (item.stored.type === 'jvm.oom') {
    const exception = item.event ? exceptionObservation(incident, item.event) : undefined;
    return exception ? [exception] : [];
  }
  if (item.stored.source === 'docker') {
    if (!item.attributes || !item.event || metadataConflicts(incident, item.attributes)) return [];
    return [dockerObservation(item.id, item.attributes)];
  }
  if (item.stored.source === 'health') {
    return [{ kind: 'health', binding: { kind: 'missing' }, transition: { kind: 'failure' }, source }];
  }
  return [];
}

function ordinary(source: NotificationObservation['source']): NotificationObservation {
  return {
    kind: 'ordinary-error',
    persistence: UNKNOWN,
    impact: UNKNOWN,
    failures: UNKNOWN,
    requests: UNKNOWN,
    logLines: UNKNOWN,
    source,
  };
}

function exceptionObservation(incident: IncidentRow, event: OpsEvent): NotificationObservation | undefined {
  const fields = projectedException(incident, event);
  if (!fields) return undefined;
  return { kind: 'jvm-exception', ...fields, source: { kind: 'event', id: event.id } };
}

function oomeObservation(incident: IncidentRow, event: OpsEvent): NotificationObservation | undefined {
  const fields = projectedException(incident, event);
  if (!fields || fields.exceptionClass !== 'java.lang.OutOfMemoryError') return undefined;
  if (fields.exceptionMessage.trim().length === 0 && fields.stackTrace.trim().length === 0) return undefined;
  return { kind: 'jvm-exception', ...fields, source: { kind: 'event', id: event.id } };
}

function projectedException(
  incident: IncidentRow,
  event: OpsEvent,
): { exceptionClass: string; exceptionMessage: string; stackTrace: string } | undefined {
  const projected = projectJfrSignalEvidence({ id: incident.id, node_id: incident.node_id }, event);
  if (!projected || !isRecord(projected.data)) return undefined;
  const attributes = projected.data.attributes;
  if (!isRecord(attributes)) return undefined;
  const exceptionClass = attributes.exceptionClass;
  if (typeof exceptionClass !== 'string' || exceptionClass.length === 0) return undefined;
  const exceptionMessage = typeof attributes.exceptionMessage === 'string' ? attributes.exceptionMessage : '';
  const primary = typeof attributes.stackTrace === 'string' ? attributes.stackTrace : '';
  const extended = realExceptionStack(attributes.jfrStackTrace) ?? realExceptionStack(attributes.exceptionStackTrace) ?? '';
  return { exceptionClass, exceptionMessage, stackTrace: primary || extended };
}

function dockerObservation(id: string, attributes: Record<string, unknown>): NotificationObservation {
  const exitCode = attributes.exitCode;
  return {
    kind: 'docker',
    dockerAction: typeof attributes.dockerAction === 'string' ? attributes.dockerAction : '',
    oomKilled: attributes.oomKilled === true,
    exitCode: typeof exitCode === 'number' && Number.isInteger(exitCode)
      ? { kind: 'known', value: exitCode }
      : { kind: 'absent' },
    source: { kind: 'event', id },
  };
}

function metadataConflicts(incident: IncidentRow, attributes: Record<string, unknown>): boolean {
  return conflicts(attributes.containerName, incident.service)
    || conflicts(attributes.service, incident.service)
    || conflicts(attributes.nodeId, incident.node_id);
}

function conflicts(value: unknown, expected: string): boolean {
  return typeof value === 'string' && value.length > 0 && value !== expected;
}

function realExceptionStack(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/(?:^|\n)\s*at\s+\S+\([^)\n]*\)/.test(value)) return undefined;
  return value;
}

function parsedTime(value: string): number | undefined {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function compareId(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function parseAttributes(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toOpsEvent(stored: StoredEvent, attributes: Record<string, unknown>): OpsEvent | undefined {
  const parsed = validateOpsEvent({
    schemaVersion: stored.schema_version,
    id: stored.id,
    time: stored.event_time,
    source: stored.source,
    nodeId: stored.node_id,
    service: stored.service,
    type: stored.type,
    severity: stored.severity,
    message: stored.message,
    attributes,
    ...(stored.fingerprint !== null ? { fingerprint: stored.fingerprint } : {}),
    ...(stored.trace_id !== null ? { traceId: stored.trace_id } : {}),
  });
  return parsed.success ? parsed.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
