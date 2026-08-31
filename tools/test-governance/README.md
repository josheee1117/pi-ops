# Test Governance

Deterministic development-time governance for Pi-Ops tests. This tool is not part of the Pi-Ops production runtime.

The model is:

```text
Feature -> Invariant -> required Evidence -> existing Test Catalog -> REUSE / GAP
                     + Architecture Guards
```

The goal is not maximum test count. A feature is considered testable only when its required invariants have the required evidence grades.

## Evidence levels

- **A** — direct result evidence: externally observable state, real SQLite state, process/HTTP state, or a real boundary relevant to the claim.
- **B** — process evidence: structured audit, logs, request correlation, lifecycle trace.
- **C** — simulation evidence: mock, fake clock, fake runtime, stub transport, isolated deterministic substitute.

A/B/C are proof grades, not aliases for unit/integration/E2E. One test may provide different grades for different invariants.

## Governed features

The catalog now covers the current Pi-Ops feature set (ingress, Incident, Evidence, Investigation, Runtime, auth, notifications, Node Agent, memory, protocol, config, persistence, local integration). Phase 12A reconciliation invariants remain PINNED:


- dynamic Evidence must not create a new Evidence generation;
- deterministic Evidence requeue is what advances generation;
- stale SUBMITTED/RUNNING attempts fail and retry within a bound;
- the crash gap is repaired from SQLite;
- external Runtime remains the authoritative reasoning path.

Historical regression proofs are marked `PINNED` in the catalog so future budget compaction cannot casually retire them.

## Commands

```bash
# Validate contracts/catalog/guards
node tools/test-governance/src/cli.mjs validate

# Machine-enforced architecture boundaries (non-zero on violation)
pnpm test:arch

# Plan against the current commit
pnpm test:plan

# Plan a specific change while developing
pnpm test:plan -- --files apps/agent/src/investigation-reconciler.ts

# JSON output for Coding Agents
pnpm test:plan -- --files apps/agent/src/investigation-reconciler.ts --json

# Make evidence gaps blocking when a later CI gate adopts it
node tools/test-governance/src/cli.mjs plan --strict --base origin/main

# Self-test + config + architecture + plan
pnpm test:governance
```

`test:plan` is advisory in Phase 1: it reports `NEEDS_EVIDENCE` but does not fail unless `--strict` is supplied. Architecture violations always fail `test:arch`.

## Configuration

- `config/features.json` — feature paths, risk class, maintenance budget, invariants and evidence floors.
- `config/catalog.json` — reusable test/smoke proofs. `ACTIVE` and `PINNED` entries are eligible for planning.
- `config/architecture-guards.json` — deterministic import/text constraints.

The planner greedily selects the smallest useful existing catalog set. It never lowers an evidence floor to satisfy a budget. Phase 1 does not create, delete, quarantine, or execute tests automatically.

## Next phase

After the contract model is proven on real commits, add selected-test execution and evidence-result artifacts. Test consolidation/retirement should come later and must require dominance proof; an LLM recommendation alone must never delete a regression proof.
