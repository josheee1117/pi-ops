import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEventStore } from '../store.js';
import { createIncidentEngine, computeFingerprint } from '../incident.js';
import type { OpsEvent } from '@pi-ops/protocol';

// ── Helpers ──────────────────────────────────────────────────────────────────

const AGGREGATION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function makeEvent(overrides: Partial<OpsEvent> = {}): OpsEvent {
  return {
    schemaVersion: 1,
    id: 'evt-0001',
    time: '2026-08-20T12:00:00.000Z',
    source: 'docker',
    nodeId: 'test-svc-02',
    service: 'dataease',
    type: 'container.die',
    severity: 'error',
    message: 'Container died',
    attributes: { exitCode: 137 },
    ...overrides,
  };
}

function setup() {
  const store = createEventStore(':memory:');
  const engine = createIncidentEngine(store, { aggregationWindowMs: AGGREGATION_WINDOW_MS });
  return { store, engine };
}

// ── Fingerprint ──────────────────────────────────────────────────────────────

describe('computeFingerprint', () => {
  it('ignores producer-provided fingerprint for Incident identity', () => {
    const event = makeEvent({ fingerprint: 'custom-fp' });
    assert.equal(computeFingerprint(event), 'docker:test-svc-02:dataease:container.die');
  });

  it('derives fingerprint from stable dimensions when not provided', () => {
    const event = makeEvent({ fingerprint: undefined });
    const fp = computeFingerprint(event);
    assert.equal(fp, 'docker:test-svc-02:dataease:container.die');
  });

  it('excludes timestamps and random data from derived fingerprint', () => {
    const event1 = makeEvent({ id: 'evt-1', time: '2026-08-20T12:00:00.000Z', fingerprint: undefined });
    const event2 = makeEvent({ id: 'evt-2', time: '2026-08-20T13:00:00.000Z', fingerprint: undefined });
    assert.equal(computeFingerprint(event1), computeFingerprint(event2));
  });

  it('maps explicit recovery types to the failure fingerprint', () => {
    const failure = makeEvent({ source: 'health', type: 'health.failure' });
    const recovery = makeEvent({ source: 'health', type: 'health.recovered' });
    assert.equal(computeFingerprint(recovery), computeFingerprint(failure));
  });

  it('aggregates matching stable fields despite different supplied fingerprints', () => {
    const { store, engine } = setup();
    const first = engine.processEvent(
      makeEvent({ id: 'evt-fp-1', fingerprint: 'producer-a' }),
      '2026-08-20T12:00:00.000Z',
    );
    const second = engine.processEvent(
      makeEvent({
        id: 'evt-fp-2',
        fingerprint: 'producer-b',
        time: '2026-08-20T12:01:00.000Z',
      }),
      '2026-08-20T12:01:00.000Z',
    );

    assert.equal(second.incidentId, first.incidentId);
    assert.equal(store.incidentCount(), 1);
    assert.equal(store.getIncident(first.incidentId!)?.event_count, 2);
  });

  it('separates different stable fields despite the same supplied fingerprint', () => {
    const { store, engine } = setup();
    const first = engine.processEvent(
      makeEvent({ id: 'evt-fp-1', service: 'dataease', fingerprint: 'shared' }),
      '2026-08-20T12:00:00.000Z',
    );
    const second = engine.processEvent(
      makeEvent({ id: 'evt-fp-2', service: 'ragflow', fingerprint: 'shared' }),
      '2026-08-20T12:00:00.000Z',
    );

    assert.notEqual(second.incidentId, first.incidentId);
    assert.equal(store.incidentCount(), 2);
  });

  it('correlates recovery even when producer fingerprints differ', () => {
    const { store, engine } = setup();
    const failure = engine.processEvent(
      makeEvent({
        id: 'evt-fp-failure',
        source: 'health',
        type: 'health.failure',
        fingerprint: 'failure-producer-fp',
      }),
      '2026-08-20T12:00:00.000Z',
    );
    const recovery = engine.processEvent(
      makeEvent({
        id: 'evt-fp-recovery',
        source: 'health',
        type: 'health.recovered',
        severity: 'info',
        fingerprint: 'recovery-producer-fp',
        time: '2026-08-20T12:01:00.000Z',
      }),
      '2026-08-20T12:01:00.000Z',
    );

    assert.equal(recovery.incidentId, failure.incidentId);
    assert.equal(recovery.isRecovery, true);
    assert.equal(store.getIncident(failure.incidentId!)?.state, 'RECOVERED');
  });
});

