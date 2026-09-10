import { mkdirSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createFakeRuntimeModel } from '../model.js';
import { parseThinkingLevel } from '../thinking-level.js';
import { CPU_GOLDEN_CASES } from './fixtures.js';
import { createLiveBenchmarkModel } from './live-model.js';
import { buildReport, renderMarkdown } from './report.js';
import { resolveCases, runBenchmark } from './runner.js';

/**
 * JVM Diagnosis Benchmark CLI.
 *
 *   pnpm benchmark:jvm                        # fake model, deterministic, CI-safe
 *   pnpm benchmark:jvm -- --thinking high     # fake model, labeled N/A
 *   pnpm benchmark:jvm -- --mode live --thinking medium --out artifacts/bench
 */

interface CliOptions {
  caseIds: string[];
  mode: 'fake' | 'live';
  thinking: string;
  outDir: string;
  provider?: string;
  model?: string;
  label?: string;
}

/**
 * `pnpm --filter ... exec` runs with the package as cwd, so a relative output
 * path would land in apps/pi-runtime. Anchor relative paths to the repo root.
 */
export function findWorkspaceRoot(start: string = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

function resolveOut(value: string): string {
  return isAbsolute(value) ? value : join(findWorkspaceRoot(), value);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    caseIds: [],
    mode: 'fake',
    thinking: 'off',
    outDir: join(findWorkspaceRoot(), 'artifacts', 'jvm-diagnosis-benchmark'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--case') options.caseIds.push(argv[++i]!);
    else if (arg === '--all') options.caseIds = [];
    else if (arg === '--mode') options.mode = argv[++i] === 'live' ? 'live' : 'fake';
    else if (arg === '--thinking') options.thinking = argv[++i]!;
    else if (arg === '--out') options.outDir = resolveOut(argv[++i]!);
    else if (arg === '--provider') options.provider = argv[++i];
    else if (arg === '--model') options.model = argv[++i];
    else if (arg === '--label') options.label = argv[++i];
  }
  return options;
}

/** Defensive scrub: never persist a credential that happens to appear in output. */
function scrub<T>(value: T, secrets: readonly string[]): T {
  let text = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret && secret.length >= 8) text = text.split(secret).join('[REDACTED]');
  }
  return JSON.parse(text) as T;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  // Strict: an unknown thinking level is rejected here, never silently clamped.
  const thinking = parseThinkingLevel(options.thinking);

  const model = options.mode === 'live'
    ? (await createLiveBenchmarkModel({
        thinkingLevel: thinking,
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.model ? { model: options.model } : {}),
      })).model
    : createFakeRuntimeModel();

  const cases = resolveCases(options.caseIds);
  const results = await runBenchmark({
    cases,
    model,
    mode: options.mode,
    thinkingLevel: thinking,
    ...(options.label ? { experimentLabel: options.label } : {}),
  });
  const report = buildReport(results, {
    ...(options.label ? { experimentLabel: options.label } : {}),
  });

  const secrets = [process.env['PI_OPS_PI_API_KEY'], process.env['GOVERNANCE_REVIEW_API_KEY']]
    .filter((item): item is string => typeof item === 'string');
  const safeReport = scrub(report, secrets);

  const slug = `${options.mode}-${report.provider}-${report.model}-${thinking}${options.label ? `-${options.label}` : ''}`.replace(/[^\w.-]+/g, '_');
  mkdirSync(options.outDir, { recursive: true });
  const jsonPath = join(options.outDir, `${slug}.json`);
  const mdPath = join(options.outDir, `${slug}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(safeReport, null, 2)}\n`, 'utf8');
  writeFileSync(mdPath, renderMarkdown(safeReport), 'utf8');

  console.log(renderMarkdown(safeReport));
  console.log(`json=${jsonPath}`);
  console.log(`markdown=${mdPath}`);
  console.log(`hardPass=${report.hardPassCount}/${report.caseCount} cases=${CPU_GOLDEN_CASES.length} thinking=${thinking}`);
  if (options.mode === 'live' && model.effectiveThinkingLevel !== undefined
    && model.effectiveThinkingLevel !== thinking) {
    console.error(`unsupported thinking level: requested=${thinking} effective=${model.effectiveThinkingLevel}`);
    process.exit(2);
  }
  if (options.mode === 'fake') {
    // CI harness check, not a quality gate: the deterministic fake model is
    // expected to fail conflict / uncertainty cases. Reaching this point means
    // the harness ran every case.
    console.log('note: fake mode validates harness stability only; it does not prove diagnosis quality');
    process.exit(0);
  }
  process.exit(report.hardPassCount === report.caseCount ? 0 : 1);
}

main().catch((error) => {
  console.error(`benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
