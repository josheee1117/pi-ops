import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlanning } from './planning.mjs';

function gitRepo(seed) {
  const repo = mkdtempSync(join(tmpdir(), 'pi-ops-planning-'));
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'governance@example.com']);
  git(['config', 'user.name', 'Governance Test']);
  seed(repo);
  git(['add', '-A']);
  git(['commit', '-qm', 'fixture']);
  return { repo, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

const required = {
  id: 'ARCH-REQ',
  kind: 'requiredText',
  scope: ['apps/foo/src/config.ts'],
  patterns: ['TOKEN'],
};

test('unreadable guarded file is GUARDED_FILE_UNREADABLE', () => {
  const fx = gitRepo((repo) => {
    mkdirSync(join(repo, 'apps/foo/src'), { recursive: true });
    symlinkSync('/this/path/does/not/exist', join(repo, 'apps/foo/src/config.ts'));
  });
  try {
    const violations = createPlanning(fx.repo).evaluateArchitecture({ guards: [required] });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, 'GUARDED_FILE_UNREADABLE');
    assert.equal(violations[0].file, 'apps/foo/src/config.ts');
    assert.deepEqual(violations[0].guardIds, ['ARCH-REQ']);
  } finally {
    fx.cleanup();
  }
});

test('unreadable unguarded file does not invent an architecture violation', () => {
  const fx = gitRepo((repo) => {
    mkdirSync(join(repo, 'apps/foo/src'), { recursive: true });
    writeFileSync(join(repo, 'apps/foo/src/config.ts'), 'TOKEN\n');
    symlinkSync('/this/path/does/not/exist', join(repo, 'apps/foo/src/unrelated.ts'));
  });
  try {
    const violations = createPlanning(fx.repo).evaluateArchitecture({ guards: [required] });
    assert.deepEqual(violations, []);
  } finally {
    fx.cleanup();
  }
});

test('readable guarded file still uses normal requiredText evaluation', () => {
  const fx = gitRepo((repo) => {
    mkdirSync(join(repo, 'apps/foo/src'), { recursive: true });
    writeFileSync(join(repo, 'apps/foo/src/config.ts'), 'TOKEN\n');
  });
  try {
    const ok = createPlanning(fx.repo).evaluateArchitecture({ guards: [required] });
    assert.deepEqual(ok, []);
    const missing = createPlanning(fx.repo).evaluateArchitecture({
      guards: [{ ...required, patterns: ['ABSENT'] }],
    });
    assert.equal(missing.length, 1);
    assert.match(missing[0].detail, /required text missing/);
  } finally {
    fx.cleanup();
  }
});

test('requiredText zero-match remains REQUIRED_GUARD_SCOPE_MISSING', () => {
  const fx = gitRepo((repo) => {
    mkdirSync(join(repo, 'apps/bar/src'), { recursive: true });
    writeFileSync(join(repo, 'apps/bar/src/other.ts'), 'ok\n');
  });
  try {
    const violations = createPlanning(fx.repo).evaluateArchitecture({ guards: [required] });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, 'REQUIRED_GUARD_SCOPE_MISSING');
  } finally {
    fx.cleanup();
  }
});
