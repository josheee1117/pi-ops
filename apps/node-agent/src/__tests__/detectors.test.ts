import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OpsEvent } from '@pi-ops/protocol';
import { createHysteresisState } from '../detectors/hysteresis.js';
import { createHealthDetector, type ProbeFn } from '../detectors/health.js';
import { dockerEventToOpsEvent } from '../events/docker-events.js';
import type { EventSender } from '../events/sender.js';
import { makeNodeAgentConfig } from './test-config.js';

function createCaptureSender(): EventSender & { events: OpsEvent[] } {
  const events: OpsEvent[] = [];
  return {
    events,
    enqueue(event) {
      events.push(event);
      return true;
    },
    droppedCount: () => 0,
    start() {},
    async stop() {},
    queueDepth: () => events.length,
  };
}

// ── Hysteresis ───────────────────────────────────────────────────────────────

describe('hysteresis', () => {
  it('does not fire on a single sample above threshold', () => {
    const h = createHysteresisState(3);
    assert.equal(h.sample(true), null);
    assert.equal(h.sample(true), null);
  });

  it('fires pressure after N consecutive samples above threshold', () => {
    const h = createHysteresisState(3);
    assert.equal(h.sample(true), null);
    assert.equal(h.sample(true), null);
    assert.equal(h.sample(true), 'pressure');
  });

  it('resets the consecutive count if a sample drops below threshold', () => {
    const h = createHysteresisState(3);
    assert.equal(h.sample(true), null);
    assert.equal(h.sample(true), null);
    assert.equal(h.sample(false), null);
    assert.equal(h.sample(true), null);
    assert.equal(h.sample(true), null);
    assert.equal(h.sample(true), 'pressure');
  });

  it('does not re-fire pressure on subsequent samples (no flood)', () => {
    const h = createHysteresisState(2);
    assert.equal(h.sample(true), null);
    assert.equal(h.sample(true), 'pressure');
    for (let i = 0; i < 20; i++) {
      assert.equal(h.sample(true), null);
    }
  });

  it('fires recovery after N consecutive samples below threshold', () => {
    const h = createHysteresisState(2);
    h.sample(true);
    h.sample(true); // pressure
    assert.equal(h.sample(false), null);
    assert.equal(h.sample(false), 'recovery');
  });

  it('does not re-fire recovery on subsequent healthy samples', () => {
    const h = createHysteresisState(2);
    h.sample(true);
    h.sample(true);
    h.sample(false);
    h.sample(false); // recovery
    for (let i = 0; i < 20; i++) {
      assert.equal(h.sample(false), null);
    }
  });
});

// ── HTTP health transitions ──────────────────────────────────────────────────

describe('health detector', () => {
  it('emits one failure then one recovery for 200 → fail → 200 (no flood)', async () => {
    const statuses: number[] = [];
    const probe: ProbeFn = async () => {
      const status = statuses.shift() ?? 200;
      return { ok: status >= 200 && status < 400, status };
    };

    const sender = createCaptureSender();
    const detector = createHealthDetector(
      makeNodeAgentConfig({
        healthFailureDuration: 2,
        healthTargets: [{ name: 'dataease', url: 'http://127.0.0.1:18080/health' }],
      }),
      sender,
      probe,
    );

    // Healthy
    statuses.push(200, 200);
    await detector.pollOnce();
    await detector.pollOnce();
    assert.equal(sender.events.length, 0);

    // Persistent failure (duration=2)
    statuses.push(500, 500);
    await detector.pollOnce();
    assert.equal(sender.events.length, 0);
    await detector.pollOnce();
    assert.equal(sender.events.length, 1);
    assert.equal(sender.events[0]!.type, 'health.failure');
    assert.equal(sender.events[0]!.severity, 'error');
    assert.equal(sender.events[0]!.service, 'dataease');

    // Flood of failures — still one event
    for (let i = 0; i < 10; i++) {
      statuses.push(500);
      await detector.pollOnce();
    }
    assert.equal(sender.events.length, 1);

    // Recovery (duration=2)
    statuses.push(200);
    await detector.pollOnce();
    assert.equal(sender.events.length, 1);
    statuses.push(200);
    await detector.pollOnce();
    assert.equal(sender.events.length, 2);
    assert.equal(sender.events[1]!.type, 'health.recovered');
    assert.equal(sender.events[1]!.severity, 'info');

    // Healthy flood — no extra events
    for (let i = 0; i < 10; i++) {
      statuses.push(200);
      await detector.pollOnce();
    }
    assert.equal(sender.events.length, 2);

    detector.stop();
  });

  it('does not treat a single failed probe as a transition', async () => {
    const probe: ProbeFn = async () => ({ ok: false, status: 503 });
    const sender = createCaptureSender();
    const detector = createHealthDetector(
      makeNodeAgentConfig({
        healthFailureDuration: 2,
        healthTargets: [{ name: 'ragflow', url: 'http://127.0.0.1:80/health' }],
      }),
      sender,
      probe,
    );

    await detector.pollOnce();
    assert.equal(sender.events.length, 0);
    detector.stop();
  });

  it('isolates targets: recovering one target does not recover another', async () => {
    const statusByTarget = new Map<string, number>([
      ['a', 500],
      ['b', 500],
    ]);
    const probe: ProbeFn = async (url) => {
      const name = url.includes('target-a') ? 'a' : 'b';
      const status = statusByTarget.get(name)!;
      return { ok: status >= 200 && status < 400, status };
    };
    const sender = createCaptureSender();
    const detector = createHealthDetector(
      makeNodeAgentConfig({
        healthFailureDuration: 1,
        healthTargets: [
          { name: 'svc-a', url: 'http://127.0.0.1/target-a' },
          { name: 'svc-b', url: 'http://127.0.0.1/target-b' },
        ],
      }),
      sender,
      probe,
    );

    await detector.pollOnce();
    assert.equal(sender.events.filter((e) => e.type === 'health.failure').length, 2);

    statusByTarget.set('a', 200);
    await detector.pollOnce();
    const recovered = sender.events.filter((e) => e.type === 'health.recovered');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.service, 'svc-a');
    detector.stop();
  });
});

// ── Docker OOM signal (event path from Milestone 5) ──────────────────────────

describe('Docker OOM signal', () => {
  it('converts a memory-limited container OOM Docker event into container.oom', () => {
    const event = dockerEventToOpsEvent(
      {
        Type: 'container',
        Action: 'die',
        Actor: {
          ID: 'deadbeef',
          Attributes: {
            name: 'oom-fixture',
            image: 'alpine:latest',
            exitCode: '137',
            oomKilled: 'true',
          },
        },
        time: 1_755_691_200,
        timeNano: 1_755_691_200_000_000_000,
      },
      makeNodeAgentConfig({ nodeId: 'test-svc-02' }),
    );
    assert.ok(event);
    assert.equal(event.type, 'container.oom');
    assert.equal(event.severity, 'critical');
    assert.equal(event.service, 'oom-fixture');
    assert.equal(event.attributes.oomKilled, true);
  });
});
