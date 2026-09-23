# Test evidence gaps

Machine state and this report must agree. Regenerate source of truth:

```bash
node tools/test-governance/src/cli.mjs gaps
```

Current machine output:

```text
MACHINE EVIDENCE GAPS: 1
- evidence.collection INV-EVD-02:A missing=1
```

This one is a **required floor slot with no existing proof** - not a recommendation. `test:plan` reports `NEEDS_EVIDENCE` for the owning (and impact-propagated) features until it is closed.

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

---

## Closed P1 gaps

### GAP-P1-SAFE-MP (closed)

- **Feature:** evidence.model-safe-projection · INV-SAFE-01
- **Closed by:** catalog entry `safe-redact-inspect-sqlite`, level A for INV-SAFE-01, source "SQLite row keeps secrets; Runtime payload is toRuntimeSafeEvidence".
- **Scope note:** the claim is field-name redaction (`SECRET_KEY`/`ENV_KEY`) and log bounding - not arbitrary secret-value DLP, which the implementation does not provide.

### GAP-P1-STALE-MP (closed)

- **Feature:** investigation.reconciliation · INV-STALE-01
- **Closed by:** `deploy/local/smoke-runtime-crash.sh`, registered as catalog entry `recon-stale-runtime-crash`, level A for INV-STALE-01. Real four-process compose: the Runtime ACKs the submit but cannot deliver its result, so the session genuinely sits in SUBMITTED; `pi-runtime` is then killed for real. The session goes FAILED after a real 15s clock (16.0s measured) with `last_error=runtime timeout`, the retry produces a second attempt, and `maxAttempts=2` holds.
- **Deviation from the suggested case:** TC-INV-STALE-001 assumed a session could be caught in SUBMITTED by polling. Measured, the ACK-to-callback window is about 20ms, so polling cannot observe it. The smoke instead makes delivery impossible, which holds the session in SUBMITTED for a real, observable window. The second attempt is not asserted COMPLETED, because with the Runtime dead its submit fails; the invariant bounds the attempt count, not the retry outcome.

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

Floors are met everywhere except the one machine gap above. Creating additional multi-process combinations without a missing floor would inflate Gate 3 without proving new invariants. The remaining P1 is the `INV-EVD-02` MULTI_PROCESS CREATE.
