# Pi-Ops test-case matrix

Machine config (`tools/test-governance/config/`) is the source of truth for Features, Invariants, floors, and catalog proofs. This document is the human view and must stay consistent with `node tools/test-governance/src/cli.mjs gaps`.

Actions: `REUSE` / `STRENGTHEN` / `CREATE`. No RETIRE in this phase.

## Planner result states

`GOVERNANCE_REVIEW_REQUIRED` > `GOVERNANCE_POLICY_WEAKENING` > `ARCHITECTURE_VIOLATION` > `UNMAPPED_PRODUCTION_CHANGE` > `NEEDS_EVIDENCE` > `BUDGET_EXCEEDED` > `READY`

The Policy Delta Guard compares the parsed governance policy at BASE with HEAD (`git show <base>:...`); weakening the rules that judge the same commit fails closed. Internal Trust Surface review-gates the HEAD-executed engine. External BASE Trust Anchor (`pull_request_target` + `tools/test-governance/trust-anchor/check.mjs`) is the PR trust boundary after it exists on `main` as a required check; the bootstrap PR that introduces it is not protected by it. See `docs/testing/test-strategy.md`.

Governed production roots cover application/protocol source, local deployment, root dependency/workspace files, and workspace package manifests. A changed or deleted path under a governed root that matches no Feature contract yields `UNMAPPED_PRODUCTION_CHANGE` (fail-closed); both sides of a rename participate. Tests, docs, governance tooling, and smoke scripts are excluded from that check; `deploy/local/smoke.sh` and `smoke-pi.sh` are test infrastructure, not production behavior, though they still map to `local.integration` for planning.

Shared-contract changes propagate: `protocol.contract` impacts ingress/evidence/callback/dynamic-enrichment/runtime-boundary/node-observation; `configuration.fail-closed` impacts auth/runtime-boundary/reconciliation; `evidence.model-safe-projection` impacts dynamic-enrichment/runtime-boundary. Plan output annotates each Feature with `reason=DIRECT` or `reason=IMPACTED_BY <feature>`.

## Feature inventory (25)

| ID | Risk | Score | Gate | Machine gaps |
|----|------|------:|------|--------------|
| event.ingress | high | 11 | 1-2 | none |
| incident.lifecycle | high | 10 | 1-2 | none |
| evidence.collection | high | 11 | 1,3 | INV-EVD-02:A |
| evidence.job-lifecycle | high | 10 | 1-2 | none |
| evidence.model-safe-projection | critical | 13 | 1,3 | INV-SAFE-01:A |
| evidence.dynamic-enrichment | high | 11 | 1,3 | none |
| investigation.reconciliation | critical | 12 | 1-3 | INV-STALE-01:A |
| investigation.lifecycle | high | 11 | 1 | none |
| investigation.callback | high | 11 | 1 | none |
| runtime.boundary | critical | 13 | 0-2 | none |
| runtime.coordinator | high | 11 | 1,3 | none |
| runtime.callback-delivery | high | 11 | 2 | none |
| auth.boundary | critical | 14 | 1 | none |
| notification.lifecycle | high | 10 | 1,3 | none |
| node.observation | high | 10 | 1 | none |
| node.http-probe | high | 12 | 1 | none |
| node.docker-evidence | high | 10 | 1 | none |
| memory.retrieval | medium | 7 | 1 | none |
| memory.governance | medium | 7 | 1 | none |
| reasoning.local | medium | 6 | 1 | none |
| protocol.contract | high | 9 | 1 | none |
| configuration.fail-closed | high | 10 | 1 | none |
| persistence.migration | high | 10 | 2 | none |
| local.integration | high | 11 | 3-4 | none |
| build.configuration | high | 9 | 1 | none |

---

## Per-Feature summary

Generated from `features.json` + `catalog.json`; regenerate with the governance config, not by hand.

### event.ingress

