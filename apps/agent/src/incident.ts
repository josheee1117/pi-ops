import type { OpsEvent } from '@pi-ops/protocol';
import type { EventStore, IncidentState } from './store.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface IncidentConfig {
  /** Aggregation window in milliseconds. */
  aggregationWindowMs: number;
}

export type IncidentResult =
  | {
      ignored: false;
      incidentId: string;
      isNew: boolean;
      isRecovery: boolean;
      eventCount: number;
    }
  | {
      ignored: true;
      incidentId: null;
      isNew: false;
      isRecovery: false;
      eventCount: 0;
    };

// ── Severity ordering (higher index = more severe) ───────────────────────────

const SEVERITY_ORDER: Record<string, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
};

function maxSeverity(a: string, b: string): string {
  return (SEVERITY_ORDER[a] ?? 0) >= (SEVERITY_ORDER[b] ?? 0) ? a : b;
}

const RECOVERY_TYPE_MAP: Readonly<Record<string, string>> = {
  'health.recovered': 'health.failure',
  'host.memory_recovered': 'host.memory_pressure',
  'host.disk_recovered': 'host.disk_pressure',
};

// ── Fingerprint ──────────────────────────────────────────────────────────────

/**
 * Compute a deterministic fingerprint from stable event dimensions.
 * Uses the event-provided fingerprint if available, otherwise derives from
 * (source, nodeId, service, type). Never includes timestamps or random data.
 */
export function computeFingerprint(event: OpsEvent): string {
  const canonicalType = RECOVERY_TYPE_MAP[event.type] ?? event.type;
  return event.fingerprint ?? `${event.source}:${event.nodeId}:${event.service}:${canonicalType}`;
}

// ── Recovery detection ───────────────────────────────────────────────────────

/**
 * An event indicates recovery if its severity is lower than the incident's
 * current severity. This matches the pattern: error → info = recovered.
 * Recovery must match by fingerprint, not just service.
 */
function isRecoveryFor(event: OpsEvent, incidentSeverity: string): boolean {
  const eventOrder = SEVERITY_ORDER[event.severity] ?? 0;
  const incidentOrder = SEVERITY_ORDER[incidentSeverity] ?? 0;
  return eventOrder < incidentOrder;
}

// ── Engine ───────────────────────────────────────────────────────────────────

export interface IncidentEngine {
  /** Process an event through the incident engine. */
  processEvent(event: OpsEvent, timestamp: string): IncidentResult;
}

export function createIncidentEngine(
  store: EventStore,
  config: IncidentConfig,
): IncidentEngine {
  return {
    processEvent(event: OpsEvent, timestamp: string): IncidentResult {
      // Transport retry guard: an immutable Event can belong to only one
      // Incident, regardless of time window or current Incident state.
      const linkedIncident = store.findIncidentByEventId(event.id);
      if (linkedIncident) {
        return {
          ignored: false,
          incidentId: linkedIncident.id,
          isNew: false,
          isRecovery: false,
          eventCount: linkedIncident.event_count,
        };
      }

      const fingerprint = computeFingerprint(event);
      const existing = store.findOpenIncident(fingerprint);
      const isExplicitRecovery = RECOVERY_TYPE_MAP[event.type] !== undefined;

      if (existing && isExplicitRecovery) {
        const linked = store.linkEventToIncident(existing.id, event.id);
        const eventCount = existing.event_count + (linked ? 1 : 0);
        store.updateIncident(existing.id, {
          last_seen: timestamp,
          event_count: eventCount,
          severity: existing.severity,
          state: 'RECOVERED',
        });
        return {
          ignored: false,
          incidentId: existing.id,
          isNew: false,
          isRecovery: true,
          eventCount,
        };
      }

      if (existing) {
        // Check if within aggregation window
        const lastSeenMs = new Date(existing.last_seen).getTime();
        const eventTimeMs = new Date(timestamp).getTime();
        const withinWindow = (eventTimeMs - lastSeenMs) <= config.aggregationWindowMs;

        let incidentId: string;
        let isNew: boolean;
        let eventCount: number;

        if (withinWindow) {
          // Aggregate into existing incident
          incidentId = existing.id;
          isNew = false;
          eventCount = existing.event_count;

          // Try to link event to incident (UNIQUE on event_id prevents double-counting)
          const linked = store.linkEventToIncident(incidentId, event.id);
          if (linked) {
            eventCount = existing.event_count + 1;
          }

          store.updateIncident(incidentId, {
            last_seen: timestamp,
            event_count: eventCount,
            severity: maxSeverity(existing.severity, event.severity),
            state: existing.state,
          });
        } else {
          // Outside window: create new incident
          const newIncident = store.createIncidentFromEvent({
            service: event.service,
            node_id: event.nodeId,
            type: event.type,
            state: 'OPEN',
            fingerprint,
            first_seen: timestamp,
            last_seen: timestamp,
            event_count: 1,
            severity: event.severity,
          }, event);
          return {
            ignored: false,
            incidentId: newIncident.id,
            isNew: true,
            isRecovery: false,
            eventCount: 1,
          };
        }

        // Check recovery: only if event severity is lower than incident's
        if (isRecoveryFor(event, existing.severity)) {
          store.updateIncident(incidentId, {
            last_seen: timestamp,
            event_count: eventCount,
            severity: maxSeverity(existing.severity, event.severity),
            state: 'RECOVERED',
          });
          return {
            ignored: false,
            incidentId,
            isNew: false,
            isRecovery: true,
            eventCount,
          };
        }

        return {
          ignored: false,
          incidentId,
          isNew: false,
          isRecovery: false,
          eventCount,
        };
      }

      // A recovery without a matching OPEN Incident is an observation, not a
      // new failure Incident.
      if (isExplicitRecovery) {
        return {
          ignored: true,
          incidentId: null,
          isNew: false,
          isRecovery: false,
          eventCount: 0,
        };
      }

      // No existing incident: create new
      const newIncident = store.createIncidentFromEvent({
        service: event.service,
        node_id: event.nodeId,
        type: event.type,
        state: 'OPEN',
        fingerprint,
        first_seen: timestamp,
        last_seen: timestamp,
        event_count: 1,
        severity: event.severity,
      }, event);

      return {
        ignored: false,
        incidentId: newIncident.id,
        isNew: true,
        isRecovery: false,
        eventCount: 1,
      };
    },
  };
}