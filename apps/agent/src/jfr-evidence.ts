import type { OpsEvent } from '@pi-ops/protocol';
import type { EventStore, EvidenceRecord } from './store.js';

export const JFR_EVIDENCE_KIND = 'jfr.signal';
export const JFR_MAX_MESSAGE_CHARS = 1024;
export const JFR_MAX_CONTAINER_NAME_CHARS = 256;

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

function projectAttributes(event: OpsEvent): Record<string, string | number> {
  if (event.type === 'jvm.cpu_pressure') return projectCpuPressureAttributes(event.attributes);
  return {};
}

export function projectJfrSignalEvidence(
  incident: { id: string; node_id: string },
  event: OpsEvent,
): EvidenceRecord | null {
  if (event.source !== 'jfr') return null;
  const message = boundNonEmptyString(event.message, JFR_MAX_MESSAGE_CHARS) ?? event.message.slice(0, JFR_MAX_MESSAGE_CHARS);
  const attributes = projectAttributes(event);
  const recognized = Object.keys(attributes).length > 0;
  return {
    id: jfrEvidenceId(event.id),
    incidentId: incident.id,
    nodeId: incident.node_id,
    source: 'jfr',
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
