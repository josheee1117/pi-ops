import Docker from 'dockerode';
import { Readable } from 'node:stream';
import type { NodeAgentConfig } from '../config.js';
import type { EventSender } from './sender.js';
import {
  dockerEventToOpsEvent,
  createContainerStateTracker,
  dockerOpsEventId,
  type DockerEvent,
} from './docker-events.js';

export interface DockerWatcher {
  /** Start watching Docker events. Resolves when the reconnect loop is running. */
  start(): Promise<void>;
  /** Stop watching. */
  stop(): void;
}

export interface DockerEventsConnectOptions {
  since: number;
}

export type DockerEventsConnector = (
  options: DockerEventsConnectOptions,
) => Promise<Readable>;

export interface DockerWatcherOptions {
  connect?: DockerEventsConnector;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export function createDockerWatcher(
  config: NodeAgentConfig,
  sender: EventSender,
  options: DockerWatcherOptions = {},
): DockerWatcher {
  let stream: Readable | null = null;
  let running = false;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffResolve: (() => void) | null = null;
  let lastTimeNano: number | undefined;
  let lastEventTime: number | undefined;
  let lastConnectSince: number | undefined;

  const stateTracker = createContainerStateTracker();
  const initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  const connect: DockerEventsConnector = options.connect ?? (async ({ since }) => {
    const docker = new Docker({ socketPath: config.dockerSocketPath });
    const eventStream = await docker.getEvents({
      filters: JSON.stringify({
        type: ['container'],
        event: ['die', 'oom', 'health_status', 'start'],
      }),
      since,
    });
    return eventStream as unknown as Readable;
  });

  function reconnectSince(): number {
    if (lastEventTime !== undefined) return lastEventTime;
    if (lastTimeNano !== undefined) return Math.floor(lastTimeNano / 1e9);
    if (lastConnectSince !== undefined) return lastConnectSince;
    return Math.floor(Date.now() / 1000) - config.dockerReplayLookbackSeconds;
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      backoffResolve = resolve;
      backoffTimer = setTimeout(() => {
        backoffTimer = null;
        backoffResolve = null;
        resolve();
      }, ms);
    });
  }

  function trackCursor(dockerEvent: DockerEvent): void {
    if (typeof dockerEvent.timeNano === 'number'
      && (lastTimeNano === undefined || dockerEvent.timeNano >= lastTimeNano)
    ) {
      lastTimeNano = dockerEvent.timeNano;
    }
    if (typeof dockerEvent.time === 'number'
      && (lastEventTime === undefined || dockerEvent.time >= lastEventTime)
    ) {
      lastEventTime = dockerEvent.time;
    }
  }

  function processEvent(dockerEvent: DockerEvent): void {
    trackCursor(dockerEvent);

    const restartFlag = stateTracker.track(dockerEvent);
    if (restartFlag === 'restart') {
      const containerName = dockerEvent.Actor.Attributes['name'] ?? dockerEvent.Actor.ID.slice(0, 12);
      const restartEvent = {
        schemaVersion: 1 as const,
        id: dockerOpsEventId(
          config.nodeId,
          dockerEvent.Actor.ID,
          dockerEvent.Action,
          dockerEvent.timeNano,
        ),
        time: new Date(dockerEvent.time * 1000).toISOString(),
        source: 'docker' as const,
        nodeId: config.nodeId,
        service: containerName,
        type: 'container.restart' as const,
        severity: 'warning' as const,
        message: `Container ${containerName} restarted after failure`,
        attributes: {
          containerId: dockerEvent.Actor.ID,
          containerName,
          image: dockerEvent.Actor.Attributes['image'] ?? 'unknown',
          dockerAction: 'restart',
        },
      };
      sender.enqueue(restartEvent);
      return;
    }

    const opsEvent = dockerEventToOpsEvent(dockerEvent, config);
    if (opsEvent) {
      const ok = sender.enqueue(opsEvent);
      if (!ok) {
        console.warn(`[node-agent] dropped Docker event: ${opsEvent.type} ${opsEvent.service}`);
      }
    }
  }

  function consume(current: Readable): Promise<void> {
    return new Promise((resolve) => {
      let buffer = '';
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        current.off('data', onData);
        current.off('end', onEnd);
        current.off('error', onError);
        resolve();
      };
      const parseLines = (final = false) => {
        const lines = buffer.split('\n');
        buffer = final ? '' : (lines.pop() ?? '');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            processEvent(JSON.parse(line) as DockerEvent);
          } catch {
            // Malformed event — skip
          }
        }
      };
      const onData = (chunk: Buffer) => {
        if (!running) return;
        buffer += chunk.toString('utf-8');
        parseLines();
      };
      const onEnd = () => {
        parseLines(true);
        finish();
      };
      const onError = (err: Error) => {
        if (running) {
          console.error(`[node-agent] Docker event stream error: ${err.message}`);
        }
        finish();
      };
      current.on('data', onData);
      current.on('end', onEnd);
      current.on('error', onError);
    });
  }

  async function runLoop(): Promise<void> {
    let backoff = initialBackoffMs;
    while (running) {
      const since = reconnectSince();
      try {
        const next = await connect({ since });
        if (!running) {
          next.destroy();
          return;
        }
        lastConnectSince = since;
        stream = next;
        console.log(`[node-agent] Docker event watcher connected (since=${since})`);
        backoff = initialBackoffMs;
        await consume(next);
        stream = null;
      } catch (err) {
        stream = null;
        if (running) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[node-agent] Docker event stream failed: ${message}`);
        }
      }
      if (!running) return;
      console.log(`[node-agent] reconnecting Docker event stream in ${backoff}ms...`);
      await delay(backoff);
      backoff = Math.min(backoff * 2, maxBackoffMs);
    }
  }

  async function start(): Promise<void> {
    if (running) return;
    running = true;
    void runLoop();
  }

  function stop(): void {
    running = false;
    if (backoffTimer) {
      clearTimeout(backoffTimer);
      backoffTimer = null;
    }
    backoffResolve?.();
    backoffResolve = null;
    if (stream) {
      stream.destroy();
      stream = null;
    }
    console.log('[node-agent] Docker event watcher stopped');
  }

  return { start, stop };
}
