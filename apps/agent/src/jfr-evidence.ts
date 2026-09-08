import type { OpsEvent } from '@pi-ops/protocol';
import type { EventStore, EvidenceRecord } from './store.js';

export const JFR_EVIDENCE_KIND = 'jfr.signal';

/** Known JFR types → primitive attributes that already exist on the DataAsset wire. */
const ATTRIBUTE_ALLOWLIST: Record<string, readonly string[]> = {
  'jvm.cpu_pressure': ['jvmUser', 'jvmSystem', 'machineTotal', 'containerName'],
};

export function jfrEvidenceId(eventId: string): string {
  return `jfr-${eventId}`;
}

function projectAttributes(event: OpsEvent): Record<string, string | number | boolean> {
  const keys = ATTRIBUTE_ALLOWLIST[event.type];
  if (!keys) return {};
  const attributes: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    const value = event.attributes[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attributes[key] = value;
    }
  }
  return attributes;
}

export function projectJfrSignalEvidence(
  incident: { id: string; node_id: string },
  event: OpsEvent,
): EvidenceRecord | null {
  if (event.source !== 'jfr') return null;
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
      message: event.message,
      attributes: projectAttributes(event),
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
