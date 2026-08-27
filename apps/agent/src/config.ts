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
  /** Poll interval for durable evidence jobs. */
  evidenceJobPollIntervalMs: number;
  /** Maximum unexpected orchestration attempts per job. */
  evidenceJobMaxAttempts: number;
  /** Maximum jobs processed in one drain. */
  evidenceJobBatchSize: number;
  /** Maximum pending Events replayed in one startup transaction. */
  eventReplayBatchSize: number;
  /** Poll interval for durable reasoning jobs. */
  reasoningJobPollIntervalMs: number;
  /** Maximum unexpected reasoning attempts recorded on a job. */
  reasoningJobMaxAttempts: number;
  /** Timeout for one Reasoner invocation. */
  reasoningTimeoutMs: number;
  /** Maximum reasoning jobs processed in one drain. */
  reasoningJobBatchSize: number;
  /** Reasoner selected for newly created ReasoningJobs. */
  reasonerType: 'fake' | 'pi';
  /** Pi SDK provider id. Required when reasonerType is pi. */
  piProvider: string;
  /** Pi SDK model id. Required when reasonerType is pi. */
  piModel: string;
  /** Optional runtime API key override. Never logged. */
  piApiKey?: string;
  /** Bounded provider retries inside one ReasoningJob attempt. */
  reasoningMaxRetries: number;
  /** Maximum IncidentContext JSON bytes sent to the model. */
  reasoningMaxContextBytes: number;
  /** Maximum evidence items included in IncidentContext. */
  reasoningMaxEvidenceItems: number;
  /** Maximum log lines retained per evidence item. */
  reasoningMaxLogLines: number;
  /** Maximum model output bytes accepted as structured JSON. */
  reasoningMaxOutputBytes: number;
  /** External Pi Runtime base URL. When unset, investigation submit stays local/no-op. */
  piRuntimeUrl?: string;
  /** Bearer token shared with Pi Runtime. Never logged. */
  piRuntimeToken?: string;
  piRuntimeTimeoutMs?: number;
  piRuntimeCallbackUrl?: string;
  notificationWebhookUrl?: string;
  notificationTimeoutMs?: number;
  notificationMaxResponseBytes?: number;
  notificationJobPollIntervalMs?: number;
  notificationJobMaxAttempts?: number;
  notificationJobBatchSize?: number;
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
  const value = raw === undefined ? fallback : Number(raw);
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
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

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`Invalid node-agent URL for nodeId: ${nodeId}`);
    }
    if (
      !['http:', 'https:'].includes(parsedUrl.protocol)
      || parsedUrl.username
      || parsedUrl.password
      || parsedUrl.search
      || parsedUrl.hash
    ) {
      throw new Error(`Invalid node-agent URL for nodeId: ${nodeId}`);
    }

    endpoints.set(nodeId, {
      nodeId,
      url: parsedUrl.toString().replace(/\/$/, ''),
      token,
    });
  }
  return endpoints;
}

