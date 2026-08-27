# ADR-0026: Typed read-only evidence enrichment boundary

- **Status**: Accepted
- **Date**: 2026-08-26
- **Scope**: How Pi Runtime asks Pi-Ops for more current Evidence without gaining tools or targets
- **Supersedes**: none
- **Related**: ADR-0008, ADR-0025

## Context

Specialists can return `missingEvidence` capability classes. Giving the Pi SDK tools, Docker access, or Node Agent credentials would collapse the control plane. The model must not pick containers, URLs, or commands.

## Decision

```text
Specialist missingEvidence (capability class)
  → Coordinator (bounded: 1 round, ≤2 types/specialist, ≤4 total)
  → Pi Runtime Evidence Client
  → Pi-Ops /v1/investigation-evidence (runtime token)
  → resolve trusted EvidenceQueryRequest
  → EvidenceOrchestrator.collectQueriesForIncident(exact queries)
  → Node Agent
  → new Evidence
  → rerun every specialist that requested that type
```

Pi Runtime decides WHAT evidence capability is missing.

Pi-Ops decides WHETHER and HOW that evidence is collected.

Node Agent performs deterministic collection.

The model never selects arbitrary execution targets.

### Target resolution

`resolveRuntimeEvidenceQuery(incident, trustedTriggeringEvent, evidenceType, logsMaxLines)` is the only way a capability class becomes an `EvidenceQueryRequest`.

- `host.memory` / `host.load` resolve against `Incident.node_id`
- `docker.inspect` / `docker.stats` / `docker.logs` resolve only from trusted container identity already present in approved Event/Incident metadata, and keep the bounded log window and maxLines policy
- `http.probe` resolves only from a trusted health-detector URL
- unresolved targets are rejected; the runtime never supplies container, url, host, path, or arguments

Every type in `RUNTIME_ALLOWED_EVIDENCE_TYPES` has a deterministic resolver outcome. `host.disk` has no trusted dynamic target and is therefore not in the runtime allowlist (the Node Agent still supports it for deterministic plans).

### Response binding

Raw durable Evidence in SQLite is not automatically safe model input. Pi-Ops owns both persistence and the model-safe projection `toRuntimeSafeEvidence`: secret-key / Env redaction and bounded logs. Initial InvestigationContext and dynamic `RuntimeEvidenceResponse.evidence` use that same projection. Specialists receive collected Evidence content after projection, not raw store rows and not merely `{ id, kind }`.

A `collected` result must carry a full Evidence row, `evidenceId` must equal `evidence.id`, and `evidence.status` must be `succeeded` when present. The Coordinator merges the model-safe payload — including diagnostic `data` — into the runtime context before rerunning requesting specialists. Duplicate Evidence ids must agree on the model-safe identity and content; otherwise enrichment fails closed. Newly collected facts that exceed `maxContextBytes` fail with `context_too_large` rather than silently dropping the requested Evidence.

The runtime binds every response item to its original request: unknown or duplicate `requestId`, wrong type, mismatched `evidence.kind`, foreign `incidentId`, or wrong `runtimeRequestId` are rejected without merging. Protocol corruption fails that enrichment request closed; the investigation still completes when existing Evidence is sufficient.

### Freshness

IncidentContext ranks Evidence by kind/status rank, then newer `collectedAt`, then id. Enrichment reuse is scoped to the current InvestigationSession (`inv-${sessionId}-evidence-${type}`). Historical same-kind Evidence does not satisfy a fresh typed request and does not suppress Coordinator enrichment. Older rows stay visible through history and are never copied or deleted.

Canonical typed requests require `requestingRoles` with at least one SpecialistRole. Roles are unique and ordered by `SPECIALIST_ROLES`.

One collection may satisfy multiple specialists, and every requesting specialist reruns after success. `InvestigationEvidenceAudit` is durable SQLite provenance with UPSERT semantics: identity (requestId, session, runtimeRequestId, runtimeTaskId, evidenceType, normalized requestingRoles, first createdAt) is immutable, while status, evidenceIds, completedAt and error follow the request lifecycle. Same requestId with a different identity is a conflict.

Malformed RuntimeEvidenceResponse, mismatched runtimeRequestId, wrong Evidence kind, or foreign Incident ids are rejected and not merged.

Pi Runtime never contacts Node Agent, Docker, or the host. `noTools: 'all'` remains. Failed enrichment is non-fatal when existing Evidence can still support a report.

## Consequences

Benefits:

- specialists can ask for host.memory / docker.stats without becoming operators
- collection stays on the existing Node Agent path
- requester provenance survives process restart

Costs:

- one enrichment round is coarse; later ADRs may raise the cap

## Supersession rule

Do not grant Pi Runtime shell, Docker, database, or Node Agent access to "finish" an investigation.
