import { it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpsEvent } from '@pi-ops/protocol';
import { createEventStore } from '../store.js';
import { createIncidentEngine } from '../incident.js';
import { computeFingerprint } from '../fingerprint.js';
import { buildNotificationJob, incidentFactsFromRow } from '../notification.js';

it('does not rewrite new episode fingerprints when the configured operation list changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'notify-policy-change-'));
  const path = join(directory, 'agent.sqlite');
  let store = createEventStore(path);
  const event: OpsEvent = { schemaVersion: 1, id: 'new-event', time: '2026-10-21T02:00:00.000Z', source: 'application', nodeId: 'node', service: 'dataasset', type: 'business.error', severity: 'error', message: 'failed', attributes: { operation: 'GET /auth/authClientInfo', module: '/auth/authClientInfo', exceptionClass: 'java.lang.IllegalStateException' } };
  try {
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    store.processBatch({ producer: { id: 'app', type: 'application', version: '1' }, events: [event] }, event.time, (item) => engine.processEvent(item, item.time));
    const before = store.listIncidents()[0]!;
    store.close();
    store = createEventStore(path, { defaultUnknownImpactWaitMs: 1000, defaultObservationMaxGapMs: 1000, services: {}, healthRules: [] });
    assert.equal(store.getIncident(before.id)?.fingerprint, before.fingerprint);
    const next = { ...event, id: 'new-event-after-config-change', time: '2026-10-21T02:01:00.000Z' };
    const restarted = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    store.processBatch({ producer: { id: 'app', type: 'application', version: '1' }, events: [next] }, next.time, (item) => restarted.processEvent(item, item.time));
    assert.equal(store.findIncidentByEventId(next.id)?.id, before.id);
    assert.equal(store.listNotificationJobs(before.id).length, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('adds legacy markers without reevaluating old incidents or changing old queue payloads', () => {
  const directory = mkdtempSync(join(tmpdir(), 'notify-legacy-'));
  const path = join(directory, 'agent.sqlite');
  let store = createEventStore(path);
  const event: OpsEvent = { schemaVersion: 1, id: 'legacy-event', time: '2026-10-21T02:00:00.000Z', source: 'health', nodeId: 'legacy-node', service: 'legacy-service', type: 'health.failure', severity: 'error', message: 'failed', attributes: { target: 'legacy-service', url: 'http://legacy/health', method: 'GET' } };
  try {
    store.insertBatch({ producer: { id: 'node', type: 'node-agent', version: '1' }, events: [event] }, event.time);
    const incident = store.createIncident({ node_id: event.nodeId, service: event.service, type: event.type, state: 'OPEN', fingerprint: computeFingerprint(event, 1), first_seen: event.time, last_seen: event.time, event_count: 1, severity: event.severity });
    store.linkEventToIncident(incident.id, event.id);
    const job = buildNotificationJob({ type: 'INCIDENT_OPEN', incident: incidentFactsFromRow(incident), evidenceIds: [], now: event.time });
    store.scheduleNotificationJob(job);
    store.close();
    const db = new Database(path);
    db.exec('DROP TABLE notification_decisions; DROP INDEX idx_notification_new_completed; ALTER TABLE notification_jobs DROP COLUMN policy_version; ALTER TABLE notification_jobs DROP COLUMN decision_json; ALTER TABLE incidents DROP COLUMN notification_policy_version; ALTER TABLE incidents DROP COLUMN fingerprint_version;');
    db.close();
    store = createEventStore(path);
    store.reconcileNotifications();
    assert.equal(store.getNotificationDecision(incident.id), undefined);
    assert.deepEqual(store.listNotificationJobs(incident.id), [job]);
    const engine = createIncidentEngine(store, { aggregationWindowMs: 300_000 });
    const next = { ...event, id: 'legacy-event-2', time: '2026-10-21T02:00:01.000Z' };
    store.processBatch({ producer: { id: 'node', type: 'node-agent', version: '1' }, events: [next] }, next.time, (item) => engine.processEvent(item, item.time));
    assert.equal(store.findIncidentByEventId(next.id)?.id, incident.id);
    assert.equal(store.getNotificationDecision(incident.id), undefined);
    assert.deepEqual(store.listNotificationJobs(incident.id), [job]);
    const recovery = { ...event, id: 'legacy-unmatched-recovery', type: 'health.recovered', time: '2026-10-21T02:00:02.000Z' };
    store.insertBatch({ producer: { id: 'node', type: 'node-agent', version: '1' }, events: [recovery] }, recovery.time);
    store.markEventProcessed(recovery.id, recovery.time);
    store.close();
    store = createEventStore(path);
    createIncidentEngine(store, { aggregationWindowMs: 300_000 }).reconcilePendingRecoveries();
    assert.equal(store.getIncident(incident.id)?.state, 'RECOVERED');
    const check = new Database(path, { readonly: true });
    assert.deepEqual(check.prepare('SELECT notification_policy_version, fingerprint_version FROM incidents WHERE id = ?').get(incident.id), { notification_policy_version: 'legacy', fingerprint_version: 1 });
    assert.equal((check.prepare('SELECT policy_version FROM notification_jobs WHERE id = ?').get(job.id) as { policy_version: string }).policy_version, 'legacy');
    check.close();
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
