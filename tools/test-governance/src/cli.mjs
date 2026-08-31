#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFeaturePlan,
  evaluateGuardFile,
  matchesPath,
  resolveAffectedFeatures,
  summarizeRequirements,
  validateGovernanceConfig
} from './core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CONFIG_DIR = resolve(ROOT, 'tools/test-governance/config');

function readJson(name) {
  return JSON.parse(readFileSync(resolve(CONFIG_DIR, name), 'utf8'));
}

function loadConfig() {
  const features = readJson('features.json');
  const catalog = readJson('catalog.json');
  const guards = readJson('architecture-guards.json');
  const errors = validateGovernanceConfig(features, catalog, guards);
  for (const entry of catalog.entries ?? []) {
    const file = entry.location?.file;
    if (file && !existsSync(resolve(ROOT, file))) {
      errors.push(`${entry.id}: catalog location.file does not exist: ${file}`);
    }
  }
  if (errors.length > 0) throw new Error(`invalid test-governance config:\n- ${errors.join('\n- ')}`);
  return { features, catalog, guards };
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function repoFiles() {
  const output = git(['ls-files']);
  return output ? output.split('\n').filter(Boolean) : [];
}

function changedFiles(options) {
  if (options.files.length > 0) return options.files;
  const output = git(['diff', '--name-only', '--diff-filter=ACMR', `${options.base}...${options.head}`]);
  return output ? output.split('\n').filter(Boolean) : [];
}

function evaluateArchitecture(guardDoc) {
  const violations = [];
  for (const file of repoFiles()) {
    if (!guardDoc.guards.some((guard) => guard.scope.some((pattern) => matchesPath(file, pattern)))) continue;
    let content;
    try {
      content = readFileSync(resolve(ROOT, file), 'utf8');
    } catch {
      continue;
    }
    for (const guard of guardDoc.guards) violations.push(...evaluateGuardFile(guard, file, content));
  }
  return violations;
}

function parseArgs(argv) {
  const [command = 'plan', ...rest] = argv;
  const options = { base: 'HEAD~1', head: 'HEAD', files: [], json: false, strict: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--') continue;
    if (arg === '--base') options.base = rest[++i];
    else if (arg === '--head') options.head = rest[++i];
    else if (arg === '--files') options.files.push(...(rest[++i] ?? '').split(',').map((item) => item.trim()).filter(Boolean));
    else if (arg === '--json') options.json = true;
    else if (arg === '--strict') options.strict = true;
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

function buildPlan(config, options) {
  const files = changedFiles(options);
  const architectureViolations = evaluateArchitecture(config.guards);
  const features = resolveAffectedFeatures(files, config.features.features).map(({ feature, matchedFiles }) => ({
    feature,
    matchedFiles,
    plan: buildFeaturePlan(feature, config.catalog.entries)
  }));
  const hasGaps = features.some((item) => item.plan.gaps.length > 0);
  return {
    base: options.files.length > 0 ? '<explicit-files>' : options.base,
    head: options.head,
    changedFiles: files,
    architecture: { status: architectureViolations.length === 0 ? 'PASS' : 'FAIL', violations: architectureViolations },
    features,
    status: architectureViolations.length > 0 ? 'ARCHITECTURE_VIOLATION' : hasGaps ? 'NEEDS_EVIDENCE' : 'READY'
  };
}

function printPlan(result, json) {
  if (json) return console.log(JSON.stringify(result, null, 2));
  console.log('TEST GOVERNANCE PLAN');
  console.log(`base=${result.base} head=${result.head}`);
  console.log(`changedFiles=${result.changedFiles.length}`);
  for (const file of result.changedFiles) console.log(`  - ${file}`);
  console.log(`architecture=${result.architecture.status}`);
  if (result.features.length === 0) console.log('affectedFeatures=0 (no governed feature matched)');
  for (const item of result.features) {
    console.log(`\n${item.feature.id} [${String(item.feature.riskClass).toUpperCase()} risk=${item.feature.riskScore}]`);
    console.log('  matched:');
    for (const file of item.matchedFiles) console.log(`    - ${file}`);
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
    console.log(`  maintenanceBudget=${item.feature.maintenanceBudget} existingCatalogCost=${item.plan.catalogMaintenanceCost} reuseDelta=0`);
  }
  console.log(`\nRESULT: ${result.status}`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (command === 'validate') {
    const result = { status: 'PASS', features: config.features.features.length, catalogEntries: config.catalog.entries.length, architectureGuards: config.guards.guards.length };
    return options.json ? console.log(JSON.stringify(result, null, 2)) : console.log(`TEST GOVERNANCE CONFIG: PASS\nfeatures=${result.features} catalogEntries=${result.catalogEntries} guards=${result.architectureGuards}`);
  }
  if (command === 'arch') {
    const violations = evaluateArchitecture(config.guards);
    printArchitecture(violations, options.json);
    if (violations.length > 0) process.exitCode = 1;
    return;
  }
  if (command === 'plan') {
    const result = buildPlan(config, options);
    printPlan(result, options.json);
    if (options.strict && result.status !== 'READY') process.exitCode = 1;
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
