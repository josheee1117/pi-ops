import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { PassThrough } from 'node:stream';
import { MAX_BATCH_SIZE, type OpsEvent } from '@pi-ops/protocol';
import { createEventSender, type EventSender } from '../events/sender.js';
import {
  dockerEventToOpsEvent,
  dockerOpsEventId,
  createContainerStateTracker,
  type DockerEvent,
} from '../events/docker-events.js';
import { createDockerWatcher } from '../events/watcher.js';
import { makeNodeAgentConfig } from './test-config.js';

function makeConfig(overrides: Parameters<typeof makeNodeAgentConfig>[0] = {}) {
  return makeNodeAgentConfig({
    nodeId: 'test-node-01',
    allowedContainers: new Set(),
    agentUrl: 'http://localhost:18080',
    eventQueueSize: 10,
    eventSendTimeoutMs: 2000,
    eventMaxRetries: 1,
    eventFlushIntervalMs: 100,
    ...overrides,
  });
}

function makeEvent(overrides: Partial<OpsEvent> = {}): OpsEvent {
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    time: '2026-08-20T12:00:00.000Z',
    source: 'docker',
    nodeId: 'test-node-01',
    service: 'dataease',
    type: 'container.die',
    severity: 'error',
    message: 'Container died',
    attributes: { exitCode: 137 },
    ...overrides,
  };
}

// ── DockerEvent → OpsEvent conversion ────────────────────────────────────────

describe('dockerEventToOpsEvent', () => {
  const config = makeConfig();

  it('converts container die event to OpsEvent', () => {
    const result = dockerEventToOpsEvent({
      Type: 'container',
      Action: 'die',
      Actor: {
        ID: 'abc123def456',
        Attributes: { name: 'dataease', image: 'dataease:latest', exitCode: '137' },
      },
      time: 1755691200,
      timeNano: 1755691200000000000,
    }, config);
    assert.ok(result);
    assert.equal(result.type, 'container.die');
    assert.equal(result.severity, 'error');
    assert.equal(result.service, 'dataease');
    assert.equal(result.source, 'docker');
    assert.equal(result.nodeId, 'test-node-01');
    assert.equal(result.attributes.exitCode, 137);
    assert.equal(result.attributes.containerName, 'dataease');
    assert.equal(result.attributes.image, 'dataease:latest');
    const again = dockerEventToOpsEvent({
      Type: 'container',
      Action: 'die',
      Actor: {
        ID: 'abc123def456',
        Attributes: { name: 'dataease', image: 'dataease:latest', exitCode: '137' },
      },
      time: 1755691200,
      timeNano: 1755691200000000000,
    }, config);
    assert.equal(result.id, again?.id);
    assert.equal(
      result.id,
      dockerOpsEventId('test-node-01', 'abc123def456', 'die', 1755691200000000000),
    );
  });

  it('converts OOMKilled die event to container.oom (critical)', () => {
    const result = dockerEventToOpsEvent({
      Type: 'container',
      Action: 'die',
      Actor: {
        ID: 'abc123',
        Attributes: { name: 'app', image: 'app:latest', exitCode: '137', oomKilled: 'true' },
      },
      time: 1755691200,
      timeNano: 1755691200000000000,
    }, config);
    assert.ok(result);
    assert.equal(result.type, 'container.oom');
    assert.equal(result.severity, 'critical');
    assert.equal(result.attributes.oomKilled, true);
  });

  it('ignores normal exit (code 0)', () => {
    const result = dockerEventToOpsEvent({
      Type: 'container',
      Action: 'die',
      Actor: {
        ID: 'abc123',
        Attributes: { name: 'app', image: 'app:latest', exitCode: '0' },
      },
      time: 1755691200,
      timeNano: 1755691200000000000,
    }, config);
    assert.equal(result, null);
  });

  it('converts oom event to container.oom (critical)', () => {
    const result = dockerEventToOpsEvent({
      Type: 'container',
      Action: 'oom',
      Actor: {
        ID: 'abc123',
        Attributes: { name: 'app', image: 'app:latest' },
      },
      time: 1755691200,
      timeNano: 1755691200000000000,
    }, config);
    assert.ok(result);
    assert.equal(result.type, 'container.oom');
    assert.equal(result.severity, 'critical');
  });

  it('converts health_status unhealthy to health.failure', () => {
    const result = dockerEventToOpsEvent({
      Type: 'container',
      Action: 'health_status',
      Actor: {
        ID: 'abc123',
        Attributes: { name: 'app', image: 'app:latest', health_status: 'unhealthy' },
      },
      time: 1755691200,
      timeNano: 1755691200000000000,
    }, config);
    assert.ok(result);
    assert.equal(result.type, 'health.failure');
    assert.equal(result.severity, 'error');
  });

  it('converts health_status healthy to health.recovered', () => {
    const result = dockerEventToOpsEvent({
      Type: 'container',
      Action: 'health_status',
      Actor: {
        ID: 'abc123',
        Attributes: { name: 'app', image: 'app:latest', health_status: 'healthy' },
      },
      time: 1755691200,
      timeNano: 1755691200000000000,
    }, config);
    assert.ok(result);
    assert.equal(result.type, 'health.recovered');
    assert.equal(result.severity, 'info');
  });

  it('ignores non-container events', () => {
    const result = dockerEventToOpsEvent({
      Type: 'network',
      Action: 'connect',
      Actor: { ID: 'xyz', Attributes: {} },
      time: 1755691200,
      timeNano: 1755691200000000000,
    }, config);
    assert.equal(result, null);
  });

  it('ignores unknown health_status values', () => {
    const result = dockerEventToOpsEvent({
      Type: 'container',
      Action: 'health_status',
      Actor: {
        ID: 'abc123',
        Attributes: { name: 'app', image: 'app:latest', health_status: 'starting' },
      },
      time: 1755691200,
      timeNano: 1755691200000000000,
    }, config);
    assert.equal(result, null);
  });
});

