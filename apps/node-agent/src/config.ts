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
  /** Maximum evidence-query request body size in bytes. */
  maxRequestBytes: number;
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

function integerEnv(
  key: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const raw = process.env[key];
  const text = raw ?? String(fallback);
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw new Error(`${key} must be a strict integer between ${min} and ${max}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be a strict integer between ${min} and ${max}`);
  }
  return value;
}

function thresholdEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  const text = raw ?? String(fallback);
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(text)) {
    throw new Error(`${key} must be a finite number greater than 0 and at most 1`);
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${key} must be a finite number greater than 0 and at most 1`);
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
    if (
      intervalMs !== undefined &&
      (typeof intervalMs !== 'number' ||
        !Number.isSafeInteger(intervalMs) ||
        intervalMs <= 0 ||
        intervalMs > 60 * 60 * 1000)
    ) {
      throw new Error(`Health target intervalMs must be a bounded positive integer: ${name}`);
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
    port: integerEnv('PI_OPS_NODE_PORT', 8081, { max: 65_535 }),
    nodeToken: requireEnv('PI_OPS_NODE_TOKEN'),
    nodeId: process.env['PI_OPS_NODE_ID'] ?? 'default',
    allowedContainers,
    dockerSocketPath: process.env['PI_OPS_DOCKER_SOCKET'] ?? '/var/run/docker.sock',
    allowedDiskPaths,
    logsMaxLines: integerEnv('PI_OPS_LOGS_MAX_LINES', 200, { max: 100_000 }),
    logsMaxBytes: integerEnv('PI_OPS_LOGS_MAX_BYTES', 1024 * 1024, {
      max: 100 * 1024 * 1024,
    }),
    dockerQueryTimeoutMs: integerEnv('PI_OPS_DOCKER_QUERY_TIMEOUT_MS', 5000, {
      max: 10 * 60 * 1000,
    }),
    probeMaxTimeoutMs: integerEnv('PI_OPS_PROBE_MAX_TIMEOUT_MS', 30_000, {
      max: 10 * 60 * 1000,
    }),
    maxResponseBytes: integerEnv('PI_OPS_MAX_RESPONSE_BYTES', 1024 * 1024, {
      max: 100 * 1024 * 1024,
    }),
    maxRequestBytes: integerEnv('PI_OPS_NODE_MAX_REQUEST_BYTES', 64 * 1024, {
      max: 10 * 1024 * 1024,
    }),
    // Event source
    agentUrl: process.env['PI_OPS_AGENT_URL'] ?? 'http://localhost:8080',
    ingestToken: process.env['PI_OPS_INGEST_TOKEN'] ?? '',
    eventQueueSize: integerEnv('PI_OPS_EVENT_QUEUE_SIZE', 1000, { max: 1_000_000 }),
    eventSendTimeoutMs: integerEnv('PI_OPS_EVENT_SEND_TIMEOUT_MS', 5000, {
      max: 10 * 60 * 1000,
    }),
    eventMaxRetries: integerEnv('PI_OPS_EVENT_MAX_RETRIES', 3, { min: 0, max: 100 }),
    eventFlushIntervalMs: integerEnv('PI_OPS_EVENT_FLUSH_INTERVAL_MS', 1000, {
      max: 60 * 60 * 1000,
    }),
    // Detectors
    detectorPollIntervalMs: integerEnv('PI_OPS_DETECTOR_POLL_INTERVAL_MS', 10_000, {
      max: 60 * 60 * 1000,
    }),
    memoryPressureThreshold: thresholdEnv('PI_OPS_MEMORY_PRESSURE_THRESHOLD', 0.9),
    memoryPressureDuration: integerEnv('PI_OPS_MEMORY_PRESSURE_DURATION', 3, {
      max: 10_000,
    }),
    diskPressureThreshold: thresholdEnv('PI_OPS_DISK_PRESSURE_THRESHOLD', 0.9),
    diskPressurePath,
    diskPressureDuration: integerEnv('PI_OPS_DISK_PRESSURE_DURATION', 3, {
      max: 10_000,
    }),
    healthTargets: parseHealthTargets(),
    healthFailureDuration: integerEnv('PI_OPS_HEALTH_FAILURE_DURATION', 2, {
      max: 10_000,
    }),
  };
}