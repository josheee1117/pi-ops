import { randomUUID } from 'node:crypto';
import type { NodeAgentConfig } from '../config.js';
import type { EvidenceQueryRequest, EvidenceQueryResult } from './types.js';

export interface ProbeEvidenceProvider {
  query(request: EvidenceQueryRequest, config: NodeAgentConfig): Promise<EvidenceQueryResult>;
}

export function createProbeEvidenceProvider(): ProbeEvidenceProvider {
  return {
    async query(request: EvidenceQueryRequest, config: NodeAgentConfig): Promise<EvidenceQueryResult> {
      const url = request.url!;
      const method = request.method ?? 'GET';
      const timeout = request.timeout ?? config.probeMaxTimeoutMs;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const start = Date.now();
      let status: number | undefined;
      let error: string | undefined;

      try {
        const res = await fetch(url, {
          method,
          signal: controller.signal,
          redirect: 'manual',
        });
        status = res.status;
        // Probe semantics depend only on headers/status. Cancel immediately so a
        // large or never-ending body cannot consume memory or hold the query.
        await res.body?.cancel().catch(() => {});
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        clearTimeout(timeoutId);
      }

      const latencyMs = Date.now() - start;

      const data = {
        url,
        method,
        status,
        error,
        latencyMs,
        healthy: status !== undefined && status >= 200 && status < 400,
      };

      return {
        id: `evd-${randomUUID()}`,
        incidentId: request.incidentId,
        nodeId: config.nodeId,
        source: 'health',
        kind: 'http.probe',
        collectedAt: new Date().toISOString(),
        data,
      };
    },
  };
}