// ── Container state tracker ──────────────────────────────────────────────────

describe('createContainerStateTracker', () => {
  it('detects restart after die within window', () => {
    const tracker = createContainerStateTracker();
    const baseTime = Math.floor(Date.now() / 1000);

    // Track a die event
    const dieResult = tracker.track({
      Type: 'container',
      Action: 'die',
      Actor: { ID: 'abc', Attributes: { name: 'app' } },
      time: baseTime,
      timeNano: baseTime * 1e9,
    });
    assert.equal(dieResult, null);

    // Start within window → restart
    const startResult = tracker.track({
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'abc', Attributes: { name: 'app' } },
      time: baseTime + 30,
      timeNano: (baseTime + 30) * 1e9,
    });
    assert.equal(startResult, 'restart');
  });

  it('does not flag normal start as restart', () => {
    const tracker = createContainerStateTracker();
    const baseTime = Math.floor(Date.now() / 1000);

    const result = tracker.track({
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'abc', Attributes: { name: 'app' } },
      time: baseTime,
      timeNano: baseTime * 1e9,
    });
    assert.equal(result, null);
  });

  it('does not flag restart after window expires', () => {
    const tracker = createContainerStateTracker();
    const baseTime = Math.floor(Date.now() / 1000);

    tracker.track({
      Type: 'container',
      Action: 'die',
      Actor: { ID: 'abc', Attributes: { name: 'app' } },
      time: baseTime,
      timeNano: baseTime * 1e9,
    });

    // Start 2 minutes later (outside 1-minute window)
    const result = tracker.track({
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'abc', Attributes: { name: 'app' } },
      time: baseTime + 120,
      timeNano: (baseTime + 120) * 1e9,
    });
    assert.equal(result, null);
  });
});

// ── Event sender ─────────────────────────────────────────────────────────────

