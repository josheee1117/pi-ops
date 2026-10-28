import { createHash } from 'node:crypto';
import type { OpsEvent } from '@pi-ops/protocol';
import { serviceForContainer, type NodeAgentConfig } from '../config.js';
import type { EventSender } from '../events/sender.js';
import { decodeDockerLogs, fetchDockerJson, fetchDockerLogs, type DockerLogFetcher, type DockerLogRecord } from '../evidence/docker.js';
import { hasJfrPayload, scanContainerRecords, type LogScanSource } from '../events/log-events.js';

export interface LogScanStats {
  truncations: number;
  retryDropped: number;
  unfinishedDropped: number;
  dropped: number;
  retryQueueDepth: number;
}

export interface LogDetector {
  start(): void;
  stop(): void;
  pollOnce(): Promise<void>;
  stats(): LogScanStats;
}

export interface LogDetectorOptions {
  fetchLogs?: DockerLogFetcher;
  fetchContainerId?: (container: string) => Promise<string>;
  now?: () => number;
}

interface ContainerCursor {
  id: string;
  since: number;
  instrumented: boolean;
  recentFatal: Map<string, number>;
  reread: Map<string, number>;
  pending: { records: DockerLogRecord[]; since: number; collectionGap: boolean } | undefined;
  retries: Array<{ event: OpsEvent; rounds: number }>;
}

