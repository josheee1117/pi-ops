# Test Governance

Deterministic development-time governance for Pi-Ops tests. This tool is not part of the Pi-Ops production runtime.

The v1 architecture is:

```text
Git Diff
  -> governed-root / architecture policy
  -> Feature + impact graph
  -> Invariant + Evidence floor
  -> Test Catalog (potential proofs)
  -> selected ExecutionPlan
  -> real test/command execution
  -> realized Evidence
  -> immutable run artifact
  -> automatic Gate PASS / fail closed
```

The goal is not maximum test count. **Catalog Proof != Realized Proof**: catalog metadata says a test can prove a claim; only a successful execution in the current gate run realizes that proof. Consequently **Planner READY != Gate PASS**.

## Evidence levels

- **A** - direct result evidence: externally observable state, real SQLite state, process/HTTP state, or a real boundary relevant to the claim.
- **B** - process evidence: structured audit, logs, request correlation, or lifecycle trace.
- **C** - simulation evidence: mock, fake clock, fake runtime, stub transport, or isolated deterministic substitute.

A/B/C are proof grades, not aliases for unit/integration/E2E. One test may provide different grades for different invariants.

## Governed features

The catalog covers the current Pi-Ops feature set (ingress, Incident, Evidence, Investigation, Runtime, auth, notifications, Node Agent, memory, protocol, config, persistence, local integration). Phase 12A reconciliation invariants remain PINNED:

- dynamic Evidence must not create a new Evidence generation;
- deterministic Evidence requeue is what advances generation;
- stale SUBMITTED/RUNNING attempts fail and retry within a bound;
- the crash gap is repaired from SQLite;
- external Runtime remains the authoritative reasoning path.

Historical regression proofs are marked `PINNED` in the catalog so future budget compaction cannot casually retire them.

## Fail-closed guarantees

- **Floors are claims.** Durability, security, and transport-ownership floors are not satisfied by mock-only evidence. Unclosed slots surface as `NEEDS_EVIDENCE` - the planner never lowers a floor.
- **Unmapped production changes fail.** Governed roots include `apps/*/src/**`, `packages/*/src/**`, local deployment, and repository/workspace manifests (`package.json`, lock/workspace/tsconfig files, `apps/*/package.json`, `packages/*/package.json`). A changed file under a root that matches no Feature yields `UNMAPPED_PRODUCTION_CHANGE` (non-READY; `--strict` exits non-zero). Git discovery retains deletions and both sides of renames. Tests, docs, governance tooling, smoke scripts, and local data are ignored; smoke scripts still map to `local.integration` for planning.
- **No ghost tests.** `validate` uses the TypeScript AST and accepts only executable static `it('…')` / `test('…')` declarations. Comments, strings, templates with substitutions, regex literals, member calls, missing names, and ambiguous duplicate names cannot satisfy catalog metadata.
- **Commands are canonical.** Command entries support only `pnpm <script>`, `pnpm run <script>`, and repository-relative `bash <file>`. A pnpm script must be exactly `bash <declared location.file>`; compound shell commands fail closed. The ExecutionPlan carries validated executable/argv rather than a shell string.
- **Proof sources are unique.** The same test or canonical command/artifact cannot fill the same invariant+level slot twice through catalog aliases; validation rejects it and realized-Evidence evaluation deduplicates it again.
- **Catalog execution is unambiguous.** Every entry is exactly one of TEST (`location.file` + `testName`) or COMMAND (`command` + `location.file`), and `executionClass` is mandatory. Unknown classes never default to Gate 1.
- **Impact propagation.** Shared contracts pull dependent Features into the plan (`protocol.contract`, `configuration.fail-closed`, `evidence.model-safe-projection` declare `impacts`). Output annotates `reason=DIRECT` / `reason=IMPACTED_BY <feature>`. Multiple parents are retained deterministically; cycles terminate; duplicates collapse.
- **Budget is engine state.** `evaluateMaintenanceBudget` computes planned delta (REUSE 0, STRENGTHEN 1, CREATE 4 defaults) and reports `WITHIN_BUDGET` / `BUDGET_EXCEEDED` without ever touching floors.

