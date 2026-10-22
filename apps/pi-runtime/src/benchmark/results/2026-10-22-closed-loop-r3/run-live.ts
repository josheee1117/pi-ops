import assert from 'node:assert/strict';
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
const results: ClosedLoopCaseResult[] = [];
let spent = 0;
const started = Date.now();
for (const id of cases) {
  assert.ok(budget - spent >= 95_000, `remaining budget below CLI reserve before ${id}: ${budget - spent}`);
  assert.equal(existsSync(join(out, `${id}.json`)), false, `refuse to rerun ${id}`);
  const args = ['--filter', '@pi-ops/pi-runtime', 'exec', 'tsx', 'src/benchmark/closed-loop-cli.ts', '--live', '--case', id,
    '--budget', String(budget - spent), '--out', out];
  console.log(JSON.stringify({ starting: id, remainingBudget: budget - spent, command: ['pnpm', ...args] }));
  let output = '';
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    const child = spawn('pnpm', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (data: Buffer) => { const text = data.toString(); output += text; process.stdout.write(text); });
    child.stderr.on('data', (data: Buffer) => { const text = data.toString(); output += text; process.stderr.write(text); });
    child.on('error', reject);
    child.on('close', resolveExit);
  });
  writeFileSync(join(out, `live-${id}.log`), `$ pnpm ${args.join(' ')}\n${output}\nexit_code=${exitCode}\n`);
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  const saved = JSON.parse(readFileSync(join(out, `${id}.json`), 'utf8'));
  const result: ClosedLoopCaseResult = saved.result;
  assert.equal(result.caseId, id);
  assert.equal(typeof summary.spent, 'number');
  spent += summary.spent;
  results.push(result);
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify({ ...summary, cases, budget, spent, wallMs: Date.now() - started, results }, null, 2)}\n`);
  writeFileSync(join(out, 'report.md'), renderClosedLoopReport({ results, diagnosis: summary.diagnosis, handler: summary.handler,
    judge: summary.judge, mode: 'live', spent, budget, wallMs: Date.now() - started }));
  assert.ok(spent <= budget, `token budget exceeded: ${spent}`);
  assert.equal(result.diagnosis.modelCalls?.some((call) => call.stopReason === 'error'), false,
    `model error in ${id}; stop and inspect provider error before continuing`);
  assert.equal(result.handler.status, 'answered', `handler failed in ${id}; stop before continuing`);
  assert.equal(exitCode, 0, `case ${id} failed; inspect saved evidence before continuing`);
}
console.log(JSON.stringify({ completed: cases.length, spent, budget, wallMs: Date.now() - started }));
