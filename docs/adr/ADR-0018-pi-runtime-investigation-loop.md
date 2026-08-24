# ADR-0018: Pi Runtime investigation loop

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: How Pi-Ops hands a frozen InvestigationContext to Pi Runtime and governs the returned InvestigationReport
- **Supersedes**: none
- **Related**: ADR-0008, ADR-0011, ADR-0012, ADR-0014, ADR-0015, ADR-0017

## Context

ADR-0017 defined InvestigationContext as the boundary object for a future Pi Runtime. ADR-0012/0014 already hand an InvestigationPlan through a DelegationTask, but they do not snapshot operational context or accept a structured investigation report.

Pi-Ops must own incident facts, the investigation lifecycle, the context snapshot, and result governance. Pi Runtime must own agent orchestration, tools, and model reasoning. Pi-Ops must not become a planner, remediator, or shell host to “complete” an investigation.

## Decision

```text
Incident + Evidence
  → InvestigationContext (hashed snapshot)
  → InvestigationSession (CREATED → SUBMITTED → RUNNING → COMPLETED | FAILED)
  → DelegationTask
  → Pi Runtime
  → InvestigationReport
  → ReasoningResult
  → ReasoningEvaluation
  → MemoryCandidate
```

Pi-Ops provides controlled investigation context. Pi Runtime performs reasoning execution.

### Session

An InvestigationSession records `incidentId`, `contextSnapshotHash`, `delegationTaskId`, and status. The snapshot row is insert-once by hash and is never updated.

### Report

An InvestigationReport records hypothesis, supporting and contradicting evidence ids, confidence, and recommendation. Evidence ids must belong to the Incident. Invalid reports write nothing. Completing a session does not mutate Incident or Evidence.

A failed runtime marks the session `FAILED` and does not change Incident or Evidence.

### Governance

Ingesting a report does not create a MemoryCandidate. A candidate for an investigation-loop result requires both:

- a persisted InvestigationReport
- a ReasoningEvaluation that meets the existing score threshold

Local FakeReasoner / PiReasoner results without a session stay on the existing evaluation path.

## Consequences

Benefits:

- first complete external investigation loop without hosting agents in Pi-Ops
- context given to Pi Runtime is auditable and immutable
- runtime output cannot mint memory without evaluation

Costs:

- HTTP transport for submit/poll is still a no-op adapter
- report aggregation into live memory confidence remains later work

## Supersession rule

Do not execute tools, shell, or remediation inside Pi-Ops to advance an InvestigationSession.
