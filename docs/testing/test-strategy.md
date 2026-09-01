# Pi-Ops test strategy

Tests are Evidence for Invariants, not coverage scores.

```text
Git Diff
  -> Policy / governed roots / Architecture Guards
  -> Feature + impact graph
  -> Invariant + required Evidence floor
  -> Test Catalog (potential Evidence)
  -> selected ExecutionPlan
  -> real execution
  -> realized Evidence
  -> commit/run Evidence Artifact
  -> automatic Gate
```

Machine config: `tools/test-governance/`. Human maps: this directory. Regenerate machine gap truth with `node tools/test-governance/src/cli.mjs gaps`.

**Potential Proof != Realized Proof.** The Test Catalog is capability metadata only. A proof is realized only when its selected backing test or command executes and passes in the current run. **Planner READY != Gate PASS**: READY means a valid potential plan exists; PASS means every required A/B/C slot was realized by this run.

## Evidence levels (A/B/C)

Assigned **per Proof**, never per file.

| Level | Meaning | Examples |
|-------|---------|----------|
| **A** | The system produced the claimed state | SQLite reopen, real HTTP status, Compose smoke, Node Agent fetch to a closed port |
| **B** | How the system got there | InvestigationEvidenceAudit, notificationId/Idempotency-Key, runtimeRequestId provenance |
| **C** | Controlled substitute | FakeRuntimeModel, fake clock, stub fetch, FakeNotifier |

C cannot satisfy a floor slot that requires A. A/B/C is not UNIT/INTEGRATION/SMOKE.

**Floors represent the claim, not the dashboard.** Durability, security boundaries, and real transport ownership are not satisfied by mock-only evidence. Where a floor slot has no proof, the planner reports `NEEDS_EVIDENCE` and the gap stays red until real evidence is added - never downgraded to make a plan green.

## B evidence usage

B is used only where a structured process trace is a distinct proof: INV-DYN-01 (InvestigationEvidenceAudit survives reopen), INV-CB-01 (runtimeRequestId/session/task provenance on ReasoningResult), INV-NOT-02 (Idempotency-Key == notificationId at the sink). B is not mandatory everywhere the letter exists.

## Execution classes

`UNIT` · `COMPONENT` · `INTEGRATION` · `MULTI_PROCESS` · `SMOKE` · `LIVE_PROVIDER` - separate from Evidence level. SQLite reopen is INTEGRATION and may still be **A** durability.

## Risk

Each Feature has `riskClass` (low/medium/high/critical) and `riskScore` 0-15 from security, durability, process boundary, state-machine complexity, corruption, credentials, blast radius, historical bugs.

## Planner result states (precedence order)

```text
GOVERNANCE_REVIEW_REQUIRED
> GOVERNANCE_POLICY_WEAKENING
> ARCHITECTURE_VIOLATION
> UNMAPPED_PRODUCTION_CHANGE
> NEEDS_EVIDENCE
> BUDGET_EXCEEDED
> READY
```

- **GOVERNANCE_REVIEW_REQUIRED** - the Governance Trust Surface changed (engine, workflow, protected package.json entrypoints) or the trust root was removed/changed after bootstrap. The automatic Gate cannot approve its own engine; exact reason kinds are retained in the artifact.
- **GOVERNANCE_POLICY_WEAKENING** - the Policy Delta Guard found the commit weakening the rules that judge it, or the BASE policy could not be read (fail closed). Exact reasons are listed in the plan, the gate output, and `policy-delta.json`.

- **ARCHITECTURE_VIOLATION** - an architecture guard matched.
- **UNMAPPED_PRODUCTION_CHANGE** - a changed file under a governed production root matches no Feature contract. Governed roots include application/protocol source, local deployment, root dependency/workspace files, and workspace package manifests. Git change discovery retains deleted paths and both sides of renames, so deleting or moving production code cannot disappear from planning. Ignored (not production): tests, docs, governance tooling, smoke scripts, local data, and local secrets. Smoke scripts are test infrastructure; they still map to `local.integration` for planning, but never trigger unmapped failures. `--strict` exits non-zero on any non-READY state.
- **NEEDS_EVIDENCE** - at least one affected Feature has an unclosed floor slot.
- **BUDGET_EXCEEDED** - planned maintenance delta exceeds the Feature budget. Budget is real engine state (`evaluateMaintenanceBudget`): REUSE = 0, STRENGTHEN = configured delta (default 1), CREATE = configured delta (default 4). Today's plans carry REUSE-only actions, so planned delta is 0; the state exists for future action plans and is self-tested.
- **READY** - all affected floors closed, architecture clean, nothing unmapped.

## Policy Delta Guard

