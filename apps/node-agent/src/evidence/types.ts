import type { NodeAgentConfig } from '../config.js';

// ── Query types ──────────────────────────────────────────────────────────────

export type EvidenceQueryType =
  | 'docker.inspect'
  | 'docker.logs'
  | 'docker.stats'
  | 'host.memory'
  | 'host.load'
  | 'host.disk'
  | 'http.probe';

export const ALLOWED_QUERY_TYPES: ReadonlySet<string> = new Set([
  'docker.inspect',
  'docker.logs',
  'docker.stats',
  'host.memory',
  'host.load',
  'host.disk',
  'http.probe',
]);

// ── Request ──────────────────────────────────────────────────────────────────

export interface EvidenceQueryRequest {
  type: EvidenceQueryType;
  incidentId: string;
  // Docker params
  container?: string;
  maxLines?: number;
  since?: string;
  // Host params
  path?: string;
  // HTTP probe params
  url?: string;
  method?: string;
  timeout?: number;
}

// ── Validation errors ────────────────────────────────────────────────────────

export interface QueryValidationError {
  field: string;
  message: string;
}

export function validateQueryRequest(
  body: unknown,
  config: NodeAgentConfig,
): { valid: true; request: EvidenceQueryRequest } | { valid: false; errors: QueryValidationError[] } {
  const errors: QueryValidationError[] = [];
  if (!body || typeof body !== 'object') {
    return { valid: false, errors: [{ field: 'body', message: 'Request body must be a JSON object' }] };
  }

  const req = body as Record<string, unknown>;

  // type
  const type = req['type'];
  if (typeof type !== 'string' || !ALLOWED_QUERY_TYPES.has(type)) {
    errors.push({ field: 'type', message: `Unknown or missing query type. Allowed: ${[...ALLOWED_QUERY_TYPES].join(', ')}` });
  }

  // incidentId
  const incidentId = req['incidentId'];
  if (typeof incidentId !== 'string' || incidentId.length === 0) {
    errors.push({ field: 'incidentId', message: 'incidentId is required' });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const request: EvidenceQueryRequest = {
    type: type as EvidenceQueryType,
    incidentId: incidentId as string,
  };

  // Per-type param validation
  switch (type) {
    case 'docker.inspect':
    case 'docker.logs':
    case 'docker.stats': {
      const container = req['container'];
      if (typeof container !== 'string' || container.length === 0) {
        errors.push({ field: 'container', message: 'container is required for docker queries' });
      } else if (config.allowedContainers.size > 0 && !config.allowedContainers.has(container)) {
        errors.push({ field: 'container', message: `Container "${container}" is not in the allowlist` });
      }
      request.container = container as string;

      // docker.logs-specific bounds
      if (type === 'docker.logs') {
        const rawMaxLines = req['maxLines'];
        if (rawMaxLines != null) {
          const maxLines = Number(rawMaxLines);
          if (!Number.isInteger(maxLines) || maxLines <= 0) {
            errors.push({ field: 'maxLines', message: 'maxLines must be a positive integer' });
          } else if (maxLines > config.logsMaxLines) {
            errors.push({ field: 'maxLines', message: `maxLines exceeds maximum of ${config.logsMaxLines}` });
          }
          request.maxLines = maxLines;
        }
        const since = req['since'];
        if (since !== undefined && typeof since === 'string') {
          request.since = since;
        }
      }
      break;
    }
    case 'host.disk': {
      const path = req['path'];
      if (typeof path !== 'string' || path.length === 0) {
        errors.push({ field: 'path', message: 'path is required for host.disk' });
      } else if (!path.startsWith('/')) {
        errors.push({ field: 'path', message: 'path must be absolute' });
      }
      request.path = path as string;
      break;
    }
    case 'http.probe': {
      const url = req['url'];
      if (typeof url !== 'string' || url.length === 0) {
        errors.push({ field: 'url', message: 'url is required for http.probe' });
      } else {
        // Block internal/private IP ranges to prevent SSRF
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            errors.push({ field: 'url', message: 'Only http and https URLs are allowed' });
          }
        } catch {
          errors.push({ field: 'url', message: 'Invalid URL format' });
        }
      }
      request.url = url as string;
      const rawTimeout = req['timeout'];
      if (rawTimeout != null) {
        const timeout = Number(rawTimeout);
        if (!Number.isInteger(timeout) || timeout <= 0) {
          errors.push({ field: 'timeout', message: 'timeout must be a positive integer' });
        } else if (timeout > config.probeMaxTimeoutMs) {
          errors.push({ field: 'timeout', message: `timeout exceeds maximum of ${config.probeMaxTimeoutMs}ms` });
        }
        request.timeout = timeout;
      }
      const method = req['method'];
      if (method !== undefined && typeof method === 'string') {
        request.method = method;
      }
      break;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, request };
}

// ── Result ───────────────────────────────────────────────────────────────────

export interface EvidenceQueryResult {
  id: string;
  incidentId: string;
  nodeId: string;
  source: string;
  kind: string;
  collectedAt: string;
  data: unknown;
}

// ── Source mapping ───────────────────────────────────────────────────────────

export function queryTypeToSource(type: EvidenceQueryType): string {
  if (type.startsWith('docker.')) return 'docker';
  if (type.startsWith('host.')) return 'host';
  if (type === 'http.probe') return 'health';
  return 'unknown';
}