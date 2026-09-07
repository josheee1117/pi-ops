import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../.github/workflows/test-governance.yml'),
  'utf8',
);

test('PR review-required state is explicitly delegated to the authoritative Trust Anchor', () => {
  assert.match(WORKFLOW, /status=.*GOVERNANCE_REVIEW_REQUIRED/s);
  assert.match(
    WORKFLOW,
    /if \[\[ "\$EVENT_NAME" == "pull_request" && "\$status" == "GOVERNANCE_REVIEW_REQUIRED" \]\]; then/,
  );
  assert.match(WORKFLOW, /deferred to authoritative Governance Trust Anchor/);
});

test('ordinary gate still fails closed outside the exact PR delegation case', () => {
  assert.match(WORKFLOW, /exit "\$code"/);
  assert.doesNotMatch(WORKFLOW, /continue-on-error:\s*true/);
  assert.doesNotMatch(WORKFLOW, /\|\|\s*true/);
});

test('structured gate result is produced directly and parsed, not inferred from prose', () => {
  assert.match(WORKFLOW, /node tools\/test-governance\/src\/cli\.mjs gate/);
  assert.match(WORKFLOW, /--json > "\$result"/);
  assert.match(WORKFLOW, /JSON\.parse\(fs\.readFileSync\(process\.argv\[1\]/);
});