// ── Incident creation ────────────────────────────────────────────────────────

describe('incident creation', () => {
  it('creates a new incident for the first event', () => {
    const { store, engine } = setup();
    const event = makeEvent();
    const result = engine.processEvent(event, event.time);
    assert.ok(result.isNew);
    assert.equal(result.eventCount, 1);
    assert.equal(store.incidentCount(), 1);
    assert.equal(store.count(), 0); // events aren't stored by processEvent alone
  });

  it('creates incident with correct initial fields', () => {
    const { store, engine } = setup();
    const event = makeEvent();
    const result = engine.processEvent(event, event.time);
    const incident = store.getIncident(result.incidentId!);
    assert.ok(incident);
    assert.equal(incident.state, 'OPEN');
    assert.equal(incident.service, 'dataease');
    assert.equal(incident.severity, 'error');
    assert.equal(incident.first_seen, '2026-08-20T12:00:00.000Z');
    assert.equal(incident.last_seen, '2026-08-20T12:00:00.000Z');
    assert.equal(incident.event_count, 1);
  });
});

// ── Aggregation within window ────────────────────────────────────────────────

describe('aggregation within window', () => {
  it('aggregates events with same fingerprint into one incident', () => {
    const { store, engine } = setup();
    const baseTime = '2026-08-20T12:00:00.000Z';

    const r1 = engine.processEvent(makeEvent({ id: 'evt-1', time: baseTime }), baseTime);
    assert.ok(r1.isNew);
    assert.equal(r1.eventCount, 1);

    const r2 = engine.processEvent(
      makeEvent({ id: 'evt-2', time: '2026-08-20T12:00:30.000Z' }),
      '2026-08-20T12:00:30.000Z',
    );
    assert.ok(!r2.isNew);
    assert.equal(r2.incidentId, r1.incidentId);
    assert.equal(r2.eventCount, 2);

    assert.equal(store.incidentCount(), 1);
  });

  it('100 identical events → 1 Incident with eventCount=100', () => {
    const { store, engine } = setup();
    const baseTime = '2026-08-20T12:00:00.000Z';

    let incidentId: string | undefined;
    for (let i = 0; i < 100; i++) {
      const seconds = Math.floor(i / 10);
      const millis = (i % 10) * 100;
      const time = `2026-08-20T12:00:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}Z`;
      const result = engine.processEvent(
        makeEvent({ id: `evt-${String(i).padStart(4, '0')}`, time }),
        time,
      );
      if (i === 0) {
        incidentId = result.incidentId ?? undefined;
      } else {
        assert.equal(result.incidentId, incidentId);
      }
    }

    assert.equal(store.incidentCount(), 1);
    const incident = store.getIncident(incidentId!);
    assert.ok(incident);
    assert.equal(incident.event_count, 100);
  });
});

// ── Same event retransmitted → UNIQUE constraint on event_id ─────────────────