export function createLogDetector(config: NodeAgentConfig, sender: EventSender, options: LogDetectorOptions = {}): LogDetector {
  const fetchLogs = options.fetchLogs ?? fetchDockerLogs;
  const now = options.now ?? Date.now;
  const fetchContainerId = options.fetchContainerId ?? (async (container: string) => {
    const inspect = await fetchDockerJson(config, `/containers/${encodeURIComponent(container)}/json`, config.maxResponseBytes);
    if (!inspect || typeof inspect !== 'object' || !('Id' in inspect) || typeof inspect.Id !== 'string') throw new Error('Docker inspect is missing Id');
    return inspect.Id;
  });
  const cursors = new Map<string, ContainerCursor>();
  const seen = new Map<string, number>();
  const counters = { truncations: 0, retryDropped: 0, unfinishedDropped: 0 };
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  function deliver(cursor: ContainerCursor, event: OpsEvent, nowMs: number): void {
    if (seen.has(event.id) || cursor.retries.some((entry) => entry.event.id === event.id)) return;
    if (sender.enqueue(event)) seen.set(event.id, nowMs);
    else if (cursor.retries.length < 100) cursor.retries.push({ event, rounds: 0 });
    else counters.retryDropped += 1;
  }

  async function scanContainer(container: string, nowMs: number): Promise<void> {
    let cursor = cursors.get(container);
    if (cursor) {
      cursor.retries = cursor.retries.filter((entry) => {
        if (sender.enqueue(entry.event)) { seen.set(entry.event.id, nowMs); return false; }
        entry.rounds += 1;
        if (entry.rounds < 5) return true;
        counters.retryDropped += 1;
        return false;
      });
    }
    let id: string;
    try { id = await fetchContainerId(container); } catch { return; }
    if (!cursor || cursor.id !== id) {
      if (cursor?.pending) counters.unfinishedDropped += 1;
      cursor = {
        id, since: Math.floor((nowMs - config.logScanInitialLookbackSeconds * 1000) / 1000),
        instrumented: false, recentFatal: new Map(), reread: new Map(), pending: undefined,
        // A failed event is already a complete observation of the old container.
        retries: cursor?.retries ?? [],
      };
      cursors.set(container, cursor);
    }
    if (cursor.pending && nowMs - cursor.pending.since >= 60000) {
      counters.unfinishedDropped += 1;
      cursor.pending = undefined;
    }
    for (const [clazz, at] of cursor.recentFatal) if (nowMs - at > config.logScanDedupWindowMs) cursor.recentFatal.delete(clazz);
    let collected: Awaited<ReturnType<DockerLogFetcher>>;
    try {
      collected = await fetchLogs(config, id, { maxLines: config.logScanMaxLines, since: cursor.since }, config.logsMaxBytes + (config.logScanMaxLines + 1) * 8);
    } catch { return; }
    const decoded = decodeDockerLogs(collected.buffer, config.logsMaxBytes, config.logScanMaxLines, collected.truncated);
    if (decoded.truncated) {
      counters.truncations += 1;
      console.warn(`[node-agent] log scan truncated for ${container}; collectionGap=true`);
    }
    const batchKeys = new Map<string, number>();
    const fresh = decoded.records.filter((record) => {
      const key = createHash('sha256').update(JSON.stringify([record.stream, record.time, record.line])).digest('hex');
      const occurrence = (batchKeys.get(key) ?? 0) + 1;
      batchKeys.set(key, occurrence);
      return occurrence > (cursor.reread.get(key) ?? 0);
    });
    // Keep only the latest bounded response, rather than accumulating every log line.
    cursor.reread = batchKeys;
    if (hasJfrPayload(decoded.lines)) cursor.instrumented = true;
    const pendingSince = cursor.pending?.since ?? nowMs;
    const collectionGap = decoded.truncated || (cursor.pending?.collectionGap ?? false);
    const settledRecords = new Set(cursor.pending?.records ?? []);
    const records = [...settledRecords, ...fresh];
    cursor.pending = undefined;
    const source: LogScanSource = { container, nodeId: config.nodeId, service: serviceForContainer(config, container) };
    const scanned = scanContainerRecords(records, source, cursor.instrumented, new Set(cursor.recentFatal.keys()), true, settledRecords);
    counters.unfinishedDropped += scanned.unfinishedDropped;
    if (scanned.pending.length > 0) {
      // One bounded unfinished block per container, never an unbounded log buffer.
      const stream = scanned.pending[0]!.stream;
      const pending = scanned.pending.filter((record) => record.stream === stream);
      if (pending.length < scanned.pending.length) counters.unfinishedDropped += 1;
      if (pending.length > 200 || Buffer.byteLength(pending.map((record) => record.line).join('\n')) > 65536) counters.unfinishedDropped += 1;
      else cursor.pending = { records: pending, since: settledRecords.has(pending[0]!) ? pendingSince : nowMs, collectionGap };
    }
    for (const event of scanned.events) {
      if (collectionGap) event.attributes['collectionGap'] = true;
      if (event.source === 'application' && (event.type === 'jvm.oom' || event.type === 'jvm.stack_overflow')) {
        cursor.recentFatal.set(event.type === 'jvm.oom' ? 'java.lang.OutOfMemoryError' : 'java.lang.StackOverflowError', nowMs);
      }
      deliver(cursor, event, nowMs);
    }
    cursor.since = Math.floor((nowMs - config.logScanOverlapSeconds * 1000) / 1000);
  }

  async function pollOnce(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const nowMs = now();
      for (const [id, at] of seen) if (nowMs - at > config.logScanDedupWindowMs) seen.delete(id);
      for (const container of config.allowedContainers) await scanContainer(container, nowMs);
    } finally { polling = false; }
  }

  return {
    pollOnce,
    stats: () => ({
      ...counters, dropped: counters.retryDropped + counters.unfinishedDropped,
      retryQueueDepth: [...cursors.values()].reduce((total, cursor) => total + cursor.retries.length, 0),
    }),
    start() {
      if (config.allowedContainers.size === 0 || timer) return;
      console.log(`[node-agent] log detector started (${config.allowedContainers.size} container(s), interval ${config.logScanIntervalMs}ms)`);
      timer = setInterval(() => {
        pollOnce().catch((error: unknown) => console.error(`[node-agent] log detector error: ${error instanceof Error ? error.message : String(error)}`));
      }, config.logScanIntervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export function logScanEnabled(config: NodeAgentConfig): boolean {
  return config.logScanEnabled && config.allowedContainers.size > 0;
}

export type { OpsEvent };