describe('EventSender', () => {
  let server: Server;
  let receivedEvents: OpsEvent[] = [];
  let serverPort: number;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/v1/events' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.events) {
              receivedEvents.push(...parsed.events);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ accepted: parsed.events?.length ?? 0, rejected: 0 }));
          } catch {
            res.writeHead(400);
            res.end();
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          serverPort = addr.port;
        }
        resolve();
      });
    });
  });

  after(() => {
    server.close();
  });

  it('sends events to central agent', async () => {
    receivedEvents = [];
    const config = makeConfig({
      agentUrl: `http://localhost:${serverPort}`,
      eventFlushIntervalMs: 100,
    });
    const sender = createEventSender(config);
    sender.start();

    sender.enqueue(makeEvent({ id: 'evt-1' }));
    sender.enqueue(makeEvent({ id: 'evt-2' }));

    // Wait for flush
    await new Promise((resolve) => setTimeout(resolve, 300));
    await sender.stop();

    assert.ok(receivedEvents.length >= 2, `Expected >=2 events, got ${receivedEvents.length}`);
    const ids = receivedEvents.map((e) => e.id);
    assert.ok(ids.includes('evt-1'));
    assert.ok(ids.includes('evt-2'));
  });

  it('drops events when queue is full', () => {
    const sender = createEventSender(makeConfig({ eventQueueSize: 3 }));
    sender.start();

    assert.ok(sender.enqueue(makeEvent({ id: 'evt-1' })));
    assert.ok(sender.enqueue(makeEvent({ id: 'evt-2' })));
    assert.ok(sender.enqueue(makeEvent({ id: 'evt-3' })));
    // Queue full — should drop
    const dropped = sender.enqueue(makeEvent({ id: 'evt-4' }));
    assert.equal(dropped, false);
    assert.equal(sender.droppedCount(), 1);
    assert.equal(sender.queueDepth(), 3);

    sender.stop();
  });

  it('non-blocking: enqueue returns immediately', () => {
    const sender = createEventSender(makeConfig());
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      sender.enqueue(makeEvent({ id: `evt-${i}` }));
    }
    const elapsed = Date.now() - start;
    // All enqueues should complete in well under 100ms
    assert.ok(elapsed < 100, `enqueue took ${elapsed}ms, expected <100ms`);
    sender.stop();
  });

  it('gracefully handles unreachable agent', async () => {
    const config = makeConfig({
      agentUrl: 'http://localhost:19999', // no server here
      eventFlushIntervalMs: 100,
      eventMaxRetries: 0,
      eventSendTimeoutMs: 500,
    });
    const sender = createEventSender(config);
    sender.start();

    sender.enqueue(makeEvent({ id: 'evt-drop' }));

    // Wait for flush attempt
    await new Promise((resolve) => setTimeout(resolve, 200));
    await sender.stop();

    // Event should be dropped (counted)
    assert.ok(sender.droppedCount() >= 1);
  });

  it('sends at most one request while Central is slow', async () => {
    let current = 0;
    let maxConcurrent = 0;
    const server = createServer((req, res) => {
      if (req.url === '/v1/events' && req.method === 'POST') {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        req.on('data', () => {});
        req.on('end', () => {
          setTimeout(() => {
            current--;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ accepted: 1, rejected: 0 }));
          }, 200);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await listen(server);
    const sender = createEventSender(makeConfig({
      agentUrl: `http://localhost:${port}`,
      eventFlushIntervalMs: 40,
      eventSendTimeoutMs: 5000,
      eventMaxRetries: 0,
    }));
    sender.start();
    sender.enqueue(makeEvent({ id: 'slow-1' }));
    await wait(70);
    sender.enqueue(makeEvent({ id: 'slow-2' }));
    await wait(70);
    sender.enqueue(makeEvent({ id: 'slow-3' }));
    await wait(800);
    await sender.stop();
    server.close();
    assert.equal(maxConcurrent, 1);
    assert.equal(current, 0);
  });

  it('drains 2500 queued events in batches of at most MAX_BATCH_SIZE without loss', async () => {
    const batches: number[] = [];
    const ids: string[] = [];
    const server = createServer((req, res) => {
      if (req.url === '/v1/events' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const parsed = JSON.parse(body) as { events: OpsEvent[] };
          batches.push(parsed.events.length);
          ids.push(...parsed.events.map((event) => event.id));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: parsed.events.length, rejected: 0 }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await listen(server);
    const sender = createEventSender(makeConfig({
      agentUrl: `http://localhost:${port}`,
      eventQueueSize: 3000,
      eventFlushIntervalMs: 10_000,
      eventMaxRetries: 0,
    }));
    sender.start();
    for (let i = 0; i < 2500; i++) {
      assert.ok(sender.enqueue(makeEvent({ id: `evt-batch-${i}` })));
    }
    await sender.stop();
    server.close();
    assert.ok(batches.every((size) => size > 0 && size <= MAX_BATCH_SIZE));
    assert.ok(batches.length >= 3);
    assert.equal(ids.length, 2500);
    assert.equal(new Set(ids).size, 2500);
  });
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await wait(10);
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
    });
  });
}

