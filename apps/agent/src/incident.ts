import type { OpsEvent } from '@pi-ops/protocol';
import type { EventStore } from './store.js';

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

function earlierTimestamp(a: string, b: string): string {
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

function laterTimestamp(a: string, b: string): string {
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
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
      const isExplicitRecovery = RECOVERY_TYPE_MAP[event.type] !== undefined;
      const existing = isExplicitRecovery
        ? store.findRecoveryIncident(fingerprint, timestamp)
        : store.findActiveIncident(fingerprint, timestamp, config.aggregationWindowMs);

      if (existing && isExplicitRecovery) {
        const linked = store.linkEventToIncident(existing.id, event.id);
        const eventCount = existing.event_count + (linked ? 1 : 0);
        store.updateIncident(existing.id, {
          first_seen: existing.first_seen,
          last_seen: laterTimestamp(existing.last_seen, timestamp),
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
        let eventCount = existing.event_count;

        // UNIQUE(event_id) prevents transport retries from double-counting.
        const linked = store.linkEventToIncident(existing.id, event.id);
        if (linked) eventCount++;

        store.updateIncident(existing.id, {
          first_seen: earlierTimestamp(existing.first_seen, timestamp),
          last_seen: laterTimestamp(existing.last_seen, timestamp),
          event_count: eventCount,
          severity: maxSeverity(existing.severity, event.severity),
          state: existing.state,
        });

        return {
          ignored: false,
          incidentId: existing.id,
          isNew: false,
          isRecovery: false,
          eventCount,
        };
      }

      // A recovery without a matching active Incident is an observation, not a
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