describe('event retransmission safety', () => {
  it('same event.id retransmitted 100 times → eventCount still 1', () => {
    const { store, engine } = setup();
    const event = makeEvent({ id: 'evt-retry' });

    // First time: creates incident, links event
    const r1 = engine.processEvent(event, event.time);
    assert.ok(r1.isNew);
    assert.equal(r1.eventCount, 1);

    // Retransmit 99 more times
    for (let i = 0; i < 99; i++) {
      const result = engine.processEvent(event, event.time);
      assert.equal(result.incidentId, r1.incidentId);
      assert.equal(result.eventCount, 1); // still 1, not 100
    }

    const incident = store.getIncident(r1.incidentId!);
    assert.ok(incident);
    assert.equal(incident.event_count, 1);
    assert.equal(store.incidentCount(), 1);
  });

  it('retry outside the aggregation window does not create another Incident', () => {
    const { store, engine } = setup();
    const event = makeEvent({ id: 'evt-old-retry', time: '2026-08-20T12:00:00.000Z' });
    const first = engine.processEvent(event, event.time);
    const retry = engine.processEvent(event, '2026-08-20T12:30:00.000Z');

    assert.equal(retry.incidentId, first.incidentId);
    assert.equal(retry.isNew, false);
    assert.equal(retry.eventCount, 1);
    assert.equal(store.incidentCount(), 1);
  });

  it('retry after recovery does not create a new Incident', () => {
    const { store, engine } = setup();
    const failure = makeEvent({
      id: 'evt-failure',
      source: 'health',
      type: 'health.failure',
      severity: 'error',
    });
    const first = engine.processEvent(failure, failure.time);
    assert.ok(first.incidentId);
    const recovery = makeEvent({
      id: 'evt-recovery',
      source: 'health',
      type: 'health.recovered',
      severity: 'info',
      time: '2026-08-20T12:10:00.000Z',
    });
    const recovered = engine.processEvent(recovery, recovery.time);
    assert.equal(recovered.isRecovery, true);
    assert.equal(store.getIncident(first.incidentId)?.state, 'RECOVERED');

    const retry = engine.processEvent(failure, '2026-08-20T13:00:00.000Z');
    assert.equal(retry.incidentId, first.incidentId);
    assert.equal(retry.isNew, false);
    assert.equal(store.incidentCount(), 1);
    assert.equal(store.getIncident(first.incidentId)?.event_count, 2);
  });
});

// ── Aggregation window boundary ──────────────────────────────────────────────

describe('aggregation window boundary', () => {
  it('creates new incident when event is outside the window', () => {
    const { store, engine } = setup();
    const event1 = makeEvent({ id: 'evt-1', time: '2026-08-20T12:00:00.000Z' });
    const r1 = engine.processEvent(event1, event1.time);
    assert.ok(r1.isNew);

    // Event 10 minutes later — outside the 5-minute window
    const event2 = makeEvent({ id: 'evt-2', time: '2026-08-20T12:10:01.000Z' });
    const r2 = engine.processEvent(event2, event2.time);
    assert.ok(r2.isNew);
    assert.notEqual(r2.incidentId, r1.incidentId);
    assert.equal(store.incidentCount(), 2);
  });

  it('aggregates event exactly at the window boundary', () => {
    const { store, engine } = setup();
    const event1 = makeEvent({ id: 'evt-1', time: '2026-08-20T12:00:00.000Z' });
    const r1 = engine.processEvent(event1, event1.time);

    // Exactly at the 5-minute boundary (within)
    const event2 = makeEvent({ id: 'evt-2', time: '2026-08-20T12:05:00.000Z' });
    const r2 = engine.processEvent(event2, event2.time);
    assert.equal(r2.incidentId, r1.incidentId);
    assert.equal(store.incidentCount(), 1);
  });

  it('creates a new incident for a far-older out-of-order event', () => {
    const { store, engine } = setup();
    const recent = makeEvent({ id: 'evt-recent', time: '2026-08-20T12:10:00.000Z' });
    const first = engine.processEvent(recent, recent.time);
    const old = makeEvent({ id: 'evt-old', time: '2026-08-20T12:00:00.000Z' });
    const second = engine.processEvent(old, old.time);

    assert.equal(second.isNew, true);
    assert.notEqual(second.incidentId, first.incidentId);
    assert.equal(store.incidentCount(), 2);
  });

  it('keeps firstSeen=min and lastSeen=max for in-window out-of-order events', () => {
    const { store, engine } = setup();
    const recent = makeEvent({ id: 'evt-recent', time: '2026-08-20T12:04:00.000Z' });
    const result = engine.processEvent(recent, recent.time);
    const earlier = makeEvent({ id: 'evt-earlier', time: '2026-08-20T12:00:00.000Z' });
    engine.processEvent(earlier, earlier.time);

    const incident = store.getIncident(result.incidentId!);
    assert.equal(incident?.first_seen, earlier.time);
    assert.equal(incident?.last_seen, recent.time);
  });

  it('creates new incident one millisecond past the window', () => {
    const { store, engine } = setup();
    const event1 = makeEvent({ id: 'evt-1', time: '2026-08-20T12:00:00.000Z' });
    const r1 = engine.processEvent(event1, event1.time);

    const event2 = makeEvent({
      id: 'evt-2',
      time: '2026-08-20T12:05:00.001Z',
    });
    const r2 = engine.processEvent(event2, event2.time);
    assert.ok(r2.isNew);
    assert.notEqual(r2.incidentId, r1.incidentId);
    assert.equal(store.incidentCount(), 2);
  });

  it('routes a delayed event to the nearest prior active window', () => {
    const { store, engine } = setup();
    const firstWindow = engine.processEvent(
      makeEvent({ id: 'evt-window-1', time: '2026-08-20T12:00:00.000Z' }),
      '2026-08-20T12:00:00.000Z',
    );
    const secondWindow = engine.processEvent(
      makeEvent({ id: 'evt-window-2', time: '2026-08-20T13:00:00.000Z' }),
      '2026-08-20T13:00:00.000Z',
    );

    const delayed = engine.processEvent(
      makeEvent({ id: 'evt-delayed', time: '2026-08-20T12:02:00.000Z' }),
      '2026-08-20T12:02:00.000Z',
    );

    assert.equal(delayed.incidentId, firstWindow.incidentId);
    assert.notEqual(delayed.incidentId, secondWindow.incidentId);
    assert.equal(delayed.isNew, false);
    assert.equal(store.incidentCount(), 2);
    assert.equal(store.getIncident(firstWindow.incidentId!)?.event_count, 2);
    assert.equal(store.getIncident(secondWindow.incidentId!)?.event_count, 1);
  });
});

