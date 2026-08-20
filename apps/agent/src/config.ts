/** Configuration loaded from environment variables. Secrets are never defaulted in code. */

export interface NodeAgentEndpoint {
  nodeId: string;
  url: string;
  token: string;
}

export interface AgentConfig {
  port: number;
  ingestToken: string;
  sqlitePath: string;
  nodeId: string;
  /** Maximum request body size in bytes (default 1 MB). */
  maxBodySize: number;
  /** Aggregation window in milliseconds. Events with the same fingerprint
   *  arriving within this window join the same incident. (default 5 min) */
  aggregationWindowMs: number;
  /** Node-agent endpoints keyed by node identity. */
  nodeAgents: Map<string, NodeAgentEndpoint>;
  /** Timeout for one typed evidence request. */
  evidenceTimeoutMs: number;
  /** Maximum response body accepted from a node agent. */
  evidenceMaxResponseBytes: number;
  /** Bounded log lines requested by deterministic evidence plans. */
  evidenceLogsMaxLines: number;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parseNodeAgents(): Map<string, NodeAgentEndpoint> {
  const raw = process.env['PI_OPS_NODE_AGENTS'];
  if (!raw) return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PI_OPS_NODE_AGENTS must be valid JSON');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('PI_OPS_NODE_AGENTS must be a JSON array');
  }

  const endpoints = new Map<string, NodeAgentEndpoint>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') {
      throw new Error('Each PI_OPS_NODE_AGENTS item requires nodeId, url, and token');
    }
    const candidate = item as Record<string, unknown>;
    const nodeId = candidate['nodeId'];
    const url = candidate['url'];
    const token = candidate['token'];
    if (
      typeof nodeId !== 'string' ||
      typeof url !== 'string' ||
      typeof token !== 'string' ||
      !nodeId ||
      !url ||
      !token
    ) {
      throw new Error('Each PI_OPS_NODE_AGENTS item requires nodeId, url, and token');
    }
    if (endpoints.has(nodeId)) {
      throw new Error(`Duplicate node-agent config for nodeId: ${nodeId}`);
    }
    endpoints.set(nodeId, {
      nodeId,
      url: url.replace(/\/$/, ''),
      token,
    });
  }
  return endpoints;
}

export function loadConfig(): AgentConfig {
  return {
    port: parseInt(process.env['PI_OPS_AGENT_PORT'] ?? '8080', 10),
    ingestToken: requireEnv('PI_OPS_INGEST_TOKEN'),
    sqlitePath: requireEnv('PI_OPS_SQLITE_PATH'),
    nodeId: process.env['PI_OPS_NODE_ID'] ?? 'default',
    maxBodySize: parseInt(process.env['PI_OPS_MAX_BODY_SIZE'] ?? String(1024 * 1024), 10),
    aggregationWindowMs: parseInt(
      process.env['PI_OPS_AGGREGATION_WINDOW_MS'] ?? String(5 * 60 * 1000),
      10,
    ),
    nodeAgents: parseNodeAgents(),
    evidenceTimeoutMs: parseInt(process.env['PI_OPS_EVIDENCE_TIMEOUT_MS'] ?? '5000', 10),
    evidenceMaxResponseBytes: parseInt(
      process.env['PI_OPS_EVIDENCE_MAX_RESPONSE_BYTES'] ?? String(1024 * 1024),
      10,
    ),
    evidenceLogsMaxLines: parseInt(process.env['PI_OPS_EVIDENCE_LOGS_MAX_LINES'] ?? '200', 10),
  };
}