- **Risk:** high (11)
- **Gate:** 1-2
- **Paths:** `apps/agent/src/app.ts`, `apps/agent/src/store.ts`
- **Invariants:**
  - `INV-ING-01` C1 A1: Only a valid ingest token may POST /v1/events.
  - `INV-ING-02` A1: A valid EventBatch is persisted immutably; duplicate event ids with the same payload are idempotent.
  - `INV-ING-03` A1: A duplicate event id with a conflicting payload is rejected without mutating stored Events.
  - `INV-ING-04` C1: Oversized or invalid JSON bodies fail closed without creating Incidents.
- **Catalog Proofs:** `ing-auth-reject`, `ing-auth-http`, `ing-persist`, `ing-idempotent`, `ing-conflict`, `ing-oversized`
- **Machine Gaps:** none

### incident.lifecycle

- **Risk:** high (10)
- **Gate:** 1-2
- **Paths:** `apps/agent/src/incident.ts`, `apps/agent/src/fingerprint.ts`, `apps/agent/src/store.ts`
- **Invariants:**
  - `INV-INC-01` A1: Matching Events within the aggregation window join one Incident; recovery maps to the failure fingerprint.
  - `INV-INC-02` A1: Unmatched recovery is durably pending and reconciles when the earlier failure arrives.
  - `INV-INC-03` C1: Incident processing of a duplicate Event is not invoked again.
- **Catalog Proofs:** `inc-recovery-pending`, `inc-no-reprocess`
- **Machine Gaps:** none

### evidence.collection

- **Risk:** high (11)
- **Gate:** 1,3
- **Paths:** `apps/agent/src/evidence-orchestrator.ts`, `apps/agent/src/runtime-evidence-resolver.ts`
- **Invariants:**
  - `INV-EVD-01` C1: Deterministic evidence plans are typed and bounded; no model participates in planning.
  - `INV-EVD-02` C1 A1: Pi-Ops transport failure to Node Agent is retryable failed Evidence and is never converted into target-health facts.
  - `INV-EVD-03` C1: Node Agent-produced target unhealth is stored as succeeded http.probe with healthy=false.
  - `INV-EVD-04` C1: Node-agent tokens never appear in persisted Evidence error text.
- **Catalog Proofs:** `evd-plan-typed`, `evd-transport-retryable`, `evd-hang-retryable`, `evd-node-unhealth`, `evd-redact-token`
- **Machine Gaps:** `INV-EVD-02:A`

### evidence.job-lifecycle

- **Risk:** high (10)
- **Gate:** 1-2
- **Paths:** `apps/agent/src/evidence-worker.ts`, `apps/agent/src/store.ts`
- **Invariants:**
  - `INV-JOB-01` A1: A new Incident atomically creates one pending EvidenceJob.
  - `INV-JOB-02` C1: Retryable collection failures requeue the job; terminal failures do not retry that query.
  - `INV-JOB-03` A1: A RUNNING EvidenceJob is reset to PENDING after process restart.
- **Catalog Proofs:** `job-atomic`, `job-retry-terminal`, `job-restart`
- **Machine Gaps:** none

### evidence.model-safe-projection

- **Risk:** critical (13)
- **Gate:** 1,3
- **Impacts:** evidence.dynamic-enrichment, runtime.boundary
- **Paths:** `apps/agent/src/incident-context.ts`, `apps/agent/src/investigation-evidence.ts`, `apps/agent/src/investigation-context.ts`
- **Invariants:**
  - `INV-SAFE-01` C1 A1: Raw SQLite Evidence remains unsanitized; Runtime receives only toRuntimeSafeEvidence.
  - `INV-SAFE-02` C1: Secret-looking field names are redacted and logs are bounded in the model-safe projection.
  - `INV-SAFE-03` C1: Initial InvestigationContext and dynamic Runtime Evidence use the same projection.
- **Catalog Proofs:** `safe-redact-inspect`, `safe-same-path`
- **Machine Gaps:** `INV-SAFE-01:A`

### evidence.dynamic-enrichment