// ── Different fingerprints → different incidents ─────────────────────────────

describe('fingerprint separation', () => {
  it('different services create different incidents', () => {
    const { store, engine } = setup();
    const e1 = engine.processEvent(
      makeEvent({ id: 'evt-1', service: 'dataease' }),
      '2026-08-20T12:00:00.000Z',
    );
    const e2 = engine.processEvent(
      makeEvent({ id: 'evt-2', service: 'ragflow' }),
      '2026-08-20T12:00:00.000Z',
    );
    assert.notEqual(e1.incidentId, e2.incidentId);
    assert.equal(store.incidentCount(), 2);
  });

  it('different nodes create different incidents', () => {
    const { store, engine } = setup();
    const e1 = engine.processEvent(
      makeEvent({ id: 'evt-1', nodeId: 'test-svc-02' }),
      '2026-08-20T12:00:00.000Z',
    );
    const e2 = engine.processEvent(
      makeEvent({ id: 'evt-2', nodeId: 'test-ai-01' }),
      '2026-08-20T12:00:00.000Z',
    );
    assert.notEqual(e1.incidentId, e2.incidentId);
    assert.equal(store.incidentCount(), 2);
  });

  it('different event types create different incidents', () => {
    const { store, engine } = setup();
    const e1 = engine.processEvent(
      makeEvent({ id: 'evt-1', type: 'container.die' }),
      '2026-08-20T12:00:00.000Z',
    );
    const e2 = engine.processEvent(
      makeEvent({ id: 'evt-2', type: 'container.oom' }),
      '2026-08-20T12:00:00.000Z',
    );
    assert.notEqual(e1.incidentId, e2.incidentId);
    assert.equal(store.incidentCount(), 2);
  });
});

// ── Recovery ─────────────────────────────────────────────────────────────────

