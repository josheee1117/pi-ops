# Test Governance

Deterministic development-time governance for Pi-Ops tests. This tool is not part of the Pi-Ops production runtime.

The model is:

```text
Feature -> Invariant -> required Evidence -> existing Test Catalog -> REUSE / GAP
                     + Architecture Guards + governed roots + impact propagation
```

The goal is not maximum test count. A feature is considered testable only when its required invariants have the required evidence grades.

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
- **Unmapped production changes fail.** Governed roots are `apps/*/src/**`, `packages/*/src/**`, `deploy/local/**`, `deploy/docker/**`. A changed file under a root that matches no Feature yields `UNMAPPED_PRODUCTION_CHANGE` (non-READY; `--strict` exits non-zero). Tests, docs, governance tooling, smoke scripts, and local data are ignored; `deploy/local/smoke.sh` / `smoke-pi.sh` are test infrastructure but still map to `local.integration` for planning.
- **No ghost tests.** `validate` fails when a catalog `testName` no longer exists (line-anchored `it(`/`test(` parse; comments do not count), when `location.file` is missing, or when a `command` references a missing package script/file (`pnpm <script>` / `bash <file>` are the verified forms; anything else is `UNVERIFIED_COMMAND`).
- **Impact propagation.** Shared contracts pull dependent Features into the plan (`protocol.contract`, `configuration.fail-closed`, `evidence.model-safe-projection` declare `impacts`). Output annotates `reason=DIRECT` / `reason=IMPACTED_BY <feature>`. Cycles terminate; duplicates collapse.
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
```

`test:plan` reports `NEEDS_EVIDENCE` / `UNMAPPED_PRODUCTION_CHANGE` honestly and fails only with `--strict`. Architecture violations always fail `test:arch`.

## Current machine gaps

As of this revision the planner honestly reports three A-level floor gaps (see `docs/testing/test-gap-report.md`): Node Agent transport ownership, stale Runtime recovery, and cross-process model-safe projection. They stay red until real evidence is added.

## Configuration

- `config/features.json` - governed roots, ignore paths, feature paths, risk, budgets, invariants, floors, and `impacts` edges.
- `config/catalog.json` - reusable test/smoke proofs with per-proof evidence levels. `ACTIVE` and `PINNED` entries are eligible for planning.
- `config/architecture-guards.json` - deterministic import/text constraints. `requiredText` guards are weak canaries by design; semantics live in tests.

The planner greedily selects the smallest useful existing catalog set. It never lowers an evidence floor to satisfy a budget. This tool does not create, delete, quarantine, or execute tests automatically.

## Next phase

Close the three P1 machine gaps (STRENGTHEN smoke for model-safe, then MULTI_PROCESS transport/stale proofs), then add selected-test execution and evidence-result artifacts. Test consolidation/retirement must require dominance proof; an LLM recommendation alone must never delete a regression proof.