- **Risk:** high (11)
- **Gate:** 1,3
- **Paths:** `apps/agent/src/investigation-evidence.ts`, `apps/pi-runtime/src/coordinator.ts`, `apps/pi-runtime/src/evidence-client.ts`
- **Invariants:**
  - `INV-DYN-01` C1 B1: missingEvidence is collected at most once per investigation within typed allowlist bounds.
  - `INV-DYN-02` C1 A1: Specialist rerun consumes collected Evidence.data; different data changes the finding.
  - `INV-DYN-03` C1: Model-supplied docker targets and URLs are rejected; only trusted metadata is used.
- **Catalog Proofs:** `dyn-rerun-data`, `dyn-rerun-data-e2e`, `dyn-once`, `dyn-reject-url`, `dyn-evidence-audit`
- **Machine Gaps:** none

### investigation.reconciliation

- **Risk:** critical (12)
- **Gate:** 1-3
- **Paths:** `apps/agent/src/investigation-reconciler.ts`, `apps/agent/src/investigation-loop.ts`, `apps/agent/src/evidence-worker.ts`, `apps/agent/src/store.ts`, `apps/agent/src/reasoning-worker.ts`, `apps/agent/src/index.ts`
- **Invariants:**
  - `INV-GEN-01` C1 A1: Dynamic Investigation Evidence belongs to the current EvidenceJob generation and must not trigger another automatic Investigation.
  - `INV-GEN-02` A1: Only deterministic Evidence requeue advances EvidenceJob.generation and permits one new automatic Investigation generation.
  - `INV-STALE-01` C2 A1: SUBMITTED and RUNNING InvestigationSessions become FAILED after the stale timeout and retry remains bounded by maxAttempts.
  - `INV-CRASH-01` A1: Completed deterministic Evidence with no successful Investigation is reconciled after restart without duplicating an already completed generation.
  - `INV-AUTH-01` C1 A1: External-runtime mode has one authoritative reasoning result path and does not create a parallel legacy local reasoning result.
- **Catalog Proofs:** `recon-dynamic-evidence-unit`, `recon-generation-requeue`, `recon-stale-submitted`, `recon-stale-running`, `recon-crash-reopen`, `recon-authoritative-result-unit`, `phase12-local-smoke`, `recon-idempotent`, `recon-max-attempts`
- **Machine Gaps:** `INV-STALE-01:A`

### investigation.lifecycle

- **Risk:** high (11)
- **Gate:** 1
- **Paths:** `apps/agent/src/investigation-loop.ts`, `apps/agent/src/investigation-session.ts`
- **Invariants:**
  - `INV-SES-01` C1: An InvestigationSession walks CREATED → SUBMITTED → RUNNING → COMPLETED or FAILED without mutating Incident facts.
  - `INV-SES-02` C1: A report may only cite Evidence ids belonging to the Incident.
  - `INV-SES-03` C1: Open sessions for the same EvidenceJob generation are reused.
- **Catalog Proofs:** `ses-lifecycle`, `ses-foreign-evidence`, `ses-reuse-open`
- **Machine Gaps:** none

### investigation.callback

- **Risk:** high (11)
- **Gate:** 1
- **Paths:** `apps/agent/src/investigation-loop.ts`, `apps/agent/src/app.ts`, `apps/pi-runtime/src/callback.ts`
- **Invariants:**
  - `INV-CB-01` C1 B1: Callbacks authenticate with the runtime token and must match session runtimeRequestId/runtimeTaskId.
  - `INV-CB-02` C1: Duplicate valid callbacks return the existing report without a second ReasoningResult.
  - `INV-CB-03` C1: Invalid callbacks do not write InvestigationReport or mutate Evidence.
- **Catalog Proofs:** `cb-duplicate`, `cb-invalid`, `cb-auth-runtime`, `cb-provenance`
- **Machine Gaps:** none

### runtime.boundary

- **Risk:** critical (13)
- **Gate:** 0-2
- **Paths:** `apps/pi-runtime/src/**`, `apps/agent/src/http-pi-runtime-client.ts`
- **Invariants:**
  - `INV-RTB-01` C1: Pi Runtime has no shell, Docker socket, or Node Agent dependency.
  - `INV-RTB-02` A1: Duplicate runtimeRequestId returns the same runtimeTaskId without rerunning the model.
  - `INV-RTB-03` C1: Runtime refuses arbitrary callback destinations.
