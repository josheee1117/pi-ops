import type { OpsEvent } from '@pi-ops/protocol';
import type { EventStore, EvidenceRecord } from './store.js';

/** Push-derived Evidence category. Reuse is not a JVM or JFR collection grant. */
export const JFR_EVIDENCE_KIND = 'jfr.signal';
export const JFR_MAX_MESSAGE_CHARS = 1024;
export const JFR_MAX_CONTAINER_NAME_CHARS = 256;
export const JFR_MAX_EXCEPTION_STACK_CHARS = 4096;

export function jfrEvidenceId(eventId: string): string {
  return `jfr-${eventId}`;
}

function cpuRatio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function boundNonEmptyString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function projectCpuPressureAttributes(raw: Record<string, unknown>): Record<string, string | number> {
  const attributes: Record<string, string | number> = {};
  if (cpuRatio(raw.jvmUser)) attributes.jvmUser = raw.jvmUser;
  if (cpuRatio(raw.jvmSystem)) attributes.jvmSystem = raw.jvmSystem;
  if (cpuRatio(raw.machineTotal)) attributes.machineTotal = raw.machineTotal;
  const containerName = boundNonEmptyString(raw.containerName, JFR_MAX_CONTAINER_NAME_CHARS);
  if (containerName) attributes.containerName = containerName;
  return attributes;
}

function projectObservationMetadata(raw: Record<string, unknown>): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const field of ['containerName', 'jfrEventName'] as const) {
    const value = boundNonEmptyString(raw[field], 256);
    if (value) attributes[field] = value;
  }
  for (const field of ['jfrStartTime', 'jfrEndTime'] as const) {
    const value = raw[field];
    if (typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))) {
      attributes[field] = value;
    }
  }
  return attributes;
}

function projectAttributes(event: OpsEvent): Record<string, string | number> {
  if (event.type === 'jvm.cpu_pressure') {
    return { ...projectObservationMetadata(event.attributes), ...projectCpuPressureAttributes(event.attributes) };
  }
  if (event.type !== 'jvm.oom' && event.type !== 'business.error') return {};
  const attributes = projectObservationMetadata(event.attributes);
  // Match actual RecordingStream consumer field names; stacks are observations, not allocation hotspots.
  for (const [field, limit] of [
    ['exceptionClass', 256], ['exceptionMessage', 1024],
    ['stackTrace', JFR_MAX_EXCEPTION_STACK_CHARS], ['jfrStackTrace', JFR_MAX_EXCEPTION_STACK_CHARS],
    ...(event.type === 'business.error'
      ? [['operation', 256] as const, ['exceptionStackTrace', JFR_MAX_EXCEPTION_STACK_CHARS] as const]
      : []),
  ] as ReadonlyArray<readonly [string, number]>) {
    const value = boundNonEmptyString(event.attributes[field], limit);
    if (value) attributes[field] = value;
  }
  if (attributes.exceptionClass && !/^[\w$]+(?:\.[\w$]+)+$/.test(attributes.exceptionClass)) {
    delete attributes.exceptionClass;
  }
  return attributes;
}

function nonBlank(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function realExceptionStack(value: unknown): boolean {
  return typeof value === 'string' && /(?:^|\n)\s*at\s+\S+\([^)\n]*\)/.test(value);
}

function hasExceptionFact(attributes: unknown, oom: boolean): boolean {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return false;
  const record = attributes as Record<string, unknown>;
  const clazz = record.exceptionClass;
  const classOk = typeof clazz === 'string' && clazz.length <= 256
    && (oom ? clazz === 'java.lang.OutOfMemoryError' : /^[\w$]+(?:\.[\w$]+)+$/.test(clazz));
  if (!classOk) return false;
  if ([record.exceptionMessage, record.stackTrace].some(nonBlank)) return true;
  return !oom && realExceptionStack(record.exceptionStackTrace);
}

/** Diagnostic CPU metrics. `containerName` is metadata and never decides recognition. */
const CPU_DIAGNOSTIC_FIELDS = ['jvmUser', 'jvmSystem', 'machineTotal'] as const;

function hasDiagnosticCpuFact(attributes: unknown): boolean {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return false;
  const record = attributes as Record<string, unknown>;
  return CPU_DIAGNOSTIC_FIELDS.some((field) => cpuRatio(record[field]));
}

/**
 * Single source of truth for "is this JFR semantic payload recognized?".
 * Shared by the projector (to stamp `semanticType`) and Evidence Intelligence
 * (to decide `primary_signal`), so the two can never disagree.
 */
export function recognizedJfrSemantic(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  if (record.eventType !== undefined && record.eventType !== record.semanticType) return false;
  switch (record.semanticType) {
    case 'jvm.cpu_pressure':
      return hasDiagnosticCpuFact(record.attributes);
    case 'jvm.oom':
      return record.eventType === 'jvm.oom' && hasExceptionFact(record.attributes, true);
    case 'business.error':
      return record.eventType === 'business.error' && hasExceptionFact(record.attributes, false);
    default:
      return false;
  }
}

export function projectJfrSignalEvidence(
  incident: { id: string; node_id: string },
  event: OpsEvent,
): EvidenceRecord | null {
  const applicationBusinessError = event.source === 'application' && event.type === 'business.error';
  if (event.source !== 'jfr' && !applicationBusinessError) return null;
  const message = boundNonEmptyString(event.message, JFR_MAX_MESSAGE_CHARS) ?? event.message.slice(0, JFR_MAX_MESSAGE_CHARS);
  const attributes = projectAttributes(event);
  const recognized = recognizedJfrSemantic({ eventType: event.type, semanticType: event.type, attributes });
  if (applicationBusinessError && !recognized) return null;
  return {
    id: jfrEvidenceId(event.id),
    incidentId: incident.id,
    nodeId: incident.node_id,
    source: event.source,
    kind: JFR_EVIDENCE_KIND,
    collectedAt: event.time,
    status: 'succeeded',
    data: {
      eventId: event.id,
      eventType: event.type,
      observedAt: event.time,
      ...(event.traceId ? { traceId: event.traceId } : {}),
      message,
      attributes,
      ...(recognized ? { semanticType: event.type } : {}),
    },
  };
}

export function persistJfrSignalEvidence(
  store: Pick<EventStore, 'insertEvidence'>,
  incident: { id: string; node_id: string },
  event: OpsEvent,
): void {
  const evidence = projectJfrSignalEvidence(incident, event);
  if (!evidence) return;
  store.insertEvidence(evidence);
}
