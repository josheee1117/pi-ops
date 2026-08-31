import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function runScriptInSandbox(sandboxSetup) {
  const tmp = mkdtempSync(join(tmpdir(), 'smoke-pi-failclosed-'));
  mkdirSync(join(tmp, 'deploy', 'local'), { recursive: true });
  cpSync(join(here, 'smoke-pi.sh'), join(tmp, 'deploy', 'local', 'smoke-pi.sh'));
  sandboxSetup?.(join(tmp, 'deploy', 'local'));
  let stderr = '';
  let exit = 0;
  try {
    execFileSync('bash', [join(tmp, 'deploy', 'local', 'smoke-pi.sh')], { encoding: 'utf8' });
  } catch (error) {
    exit = error.status ?? 1;
    stderr = error.stderr ?? '';
  }
  rmSync(tmp, { recursive: true, force: true });
  return { exit, stderr };
}

test('smoke-pi.sh fails closed without provider credentials', () => {
  const { exit, stderr } = runScriptInSandbox();
  assert.notEqual(exit, 0);
  assert.match(stderr, /BLOCKED: real Pi provider configuration required/);
});

test('smoke-pi.sh fails closed when credentials are incomplete', () => {
  const { exit, stderr } = runScriptInSandbox((localDir) => {
    writeFileSync(join(localDir, '.env'), 'PI_OPS_PI_PROVIDER=\n');
  });
  assert.notEqual(exit, 0);
  assert.match(stderr, /BLOCKED: PI_OPS_PI_PROVIDER and PI_OPS_PI_MODEL are required/);
});
