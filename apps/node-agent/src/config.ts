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
  };
}