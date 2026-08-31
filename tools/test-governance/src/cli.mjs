#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectMachineGaps,
  summarizeRequirements,
  validateCatalogArtifacts,
  validateGovernanceConfig,
} from './core.mjs';
import { createPlanning } from './planning.mjs';
import { runGate } from './gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CONFIG_DIR = resolve(ROOT, 'tools/test-governance/config');
const planning = createPlanning(ROOT);

function readJson(name) {
  return JSON.parse(readFileSync(resolve(CONFIG_DIR, name), 'utf8'));
}

function fileExists(relativePath) {
  return existsSync(resolve(ROOT, relativePath));
}

function readFileOrNull(relativePath) {
  try {
    return readFileSync(resolve(ROOT, relativePath), 'utf8');
  } catch {
    return '';
  }
}

function packageScripts() {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).scripts ?? {};
  } catch {
    return {};
  }
}

function loadConfig() {
  const features = readJson('features.json');
  const catalog = readJson('catalog.json');
  const guards = readJson('architecture-guards.json');
  const scripts = packageScripts();
  const errors = validateGovernanceConfig(features, catalog, guards, { packageScripts: scripts });
  errors.push(...validateCatalogArtifacts(catalog, {
    fileExists,
    readFile: readFileOrNull,
    packageScripts: scripts,
  }));
  if (errors.length > 0) throw new Error(`invalid test-governance config:\n- ${errors.join('\n- ')}`);
  return { features, catalog, guards, packageScripts: scripts };
}

function parseArgs(argv) {
  const [command = 'plan', ...rest] = argv;
  const options = { base: 'HEAD~1', head: 'HEAD', files: [], json: false, strict: false, maxGate: 3, allowLiveProvider: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--') continue;
    if (arg === '--base') options.base = rest[++i];
    else if (arg === '--head') options.head = rest[++i];
    else if (arg === '--files') options.files.push(...(rest[++i] ?? '').split(',').map((item) => item.trim()).filter(Boolean));
    else if (arg === '--json') options.json = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--max-gate') {
      const value = Number(rest[++i]);
      if (!Number.isInteger(value) || value < 0 || value > 4) throw new Error('--max-gate must be an integer between 0 and 4');
      options.maxGate = value;
    } else if (arg === '--allow-live-provider') options.allowLiveProvider = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { command, options };
}

function printArchitecture(violations, json) {
  const result = { status: violations.length === 0 ? 'PASS' : 'FAIL', violations };
  if (json) return console.log(JSON.stringify(result, null, 2));
  console.log(`ARCHITECTURE GUARDS: ${result.status}`);
  for (const violation of violations) console.log(`- ${violation.guardId} ${violation.file}: ${violation.detail}`);
}

function printPlan(result, json) {
  if (json) return console.log(JSON.stringify(result, null, 2));
  console.log('TEST GOVERNANCE PLAN');
  console.log(`base=${result.base} head=${result.head}`);
  console.log(`changedFiles=${result.changedFiles.length}`);
  for (const change of result.changes ?? result.changedFiles.map((path) => ({ status: 'M', path }))) {
    if (change.oldPath && change.newPath) console.log(`  - ${change.status} ${change.oldPath} -> ${change.newPath}`);
    else console.log(`  - ${change.status} ${change.path}`);
  }
  console.log(`architecture=${result.architecture.status}`);
  if (result.unmappedProductionFiles.length > 0) {
    console.log('unmappedProductionFiles:');
    for (const file of result.unmappedProductionFiles) console.log(`  - ${file}`);
  }
  if (result.features.length === 0 && result.unmappedProductionFiles.length === 0) {
    console.log('affectedFeatures=0 (no governed feature matched and no governed production file changed)');
  }
  for (const item of result.features) {
    console.log(`\n${item.feature.id} [${String(item.feature.riskClass).toUpperCase()} risk=${item.feature.riskScore}] reason=${item.reason}`);
    if (item.matchedFiles.length > 0) {
      console.log('  matched:');
      for (const file of item.matchedFiles) console.log(`    - ${file}`);
    }
    console.log('  invariants:');
    for (const requirement of summarizeRequirements(item.feature)) console.log(`    - ${requirement.id} ${requirement.required}: ${requirement.statement}`);
    console.log('  REUSE:');
    if (item.plan.selected.length === 0) console.log('    - none');
    for (const entry of item.plan.selected) {
      const proofs = entry.covers.map((proof) => `${proof.invariantId}:${proof.level}`).join(', ');
      console.log(`    - ${entry.id} -> ${entry.location?.file ?? entry.command ?? entry.id} [${proofs}]`);
    }
    console.log('  gaps:');
    if (item.plan.gaps.length === 0) console.log('    - none');
    for (const gap of item.plan.gaps) console.log(`    - ${gap.invariantId}:${gap.level} missing=${gap.missing}`);
    console.log(`  status=${item.plan.status}`);
    console.log(`  maintenanceBudget=${item.plan.maintenanceBudget} plannedDelta=${item.plan.plannedMaintenanceDelta} remainingBudget=${item.plan.remainingBudget} budgetStatus=${item.plan.budgetStatus} existingCatalogCost=${item.plan.catalogMaintenanceCost}`);
  }
  console.log(`\nRESULT: ${result.status}`);
}

