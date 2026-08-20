import Docker from 'dockerode';
import type { NodeAgentConfig } from '../config.js';
import type { EvidenceQueryRequest, EvidenceQueryResult } from './types.js';

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

export function createDockerEvidenceProvider(): DockerEvidenceProvider {
  const docker = new Docker({ socketPath: '/var/run/docker.sock' });

  // Override socketPath from config when creating the provider
  function createDocker(config: NodeAgentConfig): Docker {
    return new Docker({ socketPath: config.dockerSocketPath });
  }

  return {
    async query(request: EvidenceQueryRequest, config: NodeAgentConfig): Promise<EvidenceQueryResult> {
      const d = createDocker(config);
      const containerName = request.container!;

      const container = d.getContainer(containerName);

      let data: unknown;

      switch (request.type) {
        case 'docker.inspect': {
          const inspect = await container.inspect();
          // Only return safe, read-only fields
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
          const logOpts = {
            stdout: true,
            stderr: true,
            tail: maxLines,
            timestamps: false,
          };
          const stream = await container.logs(logOpts);
          const chunks: Buffer[] = [];
          let totalBytes = 0;

          for await (const chunk of stream) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            totalBytes += buf.length;
            if (totalBytes > config.logsMaxBytes) {
              chunks.push(Buffer.from('\n[...truncated: max bytes exceeded]'));
              break;
            }
            chunks.push(buf);
          }

          // Docker log format: 8-byte header + payload
          const text = Buffer.concat(chunks)
            .toString('utf-8')
            .split('\n')
            .map((line) => {
              // Strip Docker's 8-byte header from each line
              if (line.length > 8) return line.slice(8);
              return line;
            })
            .join('\n');

          data = {
            lines: text.split('\n').filter(Boolean),
            truncated: totalBytes > config.logsMaxBytes,
          };
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