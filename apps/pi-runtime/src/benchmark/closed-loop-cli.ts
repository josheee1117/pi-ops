import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createFakeRuntimeModel, type RuntimeModel } from '../model.js';
import { MESSAGE_CASES } from './message-cases.js';
import { readModelConfig } from './message-cli.js';
import { createLiveBenchmarkModel } from './live-model.js';
import { runClosedLoopCase, type ClosedLoopCaseResult } from './closed-loop-runner.js';
import { criteriaFor } from './closed-loop-cases.js';
import { renderClosedLoopReport } from './closed-loop-report.js';
import { rejudgeDirectory, renderRejudgeReport } from './closed-loop-rejudge.js';

const DEFAULT_AGENT_CATALOG = 'apps/pi-runtime/src/benchmark/results/2026-10-21-output-budget/pi-agent';
const CASE_RESERVE = 95_000;
const TOTAL_BUDGET = 1_000_000;

interface ModelSpec { provider: string; model: string }

function parseSpec(text: string): ModelSpec {
  const index = text.lastIndexOf('/');
  if (index <= 0 || index === text.length - 1) throw new Error(`model must be provider/id: ${text}`);
  return { provider: text.slice(0, index), model: text.slice(index + 1) };
}

async function withCatalog<T>(catalog: string | undefined, action: () => Promise<T>): Promise<T> {
  const previous = process.env['PI_CODING_AGENT_DIR'];
  if (catalog) process.env['PI_CODING_AGENT_DIR'] = catalog;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previous;
  }
}

function scriptedHandler(): RuntimeModel {
  return {
    provider: 'fake', model: 'handler', networkCalls: 0,
    async invoke(request) {
      const url = /允许的地址：(\S+)/.exec(request.user)?.[1];
      const fetched = request.user.includes('fetch_details → 成功');
      const text = fetched || !url
        ? JSON.stringify({
          tool: 'answer',
          rootCause: 'fake 处理 agent：已按消息取详情。',
          actions: [
            { kind: 'stop_loss', action: '确认影响后经批准止损。', expected: '影响不再扩大。' },
            { kind: 'repair', action: '按证据修复。', expected: '修复完成。' },
            { kind: 'verify', action: '验证健康与关键业务。', expected: '验证通过。' },
          ],
          approvals: ['重启、发布需批准。'],
          unknowns: ['fake 模式不判断真实根因。'],
        })
        : JSON.stringify({ tool: 'fetch_details', url });
      return { text, inputTokens: 10, outputTokens: 10, stopReason: 'stop' };
    },
  };
}

function scriptedJudge(): RuntimeModel {
  return {
    provider: 'fake', model: 'judge', networkCalls: 0,
    async invoke() {
      const items = ['root_cause', 'stop_loss', 'repair', 'verification', 'no_forbidden', 'approvals', 'diagnosis_truth', 'info_sufficiency']
        .map((id) => ({ id, pass: true, reason: 'fake 裁判：装置自检，不代表真实判定。' }));
      return { text: JSON.stringify({ items, notes: 'fake' }), inputTokens: 10, outputTokens: 10, stopReason: 'stop' };
    },
  };
}

interface Tracker { spent: number; budget: number }

