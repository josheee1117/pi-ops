import Docker from 'dockerode';
import { Readable } from 'node:stream';
import type { NodeAgentConfig } from '../config.js';
import type { EventSender } from './sender.js';
import { dockerEventToOpsEvent, createContainerStateTracker, type DockerEvent } from './docker-events.js';

export interface DockerWatcher {
  /** Start watching Docker events. Resolves when the stream is connected. */
  start(): Promise<void>;
  /** Stop watching. */
  stop(): void;
}

export function createDockerWatcher(
  config: NodeAgentConfig,
  sender: EventSender,
): DockerWatcher {
  let stream: Readable | null = null;
  let abortController: AbortController | null = null;
  let running = false;

  const stateTracker = createContainerStateTracker();

  async function start(): Promise<void> {
    running = true;
    const docker = new Docker({ socketPath: config.dockerSocketPath });

    // Connect to the Docker event stream
    const eventStream = await docker.getEvents({
      filters: JSON.stringify({
        type: ['container'],
        event: ['die', 'oom', 'health_status', 'start'],
      }),
      since: Math.floor(Date.now() / 1000),
    });

    stream = eventStream as unknown as Readable;
    abortController = new AbortController();

    console.log('[node-agent] Docker event watcher connected');

    // Process events as they arrive
    let buffer = '';

    const onData = (chunk: Buffer) => {
      if (!running) return;

      buffer += chunk.toString('utf-8');

      // Docker events are newline-delimited JSON
      const lines = buffer.split('\n');
      // Keep the last potentially incomplete line
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const dockerEvent: DockerEvent = JSON.parse(line);
          processEvent(dockerEvent);
        } catch {
          // Malformed event — skip
        }
      }
    };

    const onError = (err: Error) => {
      console.error(`[node-agent] Docker event stream error: ${err.message}`);
    };

    const onEnd = () => {
      console.log('[node-agent] Docker event stream ended');
      if (running) {
        // Reconnect after a delay
        setTimeout(() => {
          if (running) {
            console.log('[node-agent] reconnecting Docker event stream...');
            start().catch((err) => {
              console.error(`[node-agent] Docker event reconnection failed: ${err.message}`);
            });
          }
        }, 5000);
      }
    };

    stream.on('data', onData);
    stream.on('error', onError);
    stream.on('end', onEnd);
  }

  function processEvent(dockerEvent: DockerEvent): void {
    // Track container state for restart detection
    const restartFlag = stateTracker.track(dockerEvent);

    if (restartFlag === 'restart') {
      // Emit a restart event
      const containerName = dockerEvent.Actor.Attributes['name'] ?? dockerEvent.Actor.ID.slice(0, 12);
      const restartEvent = {
        schemaVersion: 1 as const,
        id: crypto.randomUUID(),
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

    // Convert to OpsEvent
    const opsEvent = dockerEventToOpsEvent(dockerEvent, config);
    if (opsEvent) {
      const ok = sender.enqueue(opsEvent);
      if (!ok) {
        console.warn(`[node-agent] dropped Docker event: ${opsEvent.type} ${opsEvent.service}`);
      }
    }
  }

  function stop(): void {
    running = false;
    if (abortController) {
      abortController.abort();
    }
    if (stream) {
      stream.destroy();
      stream = null;
    }
    console.log('[node-agent] Docker event watcher stopped');
  }

  return { start, stop };
}