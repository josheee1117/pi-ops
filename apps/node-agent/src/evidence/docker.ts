import Docker from 'dockerode';
import type { NodeAgentConfig } from '../config.js';
import type { EvidenceQueryRequest, EvidenceQueryResult } from './types.js';

export interface DockerInspectResult {
  Id?: string;
  Name?: string;
  State?: { Status?: string; Running?: boolean; StartedAt?: string };
  Config?: { Image?: string };
}

export interface DockerStatsResult {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: { usage?: number; limit?: number };
  pids_stats?: unknown;
}

export type DockerLogResult = Buffer | (AsyncIterable<unknown> & { destroy?: () => void });

export interface DockerContainerLike {
  inspect(): Promise<DockerInspectResult>;
  logs(options: Record<string, unknown>): Promise<DockerLogResult>;
  stats(options: { stream: false }): Promise<DockerStatsResult>;
}

export interface DockerClientLike {
  getContainer(name: string): DockerContainerLike;
}

export type DockerClientFactory = (config: NodeAgentConfig) => DockerClientLike;

/**
 * Docker evidence provider.
 *
 * Uses the Docker Engine API via the Unix socket. This carries root-equivalent
 * security risk because docker.sock access grants full container/host control.
 * All operations are strictly read-only: inspect, logs, stats.
 * Container access is gated by the allowlist in config.
 */
export interface DockerEvidenceProvider {
  query(request: EvidenceQueryRequest, config: NodeAgentConfig): Promise<EvidenceQueryResult>;
}

function durationToUnixSeconds(duration: string): number {
  const amount = parseInt(duration.slice(0, -1), 10);
  const unit = duration.at(-1);
  const seconds = amount * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1);
  return Math.floor(Date.now() / 1000) - seconds;
}

async function collectLogBuffer(
  result: DockerLogResult,
  rawLimit: number,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  if (Buffer.isBuffer(result)) {
    return {
      buffer: result.subarray(0, rawLimit),
      truncated: result.length > rawLimit,
    };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  for await (const chunk of result) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const remaining = rawLimit - total;
    if (remaining <= 0) {
      truncated = true;
      result.destroy?.();
      break;
    }
    if (buffer.length > remaining) {
      chunks.push(buffer.subarray(0, remaining));
      total += remaining;
      truncated = true;
      result.destroy?.();
      break;
    }
    chunks.push(buffer);
    total += buffer.length;
  }

  return { buffer: Buffer.concat(chunks, total), truncated };
}

function isMultiplexHeader(buffer: Buffer, offset: number): boolean {
  return (
    offset + 8 <= buffer.length &&
    buffer[offset]! <= 2 &&
    buffer[offset + 1] === 0 &&
    buffer[offset + 2] === 0 &&
    buffer[offset + 3] === 0
  );
}

/** Decode Docker's 8-byte multiplex frames, then enforce output byte/line caps. */
export function decodeDockerLogs(
  buffer: Buffer,
  maxBytes: number,
  maxLines: number,
  rawTruncated = false,
): { lines: string[]; truncated: boolean } {
  const payloads: Buffer[] = [];
  let payloadBytes = 0;
  let truncated = rawTruncated;

  if (isMultiplexHeader(buffer, 0)) {
    let offset = 0;
    while (isMultiplexHeader(buffer, offset)) {
      const frameLength = buffer.readUInt32BE(offset + 4);
      const payloadStart = offset + 8;
      const available = Math.min(frameLength, buffer.length - payloadStart);
      const remaining = maxBytes - payloadBytes;
      const take = Math.max(0, Math.min(available, remaining));
      if (take > 0) {
        payloads.push(buffer.subarray(payloadStart, payloadStart + take));
        payloadBytes += take;
      }
      if (available < frameLength || take < frameLength) truncated = true;
      if (available < frameLength || remaining <= available) break;
      offset = payloadStart + frameLength;
    }
  } else {
    const take = Math.min(buffer.length, maxBytes);
    payloads.push(buffer.subarray(0, take));
    payloadBytes = take;
    if (take < buffer.length) truncated = true;
  }

  let lines = Buffer.concat(payloads, payloadBytes)
    .toString('utf-8')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);

  if (lines.length > maxLines) {
    lines = lines.slice(-maxLines);
    truncated = true;
  }

  return { lines, truncated };
}

export function createDockerEvidenceProvider(
  createClient: DockerClientFactory = (config) =>
    new Docker({ socketPath: config.dockerSocketPath }) as unknown as DockerClientLike,
): DockerEvidenceProvider {
  return {
    async query(request: EvidenceQueryRequest, config: NodeAgentConfig): Promise<EvidenceQueryResult> {
      const docker = createClient(config);
      const containerName = request.container!;
      const container = docker.getContainer(containerName);

      let data: unknown;

      switch (request.type) {
        case 'docker.inspect': {
          const inspect = await container.inspect();
          data = {
            Id: inspect.Id,
            Name: inspect.Name,
            State: {
              Status: inspect.State?.Status,
              Running: inspect.State?.Running,
              StartedAt: inspect.State?.StartedAt,
            },
            Config: {
              Image: inspect.Config?.Image,
              Env: undefined, // never expose env vars
            },
          };
          break;
        }
        case 'docker.logs': {
          const maxLines = request.maxLines ?? config.logsMaxLines;
          const since = request.since ? durationToUnixSeconds(request.since) : undefined;
          const logOptions = {
            stdout: true,
            stderr: true,
            follow: false,
            tail: maxLines,
            timestamps: false,
            ...(since !== undefined ? { since } : {}),
          };
          const result = await container.logs(logOptions);
          // Multiplex framing adds 8 bytes per line/frame; include only that
          // bounded overhead while collecting the raw response.
          const rawLimit = config.logsMaxBytes + maxLines * 8;
          const collected = await collectLogBuffer(result, rawLimit);
          data = decodeDockerLogs(
            collected.buffer,
            config.logsMaxBytes,
            maxLines,
            collected.truncated,
          );
          break;
        }
        case 'docker.stats': {
          const stats = await container.stats({ stream: false });
          data = {
            cpu_stats: stats.cpu_stats
              ? {
                  cpu_usage: {
                    total_usage: stats.cpu_stats.cpu_usage?.total_usage,
                    system_cpu_usage: stats.cpu_stats.system_cpu_usage,
                  },
                }
              : undefined,
            memory_stats: stats.memory_stats
              ? {
                  usage: stats.memory_stats.usage,
                  limit: stats.memory_stats.limit,
                }
              : undefined,
            pids_stats: stats.pids_stats,
          };
          break;
        }
        default:
          throw new Error(`Unsupported Docker query type: ${request.type}`);
      }

      return {
        id: `evd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        incidentId: request.incidentId,
        nodeId: config.nodeId,
        source: 'docker',
        kind: request.type,
        collectedAt: new Date().toISOString(),
        data,
      };
    },
  };
}