The Gate evaluates HEAD using HEAD policy. To prevent a commit from weakening the rules that judge it, every plan over a real revision range compares the parsed policy at BASE with the parsed policy at HEAD (`git show <base>:tools/test-governance/config/...`; no LLM, no diff text).

Blocked as `GOVERNANCE_POLICY_WEAKENING`:

- removed architecture guards, removed forbidden/required patterns, shrunk guard scope, **any kind change on an existing guard** (never auto-classified as stronger/weaker);
- removed governed roots, **any added unmappedIgnore pattern** (an exemption surface; exact-set comparison, no glob containment reasoning);
- removed Features, Feature paths, or impact edges;
- removed Invariants, lowered Evidence floors (A1→A0, C2→C1);
- **any statement change on an existing Invariant id** (the machine cannot distinguish wording clarification from semantic weakening);
- deleted PINNED entries, PINNED→ACTIVE/QUARANTINED/DOMINATED/RETIRED, historicalRegression true→false, removed Proofs or changed backing sources of PINNED entries;
- Evidence-grade changes (C→B/A, B→A) on an unchanged Proof Source.

Allowed: new guards, broader scope, additional patterns, new governed roots, reduced unmappedIgnore, new Features/paths/impacts, new Invariants, higher floors, new Proofs, new PINNED regressions. If BASE policy cannot be read or parsed, the plan fails closed (`BASE_POLICY_UNREADABLE`).

## Governance Trust Surface

Two layers, different jobs:

**Internal (HEAD-executed).** `evaluateGovernanceTrustSurface()` review-gates engine/workflow/entrypoint changes for local `test:plan` / push CI. Useful against accidents. It is not adversarially self-protecting: HEAD still runs the evaluator.

- `tools/test-governance/src/**` changed → `GOVERNANCE_ENGINE_CHANGE_REQUIRES_REVIEW` (governance self-tests included);
- `.github/workflows/test-governance.yml` changed → `GOVERNANCE_WORKFLOW_CHANGE_REQUIRES_REVIEW`;
- root `package.json` protected fields changed → `GOVERNANCE_ENTRYPOINT_CHANGE_REQUIRES_REVIEW`: `scripts.test:gate`, `scripts.test:plan`, `scripts.test:run`, `scripts.test:arch`, `scripts.test:governance`, `scripts.test:governance:self`, `packageManager`, `engines.node`, `dependencies.typescript`, `devDependencies.typescript`. Unrelated package.json changes (description, other scripts) pass; new unprotected scripts are surfaced only.

Trust-root bootstrap is structural and one-time: BASE without `trustRootVersion` → HEAD with `trustRootVersion: 1` yields non-blocking `TRUST_ROOT_BOOTSTRAP` (that migration commit may change the engine). Once BASE carries `trustRootVersion: 1`, any trust-surface change, version removal, or version change blocks `GOVERNANCE_REVIEW_REQUIRED`. No environment bypass, no SHA hardcoding, no actor/branch identity.

**External BASE Trust Anchor.** `.github/workflows/governance-trust-anchor.yml` uses `pull_request_target`, checks out BASE, fetches HEAD git objects, and runs BASE `tools/test-governance/trust-anchor/check.mjs`. HEAD is data: no HEAD checkout-for-execution, no `pnpm install`, no HEAD scripts. Findings: engine/anchor/workflow/policy/entrypoint changes; accepted ACTIVE/PINNED proof source or definition changes; new proofs (A/B/C). Authoritative for PRs only after (1) the workflow exists on `main`, (2) changes go through Pull Requests, (3) the check is required. Code cannot prevent a privileged owner from direct push or disabling protection. Not cryptographic immutability.

The PR that first lands the workflow is a bootstrap: BASE does not yet contain it, so `pull_request_target` will not run it for that PR. Review is human. A later verification PR proves the merged BASE anchor.

Proof Source Integrity hashes declared `location.file` blobs and pnpm script bindings. Imported helpers are not followed unless they are themselves declared proof sources.

`test:plan --files` / `test:run --files` remain advisory (delta + trust surface skipped with a note). A full `test:gate --files` cannot return a trusted `PASS`: it reports `EXPLICIT_FILES_UNTRUSTED` instead. Only a real `base..head` gate can PASS.

## Feature impact propagation

Shared contracts propagate. `protocol.contract` impacts ingress/evidence-collection/callback/dynamic-enrichment/runtime-boundary/node-observation; `configuration.fail-closed` impacts auth/runtime-boundary/reconciliation; `evidence.model-safe-projection` impacts dynamic-enrichment/runtime-boundary. `build.configuration` directly owns root/workspace manifests; package-local manifests also map to their relevant Runtime, Node Agent, or Protocol Feature so existing impact propagation continues. Plan output annotates each Feature `reason=DIRECT` or `reason=IMPACTED_BY <feature>`. Multiple impact parents are retained in deterministic order; cycles terminate; duplicate paths deduplicate.

