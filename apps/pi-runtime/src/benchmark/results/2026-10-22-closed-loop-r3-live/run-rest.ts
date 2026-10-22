import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderClosedLoopReport } from '../../closed-loop-report.js';
import type { ClosedLoopCaseResult } from '../../closed-loop-runner.js';

const out = dirname(fileURLToPath(import.meta.url));
const root = resolve(out, '../../../../../..');
const allCases = ['dataasset-197', 'jvm-heap-oom', 'cpu-quota-burst', 'tag-group-502', 'sop-404', 'health-503', 'stack-overflow'];
const restCases = ['tag-group-502', 'sop-404', 'health-503', 'stack-overflow'];
const frozen = ['dataasset-197', 'jvm-heap-oom', 'cpu-quota-burst'];
const restBudget = 450_000;
const reserve = 95_000;
const configPath = '/tmp/pi-ops-r3-live/diagnosis.env';
const catalog = join(process.env['HOME'] ?? '', '.pi/agent');
const upstream = {
  diagnosis: 'cpa/deepseek-v4.1-flash via agentrouter. Same model as production ark/deepseek-v4.1-flash, different upstream. Rest batch did not switch back to Volcano.',
  handler: 'cpa/deepseek-v4.1-flash via agentrouter. Previous batches used cpa/deepseek-flash-latest on Volcano. Rest batch did not switch back.',
  judge: 'cpa/gemini-3.8-flash-high. Same judge as the first three cases. Did not switch back to cpa/glm-latest after the 13:57 reset.',
  thinkingRequested: 'off',
  thinkingEffective: 'Diagnosis and handler catalogs map off to unsupported, so the SDK clamps the request to low and sends reasoning_effort=low. Judge gemini-3.8-flash-high only supports high, so requested off becomes high.',
  comparisonNote: '同模型、不同上游。后 4 例与前 3 例同一配置，没有换回火山或 glm。',
};

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function loadResult(id: string): ClosedLoopCaseResult {
  return JSON.parse(readFileSync(join(out, `${id}.json`), 'utf8')).result;
}

const frozenHashes = Object.fromEntries(frozen.map((id) => [id, sha(join(out, `${id}.json`))]));

function merge(restSpent: number, restWallMs: number, stop: unknown) {
  const results = allCases.filter((id) => existsSync(join(out, `${id}.json`))).map(loadResult);
  const spent = results.reduce((sum, item) => sum + item.tokens, 0);
  const firstSpent = results.filter((item) => frozen.includes(item.caseId)).reduce((sum, item) => sum + item.tokens, 0);
  const newest = [...allCases].reverse().find((id) => existsSync(join(out, `${id}.json`)));
  const codeHashes = newest ? JSON.parse(readFileSync(join(out, `${newest}.json`), 'utf8')).codeHashes : undefined;
  const summary = {
    mode: 'live',
    configPath,
    agentCatalog: catalog,
    modelCatalog: catalog,
    diagnosis: { provider: 'cpa', model: 'deepseek-v4.1-flash', thinking: 'off' },
    handler: { provider: 'cpa', model: 'deepseek-v4.1-flash', thinking: 'off' },
    judge: { provider: 'cpa', model: 'gemini-3.8-flash-high', thinking: 'off' },
    cases: allCases,
    budget: restBudget,
    firstBatch: { budget: 400_000, spent: firstSpent, cases: frozen },
    restBatch: { budget: restBudget, spent: restSpent, cases: restCases, wallMs: restWallMs, stop },
    estimatedTokens: restCases.length * reserve,
    out,
    spent,
    wallMs: restWallMs,
    codeHashes,
    upstream,
    notRun: allCases.filter((id) => !existsSync(join(out, `${id}.json`))),
    results,
  };
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(out, 'report.md'), renderClosedLoopReport({
    results, diagnosis: summary.diagnosis, handler: summary.handler, judge: summary.judge,
    mode: 'live', spent, budget: restBudget, wallMs: restWallMs,
  }));
  for (const id of frozen) {
    const now = sha(join(out, `${id}.json`));
    if (now !== frozenHashes[id]) throw new Error(`frozen case changed: ${id}`);
  }
}

async function run(command: string[], args: string[], env?: Record<string, string>): Promise<{ exitCode: number | null; output: string }> {
  let output = '';
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    const child = spawn(command[0]!, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    child.stdout.on('data', (data: Buffer) => { const text = data.toString(); output += text; process.stdout.write(text); });
    child.stderr.on('data', (data: Buffer) => { const text = data.toString(); output += text; process.stderr.write(text); });
    child.on('error', reject);
    child.on('close', resolveExit);
  });
  return { exitCode, output };
}

