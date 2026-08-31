import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * Selected Test Runner.
 *
 * TEST_FILE runs execute the whole owning file with node/tsx --test and the
 * TAP reporter, then verify from TAP that every selected testName actually
 * ran and passed. Exit code 0 with zero matched tests is NOT a pass.
 *
 * COMMAND runs execute the validated command through bash from the repo
 * root. Identical commands execute once per gate run.
 */

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const LOG_BOUND_BYTES = 64 * 1024;

export function resolveOwningPackage(repoRoot, file) {
  let dir = join(repoRoot, dirname(file.replaceAll('\\', '/')));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) {
      return {
        packageRoot: relative(repoRoot, dir) || '.',
        relativePath: relative(dir, join(repoRoot, file.replaceAll('\\', '/'))),
      };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function parseTapResults(stdout) {
  const results = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const match = line.match(/^\s*(not )?ok \d+ - (.*)$/);
    if (!match) continue;
    const notOk = Boolean(match[1]);
    let name = match[2];
    let directive = null;
    const directiveMatch = name.match(/\s*# (SKIP|TODO)\b.*$/);
    if (directiveMatch) {
      directive = directiveMatch[1];
      name = name.slice(0, directiveMatch.index);
    }
    results.push({ name: name.trimEnd(), ok: !notOk, directive });
  }
  return results;
}

function childEnvironment(overrides) {
  const childEnv = { ...process.env, ...overrides };
  // Self-tests invoke this runner from node:test. Do not leak the parent's
  // private worker context into the selected standalone test process.
  delete childEnv.NODE_TEST_CONTEXT;
  return childEnv;
}

function bound(text) {
  const value = String(text ?? '');
  if (value.length <= LOG_BOUND_BYTES) return value;
  return `${value.slice(0, LOG_BOUND_BYTES)}\n... [truncated at ${LOG_BOUND_BYTES} bytes]`;
}

function baseResult(run, extra) {
  return {
    runId: run.runId,
    kind: run.kind,
    gate: run.gate,
    file: run.file ?? null,
    command: run.command ?? null,
    testNames: run.testNames ?? null,
    catalogEntryIds: run.entries.map((entry) => entry.id),
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    exitCode: null,
    status: null,
    entryStatuses: {},
    stdout: '',
    stderr: '',
    ...extra,
  };
}

function statusForTestName(tapResults, testName) {
  const matches = tapResults.filter((result) => result.name === testName);
  if (matches.length === 0) return 'NOT_RUN';
  if (matches.some((result) => !result.ok)) return 'FAILED';
  if (matches.some((result) => result.directive)) return 'SKIPPED';
  return 'PASSED';
}

const STATUS_SEVERITY = { PASSED: 0, SKIPPED: 1, NOT_RUN: 2, UNEXECUTABLE: 3, FAILED: 4 };

function worstStatus(statuses) {
  return statuses.reduce((worst, status) => (
    STATUS_SEVERITY[status] > STATUS_SEVERITY[worst] ? status : worst
  ), 'PASSED');
}

export function executeRuns(executionPlan, options = {}) {
  const repoRoot = options.repoRoot;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = options.env ?? {};
  const results = [];

  for (const run of executionPlan.runs ?? []) {
    if (!run.planned) {
      const reason = run.gate === 4
        ? 'gate 4 LIVE_PROVIDER requires --allow-live-provider'
        : `gate ${run.gate} exceeds effective max gate ${executionPlan.maxGate}`;
      results.push(baseResult(run, {
        status: 'NOT_RUN',
        entryStatuses: Object.fromEntries(run.entries.map((entry) => [entry.id, 'NOT_RUN'])),
        stderr: reason,
      }));
      continue;
    }

    if (run.kind === 'TEST_FILE') {
      results.push(executeTestFileRun(run, { repoRoot, timeoutMs, env }));
    } else if (run.kind === 'COMMAND') {
      results.push(executeCommandRun(run, { repoRoot, timeoutMs, env }));
    } else {
      results.push(baseResult(run, { status: 'UNEXECUTABLE', stderr: `unknown run kind ${run.kind}` }));
    }
  }
  return results;
}

function executeTestFileRun(run, { repoRoot, timeoutMs, env }) {
  const startedAt = new Date().toISOString();
  const pkg = resolveOwningPackage(repoRoot, run.file);
  if (!pkg) {
    return baseResult(run, {
      status: 'UNEXECUTABLE',
      startedAt,
      stderr: `no owning package found for ${run.file}`,
    });
  }
  const isTs = run.file.endsWith('.ts');
  let command;
  let args;
  if (isTs) {
    const tsxBin = join(repoRoot, pkg.packageRoot, 'node_modules', '.bin', 'tsx');
    if (!existsSync(tsxBin)) {
      return baseResult(run, {
        status: 'UNEXECUTABLE',
        startedAt,
        stderr: `tsx not found at ${relative(repoRoot, tsxBin)}`,
      });
    }
    command = tsxBin;
    args = ['--test', '--test-reporter=tap', pkg.relativePath];
  } else {
    command = process.execPath;
    args = ['--test', '--test-reporter=tap', pkg.relativePath];
  }
  const cwd = join(repoRoot, pkg.packageRoot);
  const res = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: childEnvironment(env),
  });
  const finishedAt = new Date().toISOString();
  const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  const timedOut = Boolean(res.error && res.error.code === 'ETIMEDOUT') || res.signal === 'SIGTERM';
  const exitCode = res.status;
  const stdout = bound(res.stdout);
  const stderr = bound(res.stderr);

  if (timedOut) {
    return baseResult(run, {
      startedAt,
      finishedAt,
      durationMs,
      exitCode,
      status: 'FAILED',
      entryStatuses: Object.fromEntries(run.entries.map((entry) => [entry.id, 'FAILED'])),
      stdout,
      stderr: `execution timed out after ${timeoutMs}ms\n${stderr}`,
    });
  }

  const tapResults = parseTapResults(res.stdout);
  const entryStatuses = {};
  for (const entry of run.entries) {
    entryStatuses[entry.id] = exitCode === 0
      ? statusForTestName(tapResults, entry.testName)
      : 'FAILED';
  }
  return baseResult(run, {
    startedAt,
    finishedAt,
    durationMs,
    exitCode,
    status: exitCode === 0 ? worstStatus(Object.values(entryStatuses)) : 'FAILED',
    entryStatuses,
    stdout,
    stderr,
  });
}

function executeCommandRun(run, { repoRoot, timeoutMs, env }) {
  const startedAt = new Date().toISOString();
  const res = spawnSync('bash', ['-c', run.command], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: childEnvironment(env),
  });
  const finishedAt = new Date().toISOString();
  const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  const timedOut = Boolean(res.error && res.error.code === 'ETIMEDOUT') || res.signal === 'SIGTERM';
  const status = timedOut || res.status !== 0 ? 'FAILED' : 'PASSED';
  return baseResult(run, {
    startedAt,
    finishedAt,
    durationMs,
    exitCode: res.status,
    status,
    entryStatuses: Object.fromEntries(run.entries.map((entry) => [entry.id, status])),
    stdout: bound(res.stdout),
    stderr: timedOut ? `execution timed out after ${timeoutMs}ms\n${bound(res.stderr)}` : bound(res.stderr),
  });
}
