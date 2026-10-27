import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { readModelConfig } from '../../message-cli.js';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const root = resolve(import.meta.dirname, '../../../../../..');
const config = readModelConfig(resolve(root, 'artifacts/real-dataasset-lab/central/runtime-secrets.env'));
const previous = process.env['PI_CODING_AGENT_DIR'];
process.env['PI_CODING_AGENT_DIR'] = resolve(root, 'apps/pi-runtime/src/benchmark/results/2026-10-21-output-budget/pi-agent');
const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
if (config.apiKey) await runtime.setRuntimeApiKey(config.provider, config.apiKey);
if (previous === undefined) delete process.env['PI_CODING_AGENT_DIR'];
else process.env['PI_CODING_AGENT_DIR'] = previous;
const model = runtime.getModel(config.provider, config.model);
if (!model) throw new Error('configured model unavailable');
const result = await runtime.completeSimple(model, { messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }] });
const safe = JSON.stringify({ provider: config.provider, model: config.model, stopReason: result.stopReason,
  errorMessage: result.errorMessage, usage: result.usage, content: result.content }, null, 2).split(config.apiKey ?? 'NO_SECRET').join('[REDACTED]');
writeFileSync(resolve(import.meta.dirname, 'probe-model.json'), `${safe}\n`);
console.log(safe);
