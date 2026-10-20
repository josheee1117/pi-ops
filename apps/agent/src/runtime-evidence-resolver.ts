import { planEvidenceQueries, resolveDockerEvidenceQuery } from './evidence-orchestrator.js';
import type { IncidentRow } from './store.js';
import type {
  EvidenceQueryRequest,
  OpsEvent,
  RuntimeEvidenceType,
} from '@pi-ops/protocol';

/**
 * Pi-Ops owns evidence targets. Pi Runtime only names a capability class.
 * Host capabilities resolve against Incident.node_id. Container and HTTP
 * capabilities resolve only from stored Event metadata. Docker requests share
 * the initial planner's target/log-window policy, but are not limited to the
 * initial query set. HTTP still requires a trusted health detector URL.
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
  if (evidenceType === 'docker.inspect' || evidenceType === 'docker.stats' || evidenceType === 'docker.logs') {
    return resolveDockerEvidenceQuery(incident, trustedTriggeringEvent, evidenceType, logsMaxLines);
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
