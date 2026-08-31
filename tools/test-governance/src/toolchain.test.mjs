import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Toolchain / dependency-surface configuration proofs for the
 * build.configuration Feature.
 *
 * These tests read real committed repository state, so they are direct
 * evidence for CONFIGURATION claims only. They deliberately prove nothing
 * about application behavior.
 */

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'));
}

function workspacePackageDirs() {
  const dirs = [];
  for (const group of ['apps', 'packages']) {
    for (const name of readdirSync(join(ROOT, group))) {
      if (existsSync(join(ROOT, group, name, 'package.json'))) dirs.push(`${group}/${name}`);
    }
  }
  return dirs.sort();
}

test('workspace manifests declare one consistent Node and pnpm toolchain', () => {
  const root = readJson('package.json');
  assert.equal(root.packageManager, 'pnpm@10.15.0');
  assert.match(root.engines.node, /^>=22$/);

  const nodeTypes = root.devDependencies?.['@types/node'];
  assert.ok(nodeTypes, '@types/node must be declared at the workspace root');
  assert.match(nodeTypes, /^\^?22\./, `@types/node must track the Node 22 runtime, got ${nodeTypes}`);

  const dockerfile = readFileSync(join(ROOT, 'deploy/docker/Dockerfile'), 'utf8');
  assert.match(dockerfile, /^FROM node:22-bookworm$/m);

  const workflow = readFileSync(join(ROOT, '.github/workflows/test-governance.yml'), 'utf8');
  assert.match(workflow, /node-version: 22/);
  assert.match(workflow, /version: 10\.15\.0/);
});

test('the committed lockfile covers every workspace package', () => {
  const lockfile = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  const importers = lockfile
    .split('\n')
    .filter((line) => /^ {2}\S+:/.test(line))
    .map((line) => line.trim().replace(/:$/, ''));
  for (const dir of workspacePackageDirs()) {
    assert.ok(importers.includes(dir), `pnpm-lock.yaml has no importer for ${dir}`);
  }
  assert.ok(importers.includes('.'), 'pnpm-lock.yaml has no root importer');
});

test('every workspace package keeps the typecheck and test script contract', () => {
  const workspace = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  assert.match(workspace, /apps\/\*/);
  assert.match(workspace, /packages\/\*/);
  for (const dir of workspacePackageDirs()) {
    const manifest = readJson(`${dir}/package.json`);
    assert.equal(typeof manifest.scripts?.typecheck, 'string', `${dir} must declare a typecheck script`);
    assert.equal(typeof manifest.scripts?.test, 'string', `${dir} must declare a test script`);
    assert.ok(existsSync(join(ROOT, dir, 'tsconfig.json')), `${dir} must keep a tsconfig.json`);
  }
  assert.ok(existsSync(join(ROOT, 'tsconfig.base.json')), 'tsconfig.base.json must exist');
});
