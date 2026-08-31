# Pi-Ops test-case matrix

Complete Feature → Invariant → Evidence map for the current repository. Catalog IDs live in `tools/test-governance/config/catalog.json`. Gaps are detailed in `test-gap-report.md`.

Action values: `REUSE` · `STRENGTHEN` · `CREATE`. No RETIRE.

---

## Feature inventory (24)

| ID | Risk | Score | Gate |
|----|------|------:|------|
| event.ingress | high | 11 | 1–2 |
| incident.lifecycle | high | 10 | 1–2 |
| evidence.collection | high | 11 | 1 |
| evidence.job-lifecycle | high | 10 | 1–2 |
| evidence.model-safe-projection | critical | 13 | 1 |
| evidence.dynamic-enrichment | high | 11 | 1,3 |
| investigation.reconciliation | critical | 12 | 1–3 |
| investigation.lifecycle | high | 11 | 1 |
| investigation.callback | high | 11 | 1 |
| runtime.boundary | critical | 13 | 0–2 |
| runtime.coordinator | high | 11 | 1,3 |
| runtime.callback-delivery | high | 11 | 2 |
| auth.boundary | critical | 14 | 1 |
| notification.lifecycle | high | 10 | 1,3 |
| node.observation | high | 10 | 1 |
| node.http-probe | high | 12 | 1 |
| node.docker-evidence | high | 10 | 1 |
| memory.retrieval | medium | 7 | 1 |
| memory.governance | medium | 7 | 1 |
| reasoning.local | medium | 6 | 1 |
| protocol.contract | high | 9 | 1 |
| configuration.fail-closed | high | 10 | 1 |
| persistence.migration | high | 10 | 2 |
| local.integration | high | 11 | 3–4 |

---

## investigation.reconciliation

**Sources:** `investigation-reconciler.ts`, `investigation-loop.ts`, `store.ts`, `index.ts`  
**ADRs:** ADR-0025, ADR-0018, ADR-0019

| Invariant | Floor | Existing | Action |
|-----------|-------|----------|--------|
| INV-GEN-01 dynamic Evidence ≠ new generation | A1 C1 | recon-dynamic-evidence-unit (C, PINNED), phase12-local-smoke (A, PINNED) | REUSE |
| INV-GEN-02 requeue advances generation | A1 | recon-generation-requeue (A, PINNED) | REUSE |
| INV-STALE-01 SUBMITTED/RUNNING timeout + bound | C2 | recon-stale-submitted, recon-stale-running (C, PINNED) | REUSE; CREATE multi-process A later |
| INV-CRASH-01 restart repair, no dup COMPLETED | A1 | recon-crash-reopen (A, PINNED) | REUSE |
| INV-AUTH-01 one reasoning path | A1 C1 | recon-authoritative-result-unit (C), smoke (A) | REUSE |

### TC-INV-GEN-001 (REUSE)

- **Invariant:** INV-GEN-01
- **Purpose:** Dynamic Investigation Evidence must not create another automatic Investigation.
- **Preconditions:** Incident exists; EvidenceJob generation=1 COMPLETED; external Runtime mode.
- **Trigger:** Reconciler Session 1; persist `inv-${sessionId}-evidence-host.memory`; complete Session 1.
- **Steps:** reconcile → persist dynamic Evidence → complete → reconcile repeatedly → reopen store → reconcile.
- **Expected:** generation remains 1; exactly one automatic InvestigationSession; one ReasoningResult; one INVESTIGATION_COMPLETED.
- **Negative:** no generation=2; no second automatic Session.
- **Evidence:** A SQLite (smoke); C fake Runtime (unit).
- **Does not prove:** live LLM enrichment quality.
- **Existing:** `does not start a new investigation when dynamic Evidence is added to a COMPLETED generation`; `pnpm smoke:local` “exactly one completed investigation session”.

### TC-INV-STALE-001 (REUSE / STRENGTHEN)

- **Invariant:** INV-STALE-01
- **Purpose:** ACK then missing callback must not stay SUBMITTED forever.
- **Existing C:** fake clock tests for SUBMITTED and RUNNING.
- **Does not prove:** real Pi Runtime process death after HTTP ACK.
- **Action:** STRENGTHEN later with MULTI_PROCESS A (GAP-P1-STALE).

---

## auth.boundary

**Sources:** `apps/agent/src/app.ts`, `config.ts` · **ADR-0025 / Phase 12A**

| Invariant | Floor | Existing | Action |
|-----------|-------|----------|--------|
| INV-TOK-01 ingest ↛ ops | A1 | auth-matrix ingest test | REUSE PINNED |
| INV-TOK-02 operator ↛ events | A1 | auth-matrix operator test | REUSE PINNED |
| INV-TOK-03 runtime ↛ ops/events | A1 | auth-matrix runtime test | REUSE PINNED |
| INV-TOK-04 tokens distinct | C1 | config rejects identical ingest/operator | REUSE PINNED |

