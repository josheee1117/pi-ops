import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { NodeAgentConfig } from '../config.js';
import type { EvidenceQueryRequest, EvidenceQueryResult } from './types.js';

export interface DockerInspectResult {
  Id?: string;
  Name?: string;
  RestartCount?: number;
  State?: {
    Status?: string;
    Running?: boolean;
    StartedAt?: string;
    OOMKilled?: boolean;
    ExitCode?: number;
    Health?: { Status?: string };
  };
  Config?: { Image?: string };
  HostConfig?: { Memory?: number };
}

export interface DockerStatsResult {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: { usage?: number; limit?: number };
  pids_stats?: unknown;
}

export interface DockerLogOptions {
  maxLines: number;
  since?: number;
  until?: number;
}

export type DockerLogFetcher = (
  config: NodeAgentConfig,
  container: string,
  options: DockerLogOptions,
  rawLimit: number,
) => Promise<{ buffer: Buffer; truncated: boolean }>;

export type DockerJsonFetcher = (
  config: NodeAgentConfig,
  path: string,
  maxBytes: number,
) => Promise<unknown>;

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

function toUnixSeconds(value: string): number | undefined {
  if (/^\d+[smh]$/.test(value)) return durationToUnixSeconds(value);
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/** Stream one Docker Engine response and stop before it exceeds maxBytes. */
export function fetchDockerBytes(
  config: NodeAgentConfig,
  path: string,
  maxBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      socketPath: config.dockerSocketPath,
      path,
      method: 'GET',
    });

    req.setTimeout(config.dockerQueryTimeoutMs, () => {
      req.destroy(new Error(`Docker query timed out after ${config.dockerQueryTimeoutMs}ms`));
    });

    req.once('error', reject);
    req.once('response', (response) => {
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new Error(`Docker Engine returned HTTP ${response.statusCode ?? 'unknown'}`));
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        resolve({ buffer: Buffer.concat(chunks, total), truncated });
      };

      response.on('data', (chunk: Buffer) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = maxBytes - total;
        if (remaining <= 0) {
          truncated = true;
          response.destroy();
          finish();
          return;
        }
        if (buffer.length > remaining) {
          chunks.push(buffer.subarray(0, remaining));
          total += remaining;
          truncated = true;
          response.destroy();
          finish();
          return;
        }
        chunks.push(buffer);
        total += buffer.length;
      });
      response.once('end', finish);
      response.once('close', () => {
        if (truncated) finish();
      });
      response.once('error', (err) => {
        if (truncated) finish();
        else if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
    req.end();
  });
}

/** Stream Docker logs directly from the Engine socket and stop at rawLimit. */
export const fetchDockerLogs: DockerLogFetcher = async (
  config,
  container,
  options,
  rawLimit,
) => {
  const params = new URLSearchParams({
    stdout: '1',
    stderr: '1',
    follow: '0',
    timestamps: '0',
    tail: String(options.maxLines),
  });
  if (options.since !== undefined) params.set('since', String(options.since));
  if (options.until !== undefined) params.set('until', String(options.until));
  return fetchDockerBytes(
    config,
    `/containers/${encodeURIComponent(container)}/logs?${params.toString()}`,
    rawLimit,
  );
};

export const fetchDockerJson: DockerJsonFetcher = async (
  config,
  path,
  maxBytes,
) => {
  const response = await fetchDockerBytes(config, path, maxBytes);
  if (response.truncated) {
    throw new Error(`Docker JSON response exceeds ${maxBytes} bytes`);
  }
  try {
    return JSON.parse(response.buffer.toString('utf-8')) as unknown;
  } catch {
    throw new Error('Docker Engine returned invalid JSON');
  }
};

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
  fetchJson: DockerJsonFetcher = fetchDockerJson,
  fetchLogs: DockerLogFetcher = fetchDockerLogs,
): DockerEvidenceProvider {
  return {
    async query(request: EvidenceQueryRequest, config: NodeAgentConfig): Promise<EvidenceQueryResult> {
      const containerName = request.container!;
      let data: unknown;

      switch (request.type) {
        case 'docker.inspect': {
          const inspect = await fetchJson(
            config,
            `/containers/${encodeURIComponent(containerName)}/json`,
            config.maxResponseBytes,
          ) as DockerInspectResult;
          data = {
            Id: inspect.Id,
            Name: inspect.Name,
            State: {
              Status: inspect.State?.Status,
              Running: inspect.State?.Running,
              StartedAt: inspect.State?.StartedAt,
              OOMKilled: inspect.State?.OOMKilled,
              ExitCode: inspect.State?.ExitCode,
              Health: {
                Status: inspect.State?.Health?.Status,
              },
            },
            RestartCount: inspect.RestartCount,
            HostConfig: {
              Memory: inspect.HostConfig?.Memory,
            },
            Config: {
              Image: inspect.Config?.Image,
            },
          };
          break;
        }
        case 'docker.logs': {
          const maxLines = request.maxLines ?? config.logsMaxLines;
          const since = request.since ? toUnixSeconds(request.since) : undefined;
          const until = request.until ? toUnixSeconds(request.until) : undefined;
          const rawLimit = config.logsMaxBytes + maxLines * 8;
          const collected = await fetchLogs(
            config,
            containerName,
            {
              maxLines,
              ...(since !== undefined ? { since } : {}),
              ...(until !== undefined ? { until } : {}),
            },
            rawLimit,
          );
          data = decodeDockerLogs(
            collected.buffer,
            config.logsMaxBytes,
            maxLines,
            collected.truncated,
          );
          break;
        }
        case 'docker.stats': {
          const stats = await fetchJson(
            config,
            `/containers/${encodeURIComponent(containerName)}/stats?stream=0`,
            config.maxResponseBytes,
          ) as DockerStatsResult;
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
        id: `evd-${randomUUID()}`,
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