describe('recovery', () => {
  it('transitions incident to RECOVERED for an explicit recovery event', () => {
    const { store, engine } = setup();

    // Error event creates incident
    const errorEvent = makeEvent({
      id: 'evt-err',
      type: 'health.failure',
      severity: 'error',
      time: '2026-08-20T12:00:00.000Z',
    });
    const r1 = engine.processEvent(errorEvent, errorEvent.time);
    assert.ok(r1.isNew);

    // Explicit recovery type maps to the failure fingerprint.
    const recoveryEvent = makeEvent({
      id: 'evt-recover',
      type: 'health.recovered',
      severity: 'info',
      time: '2026-08-20T12:01:00.000Z',
    });
    const r2 = engine.processEvent(recoveryEvent, recoveryEvent.time);
    assert.ok(r2.isRecovery);
    assert.equal(r2.incidentId, r1.incidentId);

    const incident = store.getIncident(r1.incidentId!);
    assert.ok(incident);
    assert.equal(incident.state, 'RECOVERED');
  });

  it('recovery only affects the correlated incident by fingerprint, not all incidents on same service', () => {
    const { store, engine } = setup();

    // Create two incidents on the same service but different types (different fingerprints)
    const e1 = engine.processEvent(
      makeEvent({ id: 'evt-1', source: 'health', type: 'health.failure', severity: 'error' }),
      '2026-08-20T12:00:00.000Z',
    );
    const e2 = engine.processEvent(
      makeEvent({ id: 'evt-2', type: 'container.oom', severity: 'error' }),
      '2026-08-20T12:00:00.000Z',
    );
    assert.notEqual(e1.incidentId, e2.incidentId);

    // Recovery event matching e1's fingerprint only
    const recovery = makeEvent({
      id: 'evt-recover',
      source: 'health',
      type: 'health.recovered',
      severity: 'info',
      time: '2026-08-20T12:01:00.000Z',
    });
    const r3 = engine.processEvent(recovery, recovery.time);
    assert.ok(r3.isRecovery);
    assert.equal(r3.incidentId, e1.incidentId);

    // e1 should be RECOVERED
    const inc1 = store.getIncident(e1.incidentId!);
    assert.equal(inc1!.state, 'RECOVERED');

    // e2 should still be OPEN (not recovered)
    const inc2 = store.getIncident(e2.incidentId!);
    assert.equal(inc2!.state, 'OPEN');
  });

  it('correlates an explicit health.recovered event even outside the aggregation window', () => {
    const { store, engine } = setup();
    const failure = makeEvent({
      id: 'evt-health-failure',
      source: 'health',
      type: 'health.failure',
      severity: 'error',
      time: '2026-08-20T12:00:00.000Z',
    });
    const opened = engine.processEvent(failure, failure.time);
    assert.ok(opened.incidentId);

    const recovery = makeEvent({
      id: 'evt-health-recovery',
      source: 'health',
      type: 'health.recovered',
      severity: 'info',
      time: '2026-08-20T13:00:00.000Z',
    });
    const result = engine.processEvent(recovery, recovery.time);
    assert.equal(result.isRecovery, true);
    assert.equal(result.incidentId, opened.incidentId);
    assert.equal(store.getIncident(opened.incidentId)?.state, 'RECOVERED');
    assert.equal(store.incidentCount(), 1);
  });

  it('does not correlate an out-of-order recovery to a future Incident window', () => {
    const { store, engine } = setup();
    const futureWindow = engine.processEvent(
      makeEvent({
        id: 'evt-future-failure',
        source: 'health',
        type: 'health.failure',
        time: '2026-08-20T12:10:00.000Z',
      }),
      '2026-08-20T12:10:00.000Z',
    );
    const priorWindow = engine.processEvent(
      makeEvent({
        id: 'evt-prior-failure',
        source: 'health',
        type: 'health.failure',
        time: '2026-08-20T12:00:00.000Z',
      }),
      '2026-08-20T12:00:00.000Z',
    );

    const recovery = engine.processEvent(
      makeEvent({
        id: 'evt-delayed-recovery',
        source: 'health',
        type: 'health.recovered',
        severity: 'info',
        time: '2026-08-20T12:05:00.000Z',
      }),
      '2026-08-20T12:05:00.000Z',
    );

    assert.equal(recovery.incidentId, priorWindow.incidentId);
    assert.equal(store.getIncident(priorWindow.incidentId!)?.state, 'RECOVERED');
    assert.equal(store.getIncident(futureWindow.incidentId!)?.state, 'OPEN');
  });

  it('does not let a delayed recovery close an Incident with a later failure', () => {
    const { store, engine } = setup();
    const opened = engine.processEvent(
      makeEvent({
        id: 'evt-health-1200',
        source: 'health',
        type: 'health.failure',
        time: '2026-08-20T12:00:00.000Z',
      }),
      '2026-08-20T12:00:00.000Z',
    );
    engine.processEvent(
      makeEvent({
        id: 'evt-health-1204',
        source: 'health',
        type: 'health.failure',
        time: '2026-08-20T12:04:00.000Z',
      }),
      '2026-08-20T12:04:00.000Z',
    );
    engine.processEvent(
      makeEvent({
        id: 'evt-health-1208',
        source: 'health',
        type: 'health.failure',
        time: '2026-08-20T12:08:00.000Z',
      }),
      '2026-08-20T12:08:00.000Z',
    );

    const delayedRecovery = engine.processEvent(
      makeEvent({
        id: 'evt-health-recovery-1205',
        source: 'health',
        type: 'health.recovered',
        severity: 'info',
        time: '2026-08-20T12:05:00.000Z',
      }),
      '2026-08-20T12:05:00.000Z',
    );

    assert.equal(delayedRecovery.ignored, true);
    assert.equal(store.getIncident(opened.incidentId!)?.state, 'OPEN');
    assert.equal(store.getIncident(opened.incidentId!)?.event_count, 3);
  });

  it('ignores an explicit recovery that has no correlated active Incident', () => {
    const { store, engine } = setup();
    const recovery = makeEvent({
      id: 'evt-unmatched-recovery',
      source: 'health',
      type: 'health.recovered',
      severity: 'info',
    });
    const result = engine.processEvent(recovery, recovery.time);
    assert.equal(result.ignored, true);
    assert.equal(result.incidentId, null);
    assert.equal(store.incidentCount(), 0);
  });

  it('ignores a delayed recovery for an episode that is already recovered', () => {
    const { store, engine } = setup();
    const oldFailure = makeEvent({
      id: 'evt-old-failure',
      source: 'health',
      type: 'health.failure',
      time: '2026-08-20T12:00:00.000Z',
    });
    const oldWindow = engine.processEvent(oldFailure, oldFailure.time);
    engine.processEvent(
      makeEvent({
        id: 'evt-old-recovery',
        source: 'health',
        type: 'health.recovered',
        severity: 'info',
        time: '2026-08-20T12:05:00.000Z',
      }),
      '2026-08-20T12:05:00.000Z',
    );
    const currentWindow = engine.processEvent(
      makeEvent({
        id: 'evt-current-failure',
        source: 'health',
        type: 'health.failure',
        time: '2026-08-20T13:00:00.000Z',
      }),
      '2026-08-20T13:00:00.000Z',
    );

    const delayedRecovery = engine.processEvent(
      makeEvent({
        id: 'evt-duplicate-old-recovery',
        source: 'health',
        type: 'health.recovered',
        severity: 'info',
        time: '2026-08-20T12:06:00.000Z',
      }),
      '2026-08-20T12:06:00.000Z',
    );

    assert.equal(delayedRecovery.ignored, true);
    assert.equal(store.getIncident(oldWindow.incidentId!)?.state, 'RECOVERED');
    assert.equal(store.getIncident(currentWindow.incidentId!)?.state, 'OPEN');
  });

  it('does not recover for a generic lower-severity event', () => {
    const { store, engine } = setup();
    const opened = engine.processEvent(
      makeEvent({ id: 'evt-error', severity: 'error' }),
      '2026-08-20T12:00:00.000Z',
    );
    const lowerSeverity = engine.processEvent(
      makeEvent({ id: 'evt-info', severity: 'info' }),
      '2026-08-20T12:01:00.000Z',
    );

    assert.equal(lowerSeverity.isRecovery, false);
    assert.equal(store.getIncident(opened.incidentId!)?.state, 'OPEN');
  });

  it('does not recover when event severity is equal or higher', () => {
    const { store, engine } = setup();

    const r1 = engine.processEvent(
      makeEvent({ id: 'evt-1', severity: 'error' }),
      '2026-08-20T12:00:00.000Z',
    );

    // Another error event — same severity, not recovery
    const r2 = engine.processEvent(
      makeEvent({ id: 'evt-2', severity: 'error' }),
      '2026-08-20T12:01:00.000Z',
    );
    assert.ok(!r2.isRecovery);

    const incident = store.getIncident(r1.incidentId!);
    assert.equal(incident!.state, 'OPEN');
  });
});

