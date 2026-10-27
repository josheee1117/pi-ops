import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readModelConfig } from '../../message-cli.js';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const config = readModelConfig(resolve(root, 'artifacts/real-dataasset-lab/central/runtime-secrets.env'));
const specs = process.argv.slice(2);
const safe = (value: unknown) => String(value ?? '').split(config.apiKey ?? 'NO_SECRET').join('[REDACTED]')
  .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 1000);
for (const spec of specs) {
  const slash = spec.lastIndexOf('/');
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  process.env['PI_CODING_AGENT_DIR'] = provider === config.provider
    ? resolve(root, 'apps/pi-runtime/src/benchmark/results/2026-10-21-output-budget/pi-agent')
    : join(homedir(), '.pi/agent');
  try {
    const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
    if (provider === config.provider && config.apiKey) await runtime.setRuntimeApiKey(provider, config.apiKey);
    const model = runtime.getModel(provider, id);
    if (!model) throw new Error('model not in catalog');
    const response = await runtime.completeSimple(model, {
      messages: [{ role: 'user', content: 'Reply with the single word OK.', timestamp: Date.now() }],
    }, { maxTokens: 32, signal: AbortSignal.timeout(30_000) });
    console.log(JSON.stringify({ spec, ok: response.stopReason === 'stop', stopReason: response.stopReason,
      error: safe(response.errorMessage), usage: response.usage,
      text: response.content.filter((part) => part.type === 'text').map((part) => part.text).join('').slice(0, 100) }));
  } catch (error) {
    console.log(JSON.stringify({ spec, ok: false, error: safe(error instanceof Error ? error.message : error) }));
  }
}
