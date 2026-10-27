import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OpsEvent } from '@pi-ops/protocol';
import { createHysteresisState } from '../detectors/hysteresis.js';
import { createHealthDetector, type ProbeFn } from '../detectors/health.js';
import { dockerEventToOpsEvent } from '../events/docker-events.js';
import type { EventSender } from '../events/sender.js';
import { makeNodeAgentConfig } from './test-config.js';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createDiskDetector } from '../detectors/disk.js';

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

describe('disk detector', () => {
  it('uses filesystem blocks for pressure and recovery and skips unavailable paths', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let unavailable = false;
    let free = 10;
    t.mock.method(fs, 'statfsSync', () => {
      if (unavailable) throw new Error('unavailable');
      return { bsize: 4096, blocks: 100, bfree: free, bavail: free - 5 };
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const sender = createCaptureSender();
    const detector = createDiskDetector(makeNodeAgentConfig({
      diskPressureThreshold: 0.8, diskPressureDuration: 1, detectorPollIntervalMs: 10,
    }), sender);
    detector.start();
    t.mock.timers.tick(10);
    assert.equal(sender.events[0]?.type, 'host.disk_pressure');
    assert.equal(sender.events[0]?.attributes.totalKb, 400);
    assert.equal(sender.events[0]?.attributes.usedKb, 360);
    assert.equal(sender.events[0]?.attributes.availableKb, 20);
    assert.equal(sender.events[0]?.attributes.usagePercent, 90);
    unavailable = true;
    t.mock.timers.tick(10);
    assert.equal(sender.events.length, 1);
    unavailable = false;
    free = 60;
    t.mock.timers.tick(10);
    assert.equal(sender.events[1]?.type, 'host.disk_recovered');
    assert.equal(sender.events[1]?.attributes.usagePercent, 40);
    detector.stop();
    t.mock.timers.tick(100);
    assert.equal(sender.events.length, 2);
  });
});

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
  it('emits one failure then one recovery for 200 → fail → 200 (no flood)', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-21T02:00:00Z') });
    const statuses: number[] = [];
    const probe: ProbeFn = async () => {
      const status = statuses.shift() ?? 200;
      return { ok: status >= 200 && status < 400, status };
    };

    const sender = createCaptureSender();
    const detector = createHealthDetector(
      makeNodeAgentConfig({
        healthFailureDuration: 2,
        healthTargets: [{
          name: 'dataease',
          url: 'http://127.0.0.1:18080/health',
          container: 'dataease',
          ruleId: 'dataease-http-health',
          ruleVersion: 3,
          intervalMs: 7500,
        }],
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
    t.mock.timers.tick(7500);
    await detector.pollOnce();
    assert.equal(sender.events.length, 1);
    assert.equal(sender.events[0]!.type, 'health.failure');
    assert.equal(sender.events[0]!.severity, 'error');
    assert.equal(sender.events[0]!.service, 'dataease');
    assert.equal(sender.events[0]!.attributes.containerName, 'dataease');
    assert.equal(sender.events[0]!.attributes.detector, 'http.health');
    assert.equal(sender.events[0]!.time, '2026-10-21T02:00:07.500Z');
    assert.deepEqual(sender.events[0]!.attributes, {
      detector: 'http.health',
      target: 'dataease',
      url: 'http://127.0.0.1:18080/health',
      method: 'GET',
      containerName: 'dataease',
      status: 500,
      error: undefined,
      ruleId: 'dataease-http-health',
      ruleVersion: 3,
      failureSamples: 2,
      intervalMs: 7500,
      transitionTime: sender.events[0]!.time,
    });

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
    t.mock.timers.tick(7500);
    await detector.pollOnce();
    assert.equal(sender.events.length, 2);
    assert.equal(sender.events[1]!.type, 'health.recovered');
    assert.equal(sender.events[1]!.severity, 'info');
    assert.equal(sender.events[1]!.time, '2026-10-21T02:00:15.000Z');
    assert.deepEqual(sender.events[1]!.attributes, {
      detector: 'http.health',
      target: 'dataease',
      url: 'http://127.0.0.1:18080/health',
      method: 'GET',
      containerName: 'dataease',
      status: 200,
      ruleId: 'dataease-http-health',
      ruleVersion: 3,
      failureSamples: 2,
      intervalMs: 7500,
      transitionTime: sender.events[1]!.time,
    });

    // Healthy flood — no extra events
    for (let i = 0; i < 10; i++) {
      statuses.push(200);
      await detector.pollOnce();
    }
    assert.equal(sender.events.length, 2);

    detector.stop();
  });

  it('keeps legacy events unbound and counts consecutive samples rather than seconds', async () => {
    let ok = false;
    const sender = createCaptureSender();
    const detector = createHealthDetector(makeNodeAgentConfig({
      healthFailureDuration: 3,
      detectorPollIntervalMs: 4200,
      healthTargets: [{ name: 'legacy', url: 'http://localhost/health' }],
    }), sender, async () => ok ? { ok, status: 200 } : { ok, error: 'offline' });

    await detector.pollOnce();
    await detector.pollOnce();
    ok = true;
    await detector.pollOnce();
    ok = false;
    await detector.pollOnce();
    await detector.pollOnce();
    assert.equal(sender.events.length, 0);
    await detector.pollOnce();
    assert.equal(sender.events[0]?.type, 'health.failure');
    assert.equal(sender.events[0]?.attributes.error, 'offline');

    ok = true;
    await detector.pollOnce();
    await detector.pollOnce();
    ok = false;
    await detector.pollOnce();
    ok = true;
    await detector.pollOnce();
    await detector.pollOnce();
    assert.equal(sender.events.length, 1);
    await detector.pollOnce();
    assert.equal(sender.events[1]?.type, 'health.recovered');

    for (const event of sender.events) {
      assert.equal(Object.hasOwn(event.attributes, 'ruleId'), false);
      assert.equal(Object.hasOwn(event.attributes, 'ruleVersion'), false);
      assert.equal(event.attributes.failureSamples, 3);
      assert.equal(event.attributes.intervalMs, 4200);
      assert.equal(event.attributes.transitionTime, event.time);
    }
    detector.stop();
  });

  const sharedTarget = {
    name: 'shared', url: 'http://localhost/health', method: 'GET', container: 'api',
  };
  for (const [field, value] of Object.entries({
    name: 'other', url: 'http://localhost/other', method: 'HEAD', container: 'other',
  })) {
    it(`isolates failure and recovery state by target ${field}`, async () => {
      const targets = [sharedTarget, { ...sharedTarget, [field]: value }];
      const healthy = [false, false];
      let calls = 0;
      const sender = createCaptureSender();
      const detector = createHealthDetector(makeNodeAgentConfig({
        healthFailureDuration: 2,
        healthTargets: targets,
      }), sender, async () => ({ ok: healthy[calls++ % 2]! }));

      await detector.pollOnce();
      assert.equal(sender.events.length, 0);
      await detector.pollOnce();
      assert.equal(sender.events.length, 2);
      assert.ok(sender.events.every((event) => event.type === 'health.failure'));
      healthy[0] = true;
      await detector.pollOnce();
      assert.equal(sender.events.length, 2);
      await detector.pollOnce();
      assert.equal(sender.events.length, 3);
      healthy[1] = true;
      await detector.pollOnce();
      assert.equal(sender.events.length, 3);
      await detector.pollOnce();
      assert.equal(sender.events.length, 4);

      for (const [index, target] of targets.entries()) {
        const failure = sender.events[index]!;
        const recovery = sender.events[index + 2]!;
        assert.equal(recovery.type, 'health.recovered');
        for (const event of [failure, recovery]) {
          assert.equal(event.service, target.name);
          assert.equal(event.attributes.url, target.url);
          assert.equal(event.attributes.method, target.method);
          assert.equal(event.attributes.containerName, target.container);
        }
      }
      detector.stop();
    });
  }

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
