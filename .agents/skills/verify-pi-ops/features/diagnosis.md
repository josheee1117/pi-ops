# Investigation and diagnosis

The central agent submits an investigation for an Incident to pi-runtime over `POST /v1/investigations`. pi-runtime asks for deterministic and dynamic evidence through the center, reasons, and posts the report back to `/v1/investigation-results`. The center stores it as an investigation report attached to the session.

## Sub-features

- One session per Incident generation; `GET /v1/ops/incidents/:id` shows `sessions[].status` moving `SUBMITTED`/`RUNNING` to `COMPLETED` or `FAILED`.
- The report carries `hypothesis`, `confidence`, `recommendation`, `supportingEvidenceIds`, `contradictingEvidenceIds`, and, when the runtime sends one, a structured `diagnosis`: summary, observations, candidate causes, uncertainties, actions with preconditions/risk/`requiresApproval`. Reports written before 2026-10-20 have no `diagnosis`; read `hypothesis` and the evidence ids there.
- Evidence audits show what pi-runtime asked for while investigating (`evidenceAudits[]`: request id, evidence type, status, specialist roles).
- Deterministic evidence for this Incident is collected by the center: `http.probe`, `docker.inspect`, `docker.logs`, and host evidence when the runtime asks. The observed run also got a dynamic `host.memory` item.

## How to get to it (user POV)

After an Incident opens, an operator reads the session and report from the Incident detail, or asks for the human-readable brief:

```bash
curl -fsS -H 'Authorization: Bearer local-operator-token' http://127.0.0.1:18080/v1/ops/incidents/<id>
curl -fsS -H 'Authorization: Bearer local-operator-token' 'http://127.0.0.1:18080/v1/ops/incidents/<id>/brief?format=markdown'
```

## Driving it with drive.sh

- `drill.investigation` in the JSON output means the session finished. It prints `sessionId`, `reportId`, `status`, `hypothesis`, `confidence`, `recommendation` and the evidence kinds that were collected.
- The same facts are on disk after `drive.sh evidence`: `incident-detail.json` has the full report and audits, `evidence-safe.json` has the evidence as the model saw it.

Passing end state: one session in `COMPLETED` with a report whose `supportingEvidenceIds` all appear in the Incident's evidence list, plus at least one evidence audit when the model asked for dynamic evidence. Evidence kinds must match what the workflow should collect for a health failure: `http.probe`, `docker.inspect`, `docker.logs`.

## Real-model run (opt-in)

```bash
.agents/skills/verify-pi-ops/scripts/drive.sh drill real --cases W2,B3 --execute
```

This runs the real provider through `deploy/local/fault-drills.py` and prints, per case, `sessions[].hypothesis`, `confidence`, the diagnosis summary and action purposes, and how many evidence ids the report cited. The full report and every collected evidence item are in the copied `artifacts/settled-<incident>-detail.json`.

Both cases are small. In the 2026-10-04 (W2) and 2026-10-03 (B3) runs the session completed in 35s and 19s:

| Case | Injected fault (the expected root cause) | Evidence the runtime can reach |
| --- | --- | --- |
| W2 | heap exhausted by the drill's own retention until `OutOfMemoryError: Java heap space` | JFR signal, docker inspect, logs, stats, host memory |
| B3 | the drill JVM exits with status 17, container stays down | docker inspect, logs |

Judge the report against the injected fault, not against polished wording:

- **吻合**: the hypothesis names the injected fault (heap exhaustion / exit code 17) and cites evidence ids that actually exist in the Incident.
- **部分**: it names the right area but leans on an unverifiable claim, gets the actor wrong (for example blames the container memory limit for a JVM heap fault), or cites ids it did not use.
- **不吻合**: it asserts a different cause, or the cited ids do not support the sentence.

Write the reason in one line next to the verdict. `COMPLETED` is not a verdict: the driver only checks that the session finished.

What it proves: a real provider, given the real evidence of this fault, produced this report and cited these ids. What it does not prove: that the diagnosis is complete or stable, that the same fault is diagnosed the same way on another day, or that a human agrees. Two single runs are not a benchmark; the benchmark harness is the tool for a scored matrix.

## Gotchas

- The default stack runs the FAKE model (`createFakeRuntimeModel`). Its report is deterministic text such as `memory pressure observed` with Chinese diagnosis boilerplate. It proves the contract, citations and plumbing, not diagnostic quality. For model quality use `drill real` (owner authorization, pinned WeCom robot) or the benchmark harness.
- Evidence coverage differs per case. `jvm.oom` comes with a JFR signal and stats; `container.die` only gets inspect and logs, so a B3 report that claims to know why the process chose 17 is overreaching. Check `evidenceKinds` before accepting a cause.
- A `FAILED` session is not a transport bug by itself: execution timeout (`PI_OPS_PI_RUNTIME_EXECUTION_TIMEOUT_MS`, 300s in compose), oversized context (`PI_OPS_PI_RUNTIME_MAX_CONTEXT_BYTES=16384`), or an invalid report all land there. The error text is in the session row and `logs/pi-runtime.log`.
- Dynamic evidence requests can be refused by trusted target resolution. A refusal is recorded in `evidenceAudits` and must not be reported as successful collection.
- The report's `hypothesis` is model output. Do not cite it as a proven root cause; cite the evidence ids it points at.
