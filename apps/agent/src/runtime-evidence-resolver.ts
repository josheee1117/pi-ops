import { planEvidenceQueries } from './evidence-orchestrator.js';
import type { IncidentRow } from './store.js';
import type {
  EvidenceQueryRequest,
  OpsEvent,
  RuntimeEvidenceType,
} from '@pi-ops/protocol';

/**
 * Pi-Ops owns evidence targets. Pi Runtime only names a capability class.
 * Host capabilities resolve against Incident.node_id. Container and HTTP
 * capabilities resolve only from trusted Event/Incident metadata through the
 * existing deterministic planner, which also owns the bounded docker.logs
 * window and maxLines policy.
 */
export function resolveRuntimeEvidenceQuery(
  incident: IncidentRow,
  trustedTriggeringEvent: OpsEvent,
  evidenceType: RuntimeEvidenceType,
  logsMaxLines: number,
): EvidenceQueryRequest | undefined {
  if (evidenceType === 'host.memory' || evidenceType === 'host.load') {
    return { type: evidenceType, incidentId: incident.id };
  }
  const planned = planEvidenceQueries(incident, trustedTriggeringEvent, logsMaxLines);
  return planned.find((entry) => entry.type === evidenceType);
}

export function trustedTriggeringEventFor(
  incident: IncidentRow,
  storedEvent: OpsEvent | undefined,
): OpsEvent {
  if (storedEvent) return storedEvent;
  return {
    schemaVersion: 1,
    id: `evt-synth-${incident.id}`,
    time: incident.last_seen,
    source: 'application',
    nodeId: incident.node_id,
    service: incident.service,
    type: incident.type,
    severity: 'warning',
    message: incident.type,
    attributes: {},
  };
}