- **Catalog Proofs:** `rtb-no-shell`, `rtb-dup-submit`, `rtb-callback-dest`
- **Machine Gaps:** none

### runtime.coordinator

- **Risk:** high (11)
- **Gate:** 1,3
- **Paths:** `apps/pi-runtime/src/coordinator.ts`, `apps/pi-runtime/src/specialists.ts`, `apps/pi-runtime/src/bound-context.ts`, `apps/pi-runtime/src/deadline.ts`
- **Invariants:**
  - `INV-RTC-01` C1: Historical knowledge cannot override current Evidence.
  - `INV-RTC-02` C1 A1: Context overflow fails closed with context_too_large.
  - `INV-RTC-03` C1: Execution timeout wins over a late model result.
  - `INV-RTC-04` C1: FakeRuntimeModel performs zero external model calls and changes findings when Evidence.data changes.
- **Catalog Proofs:** `rtc-history`, `rtc-budget`, `rtc-budget-smoke`, `rtc-timeout`, `rtc-fake-zero-calls`
- **Machine Gaps:** none

### runtime.callback-delivery

- **Risk:** high (11)
- **Gate:** 2
- **Paths:** `apps/pi-runtime/src/callback.ts`, `apps/pi-runtime/src/store.ts`, `apps/pi-runtime/src/app.ts`
- **Invariants:**
  - `INV-DEL-01` A1: Failed callbacks retry until delivery succeeds without rerunning the model.
  - `INV-DEL-02` A1: Pending delivery resumes after Runtime process restart without rerunning the model.
- **Catalog Proofs:** `del-retry-callback`, `del-restart`
- **Machine Gaps:** none

### auth.boundary