function printGate(result, json) {
  if (json) {
    return console.log(JSON.stringify({
      status: result.status,
      runId: result.runId,
      headSha: result.headSha,
      base: result.base,
      head: result.head,
      staticChecks: result.staticChecks,
      policyStatus: result.plan?.status ?? null,
      unmappedProductionFiles: result.plan?.unmappedProductionFiles ?? [],
      affectedFeatures: (result.plan?.features ?? []).map((item) => ({ id: item.feature.id, reason: item.reason })),
      runs: (result.executionPlan?.runs ?? []).map((run) => {
        const execution = (result.executionResults ?? []).find((candidate) => candidate.runId === run.runId);
        return {
          runId: run.runId,
          kind: run.kind,
          gate: run.gate,
          target: run.file ?? run.command,
          planned: run.planned,
          status: execution?.status ?? 'NOT_RUN',
        };
      }),
      evidence: result.evidence,
      error: result.error,
      artifactDir: result.artifact?.dir ?? null,
    }, null, 2));
  }
  console.log('TEST GOVERNANCE GATE');
  console.log(`run=${result.runId} commit=${result.headSha}`);
  console.log(`base=${result.base} head=${result.head}`);
  for (const [name, value] of Object.entries(result.staticChecks)) {
    console.log(`${name}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  if (result.plan) {
    console.log(`policy=${result.plan.status}`);
    console.log(`changedFiles=${result.plan.changedFiles.length}`);
    if (result.plan.unmappedProductionFiles.length > 0) {
      console.log('unmappedProductionFiles:');
      for (const file of result.plan.unmappedProductionFiles) console.log(`  - ${file}`);
    }
    console.log(`affectedFeatures=${result.plan.features.length}`);
    for (const item of result.plan.features) console.log(`  - ${item.feature.id} (${item.reason})`);
  }
  if (result.executionPlan) {
    const resultByRunId = new Map(result.executionResults.map((run) => [run.runId, run]));
    console.log(`execution (max gate ${result.executionPlan.maxGate}):`);
    for (const run of result.executionPlan.runs) {
      const execution = resultByRunId.get(run.runId);
      console.log(`  - ${run.runId} [gate ${run.gate}] ${run.kind} ${run.file ?? run.command} -> ${execution?.status ?? 'NOT_RUN'}`);
    }
  }
  if (result.evidence) {
    for (const feature of result.evidence.features) {
      console.log(`evidence ${feature.featureId}: ${feature.status}`);
      for (const invariant of feature.invariants) {
        if (!invariant.satisfied) {
          console.log(`  missing ${invariant.invariantId} required=${JSON.stringify(invariant.required)} realized=${JSON.stringify(invariant.realized)}`);
        }
      }
    }
  }
  if (result.error) console.log(`error: ${result.error}`);
  if (result.artifact?.dir) console.log(`artifact: ${result.artifact.dir}`);
  console.log(`\nGATE RESULT: ${result.status}`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'validate') {
    const config = loadConfig();
    const result = {
      status: 'PASS',
      features: config.features.features.length,
      catalogEntries: config.catalog.entries.length,
      architectureGuards: config.guards.guards.length,
    };
    return options.json ? console.log(JSON.stringify(result, null, 2)) : console.log(`TEST GOVERNANCE CONFIG: PASS\nfeatures=${result.features} catalogEntries=${result.catalogEntries} guards=${result.architectureGuards}`);
  }
  if (command === 'arch') {
    const config = loadConfig();
    const violations = planning.evaluateArchitecture(config.guards);
    printArchitecture(violations, options.json);
    if (violations.length > 0) process.exitCode = 1;
    return;
  }
  if (command === 'gaps') {
    const config = loadConfig();
    const gaps = collectMachineGaps(config.features.features, config.catalog.entries);
    if (options.json) return console.log(JSON.stringify({ gaps }, null, 2));
    console.log(`MACHINE EVIDENCE GAPS: ${gaps.length}`);
    for (const gap of gaps) console.log(`- ${gap.featureId} ${gap.invariantId}:${gap.level} missing=${gap.missing}`);
    return;
  }
  if (command === 'plan') {
    const config = loadConfig();
    const result = planning.buildPlan(config, options);
    printPlan(result, options.json);
    if (options.strict && result.status !== 'READY') process.exitCode = 1;
    return;
  }
  if (command === 'run' || command === 'gate') {
    const result = await runGate({
      root: ROOT,
      loadConfig,
      base: options.base,
      head: options.head,
      files: options.files,
      maxGate: options.maxGate,
      allowLiveProvider: options.allowLiveProvider,
      skipStatic: command === 'run',
    });
    printGate(result, options.json);
    if (result.status !== 'PASS') process.exitCode = 1;
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
