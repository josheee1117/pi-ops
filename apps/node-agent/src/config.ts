/** Configuration loaded from environment variables. */

export interface NodeAgentConfig {
  port: number;
  nodeToken: string;
  nodeId: string;
  /** Comma-separated list of container names allowed for evidence queries. */
  allowedContainers: Set<string>;
  /** Path to Docker Engine API socket. */
  dockerSocketPath: string;
  /** Maximum log lines returned by docker.logs. */
  logsMaxLines: number;
  /** Maximum log bytes returned by docker.logs. */
  logsMaxBytes: number;
  /** Maximum HTTP probe timeout in ms. */
  probeMaxTimeoutMs: number;
  /** Maximum response payload size in bytes. */
  maxResponseBytes: number;
  // ── Event source ──────────────────────────────────────────────────────────
  /** Central agent URL for event push. */
  agentUrl: string;
  /** Token for authenticating to the central agent. */
  ingestToken: string;
  /** Maximum number of events in the outbound queue. */
  eventQueueSize: number;
  /** HTTP timeout for event push (ms). */
  eventSendTimeoutMs: number;
  /** Maximum retry attempts for failed event pushes. */
  eventMaxRetries: number;
  /** Flush interval when queue is not full (ms). */
  eventFlushIntervalMs: number;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function loadConfig(): NodeAgentConfig {
  const raw = process.env['PI_OPS_ALLOWED_CONTAINERS'] ?? '';
  const allowedContainers = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  return {
    port: parseInt(process.env['PI_OPS_NODE_PORT'] ?? '8081', 10),
    nodeToken: requireEnv('PI_OPS_NODE_TOKEN'),
    nodeId: process.env['PI_OPS_NODE_ID'] ?? 'default',
    allowedContainers,
    dockerSocketPath: process.env['PI_OPS_DOCKER_SOCKET'] ?? '/var/run/docker.sock',
    logsMaxLines: parseInt(process.env['PI_OPS_LOGS_MAX_LINES'] ?? '200', 10),
    logsMaxBytes: parseInt(process.env['PI_OPS_LOGS_MAX_BYTES'] ?? String(1024 * 1024), 10),
    probeMaxTimeoutMs: parseInt(process.env['PI_OPS_PROBE_MAX_TIMEOUT_MS'] ?? '30000', 10),
    maxResponseBytes: parseInt(process.env['PI_OPS_MAX_RESPONSE_BYTES'] ?? String(1024 * 1024), 10),
    // Event source
    agentUrl: process.env['PI_OPS_AGENT_URL'] ?? 'http://localhost:8080',
    ingestToken: process.env['PI_OPS_INGEST_TOKEN'] ?? '',
    eventQueueSize: parseInt(process.env['PI_OPS_EVENT_QUEUE_SIZE'] ?? '1000', 10),
    eventSendTimeoutMs: parseInt(process.env['PI_OPS_EVENT_SEND_TIMEOUT_MS'] ?? '5000', 10),
    eventMaxRetries: parseInt(process.env['PI_OPS_EVENT_MAX_RETRIES'] ?? '3', 10),
    eventFlushIntervalMs: parseInt(process.env['PI_OPS_EVENT_FLUSH_INTERVAL_MS'] ?? '1000', 10),
  };
}