- **Risk:** critical (14)
- **Gate:** 1
- **Paths:** `apps/agent/src/app.ts`, `apps/agent/src/config.ts`
- **Invariants:**
  - `INV-TOK-01` A1: Ingest token cannot access /v1/ops/* or runtime callback routes.
  - `INV-TOK-02` A1: Operator token cannot POST /v1/events or runtime callback routes.
  - `INV-TOK-03` A1: Runtime token cannot access /v1/ops/* or /v1/events.
  - `INV-TOK-04` C1: Ingest, operator, and runtime tokens must be distinct at startup.
- **Catalog Proofs:** `tok-ingest-ops`, `tok-operator`, `tok-runtime`, `tok-distinct`
- **Machine Gaps:** none

### notification.lifecycle

- **Risk:** high (10)
- **Gate:** 1,3
- **Paths:** `apps/agent/src/notification.ts`, `apps/agent/src/notification-worker.ts`, `apps/agent/src/notifier.ts`
- **Invariants:**
  - `INV-NOT-01` C1 A1: OPEN, INVESTIGATION_COMPLETED, and INCIDENT_RECOVERED are each scheduled exactly once per identity.
  - `INV-NOT-02` C1 B1: Delivery uses notificationId as Idempotency-Key and does not mutate Incident facts.
  - `INV-NOT-03` C1: RUNNING notification jobs reset on start; DELIVERED jobs are not duplicated.
- **Catalog Proofs:** `not-three-types`, `not-three-types-smoke`, `not-facts`, `not-reset-running`
- **Machine Gaps:** none

### node.observation

- **Risk:** high (10)
- **Gate:** 1
- **Paths:** `apps/node-agent/src/detectors/**`, `apps/node-agent/src/events/**`, `apps/node-agent/src/app.ts`
- **Invariants:**
  - `INV-NOD-01` C1: Health and resource detectors emit one failure then one recovery without flooding.
  - `INV-NOD-02` A1: Evidence queries without a valid node token are rejected.
  - `INV-NOD-03` C1: Event enqueue is non-blocking and drops when the outbound queue is full.
- **Catalog Proofs:** `nod-hysteresis`, `nod-auth`, `nod-queue`
- **Machine Gaps:** none

### node.http-probe

- **Risk:** high (12)
- **Gate:** 1
- **Paths:** `apps/node-agent/src/evidence/probe.ts`, `apps/agent/src/evidence-orchestrator.ts`
- **Invariants:**
  - `INV-PRB-01` A1: Node Agent target unavailability yields succeeded http.probe Evidence with healthy=false.
  - `INV-PRB-02` C1: http.probe only accepts configured http(s) GET/HEAD targets and bounded timeouts.
- **Catalog Proofs:** `prb-target-down`, `prb-url-policy`
- **Machine Gaps:** none

### node.docker-evidence

- **Risk:** high (10)
- **Gate:** 1
- **Paths:** `apps/node-agent/src/evidence/docker.ts`, `apps/node-agent/src/evidence/types.ts`
- **Invariants:**
  - `INV-DOC-01` C1: Docker evidence is allowlisted by container name; empty allowlist fails closed.
  - `INV-DOC-02` C1: docker.inspect omits Env and mount secrets; log windows are bounded.
- **Catalog Proofs:** `doc-allowlist`, `doc-no-env`
- **Machine Gaps:** none

### memory.retrieval

- **Risk:** medium (7)
- **Gate:** 1
- **Paths:** `apps/agent/src/memory-retriever.ts`, `apps/agent/src/investigation-knowledge.ts`
- **Invariants:**
  - `INV-MEM-01` C1: Only ACTIVE approved memory is retrieved; DISABLED and rejected candidates are not.
  - `INV-MEM-02` C1: Historical knowledge is advisory and does not replace current Evidence.
  - `INV-MEM-03` C1: Retrieval failure does not block investigation.
- **Catalog Proofs:** `mem-active-only`, `mem-advisory`, `mem-no-block`
- **Machine Gaps:** none

### memory.governance

- **Risk:** medium (7)
- **Gate:** 1
- **Paths:** `apps/agent/src/memory-quality.ts`, `apps/agent/src/memory-governance.ts`
- **Invariants:**
  - `INV-GOV-01` C1: MemoryCandidate requires quality evaluation; approve/reject does not mutate Incident or Evidence.
  - `INV-GOV-02` C1: MemoryEntry preserves provenance and is not rewritten by feedback ranking.
- **Catalog Proofs:** `gov-eval`, `gov-no-mutate`
- **Machine Gaps:** none

### reasoning.local

- **Risk:** medium (6)
- **Gate:** 1
- **Paths:** `apps/agent/src/reasoner.ts`, `apps/agent/src/reasoning-worker.ts`, `apps/agent/src/pi-reasoner.ts`
- **Invariants:**
  - `INV-LOC-01` C1: Local ReasoningWorker does not execute when externalRuntimeEnabled is true.
  - `INV-LOC-02` A1: One ReasoningResult per ReasoningJob; Incident and Evidence are not mutated while reasoning.
- **Catalog Proofs:** `loc-worker-skip`, `loc-one-result`
- **Machine Gaps:** none

### protocol.contract

- **Risk:** high (9)
- **Gate:** 1
- **Impacts:** event.ingress, evidence.collection, investigation.callback, evidence.dynamic-enrichment, runtime.boundary, node.observation
- **Paths:** `packages/protocol/src/**`
- **Invariants:**
  - `INV-PRO-01` C1: OpsEvent and Evidence schemas reject missing required fields and invalid times.
  - `INV-PRO-02` C1: Runtime investigation payloads require requestingRoles and typed evidence requests.
- **Catalog Proofs:** `pro-event-schema`, `pro-roles`
- **Machine Gaps:** none

### configuration.fail-closed

- **Risk:** high (10)
- **Gate:** 1
- **Impacts:** auth.boundary, runtime.boundary, investigation.reconciliation
- **Paths:** `apps/agent/src/config.ts`, `apps/node-agent/src/config.ts`, `apps/pi-runtime/src/config.ts`
- **Invariants:**
  - `INV-CFG-01` C1: Partial Pi Runtime URL/token/callback configuration fails startup.
  - `INV-CFG-02` C1: Malformed node-agent JSON, duplicate node ids, and out-of-range integers fail closed.
- **Catalog Proofs:** `cfg-partial-runtime`, `cfg-integers`
- **Machine Gaps:** none

### persistence.migration

- **Risk:** high (10)
- **Gate:** 2
- **Paths:** `apps/agent/src/store.ts`, `apps/agent/src/store-attempt-migration.ts`
- **Invariants:**
  - `INV-MIG-01` A1: Opening a store fails closed on duplicate reasoning_results.reasoning_job_id.
  - `INV-MIG-02` A1: Events and Evidence survive SQLite close and reopen.
- **Catalog Proofs:** `mig-dup-result`, `mig-reopen-event`
- **Machine Gaps:** none

### local.integration

- **Risk:** high (11)
- **Gate:** 3-4
- **Paths:** `deploy/local/**`, `apps/agent/src/index.ts`, `apps/pi-runtime/src/index.ts`, `apps/node-agent/src/index.ts`, `deploy/docker/**`
- **Invariants:**
  - `INV-LOCINT-01` A1: Deterministic local smoke proves Node Agent → Incident → Evidence → Runtime → notification → recovery → restart without DataAsset.
  - `INV-LOCINT-02` A1: Smoke selects only service=pi-ops-drill nodeId=local-dev type=health.failure after a clean SQLite directory.
  - `INV-LOCINT-03` C1: Real Pi provider smoke is fail-closed and never falls back to FakeRuntimeModel.
- **Catalog Proofs:** `locint-smoke-chain`, `locint-smoke-pi-script`
- **Machine Gaps:** none

### build.configuration

- **Risk:** high (9)
- **Gate:** 1
- **Paths:** root package/lock/workspace/tsconfig files plus `apps/*/package.json` and `packages/*/package.json`
- **Invariants:**
  - `INV-BUILD-01` A1: The committed pnpm lockfile contains an importer for the repository root and every workspace package.
  - `INV-BUILD-02` A1: Every workspace package declares typecheck and test scripts and keeps a tsconfig.json; tsconfig.base.json exists at the repository root.
  - `INV-BUILD-03` A1: The root manifest, Docker image, and CI workflow declare one consistent Node 22 and pnpm 10.15.0 toolchain.
- **Catalog Proofs:** `build-lockfile-covers-workspace`, `build-workspace-typecheck-contract`, `build-toolchain-consistency`
- **Limit:** Configuration evidence only; these proofs do not claim application behavior.
- **Machine Gaps:** none

---

## Detailed Test Cases for open machine gaps

Only the three machine-detected A-level gaps get full TC records now. Everything else has catalog evidence; the catalog entry IDs above are the proof pointers.

### TC-INV-EVD-002

- **Feature:** evidence.collection · **Invariant:** INV-EVD-02 (A1 missing)
- **Purpose:** Pi-Ops must not convert Node Agent transport failure into target-health facts, proven across a real process/network boundary.
- **Preconditions:** Compose stack up (`pi-ops`, `pi-ops-node-agent`, `pi-ops-drill`); Node Agent reachable; drill failing.
- **Trigger:** After Incident OPEN and EvidenceJob running, stop/kill the `pi-ops-node-agent` container mid-collection.
- **Steps:**
  1. `POST /fail` on drill; wait for Incident + EvidenceJob RUNNING.
  2. `docker stop pi-ops-local-pi-ops-node-agent-1`.
  3. Let evidence collection time out and retry at least once.
  4. Restart Node Agent; let collection complete.
- **Expected:** `http.probe` Evidence stays `failed`/`failureClass=retryable` while Node Agent is down; after restart the job completes with Node Agent-produced Evidence.
- **Negative:** No `http.probe` Evidence with `status=succeeded healthy=false` synthesized by Pi-Ops during the outage.
- **Durable Evidence:** SQLite `evidence.failure_class='retryable'` rows; evidence job attempts.
- **Mocked layer:** none (real containers, real TCP).
- **Does not prove:** Node Agent target-vs-transport distinction (covered by C tests).
- **Action:** CREATE (MULTI_PROCESS, cost 6) — priority P1.
- **Existing insufficient evidence:** stub-fetch hang/ECONNREFUSED tests (`evd-hang-retryable`, `evd-transport-retryable`) prove the mapping only against a stub `fetchImpl`.

### TC-INV-STALE-001

- **Feature:** investigation.reconciliation · **Invariant:** INV-STALE-01 (A1 missing)
- **Purpose:** A Runtime that ACKs `/v1/investigations` and then dies before callback must not leave the Incident investigated-never; stale timeout must terminalize and bounded retry must recover when Runtime returns.
- **Preconditions:** Compose stack with `pi-runtime`; `PI_OPS_INVESTIGATION_STALE_TIMEOUT_MS` shortened for the drill; Node Agent + drill healthy.
- **Trigger:** Submit investigation; kill the `pi-runtime` container immediately after ACK (Session = SUBMITTED).
- **Steps:**
  1. Drive one drill failure; wait for Session SUBMITTED.
  2. `docker stop pi-ops-local-pi-runtime-1` (ACK already received).
  3. Advance past stale timeout; observe reconcile cycle.
  4. Restart `pi-runtime`.
  5. Observe a new bounded attempt reach COMPLETED.
- **Expected:** Session 1 = FAILED (`runtime timeout`); Session 2 = COMPLETED after Runtime returns; retry count respects maxAttempts.
- **Negative:** No Session stuck SUBMITTED forever; no unbounded retry loop after exhaustion.
- **Durable Evidence:** SQLite `investigation_sessions` FAILED then a second COMPLETED row with same `evidence_generation`.
- **Mocked layer:** none (real process kill).
- **Does not prove:** fake-clock determinism (already covered by C tests `recon-stale-submitted`/`recon-stale-running`).
- **Action:** CREATE (MULTI_PROCESS, cost 6) — priority P1.
- **Existing insufficient evidence:** fake-clock tests prove the state machine, not a real ACK-then-crash.

### TC-INV-SAFE-001

- **Feature:** evidence.model-safe-projection · **Invariant:** INV-SAFE-01 (A1 missing)
- **Purpose:** The canonical chain must prove across real processes that raw Evidence stays canonical in SQLite while the model-facing view is the projected one.
- **Preconditions:** Compose stack; a secret-shaped value planted in collected Evidence (today the drill chain plants none — see honesty note).
- **Trigger:** Complete one investigation where collected `docker.logs`/`docker.inspect` Evidence contains a field like `token=super-secret`.
- **Steps:**
  1. Plant the secret in the drill's log output (test fixture change, not production).
  2. Run the golden chain; query `/v1/ops/incidents/:id/evidence?view=raw` and `?view=safe`.
- **Expected:** raw view contains the secret (canonical preserved); safe view redacts/bounds it.
- **Negative:** safe view never contains the secret; raw view never redacted.
- **Durable Evidence:** SQLite raw rows; operator HTTP responses.
- **Mocked layer:** none.
- **Does not prove:** arbitrary secret-value DLP — the projection is field-name policy (`SECRET_KEY`/`ENV_KEY`), and that is the only claim.
- **Action:** STRENGTHEN `deploy/local/smoke.sh` + drill fixture (cost ~1) — priority P1.
- **Honesty note:** the existing smoke assertion `assert "super-secret" not in blob` is currently **vacuous**: nothing in the drill chain plants that value, so it must not be counted as INV-SAFE-01 A evidence. This document previously overstated that; corrected here.

---

## Known overstatement corrected

`docs/testing/test-case-matrix.md` (previous revision) claimed the smoke safe-view check was A-level proof for model-safe redaction. The drill chain plants no secret, so the assertion is vacuous. The claim is retracted; INV-SAFE-01 A1 is now an honest machine gap.

## Existing test files

Agent `__tests__/*` (37 files), node-agent (5), pi-runtime (4), protocol (2), `deploy/local/smoke.sh`, `deploy/local/smoke-pi.sh`. Catalog entries point at named `it()` cases or smoke commands; ghost names fail `validate`. Unlisted `it()` cases stay ACTIVE in the suite — not retired.

POSSIBLE_DOMINATED (do not retire now): overlapping protocol schema rejects; FakeReasoner identity tests duplicated between `reasoner.test.ts` and `reasoning-worker.test.ts`.
