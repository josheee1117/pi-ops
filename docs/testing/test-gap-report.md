# Test evidence gaps

Machine state and this report must agree. Regenerate source of truth:

```bash
node tools/test-governance/src/cli.mjs gaps
```

Current machine output:

```text
MACHINE EVIDENCE GAPS: 3
- evidence.collection INV-EVD-02:A missing=1
- evidence.model-safe-projection INV-SAFE-01:A missing=1
- investigation.reconciliation INV-STALE-01:A missing=1
```

These three are **required floor slots with no existing proof** - not recommendations. `test:plan` reports `NEEDS_EVIDENCE` for the owning (and impact-propagated) features until they are closed.

---

## P1 (machine-detected, floor-missing)

### GAP-P1-PROBE-MP

- **Feature:** evidence.collection
- **Invariant:** INV-EVD-02 - required A1 C1; **A1 missing (MACHINE GAP)**
- **Existing evidence:** C only - `evd-transport-retryable`, `evd-hang-retryable` (stub `fetch` ECONNREFUSED / hanging promise).
- **Why insufficient:** transport ownership is a distributed boundary; stubs cannot prove Compose DNS/TCP failure between `pi-ops` and `pi-ops-node-agent`, nor that no code path synthesizes target health under a real outage.
- **Recommended action:** CREATE
- **Suggested test case:** TC-INV-EVD-002 (stop Node Agent container mid-collection; retryable failed Evidence; no synthesized `healthy=false`; recovery after restart).
- **Maintenance cost:** 6 · **Priority:** P1

### GAP-P1-STALE-MP

- **Feature:** investigation.reconciliation
- **Invariant:** INV-STALE-01 - required A1 C2; **A1 missing (MACHINE GAP)**
- **Existing evidence:** C2 - `recon-stale-submitted`, `recon-stale-running` (fake clock).
- **Why insufficient:** no real "Runtime ACKs then process dies before callback" flow; a stuck-SUBMITTED Incident in production would not be caught by fake-clock tests alone.
- **Recommended action:** CREATE
- **Suggested test case:** TC-INV-STALE-001 (kill pi-runtime after ACK; stale timeout -> FAILED; bounded retry -> second session COMPLETED after restart).
- **Maintenance cost:** 6 · **Priority:** P1

### GAP-P1-SAFE-MP

- **Feature:** evidence.model-safe-projection
- **Invariant:** INV-SAFE-01 - required A1 C1; **A1 missing (MACHINE GAP)**
- **Existing evidence:** C only - `safe-redact-inspect`, `safe-same-path` (in-process projection tests).
- **Why insufficient:** the previous claim that smoke's `super-secret` assertion was A-level proof was **vacuous** - nothing in the drill chain plants that value. No cross-process proof exists that raw canonical Evidence stays unsanitized while the operator/model-facing view is projected.
- **Recommended action:** STRENGTHEN `deploy/local/smoke.sh` + drill fixture (plant a secret-shaped log line, assert raw preserves / safe redacts)
- **Suggested test case:** TC-INV-SAFE-001.
- **Maintenance cost:** 1 · **Priority:** P1
- **Scope note:** the claim is field-name redaction (`SECRET_KEY`/`ENV_KEY`) and log bounding - not arbitrary secret-value DLP, which the implementation does not provide.

---

## P2 (floor met; A-level depth recommended)

### GAP-P2-CB-MP

- **Feature:** investigation.callback · INV-CB-01 (B1 C1 met)
- **Existing:** in-process Hono tests + provenance test.
- **Why insufficient for production shape:** no separate Runtime container presenting a wrong token over the network.
- **Action:** optional STRENGTHEN of smoke with one 401 check on `/v1/investigation-results`.
- **Cost:** 0.5 · **Priority:** P2

### GAP-P2-NOT-RETRY-A

- **Feature:** notification.lifecycle · INV-NOT-03 (C1 met; B1 met via smoke sink idempotency keys)
- **Why insufficient:** no A-level webhook 500×N then success across Pi-Ops process restart.
- **Action:** optional CREATE COMPONENT against the existing local sink.
- **Cost:** 2 · **Priority:** P2

### GAP-P2-DOCKER-SOCK-A

- **Feature:** node.docker-evidence · INV-DOC-02 (C1 met)
- **Why insufficient:** mocked Docker JSON; no live `docker.sock` proof that inspect Env omission survives a real Docker response.
- **Action:** optional CREATE integration against the drill container.
- **Cost:** 4 · **Priority:** P2

### GAP-P2-LIVE-PROVIDER-CATALOG

- **Feature:** local.integration · INV-LOCINT-03 (C1 met via smoke-pi fail-closed script)
- **Why insufficient:** no passing live-provider run is part of ordinary governance - by design.
- **Action:** REUSE script; LIVE_PROVIDER stays Gate 4, never ordinary CI.
- **Cost:** 0 · **Priority:** P2 (documentation honesty)

---

## P3 (diagnostic quality)

### GAP-P3-PROTOCOL-RUNTIME-RESULT

- **Feature:** protocol.contract · INV-PRO-02 (C1 met)
- **Weakness:** fewer explicit invalid `InvestigationRuntimeResult` fixtures (unknown status, missing runtimeTaskId).
- **Action:** STRENGTHEN `packages/protocol/src/__tests__/investigation-runtime.test.ts`.
- **Cost:** 1 · **Priority:** P3

### GAP-P3-DOMINATED-SCHEMA

Overlapping protocol accept/reject `it()` cases. **POSSIBLE_DOMINATED** - retirement is a later reviewed phase; nothing is deleted now.

---

## Why not more CREATE

Floors are met everywhere except the three machine gaps above. Creating additional multi-process combinations without a missing floor would inflate Gate 3 without proving new invariants. Next implementation phase should close P1 in REUSE/STRENGTHEN order: TC-INV-SAFE-001 (STRENGTHEN, cost ~1) first, then the two MULTI_PROCESS CREATEs.
