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

The response reuses the canonical `evidenceSchema`. A `collected` result must carry a full Evidence row, and `evidenceId` must equal `evidence.id`. The runtime binds every response item to its original request: unknown or duplicate `requestId`, wrong type, mismatched `evidence.kind`, foreign `incidentId`, or wrong `runtimeRequestId` are rejected without merging. Protocol corruption fails that enrichment request closed; the investigation still completes when existing Evidence is sufficient.

### Freshness

Enrichment reuse is scoped to the current InvestigationSession (`inv-${sessionId}-evidence-${type}`). Older successful Evidence of the same kind is never returned as a fresh answer; it stays visible through InvestigationContext history and is never copied or deleted.

One collection may satisfy multiple specialists. The request records `requestingRoles`, and every requesting specialist reruns after success. `InvestigationEvidenceAudit` is durable SQLite provenance with UPSERT semantics: identity (requestId, session, runtimeRequestId, runtimeTaskId, evidenceType, requestingRoles, first createdAt) is immutable, while status, evidenceIds, completedAt and error follow the request lifecycle.

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
