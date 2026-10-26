import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve, join } from 'node:path';
import { createFakeRuntimeModel } from '../model.js';
import { parseThinkingLevel } from '../thinking-level.js';
import { MESSAGE_CASES } from './message-cases.js';
import { createLiveBenchmarkModel } from './live-model.js';
import { runCase, estimateCaseTokens, type CaseResult } from './runner.js';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { renderMessageReport } from './report.js';
import { withoutSourceSnippetBodies } from './agent-chain.js';

export function readModelConfig(path: string) {
  const env = parseEnv(readFileSync(path, 'utf8'));
  const provider = env['PI_OPS_PI_PROVIDER'];
  const model = env['PI_OPS_PI_MODEL'];
  if (!provider || !model) throw new Error('model config must contain PI_OPS_PI_PROVIDER and PI_OPS_PI_MODEL');
  return { provider, model, thinkingLevel: parseThinkingLevel(env['PI_OPS_PI_THINKING_LEVEL']), apiKey: env['PI_OPS_PI_API_KEY'] };
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const configPath = resolve(root, value('--config') ?? 'artifacts/real-dataasset-lab/central/runtime-secrets.env');
  const mode = args.includes('--live') ? 'live' : 'fake';
  const config = mode === 'live' ? readModelConfig(configPath)
    : { provider: 'fake', model: 'deterministic', thinkingLevel: 'off' as const, apiKey: undefined };
  const cases = value('--case') ? MESSAGE_CASES.filter((item) => item.id === value('--case')) : MESSAGE_CASES;
  if (!cases.length) throw new Error('unknown case');
  const catalogPath = resolve(process.env['PI_CODING_AGENT_DIR'] ?? join(process.env['HOME'] ?? '', '.pi/agent'), 'models.json');
  const catalog: { providers?: Record<string, { models?: Array<{ id: string; maxTokens?: number; reasoning?: boolean }> }> } = mode === 'live' ? JSON.parse(readFileSync(catalogPath, 'utf8')) : {};
  const configuredModel = catalog.providers?.[config.provider]?.models?.find((item) => item.id === config.model);
  const modelLimits = configuredModel ? { id: configuredModel.id, maxTokens: configuredModel.maxTokens, reasoning: configuredModel.reasoning } : undefined;
  const budget = 1_000_000;
  const estimate = cases.reduce((sum, item) => sum + estimateCaseTokens(item), 0);
  if (estimate > budget) throw new Error(`estimated tokens=${estimate} exceed budget=${budget}`);
  const out = resolve(root, value('--out') ?? `artifacts/on-call-messages/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  console.log(JSON.stringify({ mode, configPath, provider: config.provider, model: config.model, thinking: config.thinkingLevel, cases: cases.map((item) => item.id), estimatedTokens: estimate, budget }));
  if (args.includes('--dry-run')) return;
  const underlying = mode === 'live'
    ? (await createLiveBenchmarkModel({ ...config })).model
    : createFakeRuntimeModel();
  let inCaseSpent = 0;
  const model = {
    provider: underlying.provider, model: underlying.model,
    get networkCalls() { return underlying.networkCalls; },
    get effectiveThinkingLevel() { return underlying.effectiveThinkingLevel; },
    async invoke(request: Parameters<typeof underlying.invoke>[0]) {
      const reserve = Buffer.byteLength(request.system + request.user) + 16_384;
      if (mode === 'live' && spent + inCaseSpent + reserve > budget) throw new Error('token budget prevents another model call');
      const response = await underlying.invoke(request);
      inCaseSpent += (response.inputTokens ?? 0) + (response.outputTokens ?? 0);
      return response;
    },
  };
  const codeHashes = Object.fromEntries([
    'apps/agent/src/incident-context.ts', 'apps/agent/src/on-call-brief.ts', 'apps/agent/src/notifier.ts',
    'apps/agent/src/notification.ts', 'apps/pi-runtime/src/specialists.ts', 'apps/pi-runtime/src/coordinator.ts',
  ].map((path) => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
  const runConfig = { configPath, catalogPath, provider: config.provider, model: config.model, thinking: config.thinkingLevel, modelLimits, codeHashes };
  const results: CaseResult[] = [];
  const secrets = [config.apiKey].filter((item): item is string => Boolean(item));
  const safe = (value: unknown) => {
    let text = JSON.stringify(value, null, 2);
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return text;
  };
  mkdirSync(out, { recursive: true });
  let spent = 0;
  const saveSummary = () => {
    writeFileSync(join(out, 'summary.json'), safe({ ...runConfig, estimatedTokens: estimate, observedTokens: spent, results }) + '\n');
    writeFileSync(join(out, 'messages.md'), renderMessageReport(JSON.parse(safe(results))));
  };
  for (const item of cases) {
    const casePath = join(out, `${item.id}.json`);
    if (args.includes('--resume') && existsSync(casePath)) {
      const existing: CaseResult = await withoutSourceSnippetBodies(JSON.parse(readFileSync(casePath, 'utf8')));
      if (existing.mode !== mode || (mode === 'live' && (existing.provider !== config.provider || existing.model !== config.model || existing.thinking.requested !== config.thinkingLevel))) {
        throw new Error(`saved case configuration mismatch: ${item.id}`);
      }
      results.push(existing);
      spent += existing.modelCalls.reduce((sum, call) => sum + (call.inputTokens ?? 0) + (call.outputTokens ?? 0), 0);
      saveSummary();
      console.log(JSON.stringify({ case: item.id, resumed: true, status: existing.status }));
      continue;
    }
    if (existsSync(casePath)) throw new Error(`refuse to overwrite ${item.id}; use --resume or a new --out directory`);
    if (spent + estimateCaseTokens(item) > budget) throw new Error(`token budget reached before ${item.id}; spent=${spent}`);
    inCaseSpent = 0;
    const result = await runCase(item, { model, mode, thinkingLevel: config.thinkingLevel, executionTimeoutMs: 300_000, maxContextBytes: 65_536 });
    results.push(result);
    spent += result.modelCalls.reduce((sum, call) => sum + (call.inputTokens ?? 0) + (call.outputTokens ?? 0), 0);
    writeFileSync(join(out, `${item.id}.json`), safe({ provenance: item.provenance, oracle: item.messageOracle, codeHashes, ...result }) + '\n');
    saveSummary();
    console.log(JSON.stringify({ case: item.id, status: result.status, tokens: result.tokenUsage, ms: result.latencyMs, bytes: result.message?.bytes, checks: result.messageEvaluation?.checks }));
    if (mode === 'live' && result.modelCalls.some((call) => call.status !== 'ok' || call.inputTokens === undefined || call.outputTokens === undefined)) {
      throw new Error(`incomplete usage or model failure at ${item.id}; saved results, stopping spend`);
    }
  }
  if (mode === 'live' && results.some((result) => !result.evaluation?.hardPass || !result.messageEvaluation?.hardPass)) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('message-cli.ts')) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
