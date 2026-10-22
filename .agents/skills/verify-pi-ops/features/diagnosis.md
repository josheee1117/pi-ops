# Investigation and diagnosis

The central agent submits an investigation for an Incident to pi-runtime over `POST /v1/investigations`. pi-runtime asks for deterministic and dynamic evidence through the center, reasons, and posts the report back to `/v1/investigation-results`. The center stores it as an investigation report attached to the session.

## Sub-features

- One session per Incident generation; `GET /v1/ops/incidents/:id` shows `sessions[].status` moving `SUBMITTED`/`RUNNING` to `COMPLETED` or `FAILED`.
- The report carries `hypothesis`, `confidence`, `recommendation`, `supportingEvidenceIds`, `contradictingEvidenceIds`, and a structured `diagnosis`: summary, observations, candidate causes, uncertainties, actions with preconditions/risk/`requiresApproval`.
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

## Gotchas

- The default stack runs the FAKE model (`createFakeRuntimeModel`). Its report is deterministic text such as `memory pressure observed` with Chinese diagnosis boilerplate. It proves the contract, citations and plumbing, not diagnostic quality. For model quality use the JDK17 overlay with credentials (owner authorization required) or the benchmark harness.
- A `FAILED` session is not a transport bug by itself: execution timeout (`PI_OPS_PI_RUNTIME_EXECUTION_TIMEOUT_MS`, 300s in compose), oversized context (`PI_OPS_PI_RUNTIME_MAX_CONTEXT_BYTES=16384`), or an invalid report all land there. The error text is in the session row and `logs/pi-runtime.log`.
- Dynamic evidence requests can be refused by trusted target resolution. A refusal is recorded in `evidenceAudits` and must not be reported as successful collection.
- The report's `hypothesis` is model output. Do not cite it as a proven root cause; cite the evidence ids it points at.