## Catalog integrity (no ghost or duplicate Proofs)

`validate` uses the TypeScript AST and accepts only unambiguous executable static `it('…')` / `test('…')` calls. Comments, strings, regex literals, member calls, dynamic templates, deleted names, and duplicate names cannot satisfy a Catalog Proof.

Every Catalog entry is a strict union: TEST (`location.file` + `testName`) or COMMAND (`command` + `location.file`), never both, and always with a known `executionClass`. Commands support only `pnpm <script>`, `pnpm run <script>`, and repository-relative `bash <file>`; a pnpm script must resolve exactly to `bash <declared location.file>`. Compound shell forms fail closed, and the Runner receives canonical executable/argv.

A Proof Source is identified by source + invariant + Evidence level. Exact Catalog aliases are rejected and realized Evidence deduplicates them defensively, so one real test cannot fill two required slots.

## Catalog status

`ACTIVE` · `PINNED` · `QUARANTINED` · `DOMINATED` · `RETIRED`. This phase deletes nothing and retires nothing.

**PINNED** = historical regression (fabricated target unhealth, ingest-as-operator, partial Runtime -> Noop, Evidence COMPLETED crash gap, dynamic Evidence generation loop, stale SUBMITTED/RUNNING, stale SQLite smoke). PINNED entries cannot be removed by budget optimization without explicit architecture review.

## Architecture guards

`forbiddenImport` guards are structural (import graph). `requiredText` guards are **weak canaries** for substring presence, never route wiring or semantics. If a `requiredText` scope matches zero current files, planning emits `REQUIRED_GUARD_SCOPE_MISSING` (fail closed). `forbiddenImport` / `forbiddenText` do not invent missing-scope violations. Route-level auth and canonical-config semantics are enforced by the auth-matrix and config/reconciler tests, not by substring checks.

## Execution and Gates

| Gate | Target | Contents |
|------|--------|----------|
| 0 Static | < 30s | governance validation/self-tests, Architecture Guards, typecheck |
| 1 Fast | <= 90s | selected UNIT/COMPONENT proofs + cheap PINNED |
| 2 Integration | <= 3 min | selected SQLite, in-process HTTP, Runtime callback proofs |
| 3 Multi-process | <= 5 min | selected MULTI_PROCESS/SMOKE proofs such as `smoke:local` |
| 4 Live | n/a | LIVE_PROVIDER only with `--max-gate 4 --allow-live-provider` |

Named tests run from their owning workspace via Node 22 / package-local `tsx --test` and TAP. Whole-file execution is allowed only because the runner verifies every selected exact test name in TAP; zero observed, skipped, failed, or ambiguous tests realize nothing. Identical commands execute once; identical selected names in a file are deduplicated. A successful command can realize all catalog entries bound to that exact validated command/artifact.

Every invocation writes a fresh `artifacts/test-evidence/<HEAD_SHA>/<RUN_ID>/` with policy plan, execution plan, actual results, per-invariant potential/realized Evidence, deterministic summary, and bounded logs. Old artifacts are never input to evaluation.

Final Gate states:

```text
PASS
GOVERNANCE_REVIEW_REQUIRED
GOVERNANCE_POLICY_WEAKENING
POLICY_BLOCKED
EXECUTION_FAILED
EVIDENCE_NOT_REALIZED
LIVE_PROVIDER_REQUIRED
EXPLICIT_FILES_UNTRUSTED
INTERNAL_ERROR
```

Planner `GOVERNANCE_REVIEW_REQUIRED` and `GOVERNANCE_POLICY_WEAKENING` map to the same Gate statuses. Other non-READY plan states remain `POLICY_BLOCKED`.

Policy errors stop execution. Only execution status `PASSED` realizes Evidence; A/B/C levels never substitute for one another. Ordinary governance requires **no** live LLM and **no** remote servers. GitHub Actions runs through Gate 3 without provider secrets and always uploads artifacts.

## What a test must answer

What can break - how to trigger - success state - failure state - what must NOT happen - durable/external remainder - what is mocked - **what the test does not prove**.

## Model tests

CI uses FakeRuntimeModel for orchestration (Evidence reaches specialist, data changes finding, bounds, missingEvidence). Real model quality is LIVE_PROVIDER only.

## Honesty corrections

A previous revision counted smoke's `super-secret not in safe view` assertion as A-level model-safe evidence. It was vacuous - the drill chain plants no such value - and has been retracted. INV-SAFE-01 A1 is now an honest machine gap. Prefer trustworthy red over green.

## Retirement (later phase)

Dominance proof required. An LLM recommendation alone never deletes a PINNED regression.