Planner state precedence: `ARCHITECTURE_VIOLATION` > `UNMAPPED_PRODUCTION_CHANGE` > `NEEDS_EVIDENCE` > `BUDGET_EXCEEDED` > `READY`.

## Commands

```bash
# Validate contracts/catalog/guards (incl. ghost tests + command references)
node tools/test-governance/src/cli.mjs validate

# Machine evidence gaps across ALL features (source of truth for the gap report)
node tools/test-governance/src/cli.mjs gaps

# Machine-enforced architecture boundaries (non-zero on violation)
pnpm test:arch

# Plan against the current commit
pnpm test:plan

# Plan a specific change while developing
pnpm test:plan -- --files apps/agent/src/investigation-reconciler.ts

# JSON output for Coding Agents
pnpm test:plan -- --files apps/agent/src/investigation-reconciler.ts --json

# Make any non-READY state (gaps, unmapped production change, violation) blocking
node tools/test-governance/src/cli.mjs plan --strict --base origin/main

# Self-test + config + architecture + plan
pnpm test:governance

# Execute only selected proofs (policy + execution; skips Gate 0 self/typecheck)
pnpm test:run -- --files apps/agent/src/app.ts --max-gate 3

# Full Gate 0..3: policy, self-tests, typecheck, selected execution, Evidence artifact
pnpm test:gate -- --base HEAD~1 --head HEAD --max-gate 3

# Gate 4 requires BOTH explicit max gate and live-provider consent
pnpm test:gate -- --max-gate 4 --allow-live-provider
```

`test:plan` reports `NEEDS_EVIDENCE` / `UNMAPPED_PRODUCTION_CHANGE` honestly and fails only with `--strict`. Architecture violations always fail `test:arch`.

`test:run` and `test:gate` emit a fresh directory at `artifacts/test-evidence/<HEAD_SHA>/<RUN_ID>/` containing `plan.json`, `execution-plan.json`, `execution.json`, `evidence.json`, `summary.md`, and bounded per-run logs. Artifacts are never read back as proof. Final Gate states are `PASS`, `POLICY_BLOCKED`, `EXECUTION_FAILED`, `EVIDENCE_NOT_REALIZED`, `LIVE_PROVIDER_REQUIRED`, and `INTERNAL_ERROR`.

## Current machine gaps

As of this revision the planner honestly reports three A-level floor gaps (see `docs/testing/test-gap-report.md`): Node Agent transport ownership, stale Runtime recovery, and cross-process model-safe projection. They stay red until real evidence is added.

## Configuration

- `config/features.json` - governed roots, ignore paths, feature paths, risk, budgets, invariants, floors, and `impacts` edges.
- `config/catalog.json` - reusable test/smoke proofs with per-proof evidence levels. `ACTIVE` and `PINNED` entries are eligible for planning.
- `config/architecture-guards.json` - deterministic import/text constraints. `requiredText` guards are weak canaries by design; semantics live in tests.

The planner greedily selects the smallest useful existing catalog set. It never lowers an evidence floor to satisfy a budget. `build.configuration` governs dependency, lockfile, workspace, typecheck, and Node 22/pnpm 10.15.0 contracts without claiming application behavior. The selected runner deduplicates canonical commands and groups named tests per owning test file, executes the real Node/tsx test file with TAP, and requires every selected static name to be observed as passed. Exit code 0 with no observed selected test is not PASS.

GitHub Actions runs the deterministic Gate through Gate 3 on pull requests, pushes to `main`, and manual dispatches, then uploads Evidence artifacts with `if: always()`. It uses no provider secrets, live model, or remote servers. Gate 4 remains explicit opt-in.

Test consolidation/retirement is out of scope. Dominance proof and architecture review remain mandatory; an LLM recommendation alone never deletes a regression proof.