const started = Date.now();
const probeArgs = ['--filter', '@pi-ops/pi-runtime', 'exec', 'tsx', 'src/benchmark/results/2026-10-22-closed-loop-r3-live/probe-models.ts', 'cpa/deepseek-v4.1-flash', 'cpa/gemini-3.8-flash-high'];
const probe = await run(['pnpm', ...probeArgs], probeArgs, { PROBE_OUT: 'probe-rest.json' });
writeFileSync(join(out, 'live-rest-probe.log'), `$ PROBE_OUT=probe-rest.json pnpm ${probeArgs.join(' ')}\n${probe.output}\nexit_code=${probe.exitCode}\n`);
const probeFile = join(out, 'probe-rest.json');
if (!existsSync(probeFile)) {
  const stop = { stop: 'probe', reason: 'probe output missing', exitCode: probe.exitCode };
  writeFileSync(join(out, 'stop-rest.json'), `${JSON.stringify(stop, null, 2)}\n`);
  merge(0, Date.now() - started, stop);
  throw new Error('probe output missing');
}
const probeResults = JSON.parse(readFileSync(probeFile, 'utf8')).results as Array<{ spec: string; ok: boolean; errorMessage?: string; error?: string }>;
const probeFailed = probeResults.filter((item) => !item.ok);
if (probeFailed.length) {
  const stop = { stop: 'probe', reason: 'preflight failed', failures: probeFailed.map((item) => ({ spec: item.spec, error: item.errorMessage ?? item.error ?? '' })) };
  writeFileSync(join(out, 'stop-rest.json'), `${JSON.stringify(stop, null, 2)}\n`);
  merge(0, Date.now() - started, stop);
  console.log(JSON.stringify(stop));
  process.exitCode = 1;
} else {
  let restSpent = 0;
  let stop: unknown = null;
  for (const id of restCases) {
    if (existsSync(join(out, `${id}.json`))) {
      restSpent += loadResult(id).tokens;
      console.log(JSON.stringify({ skip: id, restSpent }));
      continue;
    }
    const remaining = restBudget - restSpent;
    if (remaining < reserve) {
      stop = { stop: id, reason: 'remaining below CLI reserve', remaining, restSpent, restBudget };
      break;
    }
    const args = ['--filter', '@pi-ops/pi-runtime', 'exec', 'tsx', 'src/benchmark/closed-loop-cli.ts', '--live',
      '--config', configPath, '--agent-catalog', catalog, '--model-catalog', catalog,
      '--handler', 'cpa/deepseek-v4.1-flash', '--judge', 'cpa/gemini-3.8-flash-high',
      '--case', id, '--budget', String(remaining), '--resume',
      '--out', 'apps/pi-runtime/src/benchmark/results/2026-10-22-closed-loop-r3-live'];
    console.log(JSON.stringify({ starting: id, remaining, command: ['pnpm', ...args] }));
    const caseStarted = Date.now();
    const resultRun = await run(['pnpm', ...args], args);
    writeFileSync(join(out, `live-${id}.log`), `$ pnpm ${args.join(' ')}\n${resultRun.output}\nexit_code=${resultRun.exitCode}\nwall_ms=${Date.now() - caseStarted}\n`);
    if (!existsSync(join(out, `${id}.json`))) {
      stop = { stop: id, reason: 'case json missing', exitCode: resultRun.exitCode, restSpent };
      break;
    }
    const result = loadResult(id);
    const providerError = result.diagnosis.modelCalls?.some((call) => call.stopReason === 'error')
      || result.diagnosis.tokens === 0
      || result.handler.status !== 'answered'
      || Boolean(result.error)
      || Boolean(result.judge?.error);
    restSpent += result.tokens;
    merge(restSpent, Date.now() - started, null);
    console.log(JSON.stringify({ case: id, verdict: result.verdict, tokens: result.tokens, restSpent, providerError, exitCode: resultRun.exitCode }));
    if (providerError || resultRun.exitCode !== 0 || restSpent > restBudget) {
      stop = { stop: id, reason: 'provider error, non-zero exit, or rest budget exceeded', providerError, exitCode: resultRun.exitCode, restSpent, restBudget };
      break;
    }
  }
  if (stop) writeFileSync(join(out, 'stop-rest.json'), `${JSON.stringify(stop, null, 2)}\n`);
  merge(restSpent, Date.now() - started, stop);
  console.log(JSON.stringify({ done: true, restSpent, restBudget, wallMs: Date.now() - started, stop }));
}
