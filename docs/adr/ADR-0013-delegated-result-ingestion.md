# ADR-0013: Delegated reasoning result ingestion

- **Status**: Accepted
- **Date**: 2026-08-21
- **Scope**: How Pi-Ops accepts a DelegatedReasoningResult and becomes the lifecycle authority again
- **Supersedes**: none
- **Related**: ADR-0011, ADR-0012

## Context

ADR-0012 leaves a ReasoningJob in `WAITING_DELEGATION` after submitting an InvestigationPlan. Pi Runtime will later return a DelegatedReasoningResult. Pi-Ops must ingest that result without executing agents, and without letting a bad payload mutate Incident or Evidence.

## Decision

Pi Runtime produces reasoning text. Pi-Ops remains the source of lifecycle truth.

```text
WAITING_DELEGATION
  → validate DelegatedReasoningResult
  → persist ReasoningResult
  → COMPLETED
```

### Validation

Reject (throw, no writes) when:

- InvestigationPlan is missing
- the plan's job is missing or not `WAITING_DELEGATION` (except idempotent replay)
- confidence is outside `[0, 1]`
- any `evidenceIds` item is not Evidence for that Incident

Incident and Evidence rows are never updated.

### Provenance

The stored ReasoningResult includes `strategy`, `strategyVersion`, and `investigationPlanId`. Optional `memoryIds` become `usedMemoryEntryIds`.

### Idempotency

Result id is `reason-${job.id}`. A second ingest of the same job returns the existing ReasoningResult and does not insert another row.

## Consequences

Benefits:

- external synthesis can complete a job without Pi-Ops hosting agents
- invalid runtime output cannot corrupt facts

Costs:

- HTTP/transport for ingest is still out of scope; this is an internal service

## Supersession rule

Do not apply a delegated result by mutating Incident or Evidence.
