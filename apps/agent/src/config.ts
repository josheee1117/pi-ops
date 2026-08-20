/** Configuration loaded from environment variables. Secrets are never defaulted in code. */

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
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
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
  };
}