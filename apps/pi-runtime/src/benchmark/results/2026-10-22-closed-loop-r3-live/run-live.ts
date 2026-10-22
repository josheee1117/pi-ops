import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderClosedLoopReport } from '../../closed-loop-report.js';
import type { ClosedLoopCaseResult } from '../../closed-loop-runner.js';

const out = dirname(fileURLToPath(import.meta.url));
const root = resolve(out, '../../../../../..');
const cases = ['dataasset-197', 'jvm-heap-oom', 'cpu-quota-burst', 'tag-group-502', 'sop-404', 'health-503', 'stack-overflow'];
const budget = 400_000;
const reserve = 95_000;
const configPath = '/tmp/pi-ops-r3-live/diagnosis.env';
const catalog = join(process.env['HOME'] ?? '', '.pi/agent');
const upstream = {
  diagnosis: 'cpa/deepseek-v4.1-flash via agentrouter. Same model as production ark/deepseek-v4.1-flash, different upstream.',
  handler: 'cpa/deepseek-v4.1-flash via agentrouter. Previous batches used cpa/deepseek-flash-latest on Volcano.',
  judge: 'cpa/gemini-3.8-flash-high. cpa/glm-latest returned 429 AccountQuotaExceeded, reset 2026-10-22 13:57:43 +0800.',
  thinkingRequested: 'off',
  thinkingEffective: 'Diagnosis and handler catalogs map off to unsupported, so the SDK clamps the request to low and sends reasoning_effort=low. Judge gemini-3.8-flash-high only supports high, so requested off becomes high.',
  comparisonNote: '同模型、不同上游。不要把本批诊断和火山 ark 批次当成同一上游的重复抽样。',
};

function loadResult(id: string): ClosedLoopCaseResult {
  return JSON.parse(readFileSync(join(out, `${id}.json`), 'utf8')).result;
}

function merge(results: ClosedLoopCaseResult[], wallMs: number, spent: number) {
  const summaryPath = join(out, 'summary.json');
  const previous = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : {};
  const summary = {
    ...previous,
    mode: 'live',
    configPath,
    agentCatalog: catalog,
    modelCatalog: catalog,
    diagnosis: { provider: 'cpa', model: 'deepseek-v4.1-flash', thinking: 'off' },
    handler: { provider: 'cpa', model: 'deepseek-v4.1-flash', thinking: 'off' },
    judge: { provider: 'cpa', model: 'gemini-3.8-flash-high', thinking: 'off' },
    cases,
    estimatedTokens: cases.length * reserve,
    budget,
    out,
    spent,
    wallMs,
    results,
    upstream,
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(out, 'report.md'), renderClosedLoopReport({
    results, diagnosis: summary.diagnosis, handler: summary.handler, judge: summary.judge,
    mode: 'live', spent, budget, wallMs,
  }));
}

const started = Date.now();
const results: ClosedLoopCaseResult[] = [];
let spent = 0;
for (const id of cases) {
  if (!existsSync(join(out, `${id}.json`))) continue;
  const result = loadResult(id);
  spent += result.tokens;
  results.push(result);
}
merge(results, Date.now() - started, spent);

for (const id of cases) {
  if (existsSync(join(out, `${id}.json`))) {
    console.log(JSON.stringify({ skip: id, spent }));
    continue;
  }
  const remaining = budget - spent;
  if (remaining < reserve) {
    const stop = { stop: id, reason: 'remaining below CLI reserve', remaining, spent, budget };
    writeFileSync(join(out, 'stop.json'), `${JSON.stringify(stop, null, 2)}\n`);
    console.log(JSON.stringify(stop));
    break;
  }
  const args = ['--filter', '@pi-ops/pi-runtime', 'exec', 'tsx', 'src/benchmark/closed-loop-cli.ts', '--live',
    '--config', configPath, '--agent-catalog', catalog, '--model-catalog', catalog,
    '--handler', 'cpa/deepseek-v4.1-flash', '--judge', 'cpa/gemini-3.8-flash-high',
    '--case', id, '--budget', String(remaining),
    '--out', 'apps/pi-runtime/src/benchmark/results/2026-10-22-closed-loop-r3-live'];
  const command = ['pnpm', ...args];
  console.log(JSON.stringify({ starting: id, remaining, command }));
  const caseStarted = Date.now();
  let output = '';
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    const child = spawn('pnpm', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (data: Buffer) => { const text = data.toString(); output += text; process.stdout.write(text); });
    child.stderr.on('data', (data: Buffer) => { const text = data.toString(); output += text; process.stderr.write(text); });
    child.on('error', reject);
    child.on('close', resolveExit);
  });
  writeFileSync(join(out, `live-${id}.log`), `$ ${command.join(' ')}\n${output}\nexit_code=${exitCode}\nwall_ms=${Date.now() - caseStarted}\n`);
  if (!existsSync(join(out, `${id}.json`))) {
    const stop = { stop: id, reason: 'case json missing', exitCode, spent };
    writeFileSync(join(out, 'stop.json'), `${JSON.stringify(stop, null, 2)}\n`);
    console.log(JSON.stringify(stop));
    break;
  }
  const result = loadResult(id);
  const providerError = result.diagnosis.modelCalls?.some((call) => call.stopReason === 'error')
    || result.diagnosis.tokens === 0
    || result.handler.status !== 'answered'
    || Boolean(result.error)
    || Boolean(result.judge?.error);
  spent += result.tokens;
  results.push(result);
  merge(results, Date.now() - started, spent);
  console.log(JSON.stringify({ case: id, verdict: result.verdict, tokens: result.tokens, spent, providerError, exitCode }));
  if (providerError || exitCode !== 0 || spent > budget) {
    const stop = { stop: id, reason: 'provider error, non-zero exit, or budget exceeded', providerError, exitCode, spent, budget };
    writeFileSync(join(out, 'stop.json'), `${JSON.stringify(stop, null, 2)}\n`);
    console.log(JSON.stringify(stop));
    break;
  }
}
console.log(JSON.stringify({ done: true, completed: results.length, spent, budget, wallMs: Date.now() - started }));