export function loadConfig(): AgentConfig {
  const reasonerType = parseReasonerType();
  const piProvider = process.env['PI_OPS_PI_PROVIDER'] ?? '';
  const piModel = process.env['PI_OPS_PI_MODEL'] ?? '';
  const piApiKey = process.env['PI_OPS_PI_API_KEY'];
  if (reasonerType === 'pi' && (!piProvider || !piModel)) {
    throw new Error('PI_OPS_PI_PROVIDER and PI_OPS_PI_MODEL are required when PI_OPS_REASONER_TYPE=pi');
  }
  return {
    port: integerEnv('PI_OPS_AGENT_PORT', 8080, { max: 65_535 }),
    ingestToken: requireEnv('PI_OPS_INGEST_TOKEN'),
    sqlitePath: requireEnv('PI_OPS_SQLITE_PATH'),
    nodeId: process.env['PI_OPS_NODE_ID'] ?? 'default',
    maxBodySize: integerEnv('PI_OPS_MAX_BODY_SIZE', 1024 * 1024, {
      max: 1024 * 1024 * 1024,
    }),
    aggregationWindowMs: integerEnv('PI_OPS_AGGREGATION_WINDOW_MS', 5 * 60 * 1000, {
      max: 30 * 24 * 60 * 60 * 1000,
    }),
    nodeAgents: parseNodeAgents(),
    evidenceTimeoutMs: integerEnv('PI_OPS_EVIDENCE_TIMEOUT_MS', 5000, {
      max: 10 * 60 * 1000,
    }),
    evidenceMaxResponseBytes: integerEnv(
      'PI_OPS_EVIDENCE_MAX_RESPONSE_BYTES',
      1024 * 1024,
      { max: 100 * 1024 * 1024 },
    ),
    evidenceLogsMaxLines: integerEnv('PI_OPS_EVIDENCE_LOGS_MAX_LINES', 200, {
      max: 100_000,
    }),
    evidenceJobPollIntervalMs: integerEnv('PI_OPS_EVIDENCE_JOB_POLL_INTERVAL_MS', 1000, {
      max: 60 * 60 * 1000,
    }),
    evidenceJobMaxAttempts: integerEnv('PI_OPS_EVIDENCE_JOB_MAX_ATTEMPTS', 3, {
      max: 100,
    }),
    evidenceJobBatchSize: integerEnv('PI_OPS_EVIDENCE_JOB_BATCH_SIZE', 10, {
      max: 1000,
    }),
    eventReplayBatchSize: integerEnv('PI_OPS_EVENT_REPLAY_BATCH_SIZE', 100, {
      max: 10_000,
    }),
    reasoningJobPollIntervalMs: integerEnv('PI_OPS_REASONING_JOB_POLL_INTERVAL_MS', 2000, {
      max: 60 * 60 * 1000,
    }),
    reasoningJobMaxAttempts: integerEnv('PI_OPS_REASONING_JOB_MAX_ATTEMPTS', 3, {
      max: 100,
    }),
    reasoningTimeoutMs: integerEnv('PI_OPS_REASONING_TIMEOUT_MS', 5000, {
      max: 10 * 60 * 1000,
    }),
    reasoningJobBatchSize: integerEnv('PI_OPS_REASONING_JOB_BATCH_SIZE', 10, {
      max: 1000,
    }),
    reasonerType,
    piProvider,
    piModel,
    ...(piApiKey ? { piApiKey } : {}),
    reasoningMaxRetries: integerEnv('PI_OPS_REASONING_MAX_RETRIES', 2, {
      min: 0,
      max: 10,
    }),
    reasoningMaxContextBytes: integerEnv('PI_OPS_REASONING_MAX_CONTEXT_BYTES', 32_768, {
      min: 1024,
      max: 1_000_000,
    }),
    reasoningMaxEvidenceItems: integerEnv('PI_OPS_REASONING_MAX_EVIDENCE_ITEMS', 12, {
      max: 50,
    }),
    reasoningMaxLogLines: integerEnv('PI_OPS_REASONING_MAX_LOG_LINES', 50, {
      max: 500,
    }),
    reasoningMaxOutputBytes: integerEnv('PI_OPS_REASONING_MAX_OUTPUT_BYTES', 8192, {
      min: 256,
      max: 100_000,
    }),
    ...(process.env['PI_OPS_PI_RUNTIME_URL']
      ? { piRuntimeUrl: process.env['PI_OPS_PI_RUNTIME_URL'] }
      : {}),
    ...(process.env['PI_OPS_PI_RUNTIME_TOKEN']
      ? { piRuntimeToken: process.env['PI_OPS_PI_RUNTIME_TOKEN'] }
      : {}),
    piRuntimeTimeoutMs: integerEnv('PI_OPS_PI_RUNTIME_TIMEOUT_MS', 5000, {
      max: 10 * 60 * 1000,
    }),
    ...(process.env['PI_OPS_PI_RUNTIME_CALLBACK_URL']
      ? { piRuntimeCallbackUrl: process.env['PI_OPS_PI_RUNTIME_CALLBACK_URL'] }
      : {}),
    ...(process.env['PI_OPS_NOTIFICATION_WEBHOOK_URL']
      ? { notificationWebhookUrl: process.env['PI_OPS_NOTIFICATION_WEBHOOK_URL'] }
      : {}),
    notificationTimeoutMs: integerEnv('PI_OPS_NOTIFICATION_TIMEOUT_MS', 3000, {
      max: 60_000,
    }),
    notificationMaxResponseBytes: integerEnv('PI_OPS_NOTIFICATION_MAX_RESPONSE_BYTES', 8192, {
      max: 1024 * 1024,
    }),
    notificationJobPollIntervalMs: integerEnv('PI_OPS_NOTIFICATION_JOB_POLL_INTERVAL_MS', 1000, {
      max: 60 * 60 * 1000,
    }),
    notificationJobMaxAttempts: integerEnv('PI_OPS_NOTIFICATION_JOB_MAX_ATTEMPTS', 5, {
      max: 100,
    }),
    notificationJobBatchSize: integerEnv('PI_OPS_NOTIFICATION_JOB_BATCH_SIZE', 20, {
      max: 1000,
    }),
  };
}

function parseReasonerType(): 'fake' | 'pi' {
  const raw = process.env['PI_OPS_REASONER_TYPE'] ?? 'fake';
  if (raw !== 'fake' && raw !== 'pi') {
    throw new Error('PI_OPS_REASONER_TYPE must be fake or pi');
  }
  return raw;
}