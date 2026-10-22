# Evidence and brief

Evidence is what the model and the on-call engineer are allowed to see. The center stores raw evidence, exposes a redacted and bounded "safe" view for reasoning and for the brief, and has a dedicated human-readable brief endpoint.

## Sub-features

- `GET /v1/ops/incidents/:id/evidence?view=safe` (default): secret-named fields and env arrays redacted, logs trimmed to `MODEL_SAFE_MAX_LOG_LINES`, data bounded in size. This is the shape the runtime receives.
- `GET /v1/ops/incidents/:id/evidence?view=raw`: unredacted records for authorized local debugging.
- `GET /v1/ops/incidents/:id/brief`: JSON brief with incident facts, plain-language summary, reports, sessions, safe evidence and the notification decision.
- `GET /v1/ops/incidents/:id/brief?format=markdown`: the same content as the on-call document, including the authenticated read path for full evidence.

## How to get to it (user POV)

The on-call engineer opens the brief, not the raw tables. During an incident the message itself carries the details command and says the token must come from a secure channel, so the brief is the user-facing document.

## Driving it with drive.sh

- `drive.sh evidence` captures `incident-brief.md`, `evidence-safe.json` and `evidence-raw.json` for the current run's Incident.
- `drill.investigation` reports the evidence kinds the center collected; `drill.notice` reports the summary the brief produced.

Passing end state: for a health failure, safe and raw evidence both list `http.probe`, `docker.inspect` and `docker.logs`; `http.probe` shows `healthy=false` with the 503; the brief markdown opens with the incident id and carries a non-empty what-happened sentence and recovery steps.

## Gotchas

- Safe and raw differ by redaction and length, not by which evidence exists. A field missing from both means it was never collected; look at `evidenceAudits` for a refused or failed request.
- The safe view's log trimming is deliberate. Reasoning over a trimmed log must not be reported as having seen the full log.
- The brief is generated at read time from stored facts and the latest report. It reflects the incident's state now, which is why the captured `incident-brief.md` reads "已收到恢复事实" after recovery rather than the original open text.
- `data/` in the evidence directory is a copy made while containers run. For a consistent snapshot use the API JSON; do not re-run SQL against the copy and call the result authoritative.
