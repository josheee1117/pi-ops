import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readModelConfig } from '../../message-cli.js';

const outDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(outDir, '../../../../../../');
const diagnosisConfig = readModelConfig(resolve(root, 'artifacts/real-dataasset-lab/central/runtime-secrets.env'));
const diagnosisCatalog = resolve(root, 'apps/pi-runtime/src/benchmark/results/2026-10-21-output-budget/pi-agent');
const handlerCatalog = join(homedir(), '.pi/agent');
const timeoutMs = Number(process.env['PROBE_TIMEOUT_MS'] ?? 60_000);
const redact = (value: unknown) => String(value ?? '').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]').split(diagnosisConfig.apiKey ?? 'NO_SECRET').join('[REDACTED]').slice(0, 800);

async function probe(spec: string, catalog: string, apiKey?: string) {
  const slash = spec.lastIndexOf('/');
  const provider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  const previous = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = catalog;
  const started = Date.now();
  try {
    const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
    if (apiKey) await runtime.setRuntimeApiKey(provider, apiKey);
    const model = runtime.getModel(provider, modelId);
    if (!model) return { spec, ok: false, error: 'model not in catalog', latencyMs: Date.now() - started };
    const result = await Promise.race([
      runtime.completeSimple(model, { messages: [{ role: 'user', content: 'Reply with the single word OK.', timestamp: Date.now() }] }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`probe timeout ${timeoutMs}ms`)), timeoutMs)),
    ]);
    const text = (result.content ?? []).map((part) => part.type === 'text' ? part.text : `[${part.type}]`).join('');
    return {
      spec, ok: result.stopReason === 'stop' && text.trim().length > 0, stopReason: result.stopReason,
      errorMessage: result.errorMessage ? redact(result.errorMessage) : null,
      usage: result.usage ?? null, text: text.slice(0, 120), latencyMs: Date.now() - started,
    };
  } catch (error) {
    return { spec, ok: false, error: redact(error instanceof Error ? error.message : error), latencyMs: Date.now() - started };
  } finally {
    if (previous === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previous;
  }
}

const results = [
  await probe(`${diagnosisConfig.provider}/${diagnosisConfig.model}`, diagnosisCatalog, diagnosisConfig.apiKey),
  await probe('cpa/deepseek-flash-latest', handlerCatalog),
  await probe('cpa/glm-latest', handlerCatalog),
];
for (const record of results) console.log(JSON.stringify(record));
writeFileSync(join(outDir, 'probe-models.json'), `${JSON.stringify({
  probedAt: new Date().toISOString(),
  diagnosisCatalog,
  handlerCatalog,
  note: 'diagnosis uses the production env key and the default agent catalog; handler and judge use ~/.pi/agent',
  results,
}, null, 2)}\n`);
