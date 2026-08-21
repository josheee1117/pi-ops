import type { OpsEvent } from '@pi-ops/protocol';
import type { EventStore } from './store.js';
import { computeFingerprint, RECOVERY_TYPE_MAP } from './fingerprint.js';

export { computeFingerprint } from './fingerprint.js';

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
  /** Reconcile every durable unmatched recovery against existing Incidents. */
  reconcilePendingRecoveries(): void;
}

export function createIncidentEngine(
  store: EventStore,
  config: IncidentConfig,
): IncidentEngine {
  function applyRecovery(incidentId: string, recovery: OpsEvent): boolean {
    return store.applyRecovery(incidentId, recovery);
  }

  function reconcileFingerprint(fingerprint: string): void {
    while (true) {
      const matches = store.listPendingRecoveries(fingerprint).map((recovery) => ({
        recovery,
        incident: store.findRecoveryIncident(fingerprint, recovery.time),
      }));
      let progress = false;
      for (const { recovery, incident } of matches) {
        if (incident && applyRecovery(incident.id, recovery)) progress = true;
      }
      if (!progress) return;
    }
  }

  return {
    reconcilePendingRecoveries(): void {
      for (const fingerprint of store.listPendingRecoveryFingerprints()) {
        reconcileFingerprint(fingerprint);
      }
    },

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
        : store.findIncidentForEvent(fingerprint, timestamp, config.aggregationWindowMs);

      if (existing && isExplicitRecovery) {
        reconcileFingerprint(fingerprint);
        applyRecovery(existing.id, event);
        return {
          ignored: false,
          incidentId: existing.id,
          isNew: false,
          isRecovery: true,
          eventCount: store.getIncident(existing.id)?.event_count ?? existing.event_count,
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

        reconcileFingerprint(fingerprint);
        return {
          ignored: false,
          incidentId: existing.id,
          isNew: false,
          isRecovery: false,
          eventCount: store.getIncident(existing.id)?.event_count ?? eventCount,
        };
      }

      // Persist unmatched recovery for deterministic reconciliation when the
      // causally earlier failure arrives later through transport.
      if (isExplicitRecovery) {
        store.addPendingRecovery(event, fingerprint);
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
      reconcileFingerprint(fingerprint);

      return {
        ignored: false,
        incidentId: newIncident.id,
        isNew: true,
        isRecovery: false,
        eventCount: store.getIncident(newIncident.id)?.event_count ?? 1,
      };
    },
  };
}