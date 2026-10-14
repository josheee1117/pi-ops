/**
 * Container-log discovery from the Docker log API.
 *
 * This is the fault-detection path for deployments that run the application
 * image alone: no Pi-Ops sender, no Node Agent probes inside the app. It reads
 * only containers already present in `allowedContainers`, and it is strictly
 * read-only (the same logs endpoint evidence collection uses).
 */
import type { OpsEvent } from '@pi-ops/protocol';
import type { NodeAgentConfig } from '../config.js';
import type { EventSender } from '../events/sender.js';
import { decodeDockerLogs, fetchDockerLogs, type DockerLogFetcher } from '../evidence/docker.js';
import { hasJfrPayload, scanContainerLog, type LogScanSource } from '../events/log-events.js';

export interface LogDetector {
  start(): void;
  stop(): void;
  pollOnce(): Promise<void>;
}

export interface LogDetectorOptions {
  fetchLogs?: DockerLogFetcher;
}

interface ContainerCursor {
  /** Unix seconds; Docker's `since` granularity means the overlap re-reads a little. */
  since: number;
  instrumented: boolean;
  recentFatal: Map<string, number>;
}

export function createLogDetector(
  config: NodeAgentConfig,
  sender: EventSender,
  options: LogDetectorOptions = {},
): LogDetector {
  const fetchLogs = options.fetchLogs ?? fetchDockerLogs;
  const cursors = new Map<string, ContainerCursor>();
  const seen = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function pruneSeen(nowMs: number): void {
    for (const [id, at] of seen) {
      if (nowMs - at > config.logScanDedupWindowMs) seen.delete(id);
    }
  }

  async function scanContainer(container: string, nowMs: number): Promise<void> {
    const cursor = cursors.get(container) ?? {
      since: Math.floor((nowMs - config.logScanInitialLookbackSeconds * 1000) / 1000),
      instrumented: false,
      recentFatal: new Map<string, number>(),
    };

    for (const [clazz, at] of cursor.recentFatal) {
      if (nowMs - at > config.logScanDedupWindowMs) cursor.recentFatal.delete(clazz);
    }

    let collected: { buffer: Buffer; truncated: boolean };
    try {
      collected = await fetchLogs(
        config,
        container,
        { maxLines: config.logScanMaxLines, since: cursor.since },
        config.logsMaxBytes + config.logScanMaxLines * 8,
      );
    } catch {
      // Engine unreachable or container gone: keep the cursor and retry next poll.
      cursors.set(container, cursor);
      return;
    }

    const decoded = decodeDockerLogs(
      collected.buffer,
      config.logsMaxBytes,
      config.logScanMaxLines,
      collected.truncated,
    );

    // Once a container shows JFR payloads, it reports its own exceptions.
    if (!cursor.instrumented && hasJfrPayload(decoded.lines)) cursor.instrumented = true;

    const source: LogScanSource = { container, nodeId: config.nodeId, service: container };
    let emitted = 0;
    const activeRecentFatal = new Set(cursor.recentFatal.keys());
    for (const event of scanContainerLog(decoded.lines, source, cursor.instrumented, activeRecentFatal)) {
      if (event.source === 'application' && (event.type === 'jvm.oom' || event.type === 'jvm.stack_overflow')) {
        const clazz = typeof event.attributes['exceptionClass'] === 'string' ? event.attributes['exceptionClass'] : undefined;
        if (clazz) cursor.recentFatal.set(clazz, nowMs);
        if (event.type === 'jvm.oom') cursor.recentFatal.set('java.lang.OutOfMemoryError', nowMs);
        if (event.type === 'jvm.stack_overflow') cursor.recentFatal.set('java.lang.StackOverflowError', nowMs);
      }
      if (seen.has(event.id)) continue;
      seen.set(event.id, nowMs);
      sender.enqueue(event);
      emitted += 1;
    }

    if (emitted > 0) {
      console.log(`[node-agent] log detector emitted ${emitted} event(s) from ${container}`);
    }

    cursors.set(container, {
      since: Math.floor((nowMs - config.logScanOverlapSeconds * 1000) / 1000),
      instrumented: cursor.instrumented,
      recentFatal: cursor.recentFatal,
    });
  }

  async function pollOnce(): Promise<void> {
    const nowMs = Date.now();
    pruneSeen(nowMs);
    for (const container of config.allowedContainers) {
      await scanContainer(container, nowMs);
    }
  }

  return {
    async pollOnce() {
      await pollOnce();
    },
    start(): void {
      if (config.allowedContainers.size === 0) {
        console.log('[node-agent] log detector idle (no PI_OPS_ALLOWED_CONTAINERS)');
        return;
      }
      console.log(
        `[node-agent] log detector started (${config.allowedContainers.size} container(s), interval ${config.logScanIntervalMs}ms)`,
      );
      timer = setInterval(() => {
        pollOnce().catch((error: unknown) => {
          console.error(`[node-agent] log detector error: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, config.logScanIntervalMs);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      console.log('[node-agent] log detector stopped');
    },
  };
}

/** Exposed for tests and for the entrypoint's startup check. */
export function logScanEnabled(config: NodeAgentConfig): boolean {
  return config.logScanEnabled && config.allowedContainers.size > 0;
}

export type { OpsEvent };
