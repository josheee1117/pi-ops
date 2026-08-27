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

The resolved query is executed exactly. Pi-Ops does not replan the default Incident evidence set.

One collection may satisfy multiple specialists. The request records `requestingRoles`. InvestigationEvidenceAudit is durable SQLite provenance and does not rewrite Evidence rows.

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
