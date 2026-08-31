# Pi-Ops test strategy

Tests are Evidence for Invariants, not coverage scores.

```text
Feature → Invariant → required Evidence floor → catalog Proof → REUSE / STRENGTHEN / CREATE
```

Machine config: `tools/test-governance/`. Human maps: this directory.

## Evidence levels (A/B/C)

Assigned **per Proof**, never per file.

| Level | Meaning | Examples |
|-------|---------|----------|
| **A** | The system produced the claimed state | SQLite reopen, real HTTP status, Compose smoke, Node Agent fetch to a closed port |
| **B** | How the system got there | InvestigationEvidenceAudit, notificationId/Idempotency-Key, runtimeRequestId |
| **C** | Controlled substitute | FakeRuntimeModel, fake clock, stub fetch, FakeNotifier |

C cannot satisfy a floor that requires A. A/B/C is not UNIT/INTEGRATION/SMOKE.

## Execution classes

Separate from Evidence level:

`UNIT` · `COMPONENT` · `INTEGRATION` · `MULTI_PROCESS` · `SMOKE` · `LIVE_PROVIDER`

Example: SQLite reopen is INTEGRATION and may still be **A** durability.

## Risk

Each Feature has `riskClass` (low/medium/high/critical) and `riskScore` 0–15 from security, durability, process boundary, state-machine complexity, corruption, credentials, blast radius, historical bugs.

## Evidence floor

Each Invariant declares `{ A, B, C }` counts. Floors are conservative:

- Pure algorithm → C1
- Security / auth HTTP → A1 (+ C1 if useful)
- Durability / crash → A1
- Cross-process lifecycle → A1 plus C for isolation

Do not demand A where it adds no information. Do not accept only C for durability, auth, or real transport ownership.

## Catalog status

`ACTIVE` · `PINNED` · `QUARANTINED` · `DOMINATED` · `RETIRED`

This phase does **not** delete tests or mark RETIRED.

**PINNED** = historical regression. Cannot be removed later without architecture review. Examples: fabricated target unhealth, ingest-as-operator, partial Runtime → Noop, Evidence COMPLETED crash gap, dynamic Evidence generation loop, stale SUBMITTED, stale SQLite smoke.

## Planner

`pnpm test:plan` greedily REUSEs the smallest ACTIVE/PINNED catalog set that fills floors. It never lowers a floor to fit `maintenanceBudget`. Gaps stay `NEEDS_EVIDENCE`.

Approximate costs: reuse 0, extra assertion 0.5, new C 1, new B 2, new A integration 4, multi-process 6, live provider 8.

If required Evidence exceeds budget: `BUDGET_EXCEEDED`. Never silently downgrade.

## Gates

| Gate | Target | Contents |
|------|--------|----------|
| 0 Static | < 30s | typecheck, `test:arch`, governance validate |
| 1 Fast | ≤ 90s | unit/component + cheap PINNED |
| 2 Integration | ≤ 3 min | SQLite, in-process HTTP, Runtime callback |
| 3 Multi-process | ≤ 5 min | `smoke:local` when A-level multi-process is required |
| 4 Live | n/a | `smoke:pi` only for provider adapter changes; fail-closed; never ordinary CI |

Ordinary governance does **not** require a live LLM or remote servers.

## What a test must answer

What can break · how to trigger · success state · failure state · what must NOT happen · durable/external remainder · what is mocked · **what the test does not prove**.

## Model tests

CI uses FakeRuntimeModel for orchestration (Evidence reaches specialist, data changes finding, bounds, missingEvidence). Real model quality is LIVE_PROVIDER only.

## Retirement (later phase)

Dominance proof required. An LLM recommendation alone never deletes a PINNED regression.