function recordingSender(): EventSender & { events: OpsEvent[] } {
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

function historicalDieEvent(): DockerEvent {
  return {
    Type: 'container',
    Action: 'die',
    Actor: {
      ID: 'abc123def456',
      Attributes: { name: 'dataease', image: 'dataease:latest', exitCode: '137' },
    },
    time: 1_600_000_000,
    timeNano: 1_600_000_000_123_456,
  };
}

describe('Docker watcher reconnect', () => {
  it('reconnect overlap produces the same OpsEvent id for the same Docker event', async () => {
    const streams: PassThrough[] = [];
    const connectOptions: Array<{ since: number }> = [];
    const sender = recordingSender();
    const watcher = createDockerWatcher(makeConfig(), sender, {
      initialBackoffMs: 20,
      maxBackoffMs: 80,
      connect: async (options) => {
        connectOptions.push(options);
        const stream = new PassThrough();
        streams.push(stream);
        return stream;
      },
    });
    await watcher.start();
    await waitFor(() => streams.length === 1);
    const payload = `${JSON.stringify(historicalDieEvent())}\n`;
    streams[0]!.write(payload);
    await waitFor(() => sender.events.length >= 1);
    streams[0]!.end();
    await waitFor(() => streams.length === 2);
    assert.ok(Math.abs(connectOptions[1]!.since - 1_600_000_000) < 2);
    assert.ok(Math.abs(connectOptions[1]!.since - Math.floor(Date.now() / 1000)) > 1000);
    streams[1]!.write(payload);
    await waitFor(() => sender.events.length >= 2);
    assert.equal(sender.events[0]!.id, sender.events[1]!.id);
    assert.equal(
      sender.events[0]!.id,
      dockerOpsEventId('test-node-01', 'abc123def456', 'die', 1_600_000_000_123_456),
    );
    watcher.stop();
    streams[1]!.end();
  });

  it('retries Docker reconnect until the stream succeeds', async () => {
    let attempts = 0;
    const sender = recordingSender();
    const stream = new PassThrough();
    const watcher = createDockerWatcher(makeConfig(), sender, {
      initialBackoffMs: 20,
      maxBackoffMs: 80,
      connect: async () => {
        attempts++;
        if (attempts < 3) throw new Error(`connect failed ${attempts}`);
        return stream;
      },
    });
    await watcher.start();
    await waitFor(() => attempts >= 3);
    assert.ok(attempts >= 3);
    watcher.stop();
    stream.end();
  });

  it('replays a lookback event after a new watcher process starts', async () => {
    const lookback = 300;
    const eventTime = Math.floor(Date.now() / 1000) - 60;
    const dockerEvent: DockerEvent = {
      Type: 'container',
      Action: 'die',
      Actor: {
        ID: 'abc123def456',
        Attributes: { name: 'dataease', image: 'dataease:latest', exitCode: '137' },
      },
      time: eventTime,
      timeNano: eventTime * 1000,
    };
    const expectedId = dockerOpsEventId('test-node-01', 'abc123def456', 'die', dockerEvent.timeNano);
    const connectOptions: Array<{ since: number }> = [];
    const sender = recordingSender();
    const watcher = createDockerWatcher(
      makeConfig({ dockerReplayLookbackSeconds: lookback }),
      sender,
      {
        initialBackoffMs: 20,
        maxBackoffMs: 80,
        connect: async (options) => {
          connectOptions.push(options);
          const stream = new PassThrough();
          queueMicrotask(() => {
            if (options.since <= eventTime) {
              stream.write(`${JSON.stringify(dockerEvent)}\n`);
            }
          });
          return stream;
        },
      },
    );
    await watcher.start();
    await waitFor(() => sender.events.length >= 1);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(connectOptions[0]!.since <= eventTime);
    assert.ok(now - connectOptions[0]!.since >= lookback - 1);
    assert.ok(now - connectOptions[0]!.since <= lookback + 2);
    assert.equal(sender.events[0]!.id, expectedId);
    watcher.stop();
  });
});