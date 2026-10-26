import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../.github/workflows/test-governance.yml'),
  'utf8',
);

test('PR review-required state runs the full suite before passing', () => {
  const branch = WORKFLOW.match(
    /if \[\[ "\$EVENT_NAME" == "pull_request" && "\$status" == "GOVERNANCE_REVIEW_REQUIRED" \]\]; then\n([\s\S]*?)\n\s*fi/,
  );
  assert.ok(branch, 'the fallback must be limited to the exact PR review-required state');
  assert.deepEqual(branch[1].trim().split('\n').map((line) => line.trim()), [
    'echo "::notice::GOVERNANCE_REVIEW_REQUIRED: final is advisory, running the full suite here"',
    'pnpm typecheck',
    'pnpm test',
    'pnpm test:governance:self',
    'pnpm test:arch',
    'exit 0',
  ]);
  assert.doesNotMatch(WORKFLOW, /deferred to authoritative Governance Trust Anchor/);
});

test('ordinary gate still fails closed outside the exact PR fallback case', () => {
  assert.match(WORKFLOW, /exit "\$code"/);
  assert.doesNotMatch(WORKFLOW, /continue-on-error:\s*true/);
  assert.doesNotMatch(WORKFLOW, /\|\|\s*true/);
});

test('structured gate result is produced directly and parsed, not inferred from prose', () => {
  assert.match(WORKFLOW, /node tools\/test-governance\/src\/cli\.mjs gate/);
  assert.match(WORKFLOW, /--json > "\$result"/);
  assert.match(WORKFLOW, /JSON\.parse\(fs\.readFileSync\(process\.argv\[1\]/);
});