In-process Hono HTTP is treated as **A** (real status codes), not a live network stack. **Does not prove** reverse-proxy auth.

---

## evidence.collection / node.http-probe

**Sources:** `evidence-orchestrator.ts`, `probe.ts` · **ADR-0026**

| Invariant | Floor | Existing | Action |
|-----------|-------|----------|--------|
| INV-EVD-02 transport failure retryable, no synthesized health | C1 | hanging fetch + ECONNREFUSED tests PINNED | REUSE |
| INV-EVD-03 Node Agent unhealth → succeeded healthy=false | C1 | orchestrator Node Agent JSON test | REUSE |
| INV-PRB-01 Node Agent closed-port probe | A1 | `returns succeeded unhealth when the target is unreachable` | REUSE PINNED |
| INV-PRB-02 URL/method policy | C1 | evidence.test URL rejects | REUSE |

### TC-PRB-OWN-001 (REUSE)

- **Purpose:** Pi-Ops must not invent target health when Node Agent is unreachable.
- **Existing:** `keeps Node Agent unavailability as retryable failed Evidence`; `keeps a hanging Pi-Ops to Node Agent request as retryable`.
- **Evidence:** C stub fetch.
- **Does not prove:** Docker DNS failure between Compose services (CREATE MULTI_PROCESS — GAP-P1-PROBE-MP).

---

## evidence.model-safe-projection

**Sources:** `incident-context.ts`, `investigation-evidence.ts` · **ADR-0025 security closure**

| Invariant | Floor | Existing | Action |
|-----------|-------|----------|--------|
| INV-SAFE-01 raw SQLite unsanitized; Runtime sees projection | C1 | model-safe-evidence tests PINNED | REUSE |
| INV-SAFE-02 field-name redaction + log bound | C1 | same | REUSE |
| INV-SAFE-03 same path initial + dynamic | C1 | same | REUSE |

**Does not prove:** arbitrary secret-value DLP. Implementation is field-name policy.

Smoke asserts `super-secret` absent in safe view — A for that fixture only.

---

## evidence.dynamic-enrichment

**Sources:** coordinator, investigation-evidence · **ADR-0026**

| Invariant | Floor | Existing | Action |
|-----------|-------|----------|--------|
| INV-DYN-01 once per investigation | C1 | coordinator collect once | REUSE |
| INV-DYN-02 Evidence.data changes finding | C1 A1 | coordinator unit + smoke host.memory | REUSE |
| INV-DYN-03 no model-supplied URL | C1 | investigation-evidence-query | REUSE |

---

## event.ingress / incident.lifecycle

**Sources:** `app.ts` POST /v1/events, `incident.ts`, `store.ts`

Existing tests in `ingress.test.ts` cover persist, idempotency, conflict 409, oversized body, recovery-before-failure, replay/migration. Actions: REUSE. CREATE not required for floor.

---

## investigation.lifecycle / callback

Existing: `investigation-loop.test.ts`, `investigation-attempt.test.ts`, `pi-runtime-contract.test.ts`. Floors C-only: REUSE. Missing A for callback identity across processes — covered in part by smoke callback (GAP-P2-CB-MP).

---

## runtime.*

Existing: `coordinator.test.ts`, `runtime-http.test.ts`, `delivery-recovery.test.ts`. Duplicate submit and delivery restart are A (in-process HTTP + SQLite). Shell absence is C (API surface). Smoke proves context_too_large A.

---

## notification.lifecycle

Unit: `notification.test.ts`. Smoke: three types + idempotency keys. REUSE.

---

## node.*

`detectors.test.ts`, `events.test.ts`, `api.test.ts`, `evidence.test.ts`. Docker inspect secret omission is C (mocked Docker JSON). Real docker.sock path is smoke for allowlisted `pi-ops-drill` only.

---

## memory.* / reasoning.local / protocol / configuration / persistence

Covered by existing unit/integration tests listed in the catalog. Floors are C or A-reopen. REUSE.

---

## local.integration

**Sources:** `deploy/local/smoke.sh`, `smoke-pi.sh`

Golden chain (A): Node Agent → Event → Incident → deterministic Evidence → FakeRuntimeModel → dynamic host.memory → report → three notifications → recovery → Pi-Ops restart.

Smoke **does not** prove: live LLM, DataAsset, RAGFlow, JFR, remote hosts, Node Agent process crash mid-callback.

`smoke-pi.sh` fail-closed without credentials is catalogued as C/script (INV-LOCINT-03). Live run is Gate 4 only.

---

## Existing test files (inventory, not deleted)

Agent `__tests__/*` (37 files), node-agent 5, pi-runtime 4, protocol 2, `deploy/local/smoke.sh`, `smoke-pi.sh`. Catalog entries point at named `it()` cases or smoke commands. Unlisted `it()` cases remain ACTIVE in the suite; they are not RETIRED.

POSSIBLE_DOMINATED (do not retire now): overlapping protocol schema rejects; duplicate FakeReasoner identity tests in `reasoner.test.ts` vs `reasoning-worker.test.ts`.
