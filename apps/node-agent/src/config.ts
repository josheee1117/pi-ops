/** Configuration loaded from environment variables. */

export interface HealthTarget {
  name: string;
  url: string;
  method?: string;
  intervalMs?: number;
  /** Optional container mapping used for deterministic follow-up evidence. */
  container?: string;
}

export interface NodeAgentConfig {
  port: number;
  nodeToken: string;
  nodeId: string;
  /** Comma-separated list of container names allowed for evidence queries. */
  allowedContainers: Set<string>;
  /** Path to Docker Engine API socket. */
  dockerSocketPath: string;
  /** Explicit paths allowed for host.disk evidence queries. */
  allowedDiskPaths: Set<string>;
  /** Maximum log lines returned by docker.logs. */
  logsMaxLines: number;
  /** Maximum log bytes returned by docker.logs. */
  logsMaxBytes: number;
  /** Timeout for Docker evidence queries in ms. */
  dockerQueryTimeoutMs: number;
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
  // ── Detectors ─────────────────────────────────────────────────────────────
  /** Polling interval for detectors (ms). */
  detectorPollIntervalMs: number;
  /** Memory usage threshold (0-1). Default 0.9 = 90%. */
  memoryPressureThreshold: number;
  /** Consecutive samples above threshold to trigger. */
  memoryPressureDuration: number;
  /** Disk usage threshold (0-1). Default 0.9 = 90%. */
  diskPressureThreshold: number;
  /** Path to check for disk pressure. */
  diskPressurePath: string;
  /** Consecutive samples above threshold to trigger. */
  diskPressureDuration: number;
  /** Configured HTTP health targets. */
  healthTargets: HealthTarget[];
  /** Consecutive failed probes before emitting a health.failure event. */
  healthFailureDuration: number;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parseHealthTargets(): HealthTarget[] {
  const raw = process.env['PI_OPS_HEALTH_TARGETS'] ?? '';
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PI_OPS_HEALTH_TARGETS must be valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('PI_OPS_HEALTH_TARGETS must be a JSON array');
  }

  return parsed.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error('Each health target requires name and url');
    }
    const candidate = item as Record<string, unknown>;
    const name = candidate['name'];
    const url = candidate['url'];
    const method = candidate['method'] ?? 'GET';
    const intervalMs = candidate['intervalMs'];
    const container = candidate['container'];
    if (typeof name !== 'string' || !name || typeof url !== 'string' || !url) {
      throw new Error('Each health target requires name and url');
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`Invalid health target URL: ${url}`);
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Health target must use http or https: ${url}`);
    }
    if (typeof method !== 'string' || !['GET', 'HEAD'].includes(method.toUpperCase())) {
      throw new Error(`Health target method must be GET or HEAD: ${name}`);
    }
    if (intervalMs !== undefined && (typeof intervalMs !== 'number' || intervalMs <= 0)) {
      throw new Error(`Health target intervalMs must be positive: ${name}`);
    }
    if (container !== undefined && (typeof container !== 'string' || !container)) {
      throw new Error(`Health target container must be a non-empty string: ${name}`);
    }
    return {
      name,
      url: parsedUrl.toString(),
      method: method.toUpperCase(),
      ...(intervalMs !== undefined ? { intervalMs } : {}),
      ...(container !== undefined ? { container } : {}),
    };
  });
}

export function loadConfig(): NodeAgentConfig {
  const raw = process.env['PI_OPS_ALLOWED_CONTAINERS'] ?? '';
  const allowedContainers = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const diskPressurePath = process.env['PI_OPS_DISK_PRESSURE_PATH'] ?? '/';
  const allowedDiskPaths = new Set(
    (process.env['PI_OPS_ALLOWED_DISK_PATHS'] ?? diskPressurePath)
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
    allowedDiskPaths,
    logsMaxLines: parseInt(process.env['PI_OPS_LOGS_MAX_LINES'] ?? '200', 10),
    logsMaxBytes: parseInt(process.env['PI_OPS_LOGS_MAX_BYTES'] ?? String(1024 * 1024), 10),
    dockerQueryTimeoutMs: parseInt(process.env['PI_OPS_DOCKER_QUERY_TIMEOUT_MS'] ?? '5000', 10),
    probeMaxTimeoutMs: parseInt(process.env['PI_OPS_PROBE_MAX_TIMEOUT_MS'] ?? '30000', 10),
    maxResponseBytes: parseInt(process.env['PI_OPS_MAX_RESPONSE_BYTES'] ?? String(1024 * 1024), 10),
    // Event source
    agentUrl: process.env['PI_OPS_AGENT_URL'] ?? 'http://localhost:8080',
    ingestToken: process.env['PI_OPS_INGEST_TOKEN'] ?? '',
    eventQueueSize: parseInt(process.env['PI_OPS_EVENT_QUEUE_SIZE'] ?? '1000', 10),
    eventSendTimeoutMs: parseInt(process.env['PI_OPS_EVENT_SEND_TIMEOUT_MS'] ?? '5000', 10),
    eventMaxRetries: parseInt(process.env['PI_OPS_EVENT_MAX_RETRIES'] ?? '3', 10),
    eventFlushIntervalMs: parseInt(process.env['PI_OPS_EVENT_FLUSH_INTERVAL_MS'] ?? '1000', 10),
    // Detectors
    detectorPollIntervalMs: parseInt(process.env['PI_OPS_DETECTOR_POLL_INTERVAL_MS'] ?? '10000', 10),
    memoryPressureThreshold: parseFloat(process.env['PI_OPS_MEMORY_PRESSURE_THRESHOLD'] ?? '0.9'),
    memoryPressureDuration: parseInt(process.env['PI_OPS_MEMORY_PRESSURE_DURATION'] ?? '3', 10),
    diskPressureThreshold: parseFloat(process.env['PI_OPS_DISK_PRESSURE_THRESHOLD'] ?? '0.9'),
    diskPressurePath,
    diskPressureDuration: parseInt(process.env['PI_OPS_DISK_PRESSURE_DURATION'] ?? '3', 10),
    healthTargets: parseHealthTargets(),
    healthFailureDuration: parseInt(process.env['PI_OPS_HEALTH_FAILURE_DURATION'] ?? '2', 10),
  };
}