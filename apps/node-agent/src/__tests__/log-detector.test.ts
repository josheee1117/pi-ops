import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogDetector } from '../detectors/logs.js';
import type { EventSender } from '../events/sender.js';
import { makeNodeAgentConfig } from './test-config.js';

// W2 of the 2026-10-22 real drill (run 20261022-023023-14895c). The app runs with
// its own sender on, so the same OutOfMemoryError reaches the center twice: once
// as the app's EventBatch, once through this container-log scan.
const SERVICE = 'order-service-本地演练-20261022-023023-14895c';
const CONTAINER = 'order-local-drill-20261022-023023-14895c';

const RAW_OOM_STACK = [
  'java.lang.OutOfMemoryError: Java heap space',
  '\tat Drill.exhaustHeap(Drill.java:285)',
  '\tat Drill$$Lambda$201/0x00000080010cf678.run(Unknown Source)',
  '\tat java.base/java.lang.Thread.run(Thread.java:840)',
];

// The drill prints its own EventBatch to stdout, so the payload line repeats the
// exception class inside a quoted field. Its prefix is not the starter's.
const DRILL_PAYLOAD_LINE = `JFR_EVENT ${JSON.stringify({
  producer: { version: '0.2.0', id: `${SERVICE}-jfr`, type: 'application' },
  events: [{
    schemaVersion: 1,
    id: '4cf16029-caab-4836-8968-9e229770cca5',
    time: '2026-10-22T02:31:21.462958465Z',
    source: 'jfr',
    nodeId: 'local-dev',
    service: SERVICE,
    type: 'jvm.oom',
    severity: 'critical',
    attributes: {
      exceptionClass: 'java.lang.OutOfMemoryError',
      exceptionMessage: 'Java heap space',
      stackTrace: 'java.lang.OutOfMemoryError: Java heap space\n\tat Drill.exhaustHeap(Drill.java:285)',
    },
  }],
})}`;

const W2_LOG = [
  ...RAW_OOM_STACK,
  'Allocation work completed; retained memory released',
  DRILL_PAYLOAD_LINE,
];

function recordingSender(): EventSender & { events: import('@pi-ops/protocol').OpsEvent[] } {
  const events: import('@pi-ops/protocol').OpsEvent[] = [];
  return {
    events,
    enqueue(event) {
      events.push(event);
      return true;
    },
    droppedCount: () => 0,
    start: () => {},
    stop: async () => {},
    queueDepth: () => events.length,
  };
}

function drivenConfig() {
  return makeNodeAgentConfig({
    nodeId: 'local-dev',
    allowedContainers: new Set([CONTAINER]),
    healthTargets: [{
      name: SERVICE,
      url: 'http://jdk17-drill:8088/health',
      container: CONTAINER,
    }],
  });
}

async function scan(lines: readonly string[], config = drivenConfig()) {
  const sender = recordingSender();
  const detector = createLogDetector(config, sender, {
    fetchLogs: async () => ({ buffer: Buffer.from(lines.join('\n')), truncated: false }),
    fetchContainerId: async () => 'container-id',
  });
  await detector.pollOnce();
  return sender.events;
}

describe('createLogDetector: one real fault is one event', () => {
  it('reports the W2 OOME once, under the service the health target binds to the container', async () => {
    const events = await scan(W2_LOG);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'jvm.oom');
    assert.equal(events[0]!.service, SERVICE);
    assert.equal(events[0]!.nodeId, 'local-dev');
  });

  it('does not read the exception class out of a quoted payload field', async () => {
    const events = await scan([DRILL_PAYLOAD_LINE]);
    assert.deepEqual(events, []);
  });

  it('falls back to the container name when no health target declares it', async () => {
    const config = makeNodeAgentConfig({
      allowedContainers: new Set([CONTAINER]),
      healthTargets: [{ name: 'some-other-service', url: 'http://localhost:1/health' }],
    });
    const events = await scan(RAW_OOM_STACK, config);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.service, CONTAINER);
  });
});
