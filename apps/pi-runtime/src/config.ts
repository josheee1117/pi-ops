export interface PiRuntimeConfig {
  port: number;
  token: string;
  maxBodySize: number;
  maxContextBytes: number;
  sqlitePath: string;
  callbackBaseUrl: string;
  callbackTimeoutMs: number;
  executionTimeoutMs: number;
  deliveryBackoffMs: number;
  maxDeliveryAttempts: number;
  piProvider: string;
  piModel: string;
  piApiKey?: string;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function integerEnv(key: string, fallback: number, options: { min?: number; max?: number } = {}): number {
  const raw = process.env[key];
  const value = raw === undefined ? fallback : Number(raw);
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig(): PiRuntimeConfig {
  const piApiKey = process.env['PI_OPS_PI_API_KEY'];
  return {
    port: integerEnv('PI_OPS_PI_RUNTIME_PORT', 8090, { max: 65_535 }),
    token: requireEnv('PI_OPS_PI_RUNTIME_TOKEN'),
    maxBodySize: integerEnv('PI_OPS_PI_RUNTIME_MAX_BODY_SIZE', 256 * 1024, { max: 2 * 1024 * 1024 }),
    maxContextBytes: integerEnv('PI_OPS_PI_RUNTIME_MAX_CONTEXT_BYTES', 16_384, {
      min: 1024,
      max: 256_000,
    }),
    sqlitePath: requireEnv('PI_OPS_PI_RUNTIME_SQLITE_PATH'),
    callbackBaseUrl: requireEnv('PI_OPS_PI_RUNTIME_CALLBACK_URL'),
    callbackTimeoutMs: integerEnv('PI_OPS_PI_RUNTIME_CALLBACK_TIMEOUT_MS', 5000, { max: 10 * 60 * 1000 }),
    executionTimeoutMs: integerEnv('PI_OPS_PI_RUNTIME_EXECUTION_TIMEOUT_MS', 30_000, { max: 10 * 60 * 1000 }),
    deliveryBackoffMs: integerEnv('PI_OPS_PI_RUNTIME_DELIVERY_BACKOFF_MS', 200, { max: 60_000 }),
    maxDeliveryAttempts: integerEnv('PI_OPS_PI_RUNTIME_MAX_DELIVERY_ATTEMPTS', 5, { max: 20 }),
    piProvider: process.env['PI_OPS_PI_PROVIDER'] ?? '',
    piModel: process.env['PI_OPS_PI_MODEL'] ?? '',
    ...(piApiKey ? { piApiKey } : {}),
  };
}

export function callbackUrlAllowed(requested: string, allowed: string): boolean {
  try {
    const left = new URL(requested);
    const right = new URL(allowed);
    return left.origin === right.origin && normalizePath(left.pathname) === normalizePath(right.pathname);
  } catch {
    return false;
  }
}

function normalizePath(path: string): string {
  return path.replace(/\/$/, '') || '/';
}
