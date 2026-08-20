import {
  EVIDENCE_QUERY_TYPES,
  type Evidence,
  type EvidenceQueryRequest,
  type EvidenceQueryType,
} from '@pi-ops/protocol';
import type { NodeAgentConfig } from '../config.js';

export type { EvidenceQueryRequest, EvidenceQueryType } from '@pi-ops/protocol';

export const ALLOWED_QUERY_TYPES: ReadonlySet<string> = new Set(EVIDENCE_QUERY_TYPES);

// ── Validation errors ────────────────────────────────────────────────────────

export interface QueryValidationError {
  field: string;
  message: string;
}

const READ_ONLY_HTTP_METHODS = new Set(['GET', 'HEAD']);

function normalizeUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
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
      } else if (!config.allowedContainers.has(container)) {
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
        if (since !== undefined) {
          if (typeof since !== 'string' || !/^\d+[smh]$/.test(since)) {
            errors.push({ field: 'since', message: 'since must be a duration such as 30s, 2m, or 1h' });
          } else {
            const amount = parseInt(since.slice(0, -1), 10);
            const unit = since.at(-1);
            const seconds = amount * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1);
            if (seconds > 3600) {
              errors.push({ field: 'since', message: 'since cannot exceed 1h' });
            } else {
              request.since = since;
            }
          }
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
      } else if (!config.allowedDiskPaths.has(path)) {
        errors.push({ field: 'path', message: `Path "${path}" is not in the allowlist` });
      }
      request.path = path as string;
      break;
    }
    case 'http.probe': {
      const url = req['url'];
      const normalizedUrl = typeof url === 'string' ? normalizeUrl(url) : undefined;
      if (!normalizedUrl) {
        errors.push({ field: 'url', message: 'url must be a valid http or https URL' });
      }

      const rawMethod = req['method'];
      const method = typeof rawMethod === 'string' ? rawMethod.toUpperCase() : 'GET';
      if (!READ_ONLY_HTTP_METHODS.has(method)) {
        errors.push({ field: 'method', message: 'Only GET and HEAD are allowed' });
      }

      if (normalizedUrl && READ_ONLY_HTTP_METHODS.has(method)) {
        const isConfigured = config.healthTargets.some((target) => {
          const targetUrl = normalizeUrl(target.url);
          const targetMethod = (target.method ?? 'GET').toUpperCase();
          return targetUrl === normalizedUrl && targetMethod === method;
        });
        if (!isConfigured) {
          errors.push({ field: 'url', message: 'HTTP probe target is not configured' });
        }
      }

      request.url = normalizedUrl ?? (url as string);
      request.method = method;

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
      break;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, request };
}

// ── Result ───────────────────────────────────────────────────────────────────

export type EvidenceQueryResult = Evidence;

// ── Source mapping ───────────────────────────────────────────────────────────

export function queryTypeToSource(type: EvidenceQueryType): string {
  if (type.startsWith('docker.')) return 'docker';
  if (type.startsWith('host.')) return 'host';
  if (type === 'http.probe') return 'health';
  return 'unknown';
}