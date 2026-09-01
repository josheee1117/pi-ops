import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { NodeAgentConfig } from '../config.js';
import type { EvidenceQueryRequest, EvidenceQueryResult } from './types.js';

export interface HostEvidenceProvider {
  query(request: EvidenceQueryRequest, config: NodeAgentConfig): Promise<EvidenceQueryResult>;
}

export function createHostEvidenceProvider(): HostEvidenceProvider {
  return {
    async query(request: EvidenceQueryRequest, config: NodeAgentConfig): Promise<EvidenceQueryResult> {
      let data: unknown;

      switch (request.type) {
        case 'host.memory': {
          const total = os.totalmem();
          const free = os.freemem();
          const used = total - free;
          const usedPercent = total > 0 ? (used / total) * 100 : 0;
          data = {
            total,
            free,
            used,
            usedPercent,
            usagePercent: usedPercent.toFixed(2),
            uptime: os.uptime(),
          };
          break;
        }
        case 'host.load': {
          const [load1, load5, load15] = os.loadavg();
          data = {
            load1,
            load5,
            load15,
            cpus: os.cpus().length,
          };
          break;
        }
        case 'host.disk': {
          const path = request.path!;
          // Use df to get disk info for the specified path.
          // This is a bounded, typed query — not arbitrary shell execution.
          const output = execFileSync('df', ['-k', path], {
            encoding: 'utf-8',
            timeout: 5000,
            maxBuffer: 1024 * 1024, // 1MB
          });
          const lines = output.trim().split('\n');
          const header = lines[0];
          const values = lines[1] ?? '';

          const fields = values.split(/\s+/);
          data = {
            path,
            filesystem: fields[0] ?? 'unknown',
            totalKb: parseInt(fields[1] ?? '0', 10),
            usedKb: parseInt(fields[2] ?? '0', 10),
            availableKb: parseInt(fields[3] ?? '0', 10),
            usagePercent: fields[4] ?? '0%',
            mountedOn: fields[5] ?? path,
          };
          break;
        }
        default:
          throw new Error(`Unsupported host query type: ${request.type}`);
      }

      return {
        id: `evd-${randomUUID()}`,
        incidentId: request.incidentId,
        nodeId: config.nodeId,
        source: 'host',
        kind: request.type,
        collectedAt: new Date().toISOString(),
        data,
      };
    },
  };
}