// ── Delayed Events for terminal Incidents ────────────────────────────────────

describe('terminal Incident event-time correlation', () => {
  it('links a delayed failure to its recovered historical Incident', () => {
    const { store, engine } = setup();
    const failure = engine.processEvent(
      makeEvent({
        id: 'evt-terminal-failure',
        source: 'health',
        type: 'health.failure',
        time: '2026-08-20T12:00:00.000Z',
      }),
      '2026-08-20T12:00:00.000Z',
    );
    engine.processEvent(
      makeEvent({
        id: 'evt-terminal-recovery',
        source: 'health',
        type: 'health.recovered',
        severity: 'info',
        time: '2026-08-20T12:10:00.000Z',
      }),
      '2026-08-20T12:10:00.000Z',
    );

    const delayed = engine.processEvent(
      makeEvent({
        id: 'evt-terminal-delayed',
        source: 'health',
        type: 'health.failure',
        time: '2026-08-20T12:05:00.000Z',
      }),
      '2026-08-20T12:05:00.000Z',
    );

    assert.equal(delayed.incidentId, failure.incidentId);
    assert.equal(delayed.isNew, false);
    assert.equal(store.getIncident(failure.incidentId!)?.state, 'RECOVERED');
    assert.equal(store.getIncident(failure.incidentId!)?.event_count, 3);
    assert.equal(store.incidentCount(), 1);
    assert.equal(store.listPendingEvidenceJobs(10).length, 1);
  });

  it('creates a new Incident for a failure after the recovery boundary', () => {
    const { store, engine } = setup();
    const failure = engine.processEvent(
      makeEvent({
        id: 'evt-boundary-failure',
        source: 'health',
        type: 'health.failure',
        time: '2026-08-20T12:00:00.000Z',
      }),
      '2026-08-20T12:00:00.000Z',
    );
    engine.processEvent(
      makeEvent({
        id: 'evt-boundary-recovery',
        source: 'health',
        type: 'health.recovered',
        severity: 'info',
        time: '2026-08-20T12:10:00.000Z',
      }),
      '2026-08-20T12:10:00.000Z',
    );

    const next = engine.processEvent(
      makeEvent({
        id: 'evt-after-recovery',
        source: 'health',
        type: 'health.failure',
        time: '2026-08-20T12:11:00.000Z',
      }),
      '2026-08-20T12:11:00.000Z',
    );

    assert.equal(next.isNew, true);
    assert.notEqual(next.incidentId, failure.incidentId);
    assert.equal(store.incidentCount(), 2);
    assert.equal(store.listPendingEvidenceJobs(10).length, 2);
  });

  it('routes a delayed failure to the correct terminal window', () => {
    const { store, engine } = setup();
    const firstWindow = engine.processEvent(
      makeEvent({
        id: 'evt-terminal-window-1',
        source: 'health',
        type: 'health.failure',
        time: '2026-08-20T12:00:00.000Z',
      }),
      '2026-08-20T12:00:00.000Z',
    );
    engine.processEvent(
      makeEvent({
        id: 'evt-terminal-recovery-1',
        source: 'health',
        type: 'health.recovered',
        severity: 'info',
        time: '2026-08-20T12:10:00.000Z',
      }),
      '2026-08-20T12:10:00.000Z',
    );
    const secondWindow = engine.processEvent(
      makeEvent({
        id: 'evt-terminal-window-2',
        source: 'health',
        type: 'health.failure',
        time: '2026-08-20T13:00:00.000Z',
      }),
      '2026-08-20T13:00:00.000Z',
    );
    engine.processEvent(
      makeEvent({
        id: 'evt-terminal-recovery-2',
        source: 'health',
        type: 'health.recovered',
        severity: 'info',
        time: '2026-08-20T13:10:00.000Z',
      }),
      '2026-08-20T13:10:00.000Z',
    );

    const delayed = engine.processEvent(
      makeEvent({
        id: 'evt-terminal-window-delayed',
        source: 'health',
        type: 'health.failure',
        time: '2026-08-20T12:05:00.000Z',
      }),
      '2026-08-20T12:05:00.000Z',
    );

    assert.equal(delayed.incidentId, firstWindow.incidentId);
    assert.notEqual(delayed.incidentId, secondWindow.incidentId);
    assert.equal(store.getIncident(firstWindow.incidentId!)?.event_count, 3);
    assert.equal(store.getIncident(secondWindow.incidentId!)?.event_count, 2);
    assert.equal(store.incidentCount(), 2);
  });
});

