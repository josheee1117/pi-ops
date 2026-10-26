import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderClosedLoopReport } from '../../closed-loop-report.js';
import type { ClosedLoopCaseResult } from '../../closed-loop-runner.js';

const out = dirname(fileURLToPath(import.meta.url));
const root = resolve(out, '../../../../../..');
const cases = ['dataasset-197', 'stack-overflow', 'jvm-heap-oom', 'cpu-quota-burst', 'tag-group-502', 'sop-404', 'health-503'];
const budget = 400_000;
const preflightTokens = 112;
const reserve = 95_000;
const results: ClosedLoopCaseResult[] = [];
let spent = preflightTokens;
let stopped: unknown = null;
const started = Date.now();
const forbidden = [
  readFileSync(join(root, 'apps/pi-runtime/src/benchmark/fixtures/closed-loop/stack-overflow/Recurse.java'), 'utf8').split('\n')[6]!.trim(),
  readFileSync(join(root, 'apps/pi-runtime/src/benchmark/fixtures/closed-loop/dataasset-197/LabFaultController.java'), 'utf8').split('\n')[24]!.trim(),
];
const diagnosis = { provider: 'ark', model: 'deepseek-v4.1-flash', thinking: 'off' };
const handler = { provider: 'cpa', model: 'deepseek-flash-latest' };
const judge = { provider: 'cpa', model: 'glm-latest' };
const save = () => {
  writeFileSync(join(out, 'summary.json'), JSON.stringify({ mode: 'live', diagnosis, handler, judge, cases,
    budget, preflightTokens, spent, wallMs: Date.now() - started, stopped, results }, null, 2) + '\n');
  writeFileSync(join(out, 'report.md'), renderClosedLoopReport({ results, diagnosis, handler, judge,
    mode: 'live', spent, budget, wallMs: Date.now() - started }));
};

try {
  for (const id of cases) {
    const remaining = budget - spent;
    assert.ok(!existsSync(join(out, `${id}.json`)), `refuse to rerun ${id}`);
    if (remaining < reserve) {
      stopped = { case: id, reason: 'remaining below CLI reserve', remaining, spent };
      break;
    }
    const args = ['--filter', '@pi-ops/pi-runtime', 'exec', 'tsx', 'src/benchmark/closed-loop-cli.ts', '--live',
      '--case', id, '--budget', String(remaining), '--out', out];
    console.log(JSON.stringify({ starting: id, remaining }));
    let output = '';
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      const child = spawn('pnpm', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (data: Buffer) => { output += data.toString(); process.stdout.write(data); });
      child.stderr.on('data', (data: Buffer) => { output += data.toString(); process.stderr.write(data); });
      child.on('error', reject);
      child.on('close', resolveExit);
    });
    assert.ok(!forbidden.some((line) => output.includes(line)), 'console output contains source body');
    writeFileSync(join(out, `live-${id}.log`), `$ pnpm ${args.join(' ')}\n${output}\nexit_code=${exitCode}\n`);
    if (!existsSync(join(out, `${id}.json`))) {
      stopped = { case: id, reason: 'case JSON missing', exitCode, spent };
      break;
    }
    const savedText = readFileSync(join(out, `${id}.json`), 'utf8');
    assert.ok(!forbidden.some((line) => savedText.includes(line)), 'case JSON contains source body');
    const result: ClosedLoopCaseResult = JSON.parse(savedText).result;
    results.push(result);
    spent += result.tokens;
    save();
    assert.ok(spent <= budget, `budget exceeded: ${spent}`);
    const providerError = result.diagnosis.modelCalls?.some((call) => call.stopReason === 'error')
      || result.diagnosis.tokens === 0 || Boolean(result.error) || Boolean(result.judge?.error)
      || result.handler.status !== 'answered';
    console.log(JSON.stringify({ case: id, verdict: result.verdict, messageHardPass: result.diagnosis.messageHardPass,
      repairKind: result.diagnosis.repairKind, spent, providerError, exitCode }));
    if (providerError || exitCode !== 0) {
      stopped = { case: id, reason: 'provider or execution error', providerError, exitCode, spent };
      break;
    }
  }
} catch (error) {
  stopped = { reason: error instanceof Error ? error.message : String(error), spent };
} finally {
  save();
  writeFileSync(join(out, 'live-status.json'), JSON.stringify({ completed: results.length, budget, spent, stopped }, null, 2) + '\n');
  console.log(JSON.stringify({ completed: results.length, spent, stopped }));
  execFileSync('/Users/hejiayuan/.pi/agent/npm/node_modules/pi-intercom/cli.mjs', ['send',
    '--to', '01a17646-e68c-7188-949e-39ecb6046e50', '--name', 'snippet-live-runner',
    '--text', `七例评测脚本已结束。完成 ${results.length}/7，累计 ${spent} token。停止信息 ${JSON.stringify(stopped)}。读取 results/2026-10-22-closed-loop-source/live-status.json 与 summary.json，检查源码无泄漏，完成对照与单独提交。`, '--json'], { stdio: 'inherit' });
}
