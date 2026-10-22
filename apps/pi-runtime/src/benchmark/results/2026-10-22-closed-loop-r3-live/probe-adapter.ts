import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readModelConfig } from '../../message-cli.js';
import { createLiveBenchmarkModel } from '../../live-model.js';

const outDir = dirname(fileURLToPath(import.meta.url));
process.env['PI_CODING_AGENT_DIR'] = process.env['PROBE_CATALOG'] ?? join(homedir(), '.pi/agent');
const config = readModelConfig('/tmp/pi-ops-r3-live/diagnosis.env');
const redact = (value: unknown) => JSON.stringify(value).replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]');

async function probe(label: string, spec: { provider: string; model: string; thinkingLevel: 'off' }) {
  const started = Date.now();
  const { model } = await createLiveBenchmarkModel(spec);
  const response = await model.invoke({ system: 'Reply with the single word OK.', user: 'OK only.' });
  return {
    label,
    provider: model.provider,
    model: model.model,
    requestedThinking: spec.thinkingLevel,
    effectiveThinkingLevel: model.effectiveThinkingLevel,
    thinkingChars: response.thinkingChars,
    stopReason: response.stopReason,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    requestParameters: response.requestParameters,
    text: response.text.slice(0, 120),
    latencyMs: Date.now() - started,
  };
}

const diagnosis = await probe('diagnosis', { provider: config.provider, model: config.model, thinkingLevel: config.thinkingLevel });
const payload = {
  probedAt: new Date().toISOString(),
  configHasApiKey: Boolean(config.apiKey),
  catalog: process.env['PI_CODING_AGENT_DIR'],
  diagnosis,
};
writeFileSync(join(outDir, process.env['PROBE_ADAPTER_OUT'] ?? 'probe-adapter.json'), `${redact(payload)}\n`);
console.log(redact(payload));