function budgeted(model: RuntimeModel, tracker: Tracker): RuntimeModel {
  return {
    get provider() { return model.provider; },
    get model() { return model.model; },
    get networkCalls() { return model.networkCalls; },
    get effectiveThinkingLevel() { return model.effectiveThinkingLevel; },
    async invoke(request) {
      if (tracker.spent + request.system.length + request.user.length + 8192 > tracker.budget) {
        throw new Error(`token budget reached: spent=${tracker.spent} budget=${tracker.budget}`);
      }
      const response = await model.invoke(request);
      tracker.spent += (response.inputTokens ?? 0) + (response.outputTokens ?? 0);
      return response;
    },
  };
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const mode = args.includes('--live') ? 'live' : 'fake';
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const rejudgeSource = value('--rejudge');
  if (rejudgeSource) {
    const sourceDir = resolve(root, rejudgeSource);
    const outDir = resolve(root, value('--out') ?? `${sourceDir}-rejudge`);
    const judgeSpec = parseSpec(value('--judge') ?? 'cpa/glm-latest');
    const modelCatalog = resolve(value('--model-catalog') ?? join(homedir(), '.pi/agent'));
    const budget = Number(value('--budget') ?? 200_000);
    const selected = value('--case');
    const caseIds = selected ? [selected] : MESSAGE_CASES.map((item) => item.id);
    const estimate = caseIds.length * 12_000;
    const judge = { provider: judgeSpec.provider, model: judgeSpec.model, thinking: 'off' };
    console.log(JSON.stringify({ mode: 'rejudge', sourceDir, outDir, judge, caseIds, estimatedTokens: estimate, budget }));
    if (estimate > budget) throw new Error(`estimated tokens=${estimate} exceed budget=${budget}`);
    if (args.includes('--dry-run')) return;
    const tracker: Tracker = { spent: 0, budget };
    const judgeModel = budgeted((await withCatalog(modelCatalog, () => createLiveBenchmarkModel({ ...judgeSpec, thinkingLevel: 'off' }))).model, tracker);
    const started = Date.now();
    const results = await rejudgeDirectory({ sourceDir, outDir, repoRoot: root, judgeModel, caseIds });
    const wallMs = Date.now() - started;
    writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify({ mode: 'rejudge', sourceDir, judge, budget, spent: tracker.spent, wallMs, results }, null, 2)}\n`);
    writeFileSync(join(outDir, 'report.md'), renderRejudgeReport({
      results, sourceDir, judge: { provider: judgeSpec.provider, model: judgeSpec.model },
      spent: tracker.spent, budget, wallMs,
    }));
    for (const result of results) {
      console.log(JSON.stringify({ case: result.caseId, old: result.oldVerdict, new: result.newVerdict, changed: result.changed.map((item) => item.id), tokens: result.tokens, ms: result.latencyMs }));
    }
    if (results.some((result) => result.error)) process.exitCode = 1;
    return;
  }
  const configPath = resolve(root, value('--config') ?? 'artifacts/real-dataasset-lab/central/runtime-secrets.env');
  const agentCatalog = resolve(root, value('--agent-catalog') ?? DEFAULT_AGENT_CATALOG);
  const modelCatalog = resolve(value('--model-catalog') ?? join(homedir(), '.pi/agent'));
  const handlerSpec = parseSpec(value('--handler') ?? 'cpa/deepseek-flash-latest');
  const judgeSpec = parseSpec(value('--judge') ?? 'cpa/glm-latest');
  const cases = value('--case') ? MESSAGE_CASES.filter((item) => item.id === value('--case')) : MESSAGE_CASES;
  if (!cases.length) throw new Error('unknown case');
  const budget = Number(value('--budget') ?? TOTAL_BUDGET);
  const estimate = cases.length * CASE_RESERVE;
  const out = resolve(root, value('--out') ?? `artifacts/closed-loop/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const diagnosisConfig = mode === 'live' ? readModelConfig(configPath) : { provider: 'fake', model: 'deterministic', thinkingLevel: 'off' as const, apiKey: undefined };
  const config = {
    mode,
    configPath: mode === 'live' ? configPath : null,
    agentCatalog: mode === 'live' ? agentCatalog : null,
    modelCatalog: mode === 'live' ? modelCatalog : null,
    diagnosis: { provider: diagnosisConfig.provider, model: diagnosisConfig.model, thinking: diagnosisConfig.thinkingLevel },
    handler: mode === 'live' ? { provider: handlerSpec.provider, model: handlerSpec.model, thinking: 'off' } : { provider: 'fake', model: 'handler', thinking: 'off' },
    judge: mode === 'live' ? { provider: judgeSpec.provider, model: judgeSpec.model, thinking: 'off' } : { provider: 'fake', model: 'judge', thinking: 'off' },
    cases: cases.map((item) => item.id),
    estimatedTokens: estimate,
    budget,
    out,
  };
  console.log(JSON.stringify(config));
  if (estimate > budget) throw new Error(`estimated tokens=${estimate} exceed budget=${budget}`);
  if (args.includes('--dry-run')) return;
  if (mode === 'live' && !existsSync(agentCatalog)) throw new Error(`agent catalog missing: ${agentCatalog}`);

  const tracker: Tracker = { spent: 0, budget };
  let diagnosisModel: RuntimeModel;
  let handlerModel: RuntimeModel;
  let judgeModel: RuntimeModel;
  if (mode === 'live') {
    diagnosisModel = budgeted((await withCatalog(agentCatalog, () => createLiveBenchmarkModel(diagnosisConfig))).model, tracker);
    handlerModel = budgeted((await withCatalog(modelCatalog, () => createLiveBenchmarkModel({ ...handlerSpec, thinkingLevel: 'off' }))).model, tracker);
    judgeModel = budgeted((await withCatalog(modelCatalog, () => createLiveBenchmarkModel({ ...judgeSpec, thinkingLevel: 'off' }))).model, tracker);
  } else {
    diagnosisModel = budgeted(createFakeRuntimeModel(), tracker);
    handlerModel = budgeted(scriptedHandler(), tracker);
    judgeModel = budgeted(scriptedJudge(), tracker);
  }

  mkdirSync(out, { recursive: true });
  const codeHashes = Object.fromEntries([
    'apps/agent/src/notifier.ts', 'apps/agent/src/on-call-brief.ts', 'apps/agent/src/incident-brief.ts',
    'apps/agent/src/notification.ts', 'apps/pi-runtime/src/specialists.ts', 'apps/pi-runtime/src/coordinator.ts',
  ].map((path) => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));

  const results: ClosedLoopCaseResult[] = [];
  const started = Date.now();
  const secrets = [diagnosisConfig.apiKey].filter((item): item is string => Boolean(item));
  const safe = (text: string) => secrets.reduce((value, secret) => value.split(secret).join('[REDACTED]'), text);
  const save = () => {
    writeFileSync(join(out, 'summary.json'), safe(`${JSON.stringify({ ...config, spent: tracker.spent, wallMs: Date.now() - started, codeHashes, results }, null, 2)}\n`));
    writeFileSync(join(out, 'report.md'), renderClosedLoopReport({
      results, diagnosis: config.diagnosis, handler: config.handler, judge: config.judge,
      mode, spent: tracker.spent, budget, wallMs: Date.now() - started,
    }));
  };

  for (const benchmarkCase of cases) {
    const casePath = join(out, `${benchmarkCase.id}.json`);
    if (args.includes('--resume') && existsSync(casePath)) {
      const existing: ClosedLoopCaseResult = JSON.parse(readFileSync(casePath, 'utf8'));
      const mismatch = existing.mode !== mode
        || existing.diagnosis.provider !== config.diagnosis.provider || existing.diagnosis.model !== config.diagnosis.model
        || existing.handler.provider !== config.handler.provider || existing.handler.model !== config.handler.model
        || existing.judge?.provider !== config.judge.provider || existing.judge?.model !== config.judge.model;
      if (mismatch) throw new Error(`saved case configuration mismatch: ${benchmarkCase.id}`);
      results.push(existing);
      tracker.spent += existing.tokens;
      save();
      console.log(JSON.stringify({ case: benchmarkCase.id, resumed: true, verdict: existing.verdict }));
      continue;
    }
    if (existsSync(casePath)) throw new Error(`refuse to overwrite ${benchmarkCase.id}; use --resume or a new --out directory`);
    if (tracker.spent + CASE_RESERVE > budget) throw new Error(`token budget reached before ${benchmarkCase.id}; spent=${tracker.spent}`);
    const result = await runClosedLoopCase(benchmarkCase, {
      repoRoot: root, diagnosisModel, handlerModel, judgeModel, mode, diagnosisThinking: config.diagnosis.thinking,
    });
    results.push(result);
    writeFileSync(casePath, safe(`${JSON.stringify({ criteria: criteriaFor(benchmarkCase.id), codeHashes, result }, null, 2)}\n`));
    save();
    console.log(JSON.stringify({
      case: benchmarkCase.id, verdict: result.verdict, gaps: result.gaps, tokens: result.tokens, ms: result.latencyMs,
      messageBytes: result.message?.bytes, detailBytes: result.detail?.bytes, turns: result.handler.turns,
      handler: result.handler.status, judge: result.judge?.items.filter((item) => !item.pass).map((item) => item.id),
    }));
  }
  if (results.some((item) => item.error || item.judge?.error)) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('closed-loop-cli.ts')) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
