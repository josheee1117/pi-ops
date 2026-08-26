export interface PiRuntimeConfig {
  port: number;
  token: string;
  timeoutMs: number;
  maxBodySize: number;
  maxContextBytes: number;
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
    timeoutMs: integerEnv('PI_OPS_PI_RUNTIME_TIMEOUT_MS', 15_000, { max: 10 * 60 * 1000 }),
    maxBodySize: integerEnv('PI_OPS_PI_RUNTIME_MAX_BODY_SIZE', 256 * 1024, { max: 2 * 1024 * 1024 }),
    maxContextBytes: integerEnv('PI_OPS_PI_RUNTIME_MAX_CONTEXT_BYTES', 16_384, {
      min: 1024,
      max: 256_000,
    }),
    piProvider: process.env['PI_OPS_PI_PROVIDER'] ?? '',
    piModel: process.env['PI_OPS_PI_MODEL'] ?? '',
    ...(piApiKey ? { piApiKey } : {}),
  };
}