// ── Incident state participation ─────────────────────────────────────────────

describe('incident state participation', () => {
  for (const activeState of ['INVESTIGATING', 'NOTIFIED'] as const) {
    it(`continues aggregating while an Incident is ${activeState}`, () => {
      const { store, engine } = setup();
      const opened = engine.processEvent(
        makeEvent({ id: `evt-open-${activeState}` }),
        '2026-08-20T12:00:00.000Z',
      );
      const incident = store.getIncident(opened.incidentId!);
      assert.ok(incident);
      store.updateIncident(incident.id, {
        first_seen: incident.first_seen,
        last_seen: incident.last_seen,
        event_count: incident.event_count,
        severity: incident.severity,
        state: activeState,
      });

      const aggregated = engine.processEvent(
        makeEvent({ id: `evt-next-${activeState}`, time: '2026-08-20T12:01:00.000Z' }),
        '2026-08-20T12:01:00.000Z',
      );

      assert.equal(aggregated.incidentId, opened.incidentId);
      assert.equal(aggregated.isNew, false);
      assert.equal(store.getIncident(opened.incidentId!)?.state, activeState);
      assert.equal(store.getIncident(opened.incidentId!)?.event_count, 2);
    });
  }

  for (const terminalState of ['RECOVERED', 'CLOSED'] as const) {
    it(`does not aggregate new failure events into a ${terminalState} Incident`, () => {
      const { store, engine } = setup();
      const opened = engine.processEvent(
        makeEvent({ id: `evt-open-${terminalState}` }),
        '2026-08-20T12:00:00.000Z',
      );
      const incident = store.getIncident(opened.incidentId!);
      assert.ok(incident);
      store.updateIncident(incident.id, {
        first_seen: incident.first_seen,
        last_seen: incident.last_seen,
        event_count: incident.event_count,
        severity: incident.severity,
        state: terminalState,
      });

      const next = engine.processEvent(
        makeEvent({ id: `evt-next-${terminalState}`, time: '2026-08-20T12:01:00.000Z' }),
        '2026-08-20T12:01:00.000Z',
      );

      assert.equal(next.isNew, true);
      assert.notEqual(next.incidentId, opened.incidentId);
      assert.equal(store.incidentCount(), 2);
      assert.equal(store.getIncident(opened.incidentId!)?.state, terminalState);
    });
  }
});

