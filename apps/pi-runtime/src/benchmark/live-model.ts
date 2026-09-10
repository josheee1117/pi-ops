import { createPiSdkRuntimeModel } from '../pi-session.js';
import { parseThinkingLevel, type RuntimeThinkingLevel } from '../thinking-level.js';
import type { RuntimeModel } from '../model.js';

/**
 * Live benchmark model: the real Pi SDK adapter, exactly the one production uses.
 * Only used by `--mode live`. Requires provider credentials in the environment.
 */
export interface LiveModelOptions {
  thinkingLevel: RuntimeThinkingLevel;
  provider?: string;
  model?: string;
  apiKey?: string;
}

export interface LiveModelResult {
  model: RuntimeModel;
  provider: string;
  modelId: string;
}

export async function createLiveBenchmarkModel(options: LiveModelOptions): Promise<LiveModelResult> {
  const provider = options.provider ?? process.env['PI_OPS_PI_PROVIDER'] ?? '';
  const modelId = options.model ?? process.env['PI_OPS_PI_MODEL'] ?? '';
  const apiKey = options.apiKey ?? process.env['PI_OPS_PI_API_KEY'];
  if (!provider || !modelId) {
    throw new Error('live benchmark requires --provider/--model or PI_OPS_PI_PROVIDER/PI_OPS_PI_MODEL');
  }
  const model = await createPiSdkRuntimeModel({
    port: 0,
    token: 'benchmark',
    maxBodySize: 256 * 1024,
    maxContextBytes: 16_384,
    sqlitePath: ':memory:',
    callbackBaseUrl: 'http://127.0.0.1/benchmark',
    callbackTimeoutMs: 5000,
    executionTimeoutMs: 120_000,
    deliveryBackoffMs: 200,
    maxDeliveryAttempts: 1,
    piProvider: provider,
    piModel: modelId,
    ...(apiKey ? { piApiKey: apiKey } : {}),
  }, { thinkingLevel: options.thinkingLevel });
  return { model, provider, modelId };
}

export function liveThinkingLevelFrom(raw: string | undefined): RuntimeThinkingLevel {
  return parseThinkingLevel(raw, 'off');
}
