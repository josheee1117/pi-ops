import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = dirname(fileURLToPath(import.meta.url));
const specs = process.argv.slice(2);
const timeoutMs = Number(process.env['PROBE_TIMEOUT_MS'] ?? 45_000);
process.env['PI_CODING_AGENT_DIR'] = join(homedir(), '.pi/agent');
const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
const redact = (value: unknown) => String(value ?? '').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 800);
const results: unknown[] = [];
for (const spec of specs) {
  const slash = spec.lastIndexOf('/');
  const provider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  const started = Date.now();
  const model = runtime.getModel(provider, modelId);
  if (!model) {
    const record = { spec, ok: false, error: 'model not in catalog', latencyMs: Date.now() - started };
    results.push(record);
    console.log(JSON.stringify(record));
    continue;
  }
  try {
    const result = await Promise.race([
      runtime.completeSimple(model, {
        messages: [{ role: 'user', content: 'Reply with the single word OK.', timestamp: Date.now() }],
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`probe timeout ${timeoutMs}ms`)), timeoutMs)),
    ]);
    const text = (result.content ?? []).map((part) => part.type === 'text' ? part.text : `[${part.type}]`).join('');
    const record = {
      spec,
      ok: result.stopReason === 'stop' && text.trim().length > 0,
      stopReason: result.stopReason,
      errorMessage: result.errorMessage ? redact(result.errorMessage) : null,
      usage: result.usage ?? null,
      text: text.slice(0, 200),
      latencyMs: Date.now() - started,
    };
    results.push(record);
    console.log(JSON.stringify(record));
  } catch (error) {
    const record = { spec, ok: false, error: redact(error instanceof Error ? error.message : error), latencyMs: Date.now() - started };
    results.push(record);
    console.log(JSON.stringify(record));
  }
}
const probeOut = process.env['PROBE_OUT'] ?? 'probe-models.json';
writeFileSync(join(outDir, probeOut), `${JSON.stringify({
  probedAt: new Date().toISOString(),
  catalog: process.env['PI_CODING_AGENT_DIR'],
  note: 'minimal completeSimple; no runtime api key override; ark key not used',
  results,
}, null, 2)}\n`);