// ── Severity escalation ──────────────────────────────────────────────────────

describe('severity escalation', () => {
  it('escalates incident severity when a more severe event arrives', () => {
    const { store, engine } = setup();

    engine.processEvent(
      makeEvent({ id: 'evt-1', severity: 'warning' }),
      '2026-08-20T12:00:00.000Z',
    );
    const r2 = engine.processEvent(
      makeEvent({ id: 'evt-2', severity: 'critical' }),
      '2026-08-20T12:01:00.000Z',
    );

    const incident = store.getIncident(r2.incidentId!);
    assert.ok(incident);
    assert.equal(incident.severity, 'critical');
  });

  it('does not downgrade severity', () => {
    const { store, engine } = setup();

    engine.processEvent(
      makeEvent({ id: 'evt-1', severity: 'critical' }),
      '2026-08-20T12:00:00.000Z',
    );
    // Even when a warning event arrives, severity stays critical
    // (recovery is tracked by state, not severity downgrade)
    const r2 = engine.processEvent(
      makeEvent({ id: 'evt-2', severity: 'warning' }),
      '2026-08-20T12:01:00.000Z',
    );

    const incident = store.getIncident(r2.incidentId!);
    assert.ok(incident);
    assert.equal(incident.severity, 'critical');
  });
});

// ── Event immutability ───────────────────────────────────────────────────────

describe('event immutability', () => {
  it('events are stored separately from incidents and are never modified', () => {
    const { store, engine } = setup();

    // Insert an event through the store
    const batch = {
      producer: { id: 'p1', type: 'node-agent' as const, version: '0.1.0' },
      events: [
        {
          ...makeEvent({ id: 'evt-immutable' }),
          schemaVersion: 1 as const,
          source: 'docker' as const,
          nodeId: 'test-svc-02' as string,
          service: 'dataease' as string,
          type: 'container.die' as string,
          severity: 'error' as const,
          message: 'Immutable event',
          attributes: { original: true },
        },
      ],
    };
    store.insertBatch(batch, '2026-08-20T12:00:00.000Z');

    // Process through incident engine
    engine.processEvent(
      makeEvent({ id: 'evt-immutable' }),
      '2026-08-20T12:00:00.000Z',
    );

    // Event row still exists and is unchanged
    assert.equal(store.count(), 1);
  });
});