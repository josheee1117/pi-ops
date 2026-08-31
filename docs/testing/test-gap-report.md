# Test evidence gaps

Only unresolved Evidence floors or high-risk proofs that existing tests do **not** provide. No fabricated coverage.

---

## P0

None. Every governed Invariant currently has at least the required A/B/C counts in the catalog from **real existing tests or smoke**.

---

## P1

### GAP-P1-PROBE-MP

- **Feature:** evidence.collection / node.http-probe
- **Invariant:** INV-EVD-02
- **Required:** C1 (met)
- **Existing:** stub `fetch` hang / ECONNREFUSED in `evidence-orchestrator.test.ts` (C)
- **Why insufficient for transport ownership in production topology:** does not prove Compose DNS/TCP failure between `pi-ops` and `pi-ops-node-agent`.
- **Action:** CREATE
- **Suggested:** MULTI_PROCESS: stop Node Agent after Incident OPEN, assert Evidence remains retryable failed, `healthy` not synthesized, then restart Node Agent and complete.
- **Cost:** 6 · **Priority:** P1

### GAP-P1-STALE-MP

- **Feature:** investigation.reconciliation
- **Invariant:** INV-STALE-01
- **Required:** C2 (met)
- **Existing:** fake-clock SUBMITTED/RUNNING tests
- **Why insufficient:** does not prove Pi Runtime HTTP ACK then process kill before callback.
- **Action:** CREATE (or STRENGTHEN smoke with a fault injection hook — do not change production to make this easy)
- **Suggested:** MULTI_PROCESS A: Runtime accepts `/v1/investigations`, then container kill; wait stale timeout; Session FAILED; bounded retry when Runtime returns.
- **Cost:** 6 · **Priority:** P1
- **Does not exist today.** Floor C2 is already satisfied; this is extra A for a historical production-shaped failure.

### GAP-P1-SAFE-SMOKE-FIELDS

- **Feature:** evidence.model-safe-projection
- **Invariant:** INV-SAFE-02
- **Required:** C1 (met)
- **Existing:** unit redaction; smoke only asserts fixture string `super-secret` absent
- **Why insufficient as A:** smoke does not plant Env/Authorization/password keys in collected docker.inspect and assert the safe view.
- **Action:** STRENGTHEN `smoke.sh` safe-view assertions **or** keep C-only (floor already met)
- **Cost:** 0.5–4 · **Priority:** P1 if claiming production secret boundary in smoke; else P2

---

## P2

### GAP-P2-CB-MP

- **Feature:** investigation.callback
- **Invariant:** INV-CB-01
- **Required:** C1 (met via auth-matrix)
- **Existing:** in-process Hono
- **Why insufficient:** not a separate Runtime container presenting a wrong token over the network.
- **Action:** STRENGTHEN smoke with one 401 check using ingest token on `/v1/investigation-results` (already implied by auth-matrix; optional smoke duplicate)
- **Cost:** 0.5 · **Priority:** P2

### GAP-P2-NOT-RETRY-A

- **Feature:** notification.lifecycle
- **Invariant:** INV-NOT-03
- **Required:** C1 (met)
- **Existing:** FakeNotifier / worker reset
- **Why insufficient:** no A-level webhook 500×N then success across process restart.
- **Action:** CREATE COMPONENT with real HTTP sink (local smoke sink already exists — STRENGTHEN smoke)
- **Cost:** 2 · **Priority:** P2

### GAP-P2-DOCKER-SOCK-A

- **Feature:** node.docker-evidence
- **Invariant:** INV-DOC-02
- **Required:** C1 (met, mocked Docker JSON)
- **Why insufficient:** mocked inspect, not live `docker.sock` Env omission.
- **Action:** CREATE optional integration against drill container inspect
- **Cost:** 4 · **Priority:** P2

### GAP-P2-LIVE-PROVIDER-CATALOG

- **Feature:** local.integration
- **Invariant:** INV-LOCINT-03
- **Required:** C1 (met: smoke-pi.sh fail-closed)
- **Existing:** script + unit-level catalog, not a passing live run in CI
- **Action:** REUSE script; do not add LIVE_PROVIDER to Gate 1
- **Cost:** 0 · **Priority:** P2 (documentation honesty)

---

## P3

### GAP-P3-PROTOCOL-RUNTIME-RESULT

- **Feature:** protocol.contract
- **Invariant:** INV-PRO-02
- **Existing:** requestingRoles tests
- **Why weak:** fewer explicit invalid InvestigationRuntimeResult fixtures (unknown status, missing runtimeTaskId).
- **Action:** STRENGTHEN `packages/protocol/src/__tests__/investigation-runtime.test.ts`
- **Cost:** 1 · **Priority:** P3

### GAP-P3-DOMINATED-SCHEMA

Overlapping protocol accept/reject `it()` cases. **POSSIBLE_DOMINATED** later. Do not delete.

---

## Why not more CREATE

Floors for critical Features are already met by PINNED Phase 11/12 tests plus `smoke:local`. Creating every multi-process combination would inflate Gate 3 without new Invariants. Next implementation phase should take P1 items in REUSE/STRENGTHEN order.
